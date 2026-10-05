import { describe, expect, it } from 'vitest';

import type { CalendarEvent } from '../../../../src/services/sync/model/CalendarEvent';
import type {
	ListInstancesRequest,
	ProviderHttpRequest,
	ProviderHttpResponse,
	ProviderHttpTransport,
	ProviderSession,
	UpdateOccurrenceRequest,
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

function occurrenceResource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return remoteResource({
		id: 'instance-1',
		recurringEventId: 'series-master',
		originalStartTime: { dateTime: event.start, timeZone: event.timezone },
		...overrides,
	});
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

function listInstances(provider: GoogleCalendarProvider, request: ListInstancesRequest) {
	if (!provider.listInstances) throw new Error('Google provider does not support instances');
	return provider.listInstances(request);
}

function updateOccurrence(provider: GoogleCalendarProvider, request: UpdateOccurrenceRequest) {
	if (!provider.updateOccurrence) throw new Error('Google provider does not support occurrence updates');
	return provider.updateOccurrence(request);
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

	it('retains moved and cancelled exception identity in the incremental change page', async () => {
		const master = remoteResource({
			id: 'series-master',
			recurrence: ['RRULE:FREQ=DAILY;COUNT=5'],
		});
		const moved = occurrenceResource({
			id: 'instance-moved',
			etag: '"v3"',
			originalStartTime: { dateTime: '2026-03-08T02:30:00-05:00', timeZone: 'America/New_York' },
			start: { dateTime: '2026-03-08T03:30:00-04:00', timeZone: 'America/New_York' },
			end: { dateTime: '2026-03-08T04:30:00-04:00', timeZone: 'America/New_York' },
		});
		const cancelled = occurrenceResource({
			id: 'instance-cancelled',
			status: 'cancelled',
			etag: '"v4"',
			originalStartTime: { date: '2026-10-25', timeZone: 'Europe/Paris' },
			start: undefined,
			end: undefined,
		});
		const transport = new QueueTransport(response(200, { items: [master, moved, cancelled], nextSyncToken: 'next' }));
		const provider = new GoogleCalendarProvider({ transport });
		const page = await provider.pullChanges({ session, calendarId: 'primary', window });
		const masterChange = page.changes.find(change => change.type === 'upsert' && change.value.remoteId === 'series-master');
		const movedChange = page.changes.find(change => change.type === 'upsert' && change.value.remoteId === 'instance-moved');
		const cancelledChange = page.changes.find(change => change.type === 'occurrence-cancelled');
		expect(masterChange).toMatchObject({ type: 'upsert', value: {
			remoteId: 'series-master',
			recurrenceStatus: 'supported',
			event: { recurrence: { frequency: 'daily', count: 5 } },
		} });
		expect(page.changes.some(change => change.type === 'series-unsupported')).toBe(false);
		expect(movedChange).toMatchObject({ type: 'upsert', value: {
			remoteId: 'instance-moved',
			recurrenceMasterId: 'series-master',
			originalStartTime: { dateTime: '2026-03-08T02:30:00-05:00', timeZone: 'America/New_York' },
			actualStart: { dateTime: '2026-03-08T03:30:00-04:00', timeZone: 'America/New_York' },
			version: '"v3"',
		} });
		expect(cancelledChange).toMatchObject({ type: 'occurrence-cancelled', occurrence: {
			masterRemoteId: 'series-master',
			instanceRemoteId: 'instance-cancelled',
			originalStartTime: { date: '2026-10-25', timeZone: 'Europe/Paris' },
			version: '"v4"',
		} });
	});

	it('fetches all instance pages and pinned original slots, then deduplicates by master and slot', async () => {
		const slotA = { dateTime: '2026-09-22T09:00:00-05:00', timeZone: 'America/Bogota' };
		const slotB = { dateTime: '2026-09-23T09:00:00-05:00', timeZone: 'America/Bogota' };
		const slotC = { date: '2028-09-24', timeZone: 'America/Bogota' };
		const transport = new QueueTransport(
			response(200, { items: [occurrenceResource({ id: 'slot-a', originalStartTime: slotA })], nextPageToken: 'page 2' }),
			response(200, { items: [occurrenceResource({ id: 'slot-b', status: 'cancelled', start: undefined, end: undefined, originalStartTime: slotB })] }),
			response(200, { items: [occurrenceResource({ id: 'slot-a', originalStartTime: slotA })] }),
			response(200, { items: [occurrenceResource({ id: 'slot-c', originalStartTime: slotC, start: { date: '2028-09-24' }, end: { date: '2028-09-25' } })] }),
		);
		const provider = new GoogleCalendarProvider({ transport });
		const occurrences = await listInstances(provider, {
			session,
			calendarId: 'primary',
			masterRemoteId: 'series-master',
			window,
			pinnedOriginalStarts: [slotA, slotC],
		});

		expect(occurrences.map(occurrence => occurrence.instanceRemoteId)).toEqual(['slot-a', 'slot-b', 'slot-c']);
		expect(occurrences.find(occurrence => occurrence.instanceRemoteId === 'slot-b')).toMatchObject({ status: 'cancelled' });
		const horizonQuery = new URL(transport.requests[0].url).searchParams;
		expect(horizonQuery.get('timeMin')).toBe(window.from);
		expect(horizonQuery.get('timeMax')).toBe(window.to);
		expect(horizonQuery.get('showDeleted')).toBe('true');
		expect(new URL(transport.requests[1].url).searchParams.get('pageToken')).toBe('page 2');
		const pinnedQuery = new URL(transport.requests[2].url).searchParams;
		expect(pinnedQuery.get('originalStart')).toBe(slotA.dateTime);
		expect(pinnedQuery.has('timeMin')).toBe(false);
		expect(pinnedQuery.has('timeMax')).toBe(false);
		expect(new URL(transport.requests[3].url).searchParams.get('originalStart')).toBe(slotC.date);
	});

	it('does not return a partial occurrence generation when a later page fails', async () => {
		const transport = new QueueTransport(
			response(200, { items: [occurrenceResource()], nextPageToken: 'page 2' }),
			response(500, { error: { message: 'temporary failure' } }),
		);
		const provider = new GoogleCalendarProvider({ transport });
		const error = await providerError(listInstances(provider, {
			session,
			calendarId: 'primary',
			masterRemoteId: 'series-master',
			window,
		}));
		expect(error).toMatchObject({ category: 'transient', operation: 'list-instances' });
		expect(transport.requests).toHaveLength(2);
	});

	it('matches a sparse timed original slot only against the verified master timezone', async () => {
		const dateTime = '2026-09-22T09:00:00-05:00';
		const sparse = occurrenceResource({ id: 'slot-a', originalStartTime: { dateTime } });
		const transport = new QueueTransport(
			response(200, { items: [sparse] }),
			response(200, { items: [sparse] }),
		);
		const provider = new GoogleCalendarProvider({ transport });
		const occurrences = await listInstances(provider, {
			session, calendarId: 'primary', masterRemoteId: 'series-master', window,
			masterTimeZone: 'America/Bogota',
			pinnedOriginalStarts: [{ dateTime, timeZone: 'America/Bogota' }],
		});
		expect(occurrences).toHaveLength(1);
		expect(occurrences[0].originalStartTime).toEqual({ dateTime });

		const staleZoneTransport = new QueueTransport(
			response(200, { items: [] }),
			response(200, { items: [sparse] }),
		);
		const staleZoneProvider = new GoogleCalendarProvider({ transport: staleZoneTransport });
		expect(await listInstances(staleZoneProvider, {
			session, calendarId: 'primary', masterRemoteId: 'series-master', window,
			masterTimeZone: 'America/New_York',
			pinnedOriginalStarts: [{ dateTime, timeZone: 'America/Bogota' }],
		})).toEqual([]);
	});

	it('uses only the civil date for all-day recurrence identity', async () => {
		const occurrence = occurrenceResource({
			id: 'all-day-slot',
			originalStartTime: { date: '2026-10-25', timeZone: 'Europe/Paris' },
			start: { date: '2026-10-25' },
			end: { date: '2026-10-26' },
		});
		const transport = new QueueTransport(
			response(200, { items: [occurrence] }),
			response(200, { items: [occurrence] }),
		);
		const provider = new GoogleCalendarProvider({ transport });
		const occurrences = await listInstances(provider, {
			session,
			calendarId: 'primary',
			masterRemoteId: 'series-master',
			window,
			pinnedOriginalStarts: [{ date: '2026-10-25' }],
		});

		expect(occurrences).toHaveLength(1);
		expect(new URL(transport.requests[1].url).searchParams.get('originalStart')).toBe('2026-10-25');
	});

	it('rejects duplicate slot results with different instance IDs or cancellation status', async () => {
		const originalStartTime = { date: '2026-10-25', timeZone: 'Europe/Paris' };
		const activeSlot = occurrenceResource({
			id: 'all-day-slot',
			originalStartTime,
			start: { date: '2026-10-25' },
			end: { date: '2026-10-26' },
		});
		const conflicts = [
			occurrenceResource({
				id: 'replacement-instance-id',
				originalStartTime,
				start: { date: '2026-10-25' },
				end: { date: '2026-10-26' },
			}),
			occurrenceResource({
				id: 'all-day-slot',
				status: 'cancelled',
				originalStartTime,
				start: undefined,
				end: undefined,
			}),
		];
		for (const conflictingPinned of conflicts) {
			const provider = new GoogleCalendarProvider({
				transport: new QueueTransport(
					response(200, { items: [activeSlot] }),
					response(200, { items: [conflictingPinned] }),
				),
			});
			const error = await providerError(listInstances(provider, {
				session,
				calendarId: 'primary',
				masterRemoteId: 'series-master',
				window,
				pinnedOriginalStarts: [{ date: '2026-10-25' }],
			}));
			expect(error).toMatchObject({ category: 'permanent', code: 'occurrence-slot-conflict' });
		}
	});

	it('fetches latest active state and distinguishes cancelled exceptions and missing IDs', async () => {
		const transport = new QueueTransport(
			response(200, occurrenceResource({ id: 'active-instance' })),
			response(200, {
				id: 'cancelled-instance', status: 'cancelled', etag: '"cancel-v2"',
				recurringEventId: 'series-master',
				originalStartTime: { dateTime: event.start, timeZone: event.timezone },
			}),
			response(404),
		);
		const provider = new GoogleCalendarProvider({ transport });
		const active = await provider.fetchEvent(session, 'primary', 'active-instance');
		const cancelled = await provider.fetchEvent(session, 'primary', 'cancelled-instance');
		const missing = await provider.fetchEvent(session, 'primary', 'missing-instance');
		expect(active).toMatchObject({ status: 'active', event: {
			remoteId: 'active-instance', recurrenceMasterId: 'series-master', originalStartTime: { dateTime: event.start },
		} });
		expect(cancelled).toMatchObject({ status: 'cancelled', tombstone: {
			remoteId: 'cancelled-instance', recurrenceMasterId: 'series-master',
			originalStartTime: { dateTime: event.start, timeZone: event.timezone },
			version: '"cancel-v2"',
		} });
		expect(missing).toEqual({ status: 'not-found', providerId: 'google', calendarId: 'primary', remoteId: 'missing-instance' });
		expect(transport.requests.every(request => request.method === 'GET')).toBe(true);
	});

	it('validates occurrence identity and PATCHes only occurrence fields with If-Match', async () => {
		const originalStartTime = { dateTime: event.start, timeZone: event.timezone };
		const movedEvent: CalendarEvent = {
			...event,
			start: '2026-09-23T11:00:00-05:00',
			end: '2026-09-23T12:00:00-05:00',
		};
		const transport = new QueueTransport(
			response(200, occurrenceResource({ id: 'instance/1', etag: '"v1"' })),
			response(200, occurrenceResource({
				id: 'instance/1', etag: '"v2"',
				start: { dateTime: movedEvent.start, timeZone: movedEvent.timezone },
				end: { dateTime: movedEvent.end, timeZone: movedEvent.timezone },
			})),
		);
		const provider = new GoogleCalendarProvider({ transport });
		const updated = await updateOccurrence(provider, {
			session,
			calendarId: 'primary',
			masterRemoteId: 'series-master',
			instanceRemoteId: 'instance/1',
			originalStartTime,
			event: movedEvent,
			expectedVersion: '"v1"',
		});
		expect(transport.requests[0]).toMatchObject({ method: 'GET' });
		expect(transport.requests[1]).toMatchObject({
			method: 'PATCH',
			url: expect.stringContaining('/events/instance%2F1'),
			headers: { 'If-Match': '"v1"' },
		});
		const body = JSON.parse(transport.requests[1].body as string) as Record<string, unknown>;
		expect(body).toMatchObject({ summary: movedEvent.title, start: { dateTime: movedEvent.start } });
		expect(body).not.toHaveProperty('recurrence');
		expect(body).not.toHaveProperty('extendedProperties');
		expect(body).not.toHaveProperty('uid');
		expect(updated).toMatchObject({ status: 'active', version: '"v2"', originalStartTime });
	});

	it('returns a conflict when the targeted GET reports a different version or HTTP 412', async () => {
		const request = {
			session,
			calendarId: 'primary',
			masterRemoteId: 'series-master',
			instanceRemoteId: 'instance-1',
			originalStartTime: { dateTime: event.start, timeZone: event.timezone },
			event,
			expectedVersion: '"v1"',
		};
		const changedBeforePatch = new GoogleCalendarProvider({
			transport: new QueueTransport(response(200, occurrenceResource({ etag: '"v2"' }))),
		});
		const stale = await providerError(updateOccurrence(changedBeforePatch, request));
		expect(stale).toMatchObject({ category: 'conflict', status: 412, code: 'version-mismatch' });

		const racedPatch = new GoogleCalendarProvider({
			transport: new QueueTransport(response(200, occurrenceResource({ etag: '"v1"' })), response(412)),
		});
		const conflict = await providerError(updateOccurrence(racedPatch, request));
		expect(conflict).toMatchObject({ category: 'conflict', status: 412, code: 'http-412' });
	});

	it('checks the current master timezone before editing a sparse timed slot', async () => {
		const sparse = occurrenceResource({ originalStartTime: { dateTime: event.start } });
		const request = {
			session, calendarId: 'primary', masterRemoteId: 'series-master',
			masterTimeZone: 'America/Bogota', instanceRemoteId: 'instance-1',
			originalStartTime: { dateTime: event.start, timeZone: 'America/Bogota' },
			event, expectedVersion: '"v1"',
		};
		const transport = new QueueTransport(
			response(200, sparse),
			response(200, remoteResource({ id: 'series-master', recurrence: ['RRULE:FREQ=DAILY'] })),
			response(200, sparse),
		);
		const provider = new GoogleCalendarProvider({ transport });
		const updated = await updateOccurrence(provider, request);
		expect(updated.originalStartTime).toEqual({ dateTime: event.start });
		expect(transport.requests.map(value => value.method)).toEqual(['GET', 'GET', 'PATCH']);

		const changedMaster = new GoogleCalendarProvider({ transport: new QueueTransport(
			response(200, sparse),
			response(200, remoteResource({ id: 'series-master', recurrence: ['RRULE:FREQ=DAILY'],
				start: { dateTime: event.start, timeZone: 'America/New_York' },
				end: { dateTime: event.end, timeZone: 'America/New_York' } })),
		) });
		expect(await providerError(updateOccurrence(changedMaster, request))).toMatchObject({
			category: 'conflict', code: 'master-timezone-mismatch', status: 412,
		});
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
		expect(body.recurrence).toEqual([]);
		expect(body).not.toHaveProperty('attendees');
		expect(body).not.toHaveProperty('reminders');
		expect(updated).toMatchObject({ remoteId: 'remote-1', version: '"v2"', calendarUid: 'local-1' });
	});

	it('PATCHes a changed series date with its recurrence rule intact', async () => {
		const series: CalendarEvent = {
			...event,
			start: '2026-09-23T09:00:00-05:00',
			end: '2026-09-23T10:00:00-05:00',
			recurrence: { frequency: 'daily', interval: 1, count: 3 },
		};
		const transport = new QueueTransport(response(200, remoteResource({
			start: { dateTime: series.start, timeZone: series.timezone },
			end: { dateTime: series.end, timeZone: series.timezone },
			recurrence: ['RRULE:FREQ=DAILY;COUNT=3'],
			etag: '"v2"',
		})));
		const provider = new GoogleCalendarProvider({ transport });
		const updated = await provider.updateEvent(session, 'primary', 'remote-1', series, '"v1"');
		const body = JSON.parse(transport.requests[0].body as string) as Record<string, unknown>;
		expect(body.start).toEqual({ dateTime: series.start, timeZone: series.timezone });
		expect(body.end).toEqual({ dateTime: series.end, timeZone: series.timezone });
		expect(body.recurrence).toEqual(['RRULE:FREQ=DAILY;COUNT=3']);
		expect(updated.event.recurrence).toMatchObject({ frequency: 'daily', count: 3 });
	});

	it('includes the recurrence timezone on an all-day recurring POST', async () => {
		const series: CalendarEvent = {
			...event,
			start: '2026-09-22',
			end: '2026-09-23',
			allDay: true,
			recurrence: { frequency: 'daily', interval: 1, count: 2 },
		};
		const responseResource = remoteResource({
			start: { date: series.start, timeZone: series.timezone },
			end: { date: series.end, timeZone: series.timezone },
			recurrence: ['RRULE:FREQ=DAILY;COUNT=2'],
		});
		const transport = new QueueTransport(response(200, responseResource));
		const provider = new GoogleCalendarProvider({ transport });
		await provider.createEvent(session, 'primary', series);
		const body = JSON.parse(transport.requests[0].body as string) as {
			start: Record<string, unknown>;
			end: Record<string, unknown>;
			recurrence: readonly string[];
		};
		expect(body.start).toEqual({ date: series.start, timeZone: series.timezone });
		expect(body.end).toEqual({ date: series.end, timeZone: series.timezone });
		expect(body.recurrence).toEqual(['RRULE:FREQ=DAILY;COUNT=2']);
	});

	it('accepts a stable base32hex create ID so an uncertain POST can be verified with events.get', async () => {
		const stableId = '0123456789abcdefghijkl';
		const transport = new QueueTransport(
			response(200, remoteResource({ id: stableId })),
			response(200, remoteResource({ id: stableId })),
		);
		const provider = new GoogleCalendarProvider({ transport });
		const created = await provider.createEvent(session, 'primary', event, undefined, stableId);
		const body = JSON.parse(transport.requests[0].body as string) as Record<string, unknown>;
		expect(body.id).toBe(stableId);
		expect(created.remoteId).toBe(stableId);

		const verified = await provider.fetchEvent(session, 'primary', stableId);
		expect(verified.status).toBe('active');
	});

	it('rejects a caller create ID outside Google base32hex rules before sending a POST', async () => {
		const transport = new QueueTransport(response(200, remoteResource()));
		const provider = new GoogleCalendarProvider({ transport });
		const error = await providerError(provider.createEvent(session, 'primary', event, undefined, 'Bad-ID'));
		expect(error).toMatchObject({ category: 'permanent', operation: 'create-event', code: 'invalid-event-id' });
		expect(transport.requests).toHaveLength(0);
	});

	it('refuses to confirm a write if Google omits the echoed private UID', async () => {
		const resource = remoteResource();
		delete resource.extendedProperties;
		const provider = new GoogleCalendarProvider({ transport: new QueueTransport(response(200, resource)) });
		const error = await providerError(provider.createEvent(session, 'primary', event));
		expect(error).toMatchObject({ category: 'permanent', code: 'missing-calendar-uid' });
	});

	it('maps supported recurrence and sends conditional deletes', async () => {
		const pullTransport = new QueueTransport(response(200, {
			items: [remoteResource({ recurrence: ['RRULE:FREQ=DAILY'] })],
			nextSyncToken: 'next',
		}));
		const provider = new GoogleCalendarProvider({ transport: pullTransport });
		const page = await provider.pullChanges({ session, calendarId: 'primary', window });
		expect(page.changes[0]).toMatchObject({ type: 'upsert', value: {
			recurrenceStatus: 'supported', event: { recurrence: { frequency: 'daily', interval: 1 } },
		} });

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
