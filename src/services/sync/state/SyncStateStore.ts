import type { CalendarEventSnapshot } from '../model/CalendarEvent';
import type { CalendarPluginSettings, SyncProviderId } from '../../../settings/settings';
import type { PluginDataMutationEnvelope } from './PluginDataStore';
import { sanitizeSyncError, type SanitizedSyncError, redactSecrets } from './redaction';

export const SYNC_STATE_SCHEMA_VERSION = 1;

export interface SyncMapping {
	readonly localUid?: string;
	readonly notePath?: string;
	readonly providerId?: string;
	readonly accountId?: string;
	readonly calendarId?: string;
	readonly remoteEventId?: string;
	readonly remoteId?: string;
	readonly version?: string;
	readonly status?: string;
	readonly [key: string]: unknown;
}

export interface SyncCursor {
	readonly providerId?: string;
	readonly accountId?: string;
	readonly calendarId?: string;
	readonly cursor?: string;
	readonly value?: string;
	readonly updatedAt?: string;
	readonly [key: string]: unknown;
}

export interface SyncSnapshotRecord {
	readonly local?: CalendarEventSnapshot;
	readonly remote?: CalendarEventSnapshot;
	readonly hash?: string;
	readonly capturedAt?: string;
	readonly [key: string]: unknown;
}

export interface SyncConflictRecord {
	readonly localUid?: string;
	readonly fields?: readonly string[];
	readonly local?: unknown;
	readonly remote?: unknown;
	readonly base?: unknown;
	readonly createdAt?: string;
	readonly [key: string]: unknown;
}

export interface SyncTombstone {
	readonly localUid?: string;
	readonly providerId?: string;
	readonly accountId?: string;
	readonly calendarId?: string;
	readonly remoteEventId?: string;
	readonly deletedAt?: string;
	readonly reason?: string;
	readonly [key: string]: unknown;
}

export interface SyncRetryState {
	readonly attempts?: number;
	readonly nextAttemptAt?: string;
	readonly lastAttemptAt?: string;
	readonly [key: string]: unknown;
}

/** All durable synchronization metadata.  No credentials belong here. */
export interface SyncState {
	readonly schemaVersion: number;
	readonly mappings: Record<string, SyncMapping>;
	readonly cursors: Record<string, SyncCursor | string>;
	readonly snapshots: Record<string, SyncSnapshotRecord | CalendarEventSnapshot>;
	readonly conflicts: Record<string, SyncConflictRecord>;
	readonly tombstones: Record<string, SyncTombstone>;
	readonly retry: Record<string, SyncRetryState>;
	lastError: SanitizedSyncError | null;
	readonly [key: string]: unknown;
}

export interface SyncDisconnectSelection {
	readonly providerId?: string;
	readonly accountId?: string;
	readonly calendarId?: string;
}

export interface SyncDisconnectResult {
	readonly state: SyncState;
	readonly removedMappingCount: number;
	readonly removedStateKeys: number;
	/** Notes and remote events are intentionally untouched by this operation. */
	readonly preservedNotes: true;
	readonly preservedRemoteEvents: true;
}

interface SyncStateStoreDataStore {
	load(): Promise<{
		envelope?: { syncState: SyncState; settings: CalendarPluginSettings };
		syncState?: SyncState;
		settings?: CalendarPluginSettings;
	}>;
	saveSyncState(state: SyncState): Promise<unknown>;
	update?(updater: (envelope: PluginDataMutationEnvelope) => PluginDataMutationEnvelope | void): Promise<unknown>;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
	if (value === undefined) return value;
	return JSON.parse(JSON.stringify(value)) as T;
}

function copyRecord<T>(value: unknown): Record<string, T> {
	if (!isRecord(value)) throw new TypeError('Expected a record');
	const redacted = redactSecrets(value);
	return clone(redacted as Record<string, T>);
}

/** Return an empty, schema-current state for a disabled sync session. */
export function createDefaultSyncState(): SyncState {
	return {
		schemaVersion: SYNC_STATE_SCHEMA_VERSION,
		mappings: {},
		cursors: {},
		snapshots: {},
		conflicts: {},
		tombstones: {},
		retry: {},
		lastError: null,
	};
}

/**
 * Strictly normalize a state object.  A malformed collection is rejected as
 * a whole so a failed migration can leave the previous raw plugin state
 * untouched instead of silently dropping half of its mappings.
 */
