import type { CalendarEvent } from '../../model/CalendarEvent';
import {
	authenticationError,
	authorizationError,
	conflictError,
	cursorExpiredError,
	permanentError,
	ProviderCancelledError,
	ProviderError,
	throttlingError,
	transientError,
	unsupportedError,
} from '../ProviderErrors';
import type {
	CalendarProvider,
	CalendarProviderDependencies,
	ChangePage,
	OpaqueCursor,
	ProviderHttpRequest,
	ProviderHttpResponse,
	ProviderSession,
	PullChangesRequest,
	RemoteCalendar,
	RemoteCalendarEvent,
} from '../CalendarProvider';
import {
	calendarEventToGoogleResource,
	GoogleEventMappingError,
	googleResourceToRemoteEvent,
	type GoogleEventResource,
} from './GoogleEventMapper';

const GOOGLE_PROVIDER_ID = 'google' as const;
const DEFAULT_BASE_URL = 'https://www.googleapis.com/calendar/v3';
// v2 marks cursors created from the unbounded query shape. A v1 cursor came
// from a bounded initial fetch, so decode rejects it and SyncService performs
// one automatic full resync without requiring the user to reconnect.
const GOOGLE_CURSOR_PREFIX = 'google-sync-v2:';
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_MAX_RESULTS = 2500;

export interface GoogleCalendarListResource {
	readonly id?: unknown;
	readonly summary?: unknown;
	readonly summaryOverride?: unknown;
	readonly description?: unknown;
	readonly accessRole?: unknown;
	readonly primary?: unknown;
	readonly timeZone?: unknown;
}

export interface GoogleCalendarListResponse {
	readonly items?: readonly GoogleCalendarListResource[];
	readonly nextPageToken?: unknown;
}

export interface GoogleEventsListResponse {
	readonly items?: readonly GoogleEventResource[];
	readonly nextPageToken?: unknown;
	readonly nextSyncToken?: unknown;
}

export interface GoogleCalendarProviderOptions extends CalendarProviderDependencies {
	readonly transport: NonNullable<CalendarProviderDependencies['http']>;
	readonly baseUrl?: string;
	readonly maxPages?: number;
	readonly maxResults?: number;
}

function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function readHeader(headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	const expected = name.toLowerCase();
	const key = Object.keys(headers).find(header => header.toLowerCase() === expected);
	return key === undefined ? undefined : headers[key];
}

