import { describe, expect, it } from 'vitest';

import {
	credentialSecretId,
	createCredentialStore,
	createSecretValueStore,
	SessionCredentialStore,
	SecretStorageValueStore,
	SecretStorageCredentialStore,
} from '../../../src/services/sync/state/CredentialStore';

describe('CredentialStore', () => {
	it('uses feature-detected SecretStorage and persists only the refresh credential there', async () => {
		const values = new Map<string, string>();
		const calls: string[] = [];
		const storage = {
			getSecret: (id: string) => values.get(id),
			setSecret: (id: string, value: string) => {
				calls.push(id);
				values.set(id, value);
			},
			deleteSecret: (id: string) => values.delete(id),
		};
		const store = createCredentialStore({ secretStorage: storage });

		expect(store).toBeInstanceOf(SecretStorageCredentialStore);
		expect(store.persistence).toBe('secure');
		await store.set('google', 'account@example.test', {
			refreshToken: 'refresh-value',
			accessToken: 'must-not-be-stored',
		});

		const id = credentialSecretId('google', 'account@example.test');
		expect(calls).toEqual([id]);
		expect(values.get(id)).toBe('refresh-value');
		expect(await store.get('google', 'account@example.test')).toEqual({ refreshToken: 'refresh-value' });
		await store.remove('google', 'account@example.test');
		expect(await store.get('google', 'account@example.test')).toBeNull();
	});

	it('falls back to session-only memory when SecretStorage is unavailable', async () => {
		const store = createCredentialStore({});
		expect(store).toBeInstanceOf(SessionCredentialStore);
		expect(store.persistence).toBe('session-only');
		await store.set('google', 'account-1', 'refresh-value');
		expect(await store.get('google', 'account-1')).toEqual({ refreshToken: 'refresh-value' });
		await store.remove('google', 'account-1');
		expect(await store.get('google', 'account-1')).toBeNull();
	});

	it('restores credentials through a newly created store after an app restart', async () => {
		const persistedValues = new Map<string, string>();
		const secretStorage = {
			getSecret: (id: string) => persistedValues.get(id) ?? null,
			setSecret: (id: string, value: string) => { persistedValues.set(id, value); },
		};
		const beforeRestart = createCredentialStore({ secretStorage });
		await beforeRestart.set('google', 'account-1', 'refresh-value');

		const afterRestart = createCredentialStore({ secretStorage });
		expect(afterRestart).toBeInstanceOf(SecretStorageCredentialStore);
		expect(await afterRestart.get('google', 'account-1')).toEqual({ refreshToken: 'refresh-value' });
	});

	it('restores named client secrets through a newly created store after an app restart', async () => {
		const persistedValues = new Map<string, string>();
		const secretStorage = {
			getSecret: (id: string) => persistedValues.get(id) ?? null,
			setSecret: (id: string, value: string) => { persistedValues.set(id, value); },
		};
		const beforeRestart = createSecretValueStore({ secretStorage });
		await beforeRestart.set('google-client-secret:desktop-client', 'client-secret-value');

		const afterRestart = createSecretValueStore({ secretStorage });
		expect(afterRestart).toBeInstanceOf(SecretStorageValueStore);
		expect(await afterRestart.get('google-client-secret:desktop-client')).toBe('client-secret-value');
	});

	it('rejects a client-secret write that SecretStorage did not retain', async () => {
		const store = createSecretValueStore({
			secretStorage: {
				getSecret: () => null,
				setSecret: () => undefined,
			},
		});

		await expect(store.set('google-client-secret:desktop-client', 'client-secret-value')).rejects.toMatchObject({
			name: 'CredentialStoreError',
			code: 'credential-storage-failed',
		});
	});

	it('does not report persistence success when SecretStorage silently drops a write', async () => {
		const store = createCredentialStore({
			secretStorage: {
				getSecret: () => null,
				setSecret: () => undefined,
			},
		});

		await expect(store.set('google', 'account-1', 'refresh-value')).rejects.toMatchObject({
			name: 'CredentialStoreError',
			code: 'credential-storage-failed',
		});
		expect(store.persistence).toBe('secure');
		expect(await store.get('google', 'account-1')).toBeNull();
	});

	it('surfaces SecretStorage read errors instead of hiding them behind an empty session store', async () => {
		const store = createCredentialStore({
			secretStorage: {
				getSecret: () => { throw new Error('host details should not leak'); },
				setSecret: () => undefined,
			},
		});

		const error = await store.get('google', 'account-1').catch(value => value);
		expect(error).toMatchObject({
			name: 'CredentialStoreError',
			code: 'credential-storage-failed',
		});
		expect(error.message).not.toContain('host details');
	});

	it('uses a legal stable secret ID without putting account text in the ID', () => {
		const id = credentialSecretId('Google Calendar', 'person@example.test');
		expect(id).toMatch(/^[a-z0-9-]+$/);
		expect(id).not.toContain('@');
		expect(id).toBe(credentialSecretId('Google Calendar', 'person@example.test'));
	});
});
