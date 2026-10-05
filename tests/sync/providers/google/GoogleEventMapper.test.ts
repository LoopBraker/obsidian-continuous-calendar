import { describe, expect, it } from 'vitest';

import type { CalendarEvent } from '../../../../src/services/sync/model/CalendarEvent';
import {
	calendarEventToGoogleResource,
	GOOGLE_CALENDAR_UID_KEY,
	GoogleEventMappingError,
	googleResourceToRemoteOccurrence,
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

	it('maps supported weekly recurrence into the canonical typed model', () => {
		const mapped = googleResourceToRemoteEvent({
			id: 'series-1',
			summary: 'Series',
			start: { date: '2026-09-22' },
			end: { date: '2026-09-23' },
			recurrence: ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=8'],
		}, { calendarId: 'primary', calendarTimezone: 'UTC' });
		expect(mapped.recurrenceStatus).toBe('supported');
		expect(mapped.event.recurrence).toEqual({
			frequency: 'weekly', interval: 2, weekdays: [1, 3], count: 8,
		});
		expect(mapped.recurrenceRaw).toEqual(['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=8']);
	});

	it('preserves complex rules and exceptions as unsupported', () => {
		const complex = googleResourceToRemoteEvent({
			id: 'series-complex',
			start: { date: '2026-09-22' },
			end: { date: '2026-09-23' },
			recurrence: ['RRULE:FREQ=DAILY;COUNT=5', 'EXDATE;VALUE=DATE:20260924'],
		}, { calendarId: 'primary' });
		expect(complex.recurrenceStatus).toBe('unsupported');
		expect(complex.recurrenceRaw).toEqual(['RRULE:FREQ=DAILY;COUNT=5', 'EXDATE;VALUE=DATE:20260924']);
		expect(complex.event).not.toHaveProperty('recurrence');

		const exception = googleResourceToRemoteEvent({
			id: 'series-instance',
			recurringEventId: 'series-master',
			originalStartTime: { dateTime: timed.start, timeZone: timed.timezone },
			start: { dateTime: timed.start, timeZone: timed.timezone },
			end: { dateTime: timed.end, timeZone: timed.timezone },
		}, { calendarId: 'primary' });
		expect(exception).toMatchObject({
			recurrenceStatus: 'unsupported',
			recurrenceMasterId: 'series-master',
			originalStartTime: { dateTime: timed.start, timeZone: timed.timezone },
			actualStart: { dateTime: timed.start, timeZone: timed.timezone },
		});
	});

	it('keeps a moved timed instance attached to its exact recurrence slot across DST', () => {
		const occurrence = googleResourceToRemoteOccurrence({
			id: 'instance-after-dst-move',
			etag: '"instance-v4"',
			recurringEventId: 'new-york-master',
			originalStartTime: { dateTime: '2026-03-08T02:30:00-05:00', timeZone: 'America/New_York' },
			start: { dateTime: '2026-03-08T03:30:00-04:00', timeZone: 'America/New_York' },
			end: { dateTime: '2026-03-08T04:30:00-04:00', timeZone: 'America/New_York' },
			summary: 'Moved occurrence',
		}, { calendarId: 'primary' });

		expect(occurrence).toMatchObject({
			status: 'active',
			masterRemoteId: 'new-york-master',
			instanceRemoteId: 'instance-after-dst-move',
			originalStartTime: { dateTime: '2026-03-08T02:30:00-05:00', timeZone: 'America/New_York' },
			actualStart: { dateTime: '2026-03-08T03:30:00-04:00', timeZone: 'America/New_York' },
			version: '"instance-v4"',
			event: { event: { start: '2026-03-08T03:30:00-04:00' } },
		});
	});

	it('maps a sparse cancelled recurring exception using only its guaranteed identity fields', () => {
		const occurrence = googleResourceToRemoteOccurrence({
			id: 'cancelled-instance',
			status: 'cancelled',
			etag: '"cancel-v2"',
			recurringEventId: 'all-day-master',
			originalStartTime: { date: '2026-10-25', timeZone: 'Europe/Paris' },
		}, { calendarId: 'primary' });

		expect(occurrence).toEqual({
			status: 'cancelled',
			providerId: 'google',
			calendarId: 'primary',
			masterRemoteId: 'all-day-master',
			instanceRemoteId: 'cancelled-instance',
			originalStartTime: { date: '2026-10-25', timeZone: 'Europe/Paris' },
			version: '"cancel-v2"',
		});
	});

	it('rejects malformed recurrence-slot identity', () => {
		expect(() => googleResourceToRemoteOccurrence({
			id: 'bad-instance',
			recurringEventId: 'master',
			originalStartTime: { dateTime: 'not-a-time', timeZone: 'America/Bogota' },
			start: { dateTime: timed.start, timeZone: timed.timezone },
			end: { dateTime: timed.end, timeZone: timed.timezone },
		}, { calendarId: 'primary' })).toThrow(GoogleEventMappingError);
	});

	it('maps timed UNTIL cutoffs to the last included local civil date', () => {
		const resource = {
			id: 'timed-series',
			start: { dateTime: '2026-09-22T09:00:00-04:00', timeZone: 'America/New_York' },
			end: { dateTime: '2026-09-22T10:00:00-04:00', timeZone: 'America/New_York' },
		};
		const supported = googleResourceToRemoteEvent({
			...resource,
			recurrence: ['RRULE:FREQ=DAILY;UNTIL=20260923T035959Z'],
		}, { calendarId: 'primary' });
		expect(supported.recurrenceStatus).toBe('supported');
		expect(supported.event.recurrence?.until).toBe('2026-09-22');

		const beforeStartTime = googleResourceToRemoteEvent({
			...resource,
			recurrence: ['RRULE:FREQ=DAILY;UNTIL=20260923T120000Z'],
		}, { calendarId: 'primary' });
		expect(beforeStartTime.recurrenceStatus).toBe('supported');
		expect(beforeStartTime.event.recurrence?.until).toBe('2026-09-22');

		const googleExample = googleResourceToRemoteEvent({
			id: 'los-angeles-series',
			start: { dateTime: '2011-06-03T10:00:00-07:00', timeZone: 'America/Los_Angeles' },
			end: { dateTime: '2011-06-03T10:25:00-07:00', timeZone: 'America/Los_Angeles' },
			recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20110701T170000Z'],
		}, { calendarId: 'primary' });
		expect(googleExample.recurrenceStatus).toBe('supported');
		expect(googleExample.event.recurrence?.until).toBe('2011-07-01');
	});

	it('maps canonical recurrence rules for Google creates', () => {
		const allDay = calendarEventToGoogleResource({
			...timed,
			start: '2026-09-22', end: '2026-09-23', allDay: true,
			recurrence: { frequency: 'weekly', interval: 1, weekdays: [1, 3], until: '2026-10-22' },
		});
		expect(allDay.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261022']);
		const timedSeries = calendarEventToGoogleResource({
			...timed,
			recurrence: { frequency: 'daily', interval: 2, until: '2026-09-22' },
		});
		expect(timedSeries.recurrence).toEqual(['RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20260923T045959Z']);
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
