import { describe, expect, it } from 'vitest';

import {
	credentialSecretId,
	createCredentialStore,
	SessionCredentialStore,
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

	it('uses a legal stable secret ID without putting account text in the ID', () => {
		const id = credentialSecretId('Google Calendar', 'person@example.test');
		expect(id).toMatch(/^[a-z0-9-]+$/);
		expect(id).not.toContain('@');
		expect(id).toBe(credentialSecretId('Google Calendar', 'person@example.test'));
	});
});
