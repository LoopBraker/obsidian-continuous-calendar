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
	ListInstancesRequest,
	OpaqueCursor,
	ProviderDateTimeValue,
	ProviderHttpRequest,
	ProviderHttpResponse,
	ProviderSession,
	PullChangesRequest,
	RemoteCalendar,
	RemoteCalendarEvent,
	RemoteEventLookupResult,
	RemoteEventTombstone,
	RemoteOccurrence,
	UpdateOccurrenceRequest,
} from '../CalendarProvider';
import {
	calendarEventToGoogleResource,
	calendarEventToGoogleInstancePatch,
	GoogleEventMappingError,
	googleDateTimeToProviderValue,
	googleResourceToRemoteOccurrence,
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

function validateGoogleEventId(requestId: string | undefined): void {
	if (requestId === undefined) return;
	if (!/^[0-9a-v]{5,1024}$/.test(requestId)) {
		throw permanentError('Google event ID must use 5 to 1024 lowercase base32hex characters', {
			providerId: GOOGLE_PROVIDER_ID,
			code: 'invalid-event-id',
			operation: 'create-event',
		});
	}
}

function providerDateTimeQueryValue(value: ProviderDateTimeValue): string | undefined {
	const mapped = googleDateTimeToProviderValue(value);
	return mapped?.dateTime ?? mapped?.date;
}

function sameProviderDateTime(
	left: ProviderDateTimeValue | undefined,
	right: ProviderDateTimeValue,
	masterTimeZone?: string,
): boolean {
	if (left?.date !== undefined || right.date !== undefined) return left?.date === right.date;
	if (left?.dateTime !== right.dateTime) return false;
	if (left?.timeZone === right.timeZone) return true;
	if (!masterTimeZone) return false;
	return (left?.timeZone ?? masterTimeZone) === (right.timeZone ?? masterTimeZone);
}

function occurrenceSlotKey(occurrence: Pick<RemoteOccurrence, 'masterRemoteId' | 'originalStartTime'>, masterTimeZone?: string): string {
	const slot = occurrence.originalStartTime;
	return slot.date !== undefined
		? JSON.stringify([occurrence.masterRemoteId, 'date', slot.date])
		: JSON.stringify([occurrence.masterRemoteId, 'dateTime', slot.dateTime, slot.timeZone ?? masterTimeZone]);
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
					if (resource.status === 'cancelled') {
						if (masterRemoteId || resource.originalStartTime !== undefined) {
							const occurrence = this.mapRemoteOccurrence(resource, request.calendarId, 'pull-changes');
							if (occurrence.status !== 'cancelled') {
								throw permanentError('Google returned a non-cancelled occurrence tombstone', {
									providerId: GOOGLE_PROVIDER_ID,
									code: 'invalid-occurrence-tombstone',
									operation: 'pull-changes',
								});
							}
							changes.push({ type: 'occurrence-cancelled', occurrence });
							continue;
						}
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
				return {
					changes,
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

	listInstances(request: ListInstancesRequest): Promise<RemoteOccurrence[]> {
		return this.withSession(request.session, request.signal, async () => {
			const staged = new Map<string, RemoteOccurrence>();
			const pinnedStarts: ProviderDateTimeValue[] = [];
			const pinnedKeys = new Set<string>();
			for (const originalStart of request.pinnedOriginalStarts ?? []) {
				if (!providerDateTimeQueryValue(originalStart)) {
					throw permanentError('Pinned Google occurrence has an invalid original start time', {
						providerId: GOOGLE_PROVIDER_ID,
						code: 'invalid-original-start-time',
						operation: 'list-instances',
					});
				}
					const key = originalStart.date !== undefined
						? JSON.stringify(['date', originalStart.date])
						: JSON.stringify(['dateTime', originalStart.dateTime, originalStart.timeZone ?? request.masterTimeZone]);
				if (pinnedKeys.has(key)) continue;
				pinnedKeys.add(key);
				pinnedStarts.push(originalStart);
			}
			const appendPages = async (originalStart?: ProviderDateTimeValue): Promise<void> => {
				let pageToken: string | undefined;
				for (let page = 0; page < this.maxPages; page += 1) {
					const response = await this.requestJson<GoogleEventsListResponse>(
						'GET',
						`/calendars/${encodeURIComponent(request.calendarId)}/events/${encodeURIComponent(request.masterRemoteId)}/instances`,
						undefined,
						this.authHeaders(request.session),
						'list-instances',
						request.signal,
						{
							showDeleted: 'true',
							maxResults: this.maxResults,
							pageToken,
							...(originalStart === undefined
								? { timeMin: request.window.from, timeMax: request.window.to }
								: { originalStart: providerDateTimeQueryValue(originalStart) }),
						},
					);
					for (const resource of response.items ?? []) {
						const occurrence = this.mapRemoteOccurrence(resource, request.calendarId, 'list-instances');
						if (occurrence.masterRemoteId !== request.masterRemoteId) {
							throw permanentError('Google returned an occurrence for a different recurring master', {
								providerId: GOOGLE_PROVIDER_ID,
								code: 'occurrence-master-mismatch',
								operation: 'list-instances',
							});
						}
						if (originalStart !== undefined && !sameProviderDateTime(occurrence.originalStartTime, originalStart, request.masterTimeZone)) continue;
						const key = occurrenceSlotKey(occurrence, request.masterTimeZone);
						const previous = staged.get(key);
						if (
							previous &&
							(previous.instanceRemoteId !== occurrence.instanceRemoteId || previous.status !== occurrence.status)
						) {
							throw permanentError('Google returned conflicting occurrences for the same recurrence slot', {
								providerId: GOOGLE_PROVIDER_ID,
								code: 'occurrence-slot-conflict',
								operation: 'list-instances',
							});
						}
						staged.set(key, occurrence);
					}
					pageToken = asNonEmptyString(response.nextPageToken);
					if (!pageToken) return;
				}
				throw transientError('Google occurrence fetch exceeded the page limit', {
					providerId: GOOGLE_PROVIDER_ID,
					code: 'page-limit',
					operation: 'list-instances',
				});
			};

			await appendPages();
			for (const originalStart of pinnedStarts) await appendPages(originalStart);
			return [...staged.values()];
		});
	}

	async fetchEvent(
		session: ProviderSession,
		calendarId: string,
		remoteId: string,
		signal?: AbortSignal,
	): Promise<RemoteEventLookupResult> {
		try {
			return await this.withSession(session, signal, async () => {
				const resource = await this.requestJson<GoogleEventResource>(
					'GET',
					`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(remoteId)}`,
					undefined,
					this.authHeaders(session),
					'get-event',
					signal,
				);
				if (resource.status === 'cancelled') {
					const tombstone = this.mapTombstone(resource, calendarId, 'get-event');
					return { status: 'cancelled', tombstone };
				}
				try {
					return {
						status: 'active',
						event: googleResourceToRemoteEvent(resource, {
							calendarId,
							calendarTimezone: this.calendarTimezones.get(calendarId),
						}),
					};
				} catch (error) {
					if (error instanceof GoogleEventMappingError) {
						throw permanentError('Google returned an invalid event resource', {
							providerId: GOOGLE_PROVIDER_ID,
							code: error.code,
							operation: 'get-event',
						});
					}
					throw error;
				}
			});
		} catch (error) {
			if (error instanceof ProviderError && error.status === 404 && error.operation === 'get-event') {
				return { status: 'not-found', providerId: GOOGLE_PROVIDER_ID, calendarId, remoteId };
			}
			throw error;
		}
	}

	updateOccurrence(request: UpdateOccurrenceRequest): Promise<Extract<RemoteOccurrence, { readonly status: 'active' }>> {
		return this.withSession(request.session, request.signal, async () => {
			const latest = await this.fetchEvent(
				request.session,
				request.calendarId,
				request.instanceRemoteId,
				request.signal,
			);
			if (latest.status !== 'active') {
				throw conflictError('Google occurrence is no longer active', {
					providerId: GOOGLE_PROVIDER_ID,
					status: latest.status === 'not-found' ? 404 : 412,
					code: latest.status === 'not-found' ? 'occurrence-not-found' : 'occurrence-cancelled',
					operation: 'update-occurrence',
				});
			}
			if (
				latest.event.originalStartTime?.dateTime &&
				(latest.event.originalStartTime.timeZone === undefined || request.originalStartTime.timeZone === undefined)
			) {
				const master = await this.fetchEvent(request.session, request.calendarId, request.masterRemoteId, request.signal);
				if (master.status !== 'active' || !request.masterTimeZone || master.event.event.timezone !== request.masterTimeZone) {
					throw conflictError('Google recurring master timezone changed before occurrence update', {
						providerId: GOOGLE_PROVIDER_ID,
						status: 412,
						code: 'master-timezone-mismatch',
						operation: 'update-occurrence',
					});
				}
			}
			if (
				latest.event.recurrenceMasterId !== request.masterRemoteId ||
				!sameProviderDateTime(latest.event.originalStartTime, request.originalStartTime, request.masterTimeZone)
			) {
				throw conflictError('Google occurrence identity no longer matches the requested recurrence slot', {
					providerId: GOOGLE_PROVIDER_ID,
					status: 412,
					code: 'occurrence-identity-mismatch',
					operation: 'update-occurrence',
				});
			}
			if (request.expectedVersion && latest.event.version !== request.expectedVersion) {
				throw conflictError('Google occurrence version changed before update', {
					providerId: GOOGLE_PROVIDER_ID,
					status: 412,
					code: 'version-mismatch',
					operation: 'update-occurrence',
				});
			}

			const headers = this.jsonHeaders(request.session);
			const expectedVersion = request.expectedVersion ?? latest.event.version;
			if (expectedVersion) headers['If-Match'] = expectedVersion;
			const resource = await this.requestJson<GoogleEventResource>(
				'PATCH',
				`/calendars/${encodeURIComponent(request.calendarId)}/events/${encodeURIComponent(request.instanceRemoteId)}`,
				calendarEventToGoogleInstancePatch(request.event),
				headers,
				'update-occurrence',
				request.signal,
			);
			const occurrence = this.mapRemoteOccurrence(resource, request.calendarId, 'update-occurrence');
			if (
				occurrence.status !== 'active' ||
				occurrence.masterRemoteId !== request.masterRemoteId ||
				occurrence.instanceRemoteId !== request.instanceRemoteId ||
				!sameProviderDateTime(occurrence.originalStartTime, request.originalStartTime, request.masterTimeZone)
			) {
				throw permanentError('Google occurrence update returned a different occurrence identity', {
					providerId: GOOGLE_PROVIDER_ID,
					code: 'occurrence-identity-mismatch',
					operation: 'update-occurrence',
				});
			}
			return occurrence;
		});
	}

	createEvent(
		session: ProviderSession,
		calendarId: string,
		event: CalendarEvent,
		signal?: AbortSignal,
		requestId?: string,
	): Promise<RemoteCalendarEvent> {
		return this.withSession(session, signal, async () => {
			validateGoogleEventId(requestId);
			const resource = await this.requestJson<GoogleEventResource>(
				'POST',
				`/calendars/${encodeURIComponent(calendarId)}/events`,
				{
					...calendarEventToGoogleResource(event),
					...(requestId === undefined ? {} : { id: requestId }),
				},
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

	private mapRemoteOccurrence(
		resource: GoogleEventResource,
		calendarId: string,
		operation: string,
	): RemoteOccurrence {
		try {
			return googleResourceToRemoteOccurrence(resource, {
				calendarId,
				calendarTimezone: this.calendarTimezones.get(calendarId),
			});
		} catch (error) {
			if (error instanceof GoogleEventMappingError) {
				throw permanentError('Google returned an invalid occurrence resource', {
					providerId: GOOGLE_PROVIDER_ID,
					code: error.code,
					operation,
				});
			}
			throw error;
		}
	}

	private mapTombstone(
		resource: GoogleEventResource,
		calendarId: string,
		operation: string,
	): RemoteEventTombstone {
		const remoteId = asNonEmptyString(resource.id);
		if (!remoteId) {
			throw permanentError('Google returned a cancelled event without an id', {
				providerId: GOOGLE_PROVIDER_ID,
				code: 'invalid-resource',
				operation,
			});
		}
		const masterRemoteId = asNonEmptyString(resource.recurringEventId);
		if (masterRemoteId || resource.originalStartTime !== undefined) {
			const occurrence = this.mapRemoteOccurrence(resource, calendarId, operation);
			if (occurrence.status !== 'cancelled') {
				throw permanentError('Google returned an invalid cancelled exception', {
					providerId: GOOGLE_PROVIDER_ID,
					code: 'invalid-occurrence-tombstone',
					operation,
				});
			}
			return {
				providerId: GOOGLE_PROVIDER_ID,
				calendarId,
				remoteId,
				...(occurrence.version === undefined ? {} : { version: occurrence.version }),
				recurrenceMasterId: occurrence.masterRemoteId,
				originalStartTime: occurrence.originalStartTime,
				...(occurrence.actualStart === undefined ? {} : { actualStart: occurrence.actualStart }),
				...(occurrence.actualEnd === undefined ? {} : { actualEnd: occurrence.actualEnd }),
			};
		}
		return {
			providerId: GOOGLE_PROVIDER_ID,
			calendarId,
			remoteId,
			...(asNonEmptyString(resource.etag) === undefined ? {} : { version: asNonEmptyString(resource.etag) }),
		};
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
