import { describe, expect, it } from 'vitest';
import {
	allDayDateMode,
	allDayEndExclusive,
	allDayEndInclusive,
	defaultAllDayRangeEndExclusive,
	zonedDateTimeToRfc3339,
} from '../../../src/modals/SyncEventModal';

describe('SyncEventModal all-day date ranges', () => {
	it('identifies a one-day event from its exclusive canonical end', () => {
		expect(allDayDateMode('2026-10-03', '2026-10-04')).toBe('single');
		expect(allDayEndInclusive('2026-10-04')).toBe('2026-10-03');
	});

	it('uses an inclusive last date for ranges and derives the exclusive end', () => {
		expect(allDayDateMode('2026-10-03', '2026-10-06')).toBe('range');
		expect(allDayEndExclusive('2026-10-03', '2026-10-05')).toBe('2026-10-06');
		expect(allDayEndInclusive('2026-10-06')).toBe('2026-10-05');
	});

	it('defaults a newly added range end to the day after the start', () => {
		expect(defaultAllDayRangeEndExclusive('2026-10-03')).toBe('2026-10-05');
	});

	it('rejects invalid or reversed all-day dates', () => {
		expect(allDayEndExclusive('2026-02-30')).toBeUndefined();
		expect(allDayEndExclusive('2026-10-04', '2026-10-03')).toBeUndefined();
	});
});

describe('SyncEventModal date and time conversion', () => {
	it('serializes wall times with the event timezone offset on each side of a DST change', () => {
		expect(zonedDateTimeToRfc3339('2026-03-08', '01:30', 'America/New_York'))
			.toBe('2026-03-08T01:30:00-05:00');
		expect(zonedDateTimeToRfc3339('2026-03-08', '03:30', 'America/New_York'))
			.toBe('2026-03-08T03:30:00-04:00');
	});

	it('rejects a wall time skipped by the spring clock change', () => {
		expect(zonedDateTimeToRfc3339('2026-03-08', '02:30', 'America/New_York')).toBeUndefined();
	});

	it('keeps the existing offset for an ambiguous fall-back wall time', () => {
		expect(zonedDateTimeToRfc3339('2026-11-01', '01:30', 'America/New_York'))
			.toBe('2026-11-01T01:30:00-04:00');
		expect(zonedDateTimeToRfc3339(
			'2026-11-01',
			'01:30',
			'America/New_York',
			'2026-11-01T01:30:00-05:00',
		)).toBe('2026-11-01T01:30:00-05:00');
	});
});
