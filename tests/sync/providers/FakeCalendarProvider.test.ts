import { describe, expect, it } from 'vitest';
import { FakeCalendarProvider, fakeProviderSession } from '../../../src/services/sync/providers/FakeCalendarProvider';
import {
	ProviderCancelledError,
	ProviderError,
	conflictError,
	cursorExpiredError,
	throttlingError,
} from '../../../src/services/sync/providers/ProviderErrors';
import type { CalendarEvent } from '../../../src/services/sync/model/CalendarEvent';

const session = fakeProviderSession('google', 'test-account');

function event(uid: string, start = '2026-01-01T09:00:00-05:00'): CalendarEvent {
	const end = `${start.slice(0, 11)}10:00:00-05:00`;
	return {
		uid,
		title: uid,
		start,
		end,
		allDay: false,
		timezone: 'America/Bogota',
		location: '',
		description: '',
	};
}

describe('FakeCalendarProvider', () => {
	it('discovers calendars and paginates opaque change cursors', async () => {
		const provider = new FakeCalendarProvider({ accountId: 'test-account', pageSize: 1 });
		provider.addCalendar({ calendarId: 'team', name: 'Team', writable: true, timezone: 'UTC' });

		const calendars = await provider.listCalendars(session);
		expect(calendars.map(calendar => calendar.calendarId)).toEqual(['primary', 'team']);

		const first = await provider.createEvent(session, 'team', event('one'));
		const second = await provider.createEvent(session, 'team', event('two', '2026-01-02T09:00:00-05:00'));
		expect(first.remoteId).not.toBe(second.remoteId);

		const pageOne = await provider.pullChanges({
			session,
			calendarId: 'team',
			window: { from: '2026-01-01T00:00:00Z', to: '2026-01-04T00:00:00Z' },
		});
		expect(pageOne.changes).toHaveLength(1);
		expect(pageOne.hasMore).toBe(true);
		expect(pageOne.nextCursor).toEqual(expect.any(String));

		const pageTwo = await provider.pullChanges({
			session,
			calendarId: 'team',
			cursor: pageOne.nextCursor,
			window: { from: '2026-01-01T00:00:00Z', to: '2026-01-04T00:00:00Z' },
		});
		expect(pageTwo.changes).toHaveLength(1);
		expect(pageTwo.hasMore).toBe(false);
		expect(pageTwo.nextCursor).toEqual(expect.any(String));

		await provider.createEvent(session, 'team', event('three', '2026-01-03T09:00:00-05:00'));
		const incremental = await provider.pullChanges({
			session,
			calendarId: 'team',
			cursor: pageTwo.nextCursor,
			window: { from: '2026-01-01T00:00:00Z', to: '2026-01-04T00:00:00Z' },
		});
		expect(incremental.changes).toHaveLength(1);
		expect(incremental.changes[0]).toMatchObject({ type: 'upsert' });
	});

	it('distinguishes private calendar UIDs from canonical event UIDs', async () => {
		const provider = new FakeCalendarProvider({ accountId: 'test-account' });
		const untagged = provider.seedEvent('primary', event('provider-shaped-uid'));
		expect(untagged.event.uid).toBe('provider-shaped-uid');
		expect(untagged).not.toHaveProperty('calendarUid');

		const created = await provider.createEvent(session, 'primary', event('local-uid'));
		expect(created.calendarUid).toBe('local-uid');

		const updated = await provider.updateEvent(
			session,
			'primary',
			created.remoteId,
			event('different-canonical-uid'),
			created.version,
		);
		expect(updated.event.uid).toBe('different-canonical-uid');
		expect(updated.calendarUid).toBe('different-canonical-uid');
	});

	it('attaches a private UID when updating an initially untagged event', async () => {
		const provider = new FakeCalendarProvider({ accountId: 'test-account' });
		const imported = provider.seedEvent('primary', event('provider-event-uid'));
		const updated = await provider.updateEvent(
			session,
			'primary',
			imported.remoteId,
			event('imported-local-uid'),
			imported.version,
		);

		expect(updated.calendarUid).toBe('imported-local-uid');
		expect(provider.getEvent('primary', imported.remoteId)?.calendarUid).toBe('imported-local-uid');

		const page = await provider.pullChanges({
			session,
			calendarId: 'primary',
			window: { from: '2026-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' },
		});
		expect(page.changes).toHaveLength(2);
		expect(page.changes[1]).toMatchObject({
			type: 'upsert',
			value: { remoteId: imported.remoteId, calendarUid: 'imported-local-uid' },
		});
	});

	it('advances a terminal checkpoint past a filtered tail and preserves it when idle', async () => {
		const provider = new FakeCalendarProvider({ accountId: 'test-account', pageSize: 1 });
		const window = { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' };
		await provider.createEvent(session, 'primary', event('in-window'));
		await provider.createEvent(session, 'primary', event('out-of-window', '2026-01-10T09:00:00-05:00'));

		const terminal = await provider.pullChanges({ session, calendarId: 'primary', window });
		expect(terminal.changes).toHaveLength(1);
		expect(terminal.changes[0]).toMatchObject({ type: 'upsert', value: { event: { uid: 'in-window' } } });
		expect(terminal.hasMore).toBe(false);
		expect(terminal.nextCursor).toEqual(expect.any(String));

		// There are no records after the terminal checkpoint. The fake omits a
		// replacement cursor, so callers retain the supplied opaque value.
		const idle = await provider.pullChanges({
			session,
			calendarId: 'primary',
			cursor: terminal.nextCursor,
			window,
		});
		expect(idle).toEqual({ changes: [], hasMore: false });

		await provider.createEvent(session, 'primary', event('new-in-window'));
		const incremental = await provider.pullChanges({
			session,
			calendarId: 'primary',
			cursor: terminal.nextCursor,
			window,
		});
		expect(incremental.changes).toHaveLength(1);
		expect(incremental.changes[0]).toMatchObject({ type: 'upsert', value: { event: { uid: 'new-in-window' } } });

		const replay = await provider.pullChanges({
			session,
			calendarId: 'primary',
			cursor: incremental.nextCursor,
			window,
		});
		expect(replay).toEqual({ changes: [], hasMore: false });
	});

	it('expires cursors deterministically and does not expose cursor structure', async () => {
		let now = 1_000;
		const provider = new FakeCalendarProvider({
			accountId: 'test-account',
			pageSize: 1,
			cursorTtlMs: 100,
			clock: { now: () => now },
		});
		await provider.createEvent(session, 'primary', event('one'));
		await provider.createEvent(session, 'primary', event('two', '2026-01-02T09:00:00-05:00'));
		const first = await provider.pullChanges({
			session,
			calendarId: 'primary',
			window: { from: '2026-01-01T00:00:00Z', to: '2026-01-04T00:00:00Z' },
		});

		now = 1_101;
		await expect(
			provider.pullChanges({
				session,
				calendarId: 'primary',
				cursor: first.nextCursor,
				window: { from: '2026-01-01T00:00:00Z', to: '2026-01-04T00:00:00Z' },
			}),
		).rejects.toMatchObject({ category: 'cursor-expired', code: 'cursor-expired' });
	});

	it('enforces conditional versions and emits deletes', async () => {
		const provider = new FakeCalendarProvider({ accountId: 'test-account' });
		const created = await provider.createEvent(session, 'primary', event('one'));
		expect(created.version).toBe('v1');

		const updated = await provider.updateEvent(session, 'primary', created.remoteId, event('one-updated'), 'v1');
		expect(updated.version).toBe('v2');
		await expect(
			provider.updateEvent(session, 'primary', created.remoteId, event('stale'), 'v1'),
		).rejects.toMatchObject({ category: 'conflict', status: 412, code: 'version-mismatch' });

		await expect(provider.deleteEvent(session, 'primary', created.remoteId, 'v1')).rejects.toMatchObject({
			category: 'conflict',
		});
		await expect(provider.deleteEvent(session, 'primary', created.remoteId, 'v2')).resolves.toBeUndefined();
		expect(provider.getEvent('primary', created.remoteId)).toBeUndefined();

		const page = await provider.pullChanges({
			session,
			calendarId: 'primary',
			window: { from: '2026-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' },
		});
		expect(page.changes[page.changes.length - 1]).toEqual({
			type: 'delete',
			providerId: 'google',
			calendarId: 'primary',
			remoteId: created.remoteId,
		});
	});

	it('supports cancellation before provider work begins', async () => {
		const provider = new FakeCalendarProvider({ accountId: 'test-account' });
		const controller = new AbortController();
		controller.abort();
		await expect(provider.listCalendars(session, controller.signal)).rejects.toBeInstanceOf(
			ProviderCancelledError,
		);
		expect(provider.getCallCount()).toBe(0);
	});

	it('supports queued retry metadata and observable calls without secrets', async () => {
		const provider = new FakeCalendarProvider({ accountId: 'test-account' });
		expect(fakeProviderSession('google', 'test-account')).not.toHaveProperty('accessToken');
		const throttled = throttlingError('Slow down', 2_500, {
			providerId: 'google',
			status: 429,
		});
		provider.failNext('pullChanges', throttled);

		const request = {
			session,
			calendarId: 'primary',
			window: { from: '2026-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' },
		};
		await expect(provider.pullChanges(request)).rejects.toMatchObject({
			category: 'throttling',
			retryAfterMs: 2_500,
		});
		await expect(provider.pullChanges(request)).resolves.toMatchObject({ changes: [], hasMore: false });
		expect(provider.getCallCount('pullChanges')).toBe(2);
		expect(provider.getCallLog().every(call => !('accessToken' in call))).toBe(true);
	});

	it('keeps categorized errors secret-safe and exposes retryability', () => {
		const error = throttlingError('Rate limited', 500, {
			providerId: 'google',
			code: 'rate-limit',
			details: { requestId: 'req-1' },
		});
		expect(error).toBeInstanceOf(ProviderError);
		expect(error.retryable).toBe(true);
		expect(error.toJSON()).not.toHaveProperty('details');
		expect(cursorExpiredError().retryable).toBe(false);
		expect(conflictError().category).toBe('conflict');
});
});
