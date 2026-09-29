import { redactSecrets } from './redaction';

/** Provider/account IDs are intentionally opaque to this layer. */
export type CredentialProviderId = string;

export interface RefreshCredential {
	readonly refreshToken: string;
	readonly [key: string]: unknown;
}

export type CredentialPersistence = 'secure' | 'session-only';

/**
 * Structural subset of Obsidian's SecretStorage.  The installed typings in
 * this checkout predate SecretStorage, so importing the host type would make
 * the plugin fail to compile.  Runtime feature detection remains explicit.
 */
export interface SecretStorageLike {
	getSecret?: (id: string) => string | null | undefined | Promise<string | null | undefined>;
	setSecret?: (id: string, secret: string) => void | Promise<void>;
	deleteSecret?: (id: string) => void | Promise<void>;
	removeSecret?: (id: string) => void | Promise<void>;
	clearSecret?: (id: string) => void | Promise<void>;
}

export interface SecretStorageAppLike {
	readonly secretStorage?: SecretStorageLike;
}

interface RequiredSecretStorageLike extends SecretStorageLike {
	getSecret: NonNullable<SecretStorageLike['getSecret']>;
	setSecret: NonNullable<SecretStorageLike['setSecret']>;
}

export interface CredentialStore {
	readonly persistence: CredentialPersistence;
	get(provider: CredentialProviderId, accountId: string): Promise<RefreshCredential | null>;
	set(provider: CredentialProviderId, accountId: string, credential: RefreshCredential | string): Promise<void>;
	remove(provider: CredentialProviderId, accountId: string): Promise<void>;
}

/** Named secret storage for OAuth client credentials and similar values. */
export interface SecretValueStore {
	readonly persistence: CredentialPersistence;
	get(key: string): Promise<string | null>;
	set(key: string, value: string): Promise<void>;
	remove(key: string): Promise<void>;
}

/** Safe-to-display error for a host SecretStorage operation that did not persist. */
export class CredentialStoreError extends Error {
	readonly code = 'credential-storage-failed';

	constructor(operation: 'read' | 'write' | 'remove') {
		super(`Obsidian could not ${operation} the saved Google credential. Reconnect after checking Obsidian's secret storage.`);
		this.name = 'CredentialStoreError';
	}
}

function isSecretStorageLike(value: unknown): value is SecretStorageLike {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as SecretStorageLike;
	return typeof candidate.getSecret === 'function' && typeof candidate.setSecret === 'function';
}

function getSecretStorage(source: unknown): SecretStorageLike | undefined {
	if (isSecretStorageLike(source)) return source;
	if (!source || typeof source !== 'object') return undefined;
	const candidate = source as SecretStorageAppLike;
	return isSecretStorageLike(candidate.secretStorage) ? candidate.secretStorage : undefined;
}

/** Feature-detect the host API without assuming a global or current typings. */
export function hasSecretStorage(source: unknown): source is SecretStorageAppLike | SecretStorageLike {
	return getSecretStorage(source) !== undefined;
}

function hashAccountId(value: string): string {
	// A deterministic non-cryptographic hash keeps email/tenant identifiers out
	// of the host's secret-name listing while remaining available on old JS.
	let first = 0x811c9dc5;
	let second = 0x9e3779b1;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		first = Math.imul(first ^ code, 0x01000193) >>> 0;
		second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
	}
	return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

/** SecretStorage IDs accept lowercase alphanumeric characters and dashes. */
export function credentialSecretId(provider: CredentialProviderId, accountId: string): string {
	const normalizedProvider = provider.toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'provider';
	return `continuous-calendar-${normalizedProvider}-${hashAccountId(accountId)}`;
}

function normalizeCredential(credential: RefreshCredential | string): RefreshCredential {
	const refreshToken = typeof credential === 'string'
		? credential
		: credential && typeof credential.refreshToken === 'string'
			? credential.refreshToken
			: '';
	if (!refreshToken) throw new TypeError('A non-empty refresh credential is required');
	// Copy only the refresh credential.  Access tokens and provider payloads are
	// deliberately ignored even in the session-only implementation.
	return { refreshToken };
}