export function normalizeSyncState(raw: unknown): SyncState {
	if (!isRecord(raw)) throw new TypeError('Sync state must be an object');
	const version = raw.schemaVersion ?? raw.version ?? SYNC_STATE_SCHEMA_VERSION;
	if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > SYNC_STATE_SCHEMA_VERSION) {
		throw new Error(`Unsupported sync state schema version: ${String(version)}`);
	}

	const redacted = redactSecrets(raw);
	const state = {
		...createDefaultSyncState(),
		...(isRecord(redacted) ? redacted : {}),
		schemaVersion: SYNC_STATE_SCHEMA_VERSION,
		mappings: copyRecord<SyncMapping>(raw.mappings ?? {}),
		cursors: copyRecord<SyncCursor | string>(raw.cursors ?? {}),
		snapshots: copyRecord<SyncSnapshotRecord | CalendarEventSnapshot>(raw.snapshots ?? {}),
		conflicts: copyRecord<SyncConflictRecord>(raw.conflicts ?? {}),
		tombstones: copyRecord<SyncTombstone>(raw.tombstones ?? {}),
		retry: copyRecord<SyncRetryState>(raw.retry ?? raw.retries ?? {}),
		lastError: raw.lastError === null || raw.lastError === undefined
			? null
			: sanitizeSyncError(raw.lastError),
	};

	return state as SyncState;
}

/** Alias used by migration code. */
export const migrateSyncState = normalizeSyncState;

function mappingMatches(mapping: SyncMapping, selection?: SyncDisconnectSelection): boolean {
	if (!selection) return true;
	if (selection.providerId !== undefined && mapping.providerId !== selection.providerId) return false;
	if (selection.accountId !== undefined && mapping.accountId !== selection.accountId) return false;
	if (selection.calendarId !== undefined && mapping.calendarId !== selection.calendarId) return false;
	return true;
}

function stateKeyMatches(key: string, selection?: SyncDisconnectSelection): boolean {
	if (!selection) return true;
	const pieces = key.split(':').map(piece => {
		try {
			return decodeURIComponent(piece);
		} catch (_error) {
			return piece;
		}
	});
	if (selection.providerId !== undefined && pieces[0] !== selection.providerId) return false;
	if (selection.accountId !== undefined && pieces[1] !== selection.accountId) return false;
	if (selection.calendarId !== undefined && pieces[2] !== selection.calendarId) return false;
	return pieces.length > 1;
}

function mappingKeyMatches(key: string, mapping: SyncMapping, selection?: SyncDisconnectSelection): boolean {
	return mappingMatches(mapping, selection) || (selection !== undefined && stateKeyMatches(key, selection));
}

function removeMatchingRecord<T>(
	record: Record<string, T>,
	selection: SyncDisconnectSelection | undefined,
	shouldRemove: (key: string, value: T) => boolean,
): number {
	let removed = 0;
	for (const [key, value] of Object.entries(record)) {
		if (shouldRemove(key, value)) {
			delete record[key];
			removed += 1;
		}
	}
	return removed;
}

/**
 * Disconnect without touching either side's notes/events.  It removes the
 * durable association and all derived sync metadata, and leaves the caller
 * responsible for removing credentials through CredentialStore.
 */
export function disconnectSyncState(
	input: SyncState,
	selection?: SyncDisconnectSelection,
): SyncDisconnectResult {
	const state = normalizeSyncState(input);
	const removedMappingKeys = new Set<string>();
	for (const [key, mapping] of Object.entries(state.mappings)) {
		if (mappingKeyMatches(key, mapping, selection)) removedMappingKeys.add(key);
	}

	const removedLocalUids = new Set<string>();
	for (const key of removedMappingKeys) {
		const mapping = state.mappings[key];
		const localUid = mapping.localUid ?? (typeof mapping.uid === 'string' ? mapping.uid : undefined);
		if (localUid) removedLocalUids.add(localUid);
		delete state.mappings[key];
	}

	let removedStateKeys = removedMappingKeys.size;
	removedStateKeys += removeMatchingRecord(state.cursors, selection, (key) => stateKeyMatches(key, selection));
	removedStateKeys += removeMatchingRecord(state.snapshots, selection, (key) => {
		return removedLocalUids.has(key) || removedMappingKeys.has(key) || stateKeyMatches(key, selection);
	});
	removedStateKeys += removeMatchingRecord(state.conflicts, selection, (key, value) => {
		return removedLocalUids.has(value.localUid ?? '') || removedMappingKeys.has(key) || stateKeyMatches(key, selection);
	});
	removedStateKeys += removeMatchingRecord(state.tombstones, selection, (key, value) => {
		return removedLocalUids.has(value.localUid ?? '') || removedMappingKeys.has(key) || stateKeyMatches(key, selection);
	});
	removedStateKeys += removeMatchingRecord(state.retry, selection, (key) => stateKeyMatches(key, selection));
	state.lastError = null;

	return {
		state,
		removedMappingCount: removedMappingKeys.size,
		removedStateKeys,
		preservedNotes: true,
		preservedRemoteEvents: true,
	};
}

