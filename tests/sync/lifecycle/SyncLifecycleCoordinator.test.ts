import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, mergeCalendarPluginSettings } from '../../../src/settings/settings';
import type { CalendarEvent } from '../../../src/services/sync/model/CalendarEvent';
import { CalendarEventIndex } from '../../../src/services/sync/notes/CalendarEventIndex';
import type { CalendarEventRepository } from '../../../src/services/sync/notes/CalendarEventRepository';
import type { CalendarProvider, ProviderSession } from '../../../src/services/sync/providers';
import {
	SyncLifecycleCoordinator,
	createRegisteredSyncClock,
	createSyncServiceFromRuntime,
} from '../../../src/services/sync/lifecycle/SyncLifecycleCoordinator';
import type { SyncStateStore } from '../../../src/services/sync/state/SyncStateStore';

const event: CalendarEvent = {
	uid: 'event-1',
	title: 'Event',
	start: '2026-09-22T09:00:00-05:00',
	end: '2026-09-22T10:00:00-05:00',
	allDay: false,
	timezone: 'America/Bogota',
	location: '',
	description: '',
};

async function settle(): Promise<void> {
	for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe('SyncLifecycleCoordinator', () => {
	it('loads the vault projection before starting provider reconciliation', async () => {
		const calls: string[] = [];
		const index = new CalendarEventIndex();
		const coordinator = new SyncLifecycleCoordinator({
			repository: { index, async reload() { calls.push('reload'); } },
			syncService: {
				async start() { calls.push('service-start'); },
				async syncNow() { calls.push('sync'); },
				async stop() { calls.push('stop'); },
			},
			onIndexChanged: received => {
				expect(received).toBe(index);
				calls.push('projection');
			},
		});
		await coordinator.start();
		expect(calls).toEqual(['reload', 'projection', 'service-start']);
	});

	it('keeps local indexing active when no authenticated runtime exists', async () => {
		let reloads = 0;
		let projections = 0;
		const coordinator = new SyncLifecycleCoordinator({
			repository: { async reload() { reloads += 1; } },
			onIndexChanged: () => { projections += 1; },
		});
		await coordinator.start();
		coordinator.handleCreate('Unmarked.md');
		coordinator.handleModify('Unmarked.md');
		await settle();
		expect(reloads).toBe(3);
		expect(projections).toBe(3);
	});

	it('records a deletion before requesting sync and ignores unmarked paths', async () => {
		const calls: string[] = [];
		const coordinator = new SyncLifecycleCoordinator({
			repository: {
				async reload() { calls.push('reload'); },
				notifyLocalDeletion(path) {
					calls.push(`delete:${path}`);
					return undefined;
				},
			},
			syncService: {
				async start() { calls.push('start'); },
				async syncNow() { calls.push('sync'); },
				async stop() {},
			},
		});
		await coordinator.start();
		coordinator.handleDelete('Unmarked.md');
		await settle();
		expect(calls).toEqual(['reload', 'start', 'delete:Unmarked.md', 'sync']);
	});

	it('moves the UID/path projection before reload so a rename is not a deletion', async () => {
		const index = new CalendarEventIndex();
		index.set({ path: 'Events/Before.md', event });
		const coordinator = new SyncLifecycleCoordinator({
			repository: { index, async reload() {} },
		});
		await coordinator.start();
		coordinator.handleRename('Events/After.md', 'Events/Before.md');
		await settle();
		expect(index.getPath('event-1')).toBe('Events/After.md');
		expect(index.getByPath('Events/Before.md')).toBeUndefined();
	});

	it('stops, disposes, and suppresses callbacks after unload', async () => {
		const calls: string[] = [];
		const coordinator = new SyncLifecycleCoordinator({
			repository: { async reload() {} },
			syncService: {
				async start() {},
				async syncNow(_trigger, signal) {
					expect(signal?.aborted).toBe(false);
					calls.push('sync');
				},
				async stop() { calls.push('stop'); },
				dispose() { calls.push('dispose'); },
			},
		});
		await coordinator.start();
		await coordinator.syncNow();
		await coordinator.stop();
		coordinator.handleModify('Events/Later.md');
		await settle();
		expect(calls).toEqual(['sync', 'stop', 'dispose']);
	});

	it('registers the engine polling interval with the host cleanup boundary', () => {
		const registered: number[] = [];
		const clock = createRegisteredSyncClock(id => registered.push(id));
		const handle = clock.setInterval(() => undefined, 300_000);
		try {
			expect(registered).toEqual([handle]);
		} finally {
			clock.clearInterval(handle);
		}
	});

	it('constructs the engine only for a complete matching authenticated selection', () => {
		const settings = mergeCalendarPluginSettings({
			...DEFAULT_SETTINGS,
			sync: {
				...DEFAULT_SETTINGS.sync,
				syncMode: 'import-only',
				providerId: 'google',
				accountId: 'account-1',
				calendarId: 'primary',
			},
		});
		const provider = { id: 'google' } as CalendarProvider;
		const session: ProviderSession = { providerId: 'google', accountId: 'account-1', accessToken: 'memory-only' };
		const repository = { onLocalDeletion: () => () => undefined } as unknown as CalendarEventRepository;
		const stateStore = {} as SyncStateStore;
		const service = createSyncServiceFromRuntime(
			{ provider, session },
			{ settings, repository, stateStore },
		);
		expect(service).toBeDefined();
		expect(service?.mode).toBe('import-only');

		const mismatched = createSyncServiceFromRuntime(
			{ provider, session: { ...session, accountId: 'other' } },
			{ settings, repository, stateStore },
		);
		expect(mismatched).toBeUndefined();
	});
});
