import { describe, expect, it } from 'vitest';

import {
	PluginDataStore,
	PLUGIN_DATA_SCHEMA_VERSION,
} from '../../../src/services/sync/state/PluginDataStore';
import {
	createDefaultSyncState,
	makeSyncStateKey,
} from '../../../src/services/sync/state/SyncStateStore';
import { DEFAULT_SETTINGS } from '../../../src/settings/settings';

class MemoryPersistence {
	value: unknown;
	saves: unknown[] = [];

	constructor(value?: unknown) {
		this.value = value;
	}

	async loadData(): Promise<unknown> {
		return this.value;
	}

	async saveData(value: unknown): Promise<void> {
		this.value = value;
		this.saves.push(value);
	}
}

describe('PluginDataStore', () => {
	it('migrates flat settings without losing values and writes a versioned envelope', async () => {
		const persistence = new MemoryPersistence({
			defaultDotColor: 'red',
			defaultBarColor: 'blue',
			shouldConfirmBeforeCreate: true,
			shouldConfirmBeforeCreateRange: false,
			tagAppearance: { project: { color: 'green', symbol: 'P' } },
			collapseDuplicateTagSymbols: false,
			useDotsOnlyForTags: true,
			useDotsOnlyForProperties: true,
			customDateProperties: [{ name: 'review', color: 'purple' }],
			holidayStorageFolder: 'My Holidays',
			holidaySources: [{ type: 'country', country: 'CO' }],
			taskSettings: { scheduled: { symbol: 'S' } },
			futureExtension: { retained: true },
		});
		const store = new PluginDataStore(persistence);

		const result = await store.load();

		expect(result.legacy).toBe(true);
		expect(result.migrated).toBe(true);
		expect(result.schemaVersion).toBe(PLUGIN_DATA_SCHEMA_VERSION);
		expect(result.settings.defaultDotColor).toBe('red');
		expect(result.settings.shouldConfirmBeforeCreate).toBe(true);
		expect(result.settings.taskSettings.due).toEqual(DEFAULT_SETTINGS.taskSettings.due);
		expect((result.settings as typeof result.settings & { futureExtension: unknown }).futureExtension).toEqual({ retained: true });
		expect(result.settings.sync.syncMode).toBe('disabled');
		expect(persistence.saves).toHaveLength(1);
		expect(persistence.value).toMatchObject({
			schemaVersion: PLUGIN_DATA_SCHEMA_VERSION,
			settings: { defaultDotColor: 'red' },
			syncState: createDefaultSyncState(),
		});
	});

	it('restores sync mappings and cursors after a restart', async () => {
		const persistence = new MemoryPersistence();
		const first = new PluginDataStore(persistence);
		await first.load();
		const state = createDefaultSyncState();
		state.mappings['local-1'] = {
			localUid: 'local-1',
			providerId: 'google',
			accountId: 'account-1',
			calendarId: 'primary',
			remoteEventId: 'remote-1',
		};
		const cursorKey = makeSyncStateKey('google', 'account-1', 'primary');
		state.cursors[cursorKey] = { cursor: 'opaque-cursor' };
		await first.saveSyncState(state);

		const restarted = new PluginDataStore(persistence);
		const result = await restarted.load();

		expect(result.syncState.mappings['local-1'].remoteEventId).toBe('remote-1');
		expect(result.syncState.cursors[cursorKey]).toEqual({ cursor: 'opaque-cursor' });
	});

	it('reloads data written after the first store load', async () => {
		const persistence = new MemoryPersistence();
		const longLivedStore = new PluginDataStore(persistence);
		await longLivedStore.load();

		const otherWriter = new PluginDataStore(persistence);
		const loaded = await otherWriter.load();
		const cursorKey = makeSyncStateKey('google', 'account-1', 'primary');
		const updatedState = loaded.syncState;
		updatedState.cursors[cursorKey] = { cursor: 'saved-after-initial-load' };
		await otherWriter.saveSyncState(updatedState);

		const reloaded = await longLivedStore.load();
		expect(reloaded.syncState.cursors[cursorKey]).toEqual({ cursor: 'saved-after-initial-load' });
	});

	it('fails closed on corrupt state while preserving the prior raw value', async () => {
		const raw = {
			schemaVersion: PLUGIN_DATA_SCHEMA_VERSION,
			settings: { defaultDotColor: 'retained' },
			syncState: { mappings: 'not-a-record' },
		};
		const persistence = new MemoryPersistence(raw);
		const result = await new PluginDataStore(persistence).load();

		expect(result.syncDisabled).toBe(true);
		expect(result.settings.defaultDotColor).toBe('retained');
		expect(result.rawStatePreserved).toBe(true);
		expect(result.migrationError?.message).toContain('malformed');
		expect(persistence.saves).toHaveLength(0);
		expect(persistence.value).toBe(raw);
	});

	it('redacts credential-shaped legacy fields before migration persistence', async () => {
		const persistence = new MemoryPersistence({
			defaultDotColor: 'red',
			refreshToken: 'credential-value-removed',
			accessToken: 'access-value-removed',
		});
		const result = await new PluginDataStore(persistence).load();
		const saved = persistence.saves[0] as Record<string, unknown>;
		const settings = saved.settings as Record<string, unknown>;

		expect(result.settings).not.toHaveProperty('refreshToken');
		expect(result.settings).not.toHaveProperty('accessToken');
		expect(settings).not.toHaveProperty('refreshToken');
		expect(settings).not.toHaveProperty('accessToken');
	});

	it('stores only a sanitized last error', async () => {
		const persistence = new MemoryPersistence({
			schemaVersion: PLUGIN_DATA_SCHEMA_VERSION,
			settings: {},
			syncState: {
				lastError: { message: 'request failed: Bearer credential-value' },
			},
		});
		const result = await new PluginDataStore(persistence).load();

		expect(result.syncState.lastError?.message).toBe('request failed: Bearer [REDACTED]');
		expect((persistence.value as { syncState: { lastError: { message: string } } }).syncState.lastError.message)
			.toBe('request failed: Bearer [REDACTED]');
	});

	it('preserves opaque cursors and snapshot text while removing credential fields', async () => {
		const opaqueCursor = 'eyJhbGciOiJIUzI1NiJ9.1//opaque-provider-cursor';
		const snapshotDescription = 'Discuss Bearer abc.def.ghi and ya29.provider-shaped text verbatim.';
		const persistence = new MemoryPersistence({
			schemaVersion: PLUGIN_DATA_SCHEMA_VERSION,
			settings: {
				customDescription: snapshotDescription,
				refreshToken: 'must-not-survive',
			},
			syncState: {
				mappings: {
					local: {
						localUid: 'local',
						accessToken: 'must-not-survive',
					},
				},
				cursors: {
					'google:account:calendar': opaqueCursor,
				},
				snapshots: {
					local: {
						local: {
							event: {
								description: snapshotDescription,
							},
							hash: 'hash',
						},
						codeVerifier: 'must-not-survive',
					},
				},
				lastError: {
					message: `request failed: Bearer abc.def.ghi (${opaqueCursor})`,
				},
			},
		});

		const result = await new PluginDataStore(persistence).load();
		const saved = persistence.value as {
			settings: Record<string, unknown>;
			syncState: {
				mappings: Record<string, Record<string, unknown>>;
				cursors: Record<string, unknown>;
				snapshots: Record<string, { local: { event: { description: string } }; codeVerifier?: string }>;
				lastError: { message: string };
			};
		};

		expect(result.settings).not.toHaveProperty('refreshToken');
		expect(saved.settings).not.toHaveProperty('refreshToken');
		expect(saved.syncState.mappings.local).not.toHaveProperty('accessToken');
		expect(saved.syncState.cursors['google:account:calendar']).toBe(opaqueCursor);
		expect(saved.syncState.snapshots.local.local.event.description).toBe(snapshotDescription);
		expect(saved.syncState.snapshots.local).not.toHaveProperty('codeVerifier');
		expect(saved.syncState.lastError.message).toContain('Bearer [REDACTED]');
		expect(saved.syncState.lastError.message).not.toContain(opaqueCursor);
	});
});
