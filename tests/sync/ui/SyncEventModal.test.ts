import { describe, expect, it } from 'vitest';
import { zonedDateTimeToRfc3339 } from '../../../src/modals/SyncEventModal';

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
