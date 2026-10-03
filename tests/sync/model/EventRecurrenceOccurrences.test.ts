import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../../../src/services/sync/model';
import { expandCalendarEventForDate } from '../../../src/services/sync/model/EventRecurrenceOccurrences';

const allDayMaster: CalendarEvent = {
	uid: 'series-all-day',
	title: 'Workshop',
	start: '2026-09-21',
	end: '2026-09-22',
	allDay: true,
	timezone: 'America/New_York',
	location: '',
	description: '',
	recurrence: { frequency: 'weekly', interval: 1, weekdays: [1, 3], count: 3 },
};

describe('calendar recurrence occurrences', () => {
	it('expands only matching all-day dates and retains exclusive occurrence ends', () => {
		expect(expandCalendarEventForDate(allDayMaster, '2026-09-21')).toMatchObject([
			{ start: '2026-09-21', end: '2026-09-22', uid: 'series-all-day' },
		]);
		expect(expandCalendarEventForDate(allDayMaster, '2026-09-22')).toEqual([]);
		expect(expandCalendarEventForDate(allDayMaster, '2026-09-23')).toMatchObject([
			{ start: '2026-09-23', end: '2026-09-24', uid: 'series-all-day' },
		]);
		expect(expandCalendarEventForDate(allDayMaster, '2026-09-30')).toEqual([]);
	});

	it('keeps a weekly timed occurrence at its event-zone wall time across DST', () => {
		const master: CalendarEvent = {
			uid: 'series-timed',
			title: 'Weekly review',
			start: '2026-03-01T09:00:00-05:00',
			end: '2026-03-01T10:00:00-05:00',
			allDay: false,
			timezone: 'America/New_York',
			location: '',
			description: '',
			recurrence: { frequency: 'weekly', interval: 1, weekdays: [7], count: 3 },
		};
		const occurrence = expandCalendarEventForDate(master, '2026-03-08');
		expect(occurrence).toHaveLength(1);
		expect(occurrence[0]).toMatchObject({
			start: '2026-03-08T13:00:00.000Z',
			end: '2026-03-08T14:00:00.000Z',
			timezone: 'America/New_York',
			recurrence: master.recurrence,
		});
	});

	it('expands all-day daily occurrences through a DST boundary without shifting their civil dates', () => {
		const master: CalendarEvent = {
			...allDayMaster,
			start: '2026-03-07',
			end: '2026-03-08',
			recurrence: { frequency: 'daily', interval: 1, count: 4 },
		};
		expect(expandCalendarEventForDate(master, '2026-03-09')).toMatchObject([
			{ start: '2026-03-09', end: '2026-03-10' },
		]);
	});
});
