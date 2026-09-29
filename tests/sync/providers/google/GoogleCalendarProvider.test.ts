import { describe, expect, it } from 'vitest';

import type { CalendarEvent } from '../../../../src/services/sync/model/CalendarEvent';
import type {
	ProviderHttpRequest,
	ProviderHttpResponse,
	ProviderHttpTransport,
	ProviderSession,
} from '../../../../src/services/sync/providers/CalendarProvider';
import { ProviderError } from '../../../../src/services/sync/providers/ProviderErrors';
import {
	decodeGoogleCursor,
	encodeGoogleCursor,
	GoogleCalendarProvider,
} from '../../../../src/services/sync/providers/google/GoogleCalendarProvider';

const session: ProviderSession = {
	providerId: 'google',
	accountId: 'account-1',
	accessToken: 'secret-access-token',
};
const window = { from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' };
const event: CalendarEvent = {
	uid: 'local-1',
	title: 'Review',
	start: '2026-09-22T09:00:00-05:00',
	end: '2026-09-22T10:00:00-05:00',
	allDay: false,
	timezone: 'America/Bogota',
	location: 'Room',
	description: 'Description',
};

function remoteResource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'remote-1',
		etag: '"v1"',
		updated: '2026-09-20T12:00:00Z',
		summary: event.title,
		description: event.description,
		location: event.location,
		start: { dateTime: event.start, timeZone: event.timezone },
		end: { dateTime: event.end, timeZone: event.timezone },
		extendedProperties: { private: { calendar_uid: event.uid } },
		...overrides,
	};
}

class QueueTransport implements ProviderHttpTransport {
	readonly requests: ProviderHttpRequest[] = [];
	readonly responses: Array<ProviderHttpResponse | Error>;

	constructor(...responses: Array<ProviderHttpResponse | Error>) {
		this.responses = responses;
	}

	async request(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
		this.requests.push(request);
		const response = this.responses.shift();
		if (!response) throw new Error('Unexpected request');
		if (response instanceof Error) throw response;
		return response;
	}
}

function response(status: number, body?: unknown, headers?: Record<string, string>): ProviderHttpResponse {
	return { status, body, headers };
}

async function providerError(promise: Promise<unknown>): Promise<ProviderError> {
	try {
		await promise;
		throw new Error('Expected provider error');
	} catch (error) {
		expect(error).toBeInstanceOf(ProviderError);
		return error as ProviderError;
	}
}

