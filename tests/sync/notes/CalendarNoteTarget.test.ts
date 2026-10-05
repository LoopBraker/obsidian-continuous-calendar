import { describe, expect, it } from 'vitest';

import {
	calendarNoteTargetClaim,
	decodeCalendarNoteTarget,
	eventDateForDayOffset,
	encodeCalendarNoteTarget,
	targetKey,
	type CalendarNoteTarget,
} from '../../../src/services/sync/notes/CalendarNoteTarget';
import {
	applyCalendarEventFrontmatter,
	decodeCalendarEventNote,
	encodeCalendarEventNote,
} from '../../../src/services/sync/notes/FrontmatterEventCodec';

const recurringDayTarget: CalendarNoteTarget = {
	version: 1,
	providerId: 'google',
	accountId: 'account-1',
	calendarId: 'primary',
	scope: 'occurrence-day',
	occurrence: {
		kind: 'recurrence',
		masterEventId: 'series-1',
		originalStartTime: { dateTime: '2026-03-08T01:30:00-05:00', timeZone: 'America/New_York' },
	},
	dayOffset: 1,
	confirmedDate: '2026-03-09',
	dayStatus: 'confirmed',
};

const event = {
	uid: 'event-note-1',
	title: 'Overnight maintenance',
	start: '2026-03-08T01:30:00-05:00',
	end: '2026-03-09T01:00:00-04:00',
	allDay: false,
	timezone: 'America/New_York',
	location: '',
	description: '',
};

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
	return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

describe('CalendarNoteTarget', () => {
	it('builds stable keys from provider identity, scope, and immutable target fields', () => {
		const suggested = {
			...recurringDayTarget,
			confirmedDate: '2026-03-10',
			proposedDate: '2026-03-11',
			dayStatus: 'unresolved' as const,
		};
		expect(targetKey(suggested)).toBe(targetKey(recurringDayTarget));
		expect(targetKey({ ...recurringDayTarget, dayOffset: 2 })).not.toBe(targetKey(recurringDayTarget));
		expect(targetKey({ ...recurringDayTarget, calendarId: 'other' })).not.toBe(targetKey(recurringDayTarget));
		expect(targetKey({
			...recurringDayTarget,
			occurrence: { kind: 'recurrence', masterEventId: 'series-1', originalStartTime: { date: '2026-03-08' } },
		})).not.toBe(targetKey(recurringDayTarget));
	});

	it('round-trips versioned frontmatter and derives the same target key', () => {
		const decoded = decodeCalendarNoteTarget(encodeCalendarNoteTarget(recurringDayTarget));
		expect(decoded).toEqual({ ok: true, target: recurringDayTarget, key: targetKey(recurringDayTarget) });
	});

	it('rejects malformed slot dates, timezone, dateTime offsets, and scope ambiguity', () => {
		const wire = encodeCalendarNoteTarget(recurringDayTarget);
		const invalidDate = cloneRecord(wire);
		const invalidDateOccurrence = invalidDate.occurrence as Record<string, unknown>;
		const invalidDateSlot = invalidDateOccurrence.original_start_time as Record<string, unknown>;
		invalidDateSlot.date_time = '2026-02-30T01:30:00-05:00';
		expect(decodeCalendarNoteTarget(invalidDate).ok).toBe(false);

		const noOffset = cloneRecord(wire);
		const noOffsetOccurrence = noOffset.occurrence as Record<string, unknown>;
		const noOffsetSlot = noOffsetOccurrence.original_start_time as Record<string, unknown>;
		noOffsetSlot.date_time = '2026-03-08T01:30:00';
		expect(decodeCalendarNoteTarget(noOffset).ok).toBe(false);

		const badTimezone = cloneRecord(wire);
		const badTimezoneOccurrence = badTimezone.occurrence as Record<string, unknown>;
		const badTimezoneSlot = badTimezoneOccurrence.original_start_time as Record<string, unknown>;
		badTimezoneSlot.time_zone = 'Mars/Olympus';
		expect(decodeCalendarNoteTarget(badTimezone).ok).toBe(false);

		const ambiguous = { ...wire, series_id: 'also-series' };
		expect(decodeCalendarNoteTarget(ambiguous).ok).toBe(false);
	});

	it('retains an identity claim when only mutable day metadata is invalid', () => {
		const invalid = { ...encodeCalendarNoteTarget(recurringDayTarget), proposed_date: 'not-a-date' };
		const decoded = decodeCalendarNoteTarget(invalid);
		const claim = calendarNoteTargetClaim(invalid);
		expect(decoded.ok).toBe(false);
		expect(claim.key).toBe(targetKey(recurringDayTarget));
	});

	it('round-trips target metadata while preserving unrelated frontmatter and body bytes', () => {
		const body = '\r\n# Local notes\r\n\r\nKeep these bytes.\r\n';
		const content = encodeCalendarEventNote(event, {
			body,
			target: recurringDayTarget,
			unknownFrontmatter: { project: 'migration', custom: { kept: true } },
		});
		const decoded = decodeCalendarEventNote(content);
		expect(decoded.note?.target).toEqual(recurringDayTarget);
		expect(decoded.note?.frontmatter.project).toBe('migration');
		expect(decoded.note?.frontmatter.custom).toEqual({ kept: true });
		expect(decoded.note?.body).toBe(body);

		const fm = { ...decoded.note?.frontmatter };
		applyCalendarEventFrontmatter(fm, { ...event, title: 'Remote title' });
		expect(decodeCalendarNoteTarget(fm.calendar_note_target)).toMatchObject({ ok: true, target: recurringDayTarget });
	});

	it('writes timed date frontmatter in the event timezone', () => {
		const utc = {
			...event,
			uid: 'timezone-event',
			start: '2026-01-01T02:00:00Z',
			end: '2026-01-01T03:00:00Z',
		timezone: 'America/Los_Angeles',
		};
		const decoded = decodeCalendarEventNote(encodeCalendarEventNote(utc));
		expect(decoded.note?.frontmatter.date).toBe('2025-12-31');
		expect(decoded.note?.frontmatter.calendar_start).toBe(utc.start);
	});

	it('computes occurrence day offsets by event-local civil dates across DST and exclusive all-day ends', () => {
		expect(eventDateForDayOffset(event, 0)).toBe('2026-03-08');
		expect(eventDateForDayOffset(event, 1)).toBe('2026-03-09');
		expect(eventDateForDayOffset(event, 2)).toBeUndefined();
		const allDay = {
			uid: 'all-day',
			title: 'Two days',
			start: '2026-03-07',
			end: '2026-03-09',
			allDay: true,
			timezone: 'America/New_York',
			location: '',
			description: '',
		};
		expect(eventDateForDayOffset(allDay, 0)).toBe('2026-03-07');
		expect(eventDateForDayOffset(allDay, 1)).toBe('2026-03-08');
		expect(eventDateForDayOffset(allDay, 2)).toBeUndefined();
	});
});
