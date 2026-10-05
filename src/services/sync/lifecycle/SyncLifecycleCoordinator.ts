import type { CalendarPluginSettings, SyncMode } from '../../../settings/settings';
import type { CalendarEvent } from '../model/CalendarEvent';
import type { CachedCalendarEvent, CachedCalendarOccurrence } from '../state/SyncStateStore';
import type { CalendarEventIndex } from '../notes/CalendarEventIndex';
import type {
	CalendarEventRepository,
	LocalCalendarEventDeletion,
} from '../notes/CalendarEventRepository';
import type {
	CalendarProvider,
	ProviderHttpTransport,
	ProviderSession,
} from '../providers';
import { GoogleCalendarProvider } from '../providers/google/GoogleCalendarProvider';
import type { GoogleCredentialStore } from '../providers/google/GoogleOAuthProvider';
import {
	SyncService,
	type SyncConflictResolutionResult,
	type SyncConflictView,
	type SyncRunTrigger,
	type SyncServiceClock,
	type SyncServiceOptions,
	type SyncServiceStatusSnapshot,
} from '../engine/SyncService';
import type { CredentialStore } from '../state/CredentialStore';
import type { PluginDataStore } from '../state/PluginDataStore';
import type { SyncStateStore } from '../state/SyncStateStore';

/**
 * The subset of the repository used by lifecycle orchestration.  Keeping this
 * structural makes the coordinator usable with deterministic test doubles and
 * avoids putting Obsidian or provider calls in the calendar read model.
 */
export interface SyncLifecycleRepository {
	readonly index?: CalendarEventIndex;
	reload(): Promise<unknown>;
	notifyLocalDeletion?(path: string): LocalCalendarEventDeletion | undefined;
}

/** A narrow, injected boundary around SyncService. */
export interface SyncLifecycleService {
	readonly provider?: CalendarProvider;
	readonly session?: ProviderSession;
	readonly conflicts?: readonly SyncConflictView[];
	readonly status?: SyncServiceStatusSnapshot;
	start(): Promise<unknown>;
	syncNow(trigger?: SyncRunTrigger, signal?: AbortSignal): Promise<unknown>;
	deleteSyncedEvent?(localUid: string, signal?: AbortSignal): Promise<boolean>;
	createCalendarEvent?(event: CalendarEvent): Promise<CachedCalendarEvent & { key: string }>;
	updateCalendarEvent?(key: string, event: CalendarEvent): Promise<CachedCalendarEvent & { key: string }>;
	updateCalendarOccurrence?(key: string, event: CalendarEvent): Promise<CachedCalendarOccurrence & { key: string; localRepairPending?: boolean }>;
	deleteCalendarEvent?(key: string): Promise<boolean>;
	linkNote?(key: string, path: string, uid: string): Promise<unknown>;
	resolveConflict?(key: string, choice: 'local' | 'remote'): Promise<SyncConflictResolutionResult>;
	stop(): Promise<void>;
	dispose?(): void;
}

export interface SyncLifecycleCoordinatorOptions {
	readonly repository: SyncLifecycleRepository | CalendarEventRepository;
	readonly syncService?: SyncLifecycleService;
	readonly onError?: (error: unknown, operation: string) => void;
	readonly onIndexChanged?: (index: CalendarEventIndex | undefined) => void;
}

export type VaultChangeKind = 'create' | 'modify' | 'delete' | 'rename';

function reportError(
	onError: SyncLifecycleCoordinatorOptions['onError'],
	error: unknown,
	operation: string,
): void {
	try {
		onError?.(error, operation);
	} catch (_ignored) {
		// Error reporting must not turn a vault callback into a plugin failure.
	}
}

/**
 * Coordinates local vault lifecycle with the provider-neutral sync engine.
 *
 * The repository is always reloaded before the first service start.  Vault
 * callbacks only request a serialized sync run; they never call a provider
 * themselves.  A missing service is a valid state (disabled, mobile, missing
 * credentials, or malformed persisted state), so local indexing remains live.
 */
export class SyncLifecycleCoordinator {
	private started = false;
	private generation = 0;
	private abortController?: AbortController;
	private pendingChange: Promise<void> = Promise.resolve();

	private readonly repository: SyncLifecycleRepository | CalendarEventRepository;
	private readonly syncService?: SyncLifecycleService;
	private readonly onError?: SyncLifecycleCoordinatorOptions['onError'];
	private readonly onIndexChanged?: SyncLifecycleCoordinatorOptions['onIndexChanged'];

	constructor(options: SyncLifecycleCoordinatorOptions) {
		this.repository = options.repository;
		this.syncService = options.syncService;
		this.onError = options.onError;
		this.onIndexChanged = options.onIndexChanged;
	}

	get isStarted(): boolean {
		return this.started;
	}

