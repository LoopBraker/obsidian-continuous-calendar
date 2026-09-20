import {
	DEFAULT_SETTINGS,
	mergeCalendarPluginSettings,
	type CalendarPluginSettings,
} from '../../../settings/settings';
import {
	createDefaultSyncState,
	normalizeSyncState,
	type SyncState,
} from './SyncStateStore';
import { redactSecrets, sanitizeSyncError, type SanitizedSyncError } from './redaction';

export const PLUGIN_DATA_SCHEMA_VERSION = 1;

/** The only durable plugin-data shape written by the new sync layer. */
export interface PluginDataEnvelope {
	readonly schemaVersion: number;
	readonly settings: CalendarPluginSettings;
	readonly syncState: SyncState;
	/** Non-enumerable compatibility alias attached by createPluginDataEnvelope. */
	readonly sync?: SyncState;
	/** Non-enumerable compatibility alias for consumers that called this `version`. */
	readonly version?: number;
}

export type PluginData = PluginDataEnvelope;

export interface PluginDataPersistence {
	loadData(): Promise<unknown>;
	saveData(data: unknown): Promise<void>;
}

export interface PluginDataStoreOptions {
	readonly defaults?: CalendarPluginSettings;
	readonly persistMigration?: boolean;
}

/** Mutable projection accepted by update callbacks without requiring callers
 * to manufacture schema metadata they are not changing. */
export interface PluginDataMutationEnvelope {
	readonly schemaVersion?: number;
	readonly settings: CalendarPluginSettings;
	readonly syncState: SyncState;
	readonly [key: string]: unknown;
}

export interface PluginDataLoadResult extends PluginDataEnvelope {
	readonly envelope: PluginDataEnvelope;
	readonly migrated: boolean;
	readonly legacy: boolean;
	readonly syncDisabled: boolean;
	readonly rawStatePreserved: boolean;
	readonly migrationError?: SanitizedSyncError;
	readonly persistenceError?: SanitizedSyncError;
}

export interface PluginDataMigrationResult {
	readonly envelope: PluginDataEnvelope;
	readonly migrated: boolean;
	readonly legacy: boolean;
}

export class PluginDataMigrationError extends Error {
	readonly causeValue?: unknown;

	constructor(message: string, causeValue?: unknown) {
		super(message);
		this.name = 'PluginDataMigrationError';
		this.causeValue = causeValue;
		Object.setPrototypeOf(this, PluginDataMigrationError.prototype);
	}
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withCompatibilityAliases<T extends PluginDataEnvelope>(envelope: T): T {
	// Keep aliases out of JSON so a future migration has one authoritative copy.
	Object.defineProperty(envelope, 'sync', {
		configurable: true,
		enumerable: false,
		value: envelope.syncState,
	});
	Object.defineProperty(envelope, 'version', {
		configurable: true,
		enumerable: false,
		value: envelope.schemaVersion,
	});
	return envelope;
}

export function createPluginDataEnvelope(
	settings: CalendarPluginSettings = DEFAULT_SETTINGS,
	syncState: SyncState = createDefaultSyncState(),
): PluginDataEnvelope {
	const safeSettings = redactSecrets(mergeCalendarPluginSettings(settings));
	return withCompatibilityAliases({
		schemaVersion: PLUGIN_DATA_SCHEMA_VERSION,
		settings: mergeCalendarPluginSettings(safeSettings),
		syncState: normalizeSyncState(syncState),
	});
}

function looksLikeSyncState(value: unknown): boolean {
	return isRecord(value) && [
		'mappings',
		'cursors',
		'snapshots',
		'conflicts',
		'tombstones',
		'retry',
		'retries',
		'lastError',
	].some(key => Object.prototype.hasOwnProperty.call(value, key));
}

function looksLikeEnvelope(raw: UnknownRecord): boolean {
	return (
		Object.prototype.hasOwnProperty.call(raw, 'schemaVersion') ||
		Object.prototype.hasOwnProperty.call(raw, 'version') ||
		Object.prototype.hasOwnProperty.call(raw, 'settings') ||
		Object.prototype.hasOwnProperty.call(raw, 'syncState') ||
		looksLikeSyncState(raw.sync)
	);
}

function rawSettingsFromEnvelope(raw: UnknownRecord): unknown {
	if (Object.prototype.hasOwnProperty.call(raw, 'settings')) return raw.settings;
	return raw;
}

function rawSyncStateFromEnvelope(raw: UnknownRecord): unknown {
	if (Object.prototype.hasOwnProperty.call(raw, 'syncState')) return raw.syncState;
	if (looksLikeSyncState(raw.sync)) return raw.sync;
	if (Object.prototype.hasOwnProperty.call(raw, 'state')) return raw.state;
	return {};
}

function disableSync(settings: CalendarPluginSettings): CalendarPluginSettings {
	return mergeCalendarPluginSettings({
		...settings,
		sync: {
			...settings.sync,
			syncMode: 'disabled',
		},
	});
}

/**
 * Pure migration from the original flat settings object and from the current
 * envelope.  No persistence happens here; callers can safely test or audit
 * this function without touching a vault.
 */
export function migratePluginData(
	raw: unknown,
	defaults: CalendarPluginSettings = DEFAULT_SETTINGS,
): PluginDataMigrationResult {
	if (raw === undefined || raw === null) {
		return {
			envelope: createPluginDataEnvelope(defaults, createDefaultSyncState()),
			migrated: true,
			legacy: true,
		};
	}
	if (!isRecord(raw)) {
		throw new PluginDataMigrationError('Persisted plugin data must be an object');
	}

	const envelopeInput = looksLikeEnvelope(raw);
	if (envelopeInput) {
		const version = raw.schemaVersion ?? raw.version;
		if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > PLUGIN_DATA_SCHEMA_VERSION) {
			throw new PluginDataMigrationError(`Unsupported plugin-data schema version: ${String(version)}`);
		}
		const rawSettings = rawSettingsFromEnvelope(raw);
		if (!isRecord(rawSettings)) {
			throw new PluginDataMigrationError('Persisted plugin-data settings are malformed');
		}

		let syncState: SyncState;
		const rawSyncState = rawSyncStateFromEnvelope(raw);
		try {
			syncState = normalizeSyncState(rawSyncState);
		} catch (error) {
			throw new PluginDataMigrationError('Persisted sync state is malformed', error);
		}
		const stateWasNormalized = JSON.stringify(rawSyncState) !== JSON.stringify(syncState);

		return {
			envelope: createPluginDataEnvelope(mergeCalendarPluginSettings({ ...defaults, ...rawSettings }), syncState),
			migrated: version !== PLUGIN_DATA_SCHEMA_VERSION || !Object.prototype.hasOwnProperty.call(raw, 'syncState') || stateWasNormalized,
			legacy: false,
		};
	}

