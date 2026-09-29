// Settings interface
import { HolidaySource } from '../services/holiday/HolidayTypes';

export interface TagAppearance {
    color?: string;
    symbol?: string;
}

export interface DateProperty {
    name: string;
    color?: string;
    symbol?: string;
    isRecurring?: boolean;
}

/**
 * Synchronization is deliberately opt-in.  The string values are persisted
 * as part of the plugin-data envelope, so keep this union stable when adding
 * future modes.
 */
export type SyncMode = 'disabled' | 'dry-run' | 'import-only' | 'bidirectional';

export type SyncProviderId = 'google' | 'microsoft';

export interface SyncHorizon {
    /** Number of civil days to include before the current date. */
    pastDays: number;
    /** Number of civil days to include after the current date. */
    futureDays: number;
}

export interface CalendarSyncSettings {
    /** Folder in which explicitly synchronized event notes are created. */
    eventFolder: string;
    /** IANA timezone used for the sync window and event-note defaults. */
    timezone: string;
    /** Polling interval in minutes while the plugin is open. */
    pollIntervalMinutes: number;
    /** Bounded pull window around the current date. */
    horizon: SyncHorizon;
    /** Selected provider, or null until an account is connected. */
    providerId: SyncProviderId | null;
    /** Stable provider account identifier, or null when disconnected. */
    accountId: string | null;
    /** Selected writable calendar identifier, or null when unselected. */
    calendarId: string | null;
    /** Persisted rollout mode.  Disabled is always the safe default. */
    syncMode: SyncMode;
    /** Explicitly user-supplied public Google Client ID for OAuth authentication. */
    googleClientId: string | null;
    /** Legacy migration slot only; the client secret is kept in SecretStorage. */
    googleClientSecret: string | null;
}

/** Short alias used by sync-layer consumers. */
export type SyncSettings = CalendarSyncSettings;

export interface CalendarPluginSettings {
    defaultDotColor: string;
    defaultBarColor: string;
    shouldConfirmBeforeCreate: boolean;
    shouldConfirmBeforeCreateRange: boolean;
    tagAppearance: Record<string, TagAppearance>;
    collapseDuplicateTagSymbols: boolean;
    // Dots-only mode for calendar view
    useDotsOnlyForTags: boolean;
    useDotsOnlyForProperties: boolean;
    // Custom Date Properties
    customDateProperties: DateProperty[];
    // Holiday settings
    holidayStorageFolder: string;
    holidaySources: HolidaySource[];
    // Task properties visuals
    taskSettings: {
        scheduled: { symbol?: string; color?: string; };
        due: { symbol?: string; color?: string; };
        completed: { symbol?: string; color?: string; };
    };
    /** Plugin-wide sync configuration.  Sync is disabled by default. */
    sync: CalendarSyncSettings;
}

export const DEFAULT_SYNC_SETTINGS: CalendarSyncSettings = {
    eventFolder: 'Calendar Events',
    timezone: 'UTC',
    pollIntervalMinutes: 5,
    horizon: {
        pastDays: 365,
        futureDays: 730,
    },
    providerId: null,
    accountId: null,
    calendarId: null,
    syncMode: 'disabled',
    googleClientId: null,
    googleClientSecret: null,
};

