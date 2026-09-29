import { describe, expect, it } from 'vitest';

import {
	createGoogleAuthenticatedRuntime,
	createGoogleRuntimeWithStoredSecret,
	extractLegacyGoogleClientSecret,
	googleClientSecretKey,
	migrateLegacyGoogleClientSecret,
} from '../../../../src/services/sync/providers/google/GoogleRuntimeFactory';
import { GoogleOAuthProvider } from '../../../../src/services/sync/providers/google/GoogleOAuthProvider';
import { DEFAULT_SETTINGS } from '../../../../src/settings/settings';
import { createDefaultSyncState } from '../../../../src/services/sync/state/SyncStateStore';
import { createCredentialStore, createSecretValueStore, type SecretValueStore } from '../../../../src/services/sync/state/CredentialStore';
import { PluginDataStore } from '../../../../src/services/sync/state/PluginDataStore';
import { asGoogleCredentialStore } from '../../../../src/services/sync/lifecycle/SyncLifecycleCoordinator';
import { GoogleCalendarProvider } from '../../../../src/services/sync/providers/google/GoogleCalendarProvider';

describe('GoogleRuntimeFactory', () => {
	it('restores the authenticated runtime after restart while plugin data stays redacted', async () => {
		const persistedValues = new Map<string, string>();
		const secretStorage = {
			getSecret: (id: string) => persistedValues.get(id) ?? null,
			setSecret: (id: string, value: string) => { persistedValues.set(id, value); },
		};
		const beforeRestartSecrets = createSecretValueStore({ secretStorage });
		const beforeRestartCredentials = createCredentialStore({ secretStorage });
		await beforeRestartSecrets.set(googleClientSecretKey('desktop-client'), 'client-secret-value');
		await beforeRestartCredentials.set('google', 'account-1', 'persisted-refresh-token');

		let persistedPluginData: unknown;
		const initialDataStore = new PluginDataStore({
			async loadData() { return undefined; },
			async saveData(value) { persistedPluginData = value; },
		});
		await initialDataStore.saveSettings({
			...DEFAULT_SETTINGS,
			sync: {
				...DEFAULT_SETTINGS.sync,
				providerId: 'google',
				accountId: 'account-1',
				calendarId: 'primary',
				googleClientId: 'desktop-client',
				googleClientSecret: 'client-secret-value',
			},
		});
		expect(JSON.stringify(persistedPluginData)).not.toContain('client-secret-value');

		// Recreate both stores from the same host SecretStorage, as on plugin reload.
		const afterRestartSecrets = createSecretValueStore({ secretStorage });
		const afterRestartCredentials = createCredentialStore({ secretStorage });
		const restoredPluginDataStore = new PluginDataStore({
			async loadData() { return persistedPluginData; },
			async saveData(value) { persistedPluginData = value; },
		});
		const restoredSettings = (await restoredPluginDataStore.load()).settings;
		const clientId = restoredSettings.sync.googleClientId;
		const accountId = restoredSettings.sync.accountId;
		if (!clientId || !accountId) throw new Error('Saved Google account settings were not restored');
		const refreshCredentials = asGoogleCredentialStore(afterRestartCredentials);
		const requests: string[] = [];
		const runtime = await createGoogleAuthenticatedRuntime({
			clientId,
			accountId,
			secretStore: afterRestartSecrets,
			credentialStore: refreshCredentials,
			createOAuthProvider: (clientId, clientSecret, credentialStore) => new GoogleOAuthProvider({
				clientId,
				clientSecret,
				transport: {
					async request(request) {
						requests.push(request.body ?? '');
						return {
							status: 200,
							body: {
								access_token: 'access-token',
								expires_in: 3600,
								scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly',
							},
						};
					},
				},
				listenerFactory: { async listen() { throw new Error('Authorization is not expected during startup'); } },
				openExternal() {},
				credentialStore,
				clock: { now: () => Date.parse('2026-09-20T12:00:00Z') },
			}),
			createCalendarProvider: () => new GoogleCalendarProvider({
				transport: { async request() { throw new Error('Calendar transport is not expected during runtime restoration'); } },
			}),
		});

		const refreshRequest = new URLSearchParams(requests[0]);
		expect(refreshRequest.get('client_id')).toBe('desktop-client');
		expect(refreshRequest.get('client_secret')).toBe('client-secret-value');
		expect(refreshRequest.get('refresh_token')).toBe('persisted-refresh-token');
		expect(runtime).toMatchObject({ provider: { id: 'google' }, session: { accountId: 'account-1' } });
	});

	it('asks for the client secret when no persistent value exists', async () => {
		const secretStore = createSecretValueStore({
			secretStorage: {
				getSecret: () => null,
				setSecret: () => undefined,
			},
		});

		await expect(createGoogleRuntimeWithStoredSecret({
			clientId: 'desktop-client',
			secretStore,
			construct: () => ({ constructed: true }),
		})).rejects.toMatchObject({ code: 'google-client-secret-missing' });
	});

	it('extracts a legacy client secret before settings migration redacts it', () => {
		expect(extractLegacyGoogleClientSecret({
			settings: {
				sync: {
					googleClientId: 'desktop-client',
					googleClientSecret: 'legacy-secret',
				},
			},
		})).toEqual({ clientId: 'desktop-client', secret: 'legacy-secret' });
	});

	it('migrates a legacy secret into SecretStorage and omits it from saved plugin settings', async () => {
		const persistedSecrets = new Map<string, string>();
		let persistedPluginData: unknown;
		const secretStorage = {
			getSecret: (id: string) => persistedSecrets.get(id) ?? null,
			setSecret: (id: string, value: string) => { persistedSecrets.set(id, value); },
		};
		const clientSecretStore: SecretValueStore = createSecretValueStore({ secretStorage });
		const legacyData = {
			schemaVersion: 1,
			settings: {
				...DEFAULT_SETTINGS,
				sync: {
					...DEFAULT_SETTINGS.sync,
					providerId: 'google',
					googleClientId: 'desktop-client',
					googleClientSecret: 'legacy-secret',
				},
			},
			syncState: createDefaultSyncState(),
		};

		const migratedSecret = await migrateLegacyGoogleClientSecret(legacyData, clientSecretStore);
		const pluginData = new PluginDataStore({
			async loadData() { return legacyData; },
			async saveData(value) { persistedPluginData = value; },
		});
		const loaded = await pluginData.load();
		await pluginData.saveSettings(loaded.settings);

		expect(migratedSecret).toEqual({ clientId: 'desktop-client', secret: 'legacy-secret' });
		expect(JSON.stringify(persistedPluginData)).not.toContain('legacy-secret');
		const afterRestart = createSecretValueStore({ secretStorage });
		expect(await afterRestart.get(googleClientSecretKey('desktop-client'))).toBe('legacy-secret');
	});
});