	// Current plugin releases stored settings directly at the root.  Every
	// existing key is spread into the settings object before defaults fill gaps.
	return {
		envelope: createPluginDataEnvelope(
			mergeCalendarPluginSettings({ ...defaults, ...raw }),
			createDefaultSyncState(),
		),
		migrated: true,
		legacy: true,
	};
}

/** Alias for callers that use the more explicit migration name. */
export const migratePluginDataEnvelope = migratePluginData;

export function tryMigratePluginData(
	raw: unknown,
	defaults: CalendarPluginSettings = DEFAULT_SETTINGS,
): PluginDataMigrationResult | { error: SanitizedSyncError } {
	try {
		return migratePluginData(raw, defaults);
	} catch (error) {
		return { error: sanitizeSyncError(error) };
	}
}

function sanitizeEnvelope(envelope: PluginDataEnvelope): PluginDataEnvelope {
	const settingsValue = redactSecrets(envelope.settings);
	const stateValue = redactSecrets(envelope.syncState);
	if (!isRecord(settingsValue) || !isRecord(stateValue)) {
		throw new PluginDataMigrationError('Unable to sanitize plugin-data envelope');
	}
	return createPluginDataEnvelope(
		mergeCalendarPluginSettings(settingsValue),
		normalizeSyncState(stateValue),
	);
}

export class PluginDataStore {
	private currentEnvelope: PluginDataEnvelope | undefined;

	private readonly defaults: CalendarPluginSettings;

	private readonly persistMigration: boolean;

	constructor(
		private readonly persistence: PluginDataPersistence,
		options: PluginDataStoreOptions = {},
	) {
		this.defaults = mergeCalendarPluginSettings(options.defaults ?? DEFAULT_SETTINGS);
		this.persistMigration = options.persistMigration !== false;
	}