export const DEFAULT_SETTINGS: CalendarPluginSettings = {
    defaultDotColor: 'var(--color-red-text)',
    defaultBarColor: 'var(--color-blue-text)',
    shouldConfirmBeforeCreate: false,
    shouldConfirmBeforeCreateRange: true,
    tagAppearance: {},
    collapseDuplicateTagSymbols: true,
    // Dots-only mode defaults (false to preserve icons)
    useDotsOnlyForTags: false,
    useDotsOnlyForProperties: false,
    // Custom Date Properties
    customDateProperties: [],
    // Holiday defaults
    holidayStorageFolder: 'Holidays',
    holidaySources: [],
    // Task Defaults
    taskSettings: {
        scheduled: { symbol: '⏳', color: 'var(--color-orange-text)' },
        due: { symbol: '📅', color: 'var(--color-red-text)' },
        completed: { symbol: '✅', color: 'var(--color-green-text)' }
    },
    sync: {
        ...DEFAULT_SYNC_SETTINGS,
        horizon: { ...DEFAULT_SYNC_SETTINGS.horizon },
    },
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneDefaultSettings(): CalendarPluginSettings {
    return {
        ...DEFAULT_SETTINGS,
        tagAppearance: { ...DEFAULT_SETTINGS.tagAppearance },
        customDateProperties: DEFAULT_SETTINGS.customDateProperties.map(property => ({ ...property })),
        holidaySources: [...DEFAULT_SETTINGS.holidaySources],
        taskSettings: {
            scheduled: { ...DEFAULT_SETTINGS.taskSettings.scheduled },
            due: { ...DEFAULT_SETTINGS.taskSettings.due },
            completed: { ...DEFAULT_SETTINGS.taskSettings.completed },
        },
        sync: {
            ...DEFAULT_SETTINGS.sync,
            horizon: { ...DEFAULT_SETTINGS.sync.horizon },
        },
    };
}

function asNullableString(value: unknown, fallback: string | null): string | null {
    if (value === null || value === undefined || value === '') return fallback;
    return typeof value === 'string' ? value : fallback;
}

function asPositiveNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function asNonNegativeInteger(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function isSyncMode(value: unknown): value is SyncMode {
    return value === 'disabled' || value === 'dry-run' || value === 'import-only' || value === 'bidirectional';
}

function normalizeSyncSettings(raw: unknown): CalendarSyncSettings {
    const value = isRecord(raw) ? raw : {};
    const horizon = isRecord(value.horizon) ? value.horizon : {};
    const providerValue = value.providerId ?? value.provider;
    const providerId = providerValue === 'google' || providerValue === 'microsoft' ? providerValue : null;

    return {
        eventFolder: typeof value.eventFolder === 'string'
            ? value.eventFolder
            : typeof value.folder === 'string'
                ? value.folder
                : DEFAULT_SYNC_SETTINGS.eventFolder,
        timezone: typeof value.timezone === 'string' && value.timezone.trim().length > 0
            ? value.timezone
            : DEFAULT_SYNC_SETTINGS.timezone,
        pollIntervalMinutes: asPositiveNumber(
            value.pollIntervalMinutes ?? value.pollInterval,
            DEFAULT_SYNC_SETTINGS.pollIntervalMinutes,
        ),
        horizon: {
            pastDays: asNonNegativeInteger(
                horizon.pastDays ?? horizon.backwardDays ?? horizon.previousDays,
                DEFAULT_SYNC_SETTINGS.horizon.pastDays,
            ),
            futureDays: asNonNegativeInteger(
                horizon.futureDays ?? horizon.forwardDays ?? horizon.nextDays,
                DEFAULT_SYNC_SETTINGS.horizon.futureDays,
            ),
        },
        providerId,
        accountId: asNullableString(value.accountId, DEFAULT_SYNC_SETTINGS.accountId),
        calendarId: asNullableString(value.calendarId, DEFAULT_SYNC_SETTINGS.calendarId),
        syncMode: isSyncMode(value.syncMode) ? value.syncMode : DEFAULT_SYNC_SETTINGS.syncMode,
        googleClientId: asNullableString(value.googleClientId, DEFAULT_SYNC_SETTINGS.googleClientId),
        googleClientSecret: asNullableString(value.googleClientSecret, DEFAULT_SYNC_SETTINGS.googleClientSecret),
    };
}

/**
 * Merge persisted settings onto every current default without the shallow
 * merge loss that the original plugin's Object.assign load path caused for
 * nested task and sync settings.  Unknown fields are retained for forward
 * compatibility; sync aliases from early development builds are accepted.
 */
export function mergeCalendarPluginSettings(raw: unknown): CalendarPluginSettings {
    if (raw === null || raw === undefined) return cloneDefaultSettings();
    if (!isRecord(raw)) throw new TypeError('Calendar plugin settings must be an object');

    const defaults = cloneDefaultSettings();
    const persistedSync = raw.sync ?? raw.syncSettings ?? raw.syncConfig;
    const legacySync: UnknownRecord = {
        ...(isRecord(persistedSync) ? persistedSync : {}),
    };
    const legacySyncKeys = [
        'eventFolder',
        'timezone',
        'pollIntervalMinutes',
        'pollInterval',
        'horizon',
        'providerId',
        'provider',
        'accountId',
        'calendarId',
        'syncMode',
        'googleClientId',
        'googleClientSecret',
    ];
    for (const key of legacySyncKeys) {
        if (legacySync[key] === undefined && raw[key] !== undefined) legacySync[key] = raw[key];
    }

    const taskSettings = isRecord(raw.taskSettings) ? raw.taskSettings : {};
    const settings: CalendarPluginSettings = {
        ...defaults,
        ...raw,
        tagAppearance: isRecord(raw.tagAppearance)
            ? { ...defaults.tagAppearance, ...(raw.tagAppearance as Record<string, TagAppearance>) }
            : defaults.tagAppearance,
        customDateProperties: Array.isArray(raw.customDateProperties)
            ? raw.customDateProperties.map(property => isRecord(property) ? { ...property } : property) as DateProperty[]
            : defaults.customDateProperties,
        holidaySources: Array.isArray(raw.holidaySources) ? [...raw.holidaySources] : defaults.holidaySources,
        taskSettings: {
            scheduled: isRecord(taskSettings.scheduled)
                ? { ...defaults.taskSettings.scheduled, ...(taskSettings.scheduled as Record<string, unknown>) } as typeof defaults.taskSettings.scheduled
                : defaults.taskSettings.scheduled,
            due: isRecord(taskSettings.due)
                ? { ...defaults.taskSettings.due, ...(taskSettings.due as Record<string, unknown>) } as typeof defaults.taskSettings.due
                : defaults.taskSettings.due,
            completed: isRecord(taskSettings.completed)
                ? { ...defaults.taskSettings.completed, ...(taskSettings.completed as Record<string, unknown>) } as typeof defaults.taskSettings.completed
                : defaults.taskSettings.completed,
        },
        sync: normalizeSyncSettings(legacySync),
    };

    return settings;
}

/** Alias used by migration code and callers that prefer a shorter name. */
export const normalizeCalendarPluginSettings = mergeCalendarPluginSettings;