function normalizeStoredSecret(value: unknown): RefreshCredential | null {
	return typeof value === 'string' && value.length > 0 ? { refreshToken: value } : null;
}

/** In-memory store used only when the host does not expose SecretStorage. */
export class SessionCredentialStore implements CredentialStore {
	readonly persistence: CredentialPersistence = 'session-only';

	private readonly credentials = new Map<string, RefreshCredential>();

	async get(provider: CredentialProviderId, accountId: string): Promise<RefreshCredential | null> {
		const credential = this.credentials.get(credentialSecretId(provider, accountId));
		return credential === undefined ? null : { ...credential };
	}

	async set(
		provider: CredentialProviderId,
		accountId: string,
		credential: RefreshCredential | string,
	): Promise<void> {
		const normalized = normalizeCredential(credential);
		this.credentials.set(credentialSecretId(provider, accountId), normalized);
	}

	async remove(provider: CredentialProviderId, accountId: string): Promise<void> {
		this.credentials.delete(credentialSecretId(provider, accountId));
	}

	/** Test/lifecycle helper; access tokens are intentionally not represented. */
	clear(): void {
		this.credentials.clear();
	}
}

/** Persistent implementation backed by the feature-detected host store. */
export class SecretStorageCredentialStore implements CredentialStore {
	private readonly secretStorage: RequiredSecretStorageLike;
	readonly persistence: CredentialPersistence = 'secure';

	constructor(source: SecretStorageLike | SecretStorageAppLike) {
		const storage = getSecretStorage(source);
		if (!storage) throw new TypeError('Obsidian SecretStorage is unavailable');
		this.secretStorage = storage as RequiredSecretStorageLike;
	}

	async get(provider: CredentialProviderId, accountId: string): Promise<RefreshCredential | null> {
		try {
			const value = await this.secretStorage.getSecret(credentialSecretId(provider, accountId));
			return normalizeStoredSecret(value);
		} catch (_error) {
			throw new CredentialStoreError('read');
		}
	}

	async set(
		provider: CredentialProviderId,
		accountId: string,
		credential: RefreshCredential | string,
	): Promise<void> {
		const normalized = normalizeCredential(credential);
		const id = credentialSecretId(provider, accountId);
		try {
			await this.secretStorage.setSecret(id, normalized.refreshToken);
			// SecretStorage is synchronous in Obsidian's public API. Read back the
			// value so a host implementation that silently fails cannot report a
			// successful connection that will disappear on restart.
			const saved = await this.secretStorage.getSecret(id);
			if (saved !== normalized.refreshToken) throw new CredentialStoreError('write');
		} catch (_error) {
			if (_error instanceof CredentialStoreError) throw _error;
			throw new CredentialStoreError('write');
		}
	}

	async remove(provider: CredentialProviderId, accountId: string): Promise<void> {
		const id = credentialSecretId(provider, accountId);
		try {
			if (typeof this.secretStorage.deleteSecret === 'function') {
				await this.secretStorage.deleteSecret(id);
			} else if (typeof this.secretStorage.removeSecret === 'function') {
				await this.secretStorage.removeSecret(id);
			} else if (typeof this.secretStorage.clearSecret === 'function') {
				await this.secretStorage.clearSecret(id);
			} else {
				// Older SecretStorage implementations expose only get/set. Overwrite
				// with an empty value; no plaintext credential remains retrievable.
				await this.secretStorage.setSecret(id, '');
			}
			const remaining = await this.secretStorage.getSecret(id);
			if (typeof remaining === 'string' && remaining.length > 0) throw new CredentialStoreError('remove');
		} catch (_error) {
			if (_error instanceof CredentialStoreError) throw _error;
			throw new CredentialStoreError('remove');
		}
	}
}