	/** Load and, when safe, upgrade the persisted data to the canonical envelope. */
	async load(): Promise<PluginDataLoadResult> {
		let raw: unknown;
		try {
			raw = await this.persistence.loadData();
		} catch (error) {
			const envelope = createPluginDataEnvelope(disableSync(this.defaults), createDefaultSyncState());
			this.currentEnvelope = envelope;
			return this.result(envelope, false, false, true, sanitizeSyncError(error));
		}

		let migration: PluginDataMigrationResult;
		try {
			migration = migratePluginData(raw, this.defaults);
		} catch (error) {
			// Preserve the prior raw value by deliberately skipping saveData.  Keep
			// recoverable settings if possible, but always fail closed for sync.
			let fallbackSettings = this.defaults;
			if (isRecord(raw)) {
				try {
					const candidate = rawSettingsFromEnvelope(raw);
					if (isRecord(candidate)) fallbackSettings = mergeCalendarPluginSettings({ ...this.defaults, ...candidate });
				} catch (_ignored) {
					fallbackSettings = this.defaults;
				}
			}
			const envelope = createPluginDataEnvelope(disableSync(fallbackSettings), createDefaultSyncState());
			this.currentEnvelope = envelope;
			return this.result(envelope, false, false, true, sanitizeSyncError(error));
		}

		this.currentEnvelope = migration.envelope;
		let persistenceError: SanitizedSyncError | undefined;
		if (this.persistMigration && migration.migrated) {
			try {
				await this.saveEnvelope(migration.envelope);
			} catch (error) {
				// Runtime can continue with the in-memory migrated value.  The raw
				// persisted data is still recoverable for a later retry.
				persistenceError = sanitizeSyncError(error);
			}
		}
		return this.result(
			migration.envelope,
			migration.migrated,
			migration.legacy,
			false,
			undefined,
			persistenceError,
		);
	}

	/** Convenience method for consumers interested only in the envelope. */
	async loadEnvelope(): Promise<PluginDataEnvelope> {
		return (await this.load()).envelope;
	}

	/** Convenience projection used by lifecycle code that only needs settings. */
	async loadSettings(): Promise<CalendarPluginSettings> {
		return (await this.load()).settings;
	}

	/** Compatibility aliases for injected Plugin-like call sites. */
	async loadData(): Promise<PluginDataLoadResult> {
		return this.load();
	}

	async saveEnvelope(envelope: PluginDataEnvelope): Promise<PluginDataEnvelope> {
		const safeEnvelope = sanitizeEnvelope(envelope);
		await this.persistence.saveData({
			schemaVersion: safeEnvelope.schemaVersion,
			settings: safeEnvelope.settings,
			syncState: safeEnvelope.syncState,
		});
		this.currentEnvelope = safeEnvelope;
		return safeEnvelope;
	}

	async save(data: PluginDataEnvelope | CalendarPluginSettings): Promise<PluginDataEnvelope> {
		if (isRecord(data) && Object.prototype.hasOwnProperty.call(data, 'schemaVersion') && Object.prototype.hasOwnProperty.call(data, 'settings')) {
			return this.saveEnvelope(data as PluginDataEnvelope);
		}
		const current = this.currentEnvelope ?? createPluginDataEnvelope(this.defaults, createDefaultSyncState());
		return this.saveEnvelope(createPluginDataEnvelope(mergeCalendarPluginSettings(data), current.syncState));
	}

	async saveSettings(settings: CalendarPluginSettings): Promise<PluginDataEnvelope> {
		const current = this.currentEnvelope ?? createPluginDataEnvelope(this.defaults, createDefaultSyncState());
		return this.saveEnvelope(createPluginDataEnvelope(settings, current.syncState));
	}

	async saveSyncState(syncState: SyncState): Promise<PluginDataEnvelope> {
		const current = this.currentEnvelope ?? createPluginDataEnvelope(this.defaults, createDefaultSyncState());
		return this.saveEnvelope(createPluginDataEnvelope(current.settings, syncState));
	}

	async saveData(data: PluginDataEnvelope | CalendarPluginSettings): Promise<PluginDataEnvelope> {
		return this.save(data);
	}

	async update(updater: (envelope: PluginDataMutationEnvelope) => PluginDataMutationEnvelope | void): Promise<PluginDataEnvelope> {
		const current = this.currentEnvelope ?? createPluginDataEnvelope(this.defaults, createDefaultSyncState());
		const candidate = createPluginDataEnvelope(current.settings, current.syncState) as PluginDataMutationEnvelope;
		const next = updater(candidate) ?? candidate;
		return this.saveEnvelope(createPluginDataEnvelope(next.settings, next.syncState));
	}

	getCurrent(): PluginDataEnvelope | undefined {
		return this.currentEnvelope === undefined
			? undefined
			: createPluginDataEnvelope(this.currentEnvelope.settings, this.currentEnvelope.syncState);
	}

	private result(
		envelope: PluginDataEnvelope,
		migrated: boolean,
		legacy: boolean,
		rawStatePreserved: boolean,
		migrationError?: SanitizedSyncError,
		persistenceError?: SanitizedSyncError,
	): PluginDataLoadResult {
		const result = {
			...envelope,
			envelope,
			migrated,
			legacy,
			syncDisabled: envelope.settings.sync.syncMode === 'disabled',
			rawStatePreserved,
			migrationError,
			persistenceError,
		};
		return withCompatibilityAliases(result);
	}
}

/** Compatibility alias for call sites that name the abstraction DataStore. */
export const PluginDataEnvelopeStore = PluginDataStore;
