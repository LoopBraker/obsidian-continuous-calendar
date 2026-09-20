import { describe, expect, it } from 'vitest';

import type { CalendarEvent } from '../../../../src/services/sync/model/CalendarEvent';
import {
	calendarEventToGoogleResource,
	GOOGLE_CALENDAR_UID_KEY,
	GoogleEventMappingError,
	googleResourceToRemoteEvent,
} from '../../../../src/services/sync/providers/google/GoogleEventMapper';

const timed: CalendarEvent = {
	uid: 'local-uid',
	title: '  Project review  ',
	start: '2026-09-22T09:00:00-05:00',
	end: '2026-09-22T10:00:00-05:00',
	allDay: false,
	timezone: 'America/Bogota',
	location: '  Room 1  ',
	description: '  Keep spacing  ',
};

describe('GoogleEventMapper', () => {
	it('maps supported canonical fields without flattening timestamps or text', () => {
		expect(calendarEventToGoogleResource(timed)).toEqual({
			summary: timed.title,
			description: timed.description,
			location: timed.location,
			start: { dateTime: timed.start, timeZone: timed.timezone },
			end: { dateTime: timed.end, timeZone: timed.timezone },
			extendedProperties: { private: { [GOOGLE_CALENDAR_UID_KEY]: timed.uid } },
		});
	});

	it('maps all-day exclusive ranges using date values', () => {
		const payload = calendarEventToGoogleResource({
			...timed,
			start: '2026-09-22',
			end: '2026-09-24',
			allDay: true,
		});
		expect(payload.start).toEqual({ date: '2026-09-22' });
		expect(payload.end).toEqual({ date: '2026-09-24' });
	});

	it('distinguishes private calendar UIDs from deterministic placeholders', () => {
		const base = {
			id: 'remote/id',
			etag: '"v1"',
			updated: '2026-09-20T12:00:00Z',
			summary: '  Remote title  ',
			description: '  Remote body  ',
			location: '  Remote room  ',
			start: { dateTime: timed.start, timeZone: timed.timezone },
			end: { dateTime: timed.end, timeZone: timed.timezone },
		};
		const untagged = googleResourceToRemoteEvent(base, { calendarId: 'primary' });
		expect(untagged.event.uid).toBe('google:primary:remote/id');
		expect(untagged).not.toHaveProperty('calendarUid');
		expect(untagged.event).toMatchObject({
			title: '  Remote title  ',
			description: '  Remote body  ',
			location: '  Remote room  ',
		});

		const tagged = googleResourceToRemoteEvent({
			...base,
			extendedProperties: { private: { calendar_uid: 'stable-local' } },
		}, { calendarId: 'primary' });
		expect(tagged.event.uid).toBe('stable-local');
		expect(tagged.calendarUid).toBe('stable-local');
	});

	it('uses the selected calendar timezone when timed resources omit it', () => {
		const mapped = googleResourceToRemoteEvent({
			id: 'remote-1',
			summary: 'Event',
			start: { dateTime: timed.start },
			end: { dateTime: timed.end },
		}, { calendarId: 'team', calendarTimezone: 'America/Bogota' });
		expect(mapped.event.timezone).toBe('America/Bogota');
	});

	it('marks recurrence as unsupported without exposing provider recurrence data', () => {
		const mapped = googleResourceToRemoteEvent({
			id: 'series-1',
			summary: 'Series',
			start: { date: '2026-09-22' },
			end: { date: '2026-09-23' },
			recurrence: ['RRULE:FREQ=WEEKLY'],
		}, { calendarId: 'primary', calendarTimezone: 'UTC' });
		expect(mapped.recurrence).toBe('unsupported');
		expect(mapped.event).not.toHaveProperty('recurrence');
	});

	it('rejects incomplete, mixed, and invalid ranges', () => {
		expect(() => googleResourceToRemoteEvent({
			id: 'mixed',
			summary: 'Mixed',
			start: { date: '2026-09-22' },
			end: { dateTime: timed.end },
		}, { calendarId: 'primary' })).toThrow(GoogleEventMappingError);
		expect(() => googleResourceToRemoteEvent({
			id: 'backwards',
			summary: 'Backwards',
			start: { dateTime: timed.end, timeZone: timed.timezone },
			end: { dateTime: timed.start, timeZone: timed.timezone },
		}, { calendarId: 'primary' })).toThrow(GoogleEventMappingError);
	});
});