	get calendarEventIndex(): CalendarEventIndex | undefined {
		return this.repository.index;
	}

	get service(): SyncLifecycleService | undefined {
		return this.syncService;
	}

	/**
	 * Reload local event notes before allowing any provider reconciliation.  A
	 * malformed event note is reported by the repository and does not prevent
	 * the rest of the plugin from starting.
	 */
	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		const currentGeneration = ++this.generation;
		this.abortController = new AbortController();

		try {
			await this.repository.reload();
			this.onIndexChanged?.(this.repository.index);
		} catch (error) {
			reportError(this.onError, error, 'reload-local-events');
		}

		if (!this.started || currentGeneration !== this.generation) return;
		if (!this.syncService) return;

		try {
			await this.syncService.start();
		} catch (error) {
			// Startup must remain local-first.  A missing credential, malformed
			// state, or provider outage is observable but not fatal to Obsidian.
			reportError(this.onError, error, 'start-sync-service');
		}
	}

	/** Stop new callbacks, abort an in-flight run, and release service hooks. */
	async stop(): Promise<void> {
		if (!this.started && !this.abortController) return;
		this.started = false;
		this.generation += 1;
		this.abortController?.abort(new Error('Sync lifecycle stopped'));
		this.abortController = undefined;

		if (!this.syncService) return;
		try {
			await this.syncService.stop();
		} catch (error) {
			reportError(this.onError, error, 'stop-sync-service');
		} finally {
			try {
				this.syncService.dispose?.();
			} catch (error) {
				reportError(this.onError, error, 'dispose-sync-service');
			}
		}
	}

	/** Request one run. Provider access remains entirely inside the service. */
	async syncNow(trigger: SyncRunTrigger = 'manual'): Promise<unknown> {
		if (!this.started || !this.syncService || !this.abortController) return undefined;
		try {
			const result = await this.syncService.syncNow(trigger, this.abortController.signal);
			this.onIndexChanged?.(this.repository.index);
			return result;
		} catch (error) {
			if (this.started) reportError(this.onError, error, `sync-${trigger}`);
			return undefined;
		}
	}

	/** Forward one vault event without performing provider work in the callback. */
	handleVaultChange(kind: VaultChangeKind, path: string): void {
		if (kind === 'delete') {
			try {
				// Capture the UID while the repository still has the old path.  The
				// engine turns this signal into a tombstone; unmarked notes are a no-op.
				this.repository.notifyLocalDeletion?.(path);
			} catch (error) {
				reportError(this.onError, error, 'record-local-deletion');
			}
		}
		if (!this.started) return;
		this.pendingChange = this.pendingChange.then(async () => {
			if (!this.started) return;
			if (this.syncService) {
				await this.syncNow('manual');
				return;
			}
			try {
				await this.repository.reload();
				this.onIndexChanged?.(this.repository.index);
			} catch (error) {
				reportError(this.onError, error, 'reload-local-events');
			}
		});
	}

	handleCreate(path: string): void {
		this.handleVaultChange('create', path);
	}

	handleModify(path: string): void {
		this.handleVaultChange('modify', path);
	}

	handleDelete(path: string): void {
		this.handleVaultChange('delete', path);
	}

	handleRename(path: string, oldPath?: string): void {
		// Do not call repository.rename here: Obsidian has already moved the file.
		// Move the read-model entry first so reload cannot misclassify a rename as
		// a deletion and emit a tombstone for an event that still exists.
		if (oldPath && this.repository.index?.getByPath(oldPath)) {
			try {
				this.repository.index.rename(oldPath, path);
			} catch (error) {
				reportError(this.onError, error, 'record-local-rename');
			}
		}
		this.handleVaultChange('rename', path);
	}
}

/** Build the timer boundary SyncService needs while registering its interval with Obsidian. */
export function createRegisteredSyncClock(
	registerInterval: (intervalId: number) => void,
): SyncServiceClock {
	return {
		now: () => Date.now(),
		setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
		clearTimeout: handle => globalThis.clearTimeout(handle as number),
		setInterval: (callback, intervalMs) => {
			const intervalId = globalThis.setInterval(callback, intervalMs) as unknown as number;
			registerInterval(intervalId);
			return intervalId;
		},
		clearInterval: handle => globalThis.clearInterval(handle as number),
	};
}

export interface SyncPollRegistrationOptions {
	readonly intervalMs?: number;
	readonly setInterval: (callback: () => void, intervalMs: number) => number;
	readonly registerInterval: (intervalId: number) => void;
}

/**
 * Register the plugin-owned polling callback.  Obsidian then owns timer
 * cleanup; the coordinator also ignores callbacks after stop/unload.
 */
