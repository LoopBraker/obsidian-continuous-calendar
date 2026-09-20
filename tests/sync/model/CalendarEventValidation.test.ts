import { describe, expect, it } from 'vitest';

import {
	isCalendarEvent,
	isValidIanaTimezone,
	normalizeCalendarEvent,
	validateCalendarEvent,
} from '../../../src/services/sync/model/CalendarEventValidation';

const timedEvent = {
	uid: 'event-1',
	title: '  Project review  ',
	start: '2026-09-22T09:00:00-05:00',
	end: '2026-09-22T10:00:00-05:00',
	allDay: false,
	timezone: 'America/Bogota',
};

describe('calendar event validation and normalization', () => {
	it('normalizes optional fields and accepts note frontmatter names', () => {
		const result = validateCalendarEvent({
			calendar_uid: timedEvent.uid,
			calendar_title: timedEvent.title,
			calendar_start: timedEvent.start,
			calendar_end: timedEvent.end,
			calendar_all_day: timedEvent.allDay,
			calendar_timezone: timedEvent.timezone,
			calendar_location: '  Room 1 ',
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toEqual({
			uid: 'event-1',
			title: '  Project review  ',
			start: timedEvent.start,
			end: timedEvent.end,
			allDay: false,
			timezone: 'America/Bogota',
			location: '  Room 1 ',
			description: '',
		});
		expect(isCalendarEvent(result.value)).toBe(true);
	});

	it('rejects surrounding UID whitespace instead of changing identity', () => {
		const result = validateCalendarEvent({ ...timedEvent, uid: ' event-1 ' });

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ field: 'uid', code: 'invalid-uid' }),
			]),
		);
		}
	});

	it('requires explicit offsets on timed values', () => {
		const result = validateCalendarEvent({
			...timedEvent,
			start: '2026-09-22T09:00:00',
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ field: 'start', code: 'missing-offset' }),
			]),
		);
	});

	it('compares timed instants using offsets across a DST transition', () => {
		const result = validateCalendarEvent({
			...timedEvent,
			timezone: 'America/New_York',
			start: '2026-03-08T01:30:00-05:00',
			end: '2026-03-08T03:30:00-04:00',
		});
		expect(result.ok).toBe(true);

		const backwards = validateCalendarEvent({
			...timedEvent,
			timezone: 'America/New_York',
			start: '2026-03-08T03:30:00-04:00',
			end: '2026-03-08T01:30:00-05:00',
		});
		expect(backwards.ok).toBe(false);
		if (!backwards.ok) {
			expect(backwards.errors).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ field: 'end', code: 'invalid-duration' }),
				]),
			);
		}
	});

	it('enforces exclusive all-day ends and real calendar dates', () => {
		const sameDay = validateCalendarEvent({
			...timedEvent,
			allDay: true,
			start: '2026-02-28',
			end: '2026-02-28',
		});
		expect(sameDay.ok).toBe(false);
		if (!sameDay.ok) {
			expect(sameDay.errors).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ code: 'all-day-end-not-exclusive' }),
				]),
			);
		}

		const invalidDate = validateCalendarEvent({
			...timedEvent,
			allDay: true,
			start: '2026-02-29',
			end: '2026-03-01',
		});
		expect(invalidDate.ok).toBe(false);
		if (!invalidDate.ok) {
			expect(invalidDate.errors).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ field: 'start', code: 'invalid-date' }),
				]),
			);
		}
	});

	it('returns structured errors for unsupported recurrence and invalid zones', () => {
		const result = validateCalendarEvent({
			...timedEvent,
			timezone: 'Not/A-Timezone',
			recurrence: ['RRULE:FREQ=DAILY'],
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toEqual(
				expect.arrayContaining([
				expect.objectContaining({ field: 'timezone', code: 'invalid-timezone' }),
				expect.objectContaining({ field: 'recurrence', code: 'unsupported-recurrence' }),
			]),
		);
		}
		expect(isValidIanaTimezone('America/Bogota')).toBe(true);
		expect(isValidIanaTimezone('Not/A-Timezone')).toBe(false);
	});

	it('throws the same structured errors from strict normalization', () => {
		expect(() => normalizeCalendarEvent({ ...timedEvent, end: timedEvent.start })).toThrow(
		/Timed end must be later than start/,
	);
	});
});