describe('GoogleCalendarProvider', () => {
	it('discovers only writable calendars across pages', async () => {
		const transport = new QueueTransport(
			response(200, {
				items: [
					{ id: 'reader', summary: 'Read only', accessRole: 'reader' },
					{ id: 'team/a', summaryOverride: ' Team ', accessRole: 'writer', timeZone: 'America/Bogota' },
				],
				nextPageToken: 'page 2',
			}),
			response(200, { items: [{ id: 'primary', summary: 'Primary', accessRole: 'owner' }] }),
		);
		const provider = new GoogleCalendarProvider({ transport });
		const calendars = await provider.listCalendars(session);
		expect(calendars.map(calendar => calendar.calendarId)).toEqual(['team/a', 'primary']);
		expect(calendars[0]).toMatchObject({ name: 'Team', writable: true, timezone: 'America/Bogota' });
		expect(new URL(transport.requests[1].url).searchParams.get('pageToken')).toBe('page 2');
	});

	it('paginates a full pull and emits only the final opaque sync cursor', async () => {
		const transport = new QueueTransport(
			response(200, { items: [remoteResource()], nextPageToken: 'next/page' }),
			response(200, {
				items: [remoteResource({ id: 'deleted-1', status: 'cancelled', start: undefined, end: undefined })],
				nextSyncToken: 'sync/token+1',
			}),
		);
		const provider = new GoogleCalendarProvider({ transport });
		const page = await provider.pullChanges({ session, calendarId: 'primary', window });
		expect(page.hasMore).toBe(false);
		expect(page.changes).toHaveLength(2);
		expect(page.changes[0]).toMatchObject({ type: 'upsert', value: { calendarUid: 'local-1' } });
		expect(page.changes[1]).toEqual({
			type: 'delete', providerId: 'google', calendarId: 'primary', remoteId: 'deleted-1',
		});
		expect(decodeGoogleCursor(page.nextCursor as string)).toBe('sync/token+1');
		const firstUrl = new URL(transport.requests[0].url);
		const secondUrl = new URL(transport.requests[1].url);
		expect(firstUrl.searchParams.has('timeMin')).toBe(false);
		expect(firstUrl.searchParams.has('timeMax')).toBe(false);
		expect(secondUrl.searchParams.has('timeMin')).toBe(false);
		expect(secondUrl.searchParams.has('timeMax')).toBe(false);
		expect(secondUrl.searchParams.get('pageToken')).toBe('next/page');
	});

	it('uses a consistent unbounded query shape so a later Google event arrives incrementally', async () => {
		const transport = new QueueTransport(
			response(200, { items: [], nextSyncToken: 'initial-sync-token' }),
			response(200, { items: [remoteResource({ id: 'created-after-first-sync' })], nextSyncToken: 'next-sync-token' }),
		);
		const provider = new GoogleCalendarProvider({ transport });
		const initial = await provider.pullChanges({ session, calendarId: 'primary', window });
		const incremental = await provider.pullChanges({
			session,
			calendarId: 'primary',
			cursor: initial.nextCursor,
			window,
		});

		expect(initial.changes).toEqual([]);
		expect(incremental.changes).toMatchObject([
			{ type: 'upsert', value: { remoteId: 'created-after-first-sync', event: { title: 'Review' } } },
		]);

		const initialQuery = new URL(transport.requests[0].url).searchParams;
		const incrementalQuery = new URL(transport.requests[1].url).searchParams;
		for (const query of [initialQuery, incrementalQuery]) {
			expect(query.has('timeMin')).toBe(false);
			expect(query.has('timeMax')).toBe(false);
			expect(query.get('showDeleted')).toBe('true');
			expect(query.get('singleEvents')).toBe('false');
			expect(query.get('maxResults')).toBe('2500');
		}
		expect(initialQuery.has('syncToken')).toBe(false);
		expect(incrementalQuery.get('syncToken')).toBe('initial-sync-token');
	});

	it('retains the sync token on every incremental page and omits time bounds', async () => {
		const cursor = encodeGoogleCursor('old token');
		const transport = new QueueTransport(
			response(200, { items: [], nextPageToken: 'page-2' }),
			response(200, { items: [], nextSyncToken: 'new-token' }),
		);
		const provider = new GoogleCalendarProvider({ transport });
		await provider.pullChanges({ session, calendarId: 'primary', cursor, window });
		for (const request of transport.requests) {
			const url = new URL(request.url);
			expect(url.searchParams.get('syncToken')).toBe('old token');
			expect(url.searchParams.has('timeMin')).toBe(false);
			expect(url.searchParams.has('timeMax')).toBe(false);
		}
	});

	it('invalidates bounded-query v1 cursors so the engine can recover with a full sync', async () => {
		const provider = new GoogleCalendarProvider({ transport: new QueueTransport(response(200, {})) });
		const error = await providerError(provider.pullChanges({
			session,
			calendarId: 'primary',
			cursor: 'google-sync-v1:legacy-token',
			window,
		}));
		expect(error).toMatchObject({ category: 'cursor-expired', code: 'invalid-google-cursor' });
	});

	it('requires a final sync token and bounds pagination', async () => {
		const missing = new GoogleCalendarProvider({ transport: new QueueTransport(response(200, { items: [] })) });
		const missingError = await providerError(missing.pullChanges({ session, calendarId: 'primary', window }));
		expect(missingError).toMatchObject({ category: 'transient', code: 'missing-sync-token' });

		const transport = new QueueTransport(response(200, { items: [], nextPageToken: 'again' }));
		const bounded = new GoogleCalendarProvider({ transport, maxPages: 1 });
		const boundedError = await providerError(bounded.pullChanges({ session, calendarId: 'primary', window }));
		expect(boundedError).toMatchObject({ category: 'transient', code: 'page-limit' });
	});

	it('uses PATCH with If-Match and changes only plugin-owned fields', async () => {
		const transport = new QueueTransport(response(200, remoteResource({ etag: '"v2"' })));
		const provider = new GoogleCalendarProvider({ transport });
		const updated = await provider.updateEvent(session, 'team/a', 'remote/1', event, '"v1"');
		const request = transport.requests[0];
		expect(request.method).toBe('PATCH');
		expect(request.url).toContain('/calendars/team%2Fa/events/remote%2F1');
		expect(request.headers?.['If-Match']).toBe('"v1"');
		expect(request.headers?.Authorization).toBe('Bearer secret-access-token');
		const body = JSON.parse(request.body as string) as Record<string, unknown>;
		expect(body).toMatchObject({ summary: 'Review', extendedProperties: { private: { calendar_uid: 'local-1' } } });
		expect(body).not.toHaveProperty('attendees');
		expect(body).not.toHaveProperty('reminders');
		expect(updated).toMatchObject({ remoteId: 'remote-1', version: '"v2"', calendarUid: 'local-1' });
	});

	it('refuses to confirm a write if Google omits the echoed private UID', async () => {
		const resource = remoteResource();
		delete resource.extendedProperties;
		const provider = new GoogleCalendarProvider({ transport: new QueueTransport(response(200, resource)) });
		const error = await providerError(provider.createEvent(session, 'primary', event));
		expect(error).toMatchObject({ category: 'permanent', code: 'missing-calendar-uid' });
	});

	it('maps recurrence without modifying it and sends conditional deletes', async () => {
		const pullTransport = new QueueTransport(response(200, {
			items: [remoteResource({ recurrence: ['RRULE:FREQ=DAILY'] })],
			nextSyncToken: 'next',
		}));
		const provider = new GoogleCalendarProvider({ transport: pullTransport });
		const page = await provider.pullChanges({ session, calendarId: 'primary', window });
		expect(page.changes[0]).toMatchObject({ type: 'upsert', value: { recurrence: 'unsupported' } });

		const deleteTransport = new QueueTransport(response(204));
		const deleteProvider = new GoogleCalendarProvider({ transport: deleteTransport });
		await deleteProvider.deleteEvent(session, 'primary', 'remote-1', '"v3"');
		expect(deleteTransport.requests[0]).toMatchObject({ method: 'DELETE', headers: { 'If-Match': '"v3"' } });
	});

	it.each([
		[401, 'authentication'],
		[403, 'authorization'],
		[404, 'permanent'],
		[410, 'cursor-expired'],
		[412, 'conflict'],
		[429, 'throttling'],
		[500, 'transient'],
	] as const)('categorizes pull HTTP %i as %s without leaking credentials', async (status, category) => {
		const provider = new GoogleCalendarProvider({
			transport: new QueueTransport(response(status, { error: { message: 'secret-access-token' } }, { 'Retry-After': '2' })),
			clock: { now: () => 0 },
		});
		const error = await providerError(provider.pullChanges({ session, calendarId: 'primary', window }));
		expect(error.category).toBe(category);
		expect(JSON.stringify(error)).not.toContain('secret-access-token');
		if (status === 429) expect(error.retryAfterMs).toBe(2_000);
	});

	it('treats non-pull 410 as permanent and transport failure as transient', async () => {
		const gone = new GoogleCalendarProvider({ transport: new QueueTransport(response(410)) });
		expect((await providerError(gone.deleteEvent(session, 'primary', 'gone'))).category).toBe('permanent');
		const offline = new GoogleCalendarProvider({ transport: new QueueTransport(new Error('secret-access-token')) });
		const error = await providerError(offline.listCalendars(session));
		expect(error.category).toBe('transient');
		expect(error.message).not.toContain('secret-access-token');
	});

	it('honors cancellation and rejects sessions from another provider', async () => {
		const transport = new QueueTransport(response(200, {}));
		const provider = new GoogleCalendarProvider({ transport });
		const controller = new AbortController();
		controller.abort();
		const cancelled = await providerError(provider.listCalendars(session, controller.signal));
		expect(cancelled).toMatchObject({ category: 'cancelled', name: 'AbortError' });
		expect(transport.requests).toHaveLength(0);
		const wrong = await providerError(provider.listCalendars({ ...session, providerId: 'microsoft' }));
		expect(wrong.category).toBe('authorization');
	});
});
