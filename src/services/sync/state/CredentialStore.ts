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

/** In-memory fallback used when SecretStorage is unavailable on the host. */
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
	private readonly sessionFallback = new SessionCredentialStore();
	private usingSessionFallback = false;

	get persistence(): CredentialPersistence {
		return this.usingSessionFallback ? 'session-only' : 'secure';
	}

	constructor(source: SecretStorageLike | SecretStorageAppLike) {
		const storage = getSecretStorage(source);
		if (!storage) throw new TypeError('Obsidian SecretStorage is unavailable');
		this.secretStorage = storage as RequiredSecretStorageLike;
	}

	async get(provider: CredentialProviderId, accountId: string): Promise<RefreshCredential | null> {
		if (this.usingSessionFallback) return this.sessionFallback.get(provider, accountId);
		try {
			const value = await this.secretStorage.getSecret(credentialSecretId(provider, accountId));
			return normalizeStoredSecret(value);
		} catch (_error) {
			this.usingSessionFallback = true;
			return this.sessionFallback.get(provider, accountId);
		}
	}

	async set(
		provider: CredentialProviderId,
		accountId: string,
		credential: RefreshCredential | string,
	): Promise<void> {
		const normalized = normalizeCredential(credential);
		if (this.usingSessionFallback) {
			await this.sessionFallback.set(provider, accountId, normalized);
			return;
		}
		try {
			await this.secretStorage.setSecret(credentialSecretId(provider, accountId), normalized.refreshToken);
		} catch (_error) {
			this.usingSessionFallback = true;
			await this.sessionFallback.set(provider, accountId, normalized);
		}
	}

	async remove(provider: CredentialProviderId, accountId: string): Promise<void> {
		if (this.usingSessionFallback) {
			await this.sessionFallback.remove(provider, accountId);
			return;
		}
		const id = credentialSecretId(provider, accountId);
		try {
			if (typeof this.secretStorage.deleteSecret === 'function') {
				await this.secretStorage.deleteSecret(id);
				return;
			}
			if (typeof this.secretStorage.removeSecret === 'function') {
				await this.secretStorage.removeSecret(id);
				return;
			}
			if (typeof this.secretStorage.clearSecret === 'function') {
				await this.secretStorage.clearSecret(id);
				return;
			}
			// Older SecretStorage implementations expose only get/set.  Overwrite
			// with an empty value; no plaintext credential remains retrievable.
			await this.secretStorage.setSecret(id, '');
		} catch (_error) {
			this.usingSessionFallback = true;
			await this.sessionFallback.remove(provider, accountId);
		}
	}
}

/**
 * Select secure persistence when the host exposes a compatible API; otherwise
 * retain credentials only for the current process.  There is intentionally no
 * ordinary Plugin.saveData fallback.
 */
export function createCredentialStore(source?: unknown): CredentialStore {
	const storage = getSecretStorage(source);
	return storage ? new SecretStorageCredentialStore(storage) : new SessionCredentialStore();
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