/** Session-only fallback for named secrets when the host has no SecretStorage. */
export class SessionSecretValueStore implements SecretValueStore {
	readonly persistence: CredentialPersistence = 'session-only';
	private readonly values = new Map<string, string>();

	async get(key: string): Promise<string | null> {
		return this.values.get(credentialSecretId('secret-value', key)) ?? null;
	}

	async set(key: string, value: string): Promise<void> {
		if (!value) throw new TypeError('A non-empty secret value is required');
		this.values.set(credentialSecretId('secret-value', key), value);
	}

	async remove(key: string): Promise<void> {
		this.values.delete(credentialSecretId('secret-value', key));
	}
}

/** Persistent named-secret implementation backed by Obsidian SecretStorage. */
export class SecretStorageValueStore implements SecretValueStore {
	readonly persistence: CredentialPersistence = 'secure';
	private readonly secretStorage: RequiredSecretStorageLike;

	constructor(source: SecretStorageLike | SecretStorageAppLike) {
		const storage = getSecretStorage(source);
		if (!storage) throw new TypeError('Obsidian SecretStorage is unavailable');
		this.secretStorage = storage as RequiredSecretStorageLike;
	}

	async get(key: string): Promise<string | null> {
		try {
			const value = await this.secretStorage.getSecret(credentialSecretId('secret-value', key));
			return typeof value === 'string' && value.length > 0 ? value : null;
		} catch (_error) {
			throw new CredentialStoreError('read');
		}
	}

	async set(key: string, value: string): Promise<void> {
		if (!value) throw new TypeError('A non-empty secret value is required');
		const id = credentialSecretId('secret-value', key);
		try {
			await this.secretStorage.setSecret(id, value);
			if (await this.secretStorage.getSecret(id) !== value) throw new CredentialStoreError('write');
		} catch (_error) {
			if (_error instanceof CredentialStoreError) throw _error;
			throw new CredentialStoreError('write');
		}
	}

	async remove(key: string): Promise<void> {
		const id = credentialSecretId('secret-value', key);
		try {
			if (typeof this.secretStorage.deleteSecret === 'function') {
				await this.secretStorage.deleteSecret(id);
			} else if (typeof this.secretStorage.removeSecret === 'function') {
				await this.secretStorage.removeSecret(id);
			} else if (typeof this.secretStorage.clearSecret === 'function') {
				await this.secretStorage.clearSecret(id);
			} else {
				await this.secretStorage.setSecret(id, '');
			}
			const remaining = await this.secretStorage.getSecret(id);
			if (typeof remaining === 'string' && remaining.length > 0) throw new CredentialStoreError('remove');
		} catch (_error) {
			if (_error instanceof CredentialStoreError) throw _error;
			throw new CredentialStoreError('remove');
		}
	}
}

/**
 * Select secure persistence when the host exposes a compatible API; otherwise
 * retain credentials only for the current process. SecretStorage failures are
 * surfaced instead of silently falling back to memory. There is intentionally
 * no ordinary Plugin.saveData fallback.
 */
export function createCredentialStore(source?: unknown): CredentialStore {
	const storage = getSecretStorage(source);
	return storage ? new SecretStorageCredentialStore(storage) : new SessionCredentialStore();
}

/** Use SecretStorage when available; never put named secrets in plugin data. */
export function createSecretValueStore(source?: unknown): SecretValueStore {
	const storage = getSecretStorage(source);
	return storage ? new SecretStorageValueStore(storage) : new SessionSecretValueStore();
}

/** Compatibility alias describing the feature-detected choice explicitly. */
export const FeatureDetectedCredentialStore = createCredentialStore;
export const ObsidianCredentialStore = SecretStorageCredentialStore;

/**
 * Runtime assertion used by persistence tests: this data can never contain
 * access/refresh token fields because only the secure store receives them.
 */
export function sanitizeCredentialMetadata(value: unknown): unknown {
	return redactSecrets(value);
}