function parseRetryAfter(
	headers: Readonly<Record<string, string>> | undefined,
	now: number,
): number | undefined {
	const value = readHeader(headers, 'retry-after');
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function encodeGoogleCursor(syncToken: string): OpaqueCursor {
	return `${GOOGLE_CURSOR_PREFIX}${encodeURIComponent(syncToken)}`;
}

function decodeGoogleCursor(cursor: OpaqueCursor): string {
	if (!cursor.startsWith(GOOGLE_CURSOR_PREFIX)) {
		throw cursorExpiredError('Google change cursor is not valid for this adapter', {
			providerId: GOOGLE_PROVIDER_ID,
			code: 'invalid-google-cursor',
		});
	}
	try {
		const syncToken = decodeURIComponent(cursor.slice(GOOGLE_CURSOR_PREFIX.length));
		if (!syncToken) throw new Error('empty cursor');
		return syncToken;
	} catch (_error) {
		throw cursorExpiredError('Google change cursor could not be decoded', {
			providerId: GOOGLE_PROVIDER_ID,
			code: 'invalid-google-cursor',
		});
	}
}

function readResponseBody(response: ProviderHttpResponse): unknown {
	if (response.body !== undefined) return response.body;
	const responseWithJson = response as ProviderHttpResponse & { readonly json?: unknown; readonly text?: unknown };
	if (responseWithJson.json !== undefined) return responseWithJson.json;
	if (typeof responseWithJson.text === 'string' && responseWithJson.text.length > 0) {
		try {
			return JSON.parse(responseWithJson.text);
		} catch (_error) {
			return undefined;
		}
	}
	return undefined;
}

function appendQuery(path: string, values: Readonly<Record<string, string | number | undefined>>): string {
	const query = Object.keys(values)
		.filter(key => values[key] !== undefined)
		.map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(values[key]))}`)
		.join('&');
	return query.length > 0 ? `${path}?${query}` : path;
}

function supportedWritableAccessRole(role: unknown): boolean {
	return role === 'owner' || role === 'writer';
}

/** Google Calendar adapter with all network and clock behavior injected. */
export class GoogleCalendarProvider implements CalendarProvider {
	readonly id = GOOGLE_PROVIDER_ID;

	private readonly transport: NonNullable<CalendarProviderDependencies['http']>;
	private readonly baseUrl: string;
	private readonly maxPages: number;
	private readonly maxResults: number;
	private readonly clock: { now(): number };
	private readonly calendarTimezones = new Map<string, string>();

	constructor(options: GoogleCalendarProviderOptions) {
		this.transport = options.transport;
		this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
		this.maxPages = Math.max(1, Math.floor(options.maxPages ?? DEFAULT_MAX_PAGES));
		this.maxResults = Math.max(1, Math.floor(options.maxResults ?? DEFAULT_MAX_RESULTS));
		this.clock = options.clock ?? { now: () => Date.now() };
	}

	listCalendars(session: ProviderSession, signal?: AbortSignal): Promise<RemoteCalendar[]> {
		return this.withSession(session, signal, async () => {
			const calendars: RemoteCalendar[] = [];
			let pageToken: string | undefined;
			for (let page = 0; page < this.maxPages; page += 1) {
				const response = await this.requestJson<GoogleCalendarListResponse>(
					'GET',
					appendQuery('/users/me/calendarList', {
						showDeleted: 'false',
						minAccessRole: 'writer',
						maxResults: this.maxResults,
						pageToken,
					}),
				undefined,
				this.authHeaders(session),
				'list-calendars',
					signal,
				);
				for (const item of response.items ?? []) {
					const calendarId = asNonEmptyString(item.id);
					if (!calendarId || !supportedWritableAccessRole(item.accessRole)) continue;
					const timezone = asNonEmptyString(item.timeZone);
					if (timezone) this.calendarTimezones.set(calendarId, timezone);
					calendars.push({
						providerId: GOOGLE_PROVIDER_ID,
						accountId: session.accountId,
						calendarId,
						name:
							asNonEmptyString(item.summaryOverride) ??
							asNonEmptyString(item.summary) ??
							calendarId,
						writable: true,
						timezone,
					});
				}
				pageToken = asNonEmptyString(response.nextPageToken);
				if (!pageToken) return calendars;
			}
			throw transientError('Google calendar discovery exceeded the page limit', {
				providerId: GOOGLE_PROVIDER_ID,
				code: 'page-limit',
				operation: 'list-calendars',
			});
		});
	}

	pullChanges(request: PullChangesRequest): Promise<ChangePage> {
		return this.withSession(request.session, request.signal, async () => {
			const syncToken = request.cursor ? decodeGoogleCursor(request.cursor) : undefined;
			let pageToken: string | undefined;
			const changes: ChangePage['changes'] = [];
			const exceptionMasterIds = new Set<string>();

			for (let page = 0; page < this.maxPages; page += 1) {
				const response = await this.requestJson<GoogleEventsListResponse>(
					'GET',
					`/calendars/${encodeURIComponent(request.calendarId)}/events`,
					undefined,
					this.authHeaders(request.session),
					'pull-changes',
					request.signal,
					{
						showDeleted: 'true',
						singleEvents: 'false',
						maxResults: this.maxResults,
						pageToken,
						syncToken,
					},
				);

				for (const resource of response.items ?? []) {
					const remoteId = asNonEmptyString(resource.id);
					if (!remoteId) continue;
					const masterRemoteId = asNonEmptyString(resource.recurringEventId);
					if (masterRemoteId) {
						exceptionMasterIds.add(masterRemoteId);
						changes.push({
							type: 'series-unsupported',
							providerId: GOOGLE_PROVIDER_ID,
							calendarId: request.calendarId,
							masterRemoteId,
						});
					}
					if (resource.status === 'cancelled') {
						changes.push({
							type: 'delete',
							providerId: GOOGLE_PROVIDER_ID,
							calendarId: request.calendarId,
							remoteId,
						});
						continue;
					}
					try {
						changes.push({
							type: 'upsert',
							value: googleResourceToRemoteEvent(resource, {
								calendarId: request.calendarId,
								calendarTimezone: this.calendarTimezones.get(request.calendarId),
							}),
						});
					} catch (error) {
						if (error instanceof GoogleEventMappingError) {
							throw permanentError('Google returned an invalid event resource', {
								providerId: GOOGLE_PROVIDER_ID,
								code: error.code,
								operation: 'pull-changes',
							});
						}
						throw error;
					}
				}

				pageToken = asNonEmptyString(response.nextPageToken);
				if (pageToken) continue;
				const nextSyncToken = asNonEmptyString(response.nextSyncToken);
				if (!nextSyncToken) {
					throw transientError('Google change pull did not return a final sync token', {
						providerId: GOOGLE_PROVIDER_ID,
						code: 'missing-sync-token',
						operation: 'pull-changes',
					});
				}
				const guardedChanges = changes.map(change => {
					if (change.type !== 'upsert' || !exceptionMasterIds.has(change.value.remoteId)) return change;
					return {
						type: 'upsert' as const,
						value: {
							...change.value,
							recurrenceStatus: 'unsupported' as const,
							recurrence: 'unsupported' as const,
							recurrenceHasExceptions: true,
						},
					};
				});
				return {
					changes: guardedChanges,
					hasMore: false,
					nextCursor: encodeGoogleCursor(nextSyncToken),
				};
			}
			throw transientError('Google change pull exceeded the page limit', {
				providerId: GOOGLE_PROVIDER_ID,
				code: 'page-limit',
				operation: 'pull-changes',
			});
		});
	}

	createEvent(
		session: ProviderSession,
		calendarId: string,
		event: CalendarEvent,
		signal?: AbortSignal,
	): Promise<RemoteCalendarEvent> {
		return this.withSession(session, signal, async () => {
			const resource = await this.requestJson<GoogleEventResource>(
				'POST',
				`/calendars/${encodeURIComponent(calendarId)}/events`,
				calendarEventToGoogleResource(event),
				this.jsonHeaders(session),
				'create-event',
				signal,
			);
			return this.mapWrittenResource(resource, calendarId);
		});
	}

	updateEvent(
		session: ProviderSession,
		calendarId: string,
		remoteId: string,
		event: CalendarEvent,
		expectedVersion?: string,
		signal?: AbortSignal,
	): Promise<RemoteCalendarEvent> {
		return this.withSession(session, signal, async () => {
			const headers = this.jsonHeaders(session);
			if (expectedVersion) headers['If-Match'] = expectedVersion;
			const resource = await this.requestJson<GoogleEventResource>(
				'PATCH',
				`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(remoteId)}`,
				calendarEventToGoogleResource(event, true),
				headers,
				'update-event',
				signal,
			);
			return this.mapWrittenResource(resource, calendarId);
		});
	}

	deleteEvent(
		session: ProviderSession,
		calendarId: string,
		remoteId: string,
		expectedVersion?: string,
		signal?: AbortSignal,
	): Promise<void> {
		return this.withSession(session, signal, async () => {
			const headers = this.authHeaders(session);
			if (expectedVersion) headers['If-Match'] = expectedVersion;
			await this.requestJson<unknown>(
				'DELETE',
				`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(remoteId)}`,
				undefined,
				headers,
				'delete-event',
				signal,
			);
		});
	}

	private mapWrittenResource(
		resource: GoogleEventResource,
		calendarId: string,
	): RemoteCalendarEvent {
		try {
			const mapped = googleResourceToRemoteEvent(resource, {
				calendarId,
				calendarTimezone: this.calendarTimezones.get(calendarId),
			});
			if (!mapped.calendarUid) {
				throw permanentError('Google write response omitted the private calendar UID', {
					providerId: GOOGLE_PROVIDER_ID,
					code: 'missing-calendar-uid',
					operation: 'map-event',
				});
			}
			return mapped;
		} catch (error) {
			if (error instanceof GoogleEventMappingError) {
				throw permanentError('Google returned an invalid event resource', {
					providerId: GOOGLE_PROVIDER_ID,
					code: error.code,
					operation: 'map-event',
				});
			}
			throw error;
		}
	}

	private authHeaders(session: ProviderSession): Record<string, string> {
		if (!session.accessToken) {
			throw authenticationError('Google access token is unavailable', {
				providerId: GOOGLE_PROVIDER_ID,
				code: 'missing-access-token',
			});
		}
		return { Authorization: `Bearer ${session.accessToken}`, Accept: 'application/json' };
	}

	private jsonHeaders(session: ProviderSession): Record<string, string> {
		return { ...this.authHeaders(session), 'Content-Type': 'application/json' };
	}

	private async withSession<T>(
		session: ProviderSession,
		signal: AbortSignal | undefined,
		operation: () => Promise<T>,
	): Promise<T> {
		this.assertSession(session);
		if (signal?.aborted) throw new ProviderCancelledError('Google operation was cancelled', GOOGLE_PROVIDER_ID);
		return operation();
	}

	private assertSession(session: ProviderSession): void {
		if (session.providerId !== GOOGLE_PROVIDER_ID) {
			throw authorizationError('Session does not belong to Google', {
				providerId: GOOGLE_PROVIDER_ID,
				code: 'wrong-provider',
			});
		}
	}

	private async requestJson<T>(
		method: string,
		path: string,
		body: unknown,
		headers: Readonly<Record<string, string>>,
		operation: string,
		signal?: AbortSignal,
		query?: Readonly<Record<string, string | number | undefined>>,
	): Promise<T> {
		if (signal?.aborted) throw new ProviderCancelledError('Google operation was cancelled', GOOGLE_PROVIDER_ID);
		const request: ProviderHttpRequest = {
			method,
			url: `${this.baseUrl}${appendQuery(path, query ?? {})}`,
			headers,
			signal,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		};
		let response: ProviderHttpResponse;
		try {
			response = await this.transport.request(request);
		} catch (_error) {
			if (signal?.aborted) throw new ProviderCancelledError('Google operation was cancelled', GOOGLE_PROVIDER_ID);
			throw transientError('Google request failed before an HTTP response', {
				providerId: GOOGLE_PROVIDER_ID,
				operation,
			});
		}
		if (response.status < 200 || response.status >= 300) {
			throw this.errorForResponse(response, operation);
		}
		return readResponseBody(response) as T;
	}

	private errorForResponse(response: ProviderHttpResponse, operation: string): ProviderError {
		const options = {
			providerId: GOOGLE_PROVIDER_ID,
			status: response.status,
			operation,
			retryAfterMs: parseRetryAfter(response.headers, this.clock.now()),
		};
		switch (response.status) {
			case 401:
				return authenticationError('Google authentication failed', { ...options, code: 'http-401' });
			case 403:
				return authorizationError('Google authorization failed', { ...options, code: 'http-403' });
			case 404:
				return permanentError('Google resource was not found', { ...options, code: 'http-404' });
			case 410:
				return operation === 'pull-changes'
					? cursorExpiredError('Google change cursor expired', { ...options, code: 'http-410' })
					: permanentError('Google resource is no longer available', { ...options, code: 'http-410' });
			case 412:
				return conflictError('Google event version conflict', { ...options, code: 'http-412' });
			case 429:
				return throttlingError('Google rate limit exceeded', options.retryAfterMs, {
					providerId: GOOGLE_PROVIDER_ID,
					status: response.status,
					operation,
					code: 'http-429',
				});
			case 501:
				return unsupportedError('Google operation is unsupported', { ...options, code: 'http-501' });
			default:
				return response.status >= 500
					? transientError('Google service is temporarily unavailable', { ...options, code: `http-${response.status}` })
					: permanentError('Google request was rejected', { ...options, code: `http-${response.status}` });
		}
	}
}

export { decodeGoogleCursor, encodeGoogleCursor };
