import { describe, expect, it } from 'vitest';

import {
	createDefaultSyncState,
	disconnectSyncState,
	makeSyncStateKey,
	normalizeSyncState,
	SyncStateStore,
} from '../../../src/services/sync/state/SyncStateStore';
import { PluginDataStore } from '../../../src/services/sync/state/PluginDataStore';
import type { PluginDataMutationEnvelope } from '../../../src/services/sync/state/PluginDataStore';
import { DEFAULT_SETTINGS } from '../../../src/settings/settings';

describe('SyncStateStore state helpers', () => {
	it('disconnects bindings and removes only the selected remote event cache', () => {
		const state = createDefaultSyncState();
		state.mappings.local = {
			localUid: 'local',
			providerId: 'google',
			accountId: 'account@example.test',
			calendarId: 'primary',
			remoteEventId: 'remote',
		};
		state.mappings.other = {
			localUid: 'other',
			providerId: 'microsoft',
			accountId: 'other-account',
			calendarId: 'calendar',
			remoteEventId: 'remote-other',
		};
		state.cursors[makeSyncStateKey('google', 'account@example.test', 'primary')] = 'opaque';
		state.eventCacheInitialized[makeSyncStateKey('google', 'account@example.test', 'primary')] = true;
		state.remoteEvents[makeSyncStateKey('google', 'account@example.test', 'primary', 'remote')] = {
			providerId: 'google',
			accountId: 'account@example.test',
			calendarId: 'primary',
			remoteEventId: 'remote',
			event: { uid: 'uid', title: 'event', start: '2026-09-22', end: '2026-09-23', allDay: true, timezone: 'UTC', location: '', description: '' },
			recurrence: 'none',
			status: 'synced',
		};
		state.snapshots.local = { hash: 'snapshot' };
		state.lastError = { message: 'recoverable' };

		const result = disconnectSyncState(state, {
			providerId: 'google',
			accountId: 'account@example.test',
			calendarId: 'primary',
		});

		expect(result.state.mappings.local).toBeUndefined();
		expect(result.state.mappings.other).toBeDefined();
		expect(result.state.cursors).toEqual({});
		expect(result.state.eventCacheInitialized).toEqual({});
		expect(result.state.remoteEvents).toEqual({});
		expect(result.state.snapshots).toEqual({});
		expect(result.state.lastError).toBeNull();
		expect(result.preservedNotes).toBe(true);
		expect(result.preservedRemoteEvents).toBe(true);
	});

	it('migrates older sync state by adding independent event cache collections', () => {
		const state = normalizeSyncState({ schemaVersion: 1, mappings: {}, cursors: { old: 'cursor' } });
		expect(state.schemaVersion).toBe(2);
		expect(state.cursors.old).toBe('cursor');
		expect(state.remoteEvents).toEqual({});
		expect(state.eventCacheInitialized).toEqual({});
	});

	it('notifies cloned state snapshots after load, save, and disconnect', async () => {
		let persisted = createDefaultSyncState();
		const dataStore = {
			async load() { return { syncState: persisted }; },
			async saveSyncState(state: typeof persisted) { persisted = state; },
			async update(updater: (envelope: PluginDataMutationEnvelope) => PluginDataMutationEnvelope | void) {
				const envelope = { schemaVersion: 1, syncState: persisted, settings: DEFAULT_SETTINGS };
				const updated = updater(envelope);
				persisted = updated?.syncState ?? envelope.syncState;
			},
		};
		const store = new SyncStateStore(dataStore);
		const notifications: number[] = [];
		store.subscribe(state => {
			notifications.push(Object.keys(state.remoteEvents).length);
			(state.remoteEvents as Record<string, unknown>).observerMutation = true;
		});
		await store.load();
		const state = store.getState();
		state.remoteEvents[makeSyncStateKey('google', 'account', 'primary', 'one')] = {
			providerId: 'google', accountId: 'account', calendarId: 'primary', remoteEventId: 'one',
			event: { uid: 'one', title: 'one', start: '2026-09-22', end: '2026-09-23', allDay: true, timezone: 'UTC', location: '', description: '' },
			recurrence: 'none', status: 'synced',
		};
		await store.save(state);
		await store.disconnect({ providerId: 'google', accountId: 'account', calendarId: 'primary' });
		expect(notifications).toEqual([0, 1, 0]);
		expect(store.getState().remoteEvents).toEqual({});
	});

	it('rejects malformed collections rather than partially migrating them', () => {
		expect(() => normalizeSyncState({ mappings: [] })).toThrow();
	});

	it('disconnects through the plugin store and disables the persisted mode', async () => {
		let persisted: unknown;
		const dataStore = new PluginDataStore({
			async loadData() {
				return {
					settings: { sync: { syncMode: 'bidirectional', providerId: 'google', accountId: 'account-1', calendarId: 'primary' } },
					schemaVersion: 1,
					syncState: {
						mappings: {
							local: {
								localUid: 'local',
								providerId: 'google',
								accountId: 'account-1',
								calendarId: 'primary',
							},
						},
					},
				};
			},
			async saveData(value: unknown) {
				persisted = value;
			},
		});
		const stateStore = new SyncStateStore(dataStore);
		await stateStore.load();
		await stateStore.disconnect({ providerId: 'google', accountId: 'account-1', calendarId: 'primary' });

		expect((persisted as { settings: { sync: { syncMode: string; providerId: string | null } } }).settings.sync).toEqual({
			eventFolder: 'Calendar Events',
			timezone: 'UTC',
			pollIntervalMinutes: 5,
			horizon: { pastDays: 365, futureDays: 730 },
			providerId: null,
			accountId: null,
			calendarId: null,
			syncMode: 'disabled',
			googleClientId: null,
			googleClientSecret: null,
		});
	});
});