export function registerSyncPoll(
	coordinator: SyncLifecycleCoordinator,
	options: SyncPollRegistrationOptions,
): number {
	const intervalMs = Math.max(1, Math.floor(options.intervalMs ?? 5 * 60_000));
	const intervalId = options.setInterval(() => {
		void coordinator.syncNow('interval');
	}, intervalMs);
	options.registerInterval(intervalId);
	return intervalId;
}

/** Runtime context supplied only after persisted settings have loaded. */
export interface SyncRuntimeContext {
	readonly settings: CalendarPluginSettings;
	readonly repository: CalendarEventRepository;
	readonly calendarEventIndex: CalendarEventIndex;
	readonly dataStore: PluginDataStore;
	readonly stateStore: SyncStateStore;
	readonly credentialStore: CredentialStore;
	readonly isDesktop: boolean;
	readonly app: unknown;
}

/**
 * An authenticated provider/session boundary.  H can supply one after OAuth;
 * G never invents a client ID, access token, or persisted credential.
 */
export interface AuthenticatedSyncRuntime {
	readonly provider: CalendarProvider;
	readonly session: ProviderSession;
}

export type SyncRuntimeFactory = (
	context: SyncRuntimeContext,
) => SyncLifecycleService | AuthenticatedSyncRuntime | undefined | Promise<SyncLifecycleService | AuthenticatedSyncRuntime | undefined>;

function isAuthenticatedRuntime(value: SyncLifecycleService | AuthenticatedSyncRuntime): value is AuthenticatedSyncRuntime {
	return 'provider' in value && 'session' in value;
}

/** Build the accepted engine only from a caller-supplied authenticated runtime. */
export function createSyncServiceFromRuntime(
	runtime: AuthenticatedSyncRuntime,
	options: {
		readonly settings: CalendarPluginSettings;
		readonly repository: CalendarEventRepository;
		readonly stateStore: SyncStateStore;
		readonly clock?: SyncServiceClock;
		readonly extra?: Omit<SyncServiceOptions, 'provider' | 'session' | 'calendarId' | 'repository' | 'stateStore'>;
	},
): SyncService | undefined {
	const sync = options.settings.sync;
	if (sync.syncMode === 'disabled' || !sync.calendarId || !sync.accountId) return undefined;
	if (runtime.session.providerId !== runtime.provider.id || runtime.session.accountId !== sync.accountId) return undefined;
	return new SyncService({
		provider: runtime.provider,
		session: runtime.session,
		calendarId: sync.calendarId,
		repository: options.repository,
		stateStore: options.stateStore,
		syncMode: sync.syncMode,
		timezone: sync.timezone,
		horizon: sync.horizon,
		pollIntervalMinutes: sync.pollIntervalMinutes,
		clock: options.clock,
		...(options.extra ?? {}),
	});
}

/**
 * Google adapter boundary.  Network transport and an already-authenticated
 * session are injected; this function never reads or persists an access token.
 */
export function createGoogleSyncService(options: {
	readonly settings: CalendarPluginSettings;
	readonly repository: CalendarEventRepository;
	readonly stateStore: SyncStateStore;
	readonly session: ProviderSession;
	readonly transport: ProviderHttpTransport;
	readonly clock?: SyncServiceClock;
	readonly extra?: Omit<SyncServiceOptions, 'provider' | 'session' | 'calendarId' | 'repository' | 'stateStore'>;
}): SyncService | undefined {
	if (options.settings.sync.providerId !== 'google') return undefined;
	return createSyncServiceFromRuntime(
		{
			provider: new GoogleCalendarProvider({ transport: options.transport, clock: options.clock }),
			session: options.session,
		},
		options,
	);
}

/** Adapt the generic feature-detected credential store to Google's narrow API. */
export function asGoogleCredentialStore(store: CredentialStore): GoogleCredentialStore {
	return {
		async get(accountId: string): Promise<string | null> {
			const credential = await store.get('google', accountId);
			return credential?.refreshToken ?? null;
		},
		set(accountId: string, refreshToken: string): Promise<void> {
			return store.set('google', accountId, { refreshToken });
		},
		remove(accountId: string): Promise<void> {
			return store.remove('google', accountId);
		},
	};
}

export function resolveSyncRuntime(
	value: SyncLifecycleService | AuthenticatedSyncRuntime | undefined,
	context: {
		readonly settings: CalendarPluginSettings;
		readonly repository: CalendarEventRepository;
		readonly stateStore: SyncStateStore;
		readonly clock?: SyncServiceClock;
	},
): SyncLifecycleService | undefined {
	if (!value) return undefined;
	if (!isAuthenticatedRuntime(value)) return value;
	const service = createSyncServiceFromRuntime(value, { ...context, clock: context.clock });
	if (service) return service;
	return {
		provider: value.provider,
		session: value.session,
		async start() {},
		async syncNow() {},
		async stop() {},
	};
}

export const DEFAULT_SYNC_MODE: SyncMode = 'disabled';