/**
 * Construct a stable provider/account/calendar key for cursor and retry maps.
 * Components are escaped so account IDs containing ':' cannot collide.
 */
export function makeSyncStateKey(
	providerId: string,
	accountId: string,
	calendarId: string,
	...parts: string[]
): string {
	return [providerId, accountId, calendarId, ...parts].map(value => encodeURIComponent(value)).join(':');
}

/** Return a copy with one sanitized last error attached. */
export function withSyncStateError(state: SyncState, error: unknown, at?: string): SyncState {
	const next = normalizeSyncState(state);
	next.lastError = sanitizeSyncError(error, at);
	return next;
}

/** Narrow a provider value without importing provider contracts. */
export function isSyncProviderId(value: unknown): value is SyncProviderId {
	return value === 'google' || value === 'microsoft';
}

export class SyncStateStore {
	private state: SyncState = createDefaultSyncState();
	private loaded = false;

	/** Injected plugin-data store is typed structurally to avoid a runtime cycle. */
	constructor(
		private readonly dataStore: SyncStateStoreDataStore,
	) {}

	async load(): Promise<SyncState> {
		const result = await this.dataStore.load();
		const rawState = result.syncState ?? result.envelope?.syncState ?? createDefaultSyncState();
		this.state = normalizeSyncState(rawState);
		this.loaded = true;
		return clone(this.state);
	}

	async initialize(): Promise<SyncState> {
		return this.load();
	}

	async loadState(): Promise<SyncState> {
		return this.load();
	}

	getState(): SyncState {
		return clone(this.state);
	}

	get isLoaded(): boolean {
		return this.loaded;
	}

	async save(state: SyncState = this.state): Promise<SyncState> {
		this.state = normalizeSyncState(state);
		await this.dataStore.saveSyncState(this.state);
		this.loaded = true;
		return clone(this.state);
	}

	async update(updater: (state: SyncState) => SyncState | void): Promise<SyncState> {
		const next = clone(this.state);
		const updated = updater(next) ?? next;
		return this.save(updated);
	}

	async setLastError(error: unknown, at?: string): Promise<SyncState> {
		return this.save(withSyncStateError(this.state, error, at));
	}

	async clearLastError(): Promise<SyncState> {
		const next = normalizeSyncState(this.state);
		next.lastError = null;
		return this.save(next);
	}

	async disconnect(
		selection?: SyncDisconnectSelection,
		credentialStore?: { remove(provider: string, accountId: string): Promise<void> },
	): Promise<SyncDisconnectResult> {
		const credentialPairs = new Set<string>();
		for (const mapping of Object.values(this.state.mappings)) {
			if (mapping.providerId && mapping.accountId && mappingMatches(mapping, selection)) {
				credentialPairs.add(`${mapping.providerId}\u0000${mapping.accountId}`);
			}
		}
		const result = disconnectSyncState(this.state, selection);
		if (this.dataStore.update) {
			await this.dataStore.update((envelope) => ({
				...envelope,
				settings: {
					...envelope.settings,
					sync: {
						...envelope.settings.sync,
						syncMode: 'disabled',
						providerId: null,
						accountId: null,
						calendarId: null,
					},
				},
				syncState: result.state,
			}));
			this.state = normalizeSyncState(result.state);
			this.loaded = true;
		} else {
			await this.save(result.state);
		}

		if (credentialStore) {
			const provider = selection?.providerId;
			const accountId = selection?.accountId;
			if (provider && accountId) credentialPairs.add(`${provider}\u0000${accountId}`);
			for (const pair of credentialPairs) {
				const separator = pair.indexOf('\u0000');
				await credentialStore.remove(pair.slice(0, separator), pair.slice(separator + 1));
			}
		}
		return { ...result, state: this.getState() };
	}
}
