import { describe, expect, it } from 'vitest';

import {
	createDefaultSyncState,
	disconnectSyncState,
	makeSyncStateKey,
	normalizeSyncState,
	SyncStateStore,
} from '../../../src/services/sync/state/SyncStateStore';
import { PluginDataStore } from '../../../src/services/sync/state/PluginDataStore';

describe('SyncStateStore state helpers', () => {
	it('disconnects bindings and derived state without deleting notes or remote events', () => {
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
		expect(result.state.snapshots).toEqual({});
		expect(result.state.lastError).toBeNull();
		expect(result.preservedNotes).toBe(true);
		expect(result.preservedRemoteEvents).toBe(true);
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
