import { describe, expect, it } from 'vitest';
import { calendarEventIntersectsDate, formatCalendarEventTime, sanitizeSyncUiError, syncStatusLabel, zonedDraftTimestamp } from '../../../src/components/SyncUi';

describe('sync UI helpers', () => {
	it('labels every persisted status consistently', () => {
		expect(syncStatusLabel('synced')).toBe('Synced');
		expect(syncStatusLabel('remote_deleted')).toBe('Remote deleted');
		expect(syncStatusLabel('conflict')).toBe('Conflict');
		expect(syncStatusLabel(undefined)).toBeUndefined();
	});

	it('redacts secret-shaped error text before rendering', () => {
		expect(sanitizeSyncUiError('Bearer abc.def access_token=secret-value')).toContain('Bearer [REDACTED]');
		expect(sanitizeSyncUiError('Bearer abc.def access_token=secret-value')).not.toContain('secret-value');
		expect(sanitizeSyncUiError('eyJheader.payload.signature')).not.toContain('eyJheader');
	});

	it('projects all-day and timed cross-midnight events by their event timezone', () => {
		expect(calendarEventIntersectsDate({
			uid: 'all-day', title: 'All day', start: '2026-09-20', end: '2026-09-22', allDay: true,
			timezone: 'America/Bogota', location: '', description: '',
		}, '2026-09-21')).toBe(true);
		expect(calendarEventIntersectsDate({
			uid: 'timed', title: 'Timed', start: '2026-09-20T23:30:00-05:00', end: '2026-09-21T01:30:00-05:00', allDay: false,
			timezone: 'America/Bogota', location: '', description: '',
		}, '2026-09-21')).toBe(true);
	});

	it('creates timed drafts with an offset matching the selected timezone', () => {
		expect(zonedDraftTimestamp('2026-09-20', 9, 'America/Bogota')).toBe('2026-09-20T09:00:00-05:00');
		expect(zonedDraftTimestamp('2026-09-20', 9, 'Asia/Tokyo')).toBe('2026-09-20T09:00:00+09:00');
	});

	it('formats timed events in their declared timezone instead of the host timezone', () => {
		const label = formatCalendarEventTime({
			start: '2026-09-20T14:00:00Z',
			end: '2026-09-20T15:00:00Z',
			allDay: false,
			timezone: 'America/Bogota',
		});
		expect(label).toContain('09:00');
		expect(label).toContain('10:00');
	});
});
