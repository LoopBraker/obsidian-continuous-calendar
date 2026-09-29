import type { SyncMode, SyncHorizon } from '../../../settings/settings';
import {
	createCalendarEventSnapshot,
	hashCalendarEvent,
	type CalendarEvent,
	type CalendarEventAssociation,
	type CalendarEventSnapshot,
	type ProviderReference,
} from '../model';
import {
	makeSyncStateKey,
	type SyncConflictRecord,
	type SyncCursor,
	type SyncMapping,
	type SyncState,
	type SyncStateStore,
	createDefaultSyncState,
	type CachedCalendarEvent,
	withSyncStateError,
} from '../state';
import type {
	CalendarProvider,
	ChangePage,
	OpaqueCursor,
	ProviderId,
	ProviderSession,
	RemoteCalendarEvent,
	RemoteChange,
	SyncWindow,
} from '../providers';
import { isProviderCancelledError, isProviderError } from '../providers/ProviderErrors';
import { normalizeCalendarEvent } from '../model/CalendarEventValidation';
import type {
	CalendarEventCreateOptions,
	CalendarEventInputLike,
	CalendarEventNoteRecord,
	CalendarEventRepository,
	CalendarEventReloadResult,
	LocalCalendarEventDeletion,
	CalendarEventUpdateOptions,
} from '../notes';
import type { ConflictChoice, SyncConflictCandidate } from './ConflictResolver';
import { SyncQueue, type SyncQueueScheduler } from './SyncQueue';

export type SyncRunTrigger = 'startup' | 'manual' | 'interval' | 'retry' | 'full-resync';

export type SyncServiceStatus =
	| 'idle'
	| 'starting'
	| 'running'
	| 'disabled'
	| 'dry-run'
	| 'offline'
	| 'conflict'
	| 'error'
	| 'cancelled'
	| 'stopped';

export interface SyncServiceStatusSnapshot {
	readonly status: SyncServiceStatus;
	readonly mode: SyncMode;
	readonly trigger?: SyncRunTrigger;
	readonly startedAt?: string;
	readonly completedAt?: string;
	readonly conflictCount: number;
	readonly pendingOutbound: number;
	readonly lastError?: string;
}

export interface SyncRunResult {
	readonly trigger: SyncRunTrigger;
	readonly status: SyncServiceStatus;
	readonly pulled: number;
	readonly imported: number;
	readonly localUpdated: number;
	readonly remoteCreated: number;
	readonly remoteUpdated: number;
	readonly conflicts: readonly string[];
	readonly deleted: number;
	readonly fullResync: boolean;
	readonly skippedReason?: string;
	readonly error?: string;
}

export interface SyncServiceClock {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
	setInterval(callback: () => void, delayMs: number): unknown;
	clearInterval(handle: unknown): void;
}

const defaultClock: SyncServiceClock = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
	clearTimeout: handle => globalThis.clearTimeout(handle as number),
	setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
	clearInterval: handle => globalThis.clearInterval(handle as number),
};

export interface SyncServiceRetryOptions {
	readonly maxAttempts?: number;
	readonly baseDelayMs?: number;
	readonly maxDelayMs?: number;
}

export interface SyncRepositoryLike {
	reload(): Promise<CalendarEventReloadResult>;
	list(): readonly CalendarEventNoteRecord[];
	getByUid(uid: string): CalendarEventNoteRecord | undefined;
	getByPath(path: string): CalendarEventNoteRecord | undefined;
	create(input: CalendarEventInputLike, options?: CalendarEventCreateOptions): Promise<CalendarEventNoteRecord>;
	update(
		pathOrUid: string,
		input: CalendarEventInputLike,
		options?: CalendarEventUpdateOptions,
	): Promise<CalendarEventNoteRecord>;
	markRemoteDeleted(pathOrUid: string): Promise<CalendarEventNoteRecord>;
	markUnsupported(pathOrUid: string): Promise<CalendarEventNoteRecord>;
	markError(pathOrUid: string): Promise<CalendarEventNoteRecord>;
	onLocalDeletion?(listener: (deletion: LocalCalendarEventDeletion) => void): () => void;
	trash?(path: string): Promise<void>;
}

export interface SyncStateStoreLike {
	load(): Promise<SyncState>;
	save(state: SyncState): Promise<unknown>;
	getState?(): SyncState;
}

export interface CachedCalendarEventView extends CachedCalendarEvent {
	readonly key: string;
}

export interface SyncServiceOptions {
	readonly provider: CalendarProvider;
	readonly session: ProviderSession;
	readonly calendarId: string;
	readonly repository: SyncRepositoryLike | CalendarEventRepository;
	readonly stateStore: SyncStateStoreLike | SyncStateStore;
	readonly mode?: SyncMode;
	readonly syncMode?: SyncMode;
	readonly window?: SyncWindow | (() => SyncWindow);
	readonly timezone?: string;
	readonly horizon?: SyncHorizon;
	readonly pollIntervalMinutes?: number;
	readonly pollIntervalMs?: number;
	readonly debounceMs?: number;
	readonly retry?: SyncServiceRetryOptions;
	readonly clock?: SyncServiceClock;
	readonly queue?: SyncQueue;
	readonly queueScheduler?: SyncQueueScheduler;
	readonly maxPages?: number;
	readonly autoStart?: boolean;
}

export interface SyncConflictView extends SyncConflictRecord {
	readonly key: string;
}

export interface SyncConflictResolutionResult {
	readonly key: string;
	readonly event: CalendarEvent;
	readonly status: 'resolved';
}

interface Binding {
	readonly key: string;
	readonly mapping: SyncMapping;
	readonly localUid: string;
}

interface MutableRunCounters {
	pulled: number;
	imported: number;
	localUpdated: number;
	remoteCreated: number;
	remoteUpdated: number;
	deleted: number;
	fullResync: boolean;
	conflicts: string[];
}

function isSyncMode(value: SyncMode | undefined): value is SyncMode {
	return value === 'disabled' || value === 'dry-run' || value === 'import-only' || value === 'bidirectional';
}

function cloneEvent(event: CalendarEvent): CalendarEvent {
	return { ...event };
}

function nowIso(clock: SyncServiceClock): string {
	return new Date(clock.now()).toISOString();
}

function keyForBinding(providerId: ProviderId, accountId: string, calendarId: string, localUid: string): string {
	return makeSyncStateKey(providerId, accountId, calendarId, 'local', localUid);
}

function providerRemoteId(mapping: SyncMapping): string | undefined {
	const value = mapping.remoteEventId ?? mapping.remoteId;
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function mappingMatchesBinding(
	mapping: SyncMapping,
	providerId: ProviderId,
	accountId: string,
	calendarId: string,
): boolean {
	return (
		mapping.providerId === providerId &&
		mapping.accountId === accountId &&
		mapping.calendarId === calendarId
	);
}

function makeAssociation(
	providerId: ProviderId,
	accountId: string,
	calendarId: string,
	remoteEventId: string,
	status: 'pending' | 'synced' | 'conflict' | 'remote_deleted' | 'unsupported' | 'error',
): CalendarEventAssociation {
	const reference: ProviderReference = {
		providerId,
		accountId,
		calendarId,
		remoteEventId,
	};
	return { calendarUid: '', reference, status };
}

function sanitizedErrorMessage(error: unknown): string {
	if (isProviderError(error)) return error.message;
	return error instanceof Error ? error.message : String(error);
}

function isRetryable(error: unknown): boolean {
	return isProviderError(error) && error.retryable;
}

function isCursorExpired(error: unknown): boolean {
	return isProviderError(error) && error.category === 'cursor-expired';
}

function isCancellation(error: unknown): boolean {
	return isProviderCancelledError(error) || (error instanceof Error && error.name === 'AbortError');
}

function abortIfNeeded(signal: AbortSignal): void {
	if (signal.aborted) {
		const error = new Error(signal.reason === undefined ? 'Sync cancelled' : String(signal.reason));
		error.name = 'AbortError';
		throw error;
	}
}

function defaultWindow(clock: SyncServiceClock, horizon: SyncHorizon): SyncWindow {
	const now = new Date(clock.now());
	const from = new Date(now.getTime() - horizon.pastDays * 86_400_000);
	const to = new Date(now.getTime() + horizon.futureDays * 86_400_000);
	return { from: from.toISOString(), to: to.toISOString() };
}

function eventIntersectsWindow(event: CalendarEvent, window: SyncWindow): boolean {
	const windowStart = Date.parse(window.from);
	const windowEnd = Date.parse(window.to);
	const eventStart = Date.parse(event.allDay ? `${event.start}T00:00:00Z` : event.start);
	const eventEnd = Date.parse(event.allDay ? `${event.end}T00:00:00Z` : event.end);
	if (![windowStart, windowEnd, eventStart, eventEnd].every(Number.isFinite)) return true;
	return eventStart < windowEnd && eventEnd > windowStart;
}

/**
 * Provider-neutral reconciliation engine. It owns no provider wire details and
 * only uses repository operations that update synchronized frontmatter.
 */
export class SyncService {
	readonly provider: CalendarProvider;
	readonly repository: SyncRepositoryLike;
	readonly stateStore: SyncStateStoreLike;
	readonly session: ProviderSession;
	readonly calendarId: string;
	readonly mode: SyncMode;
	readonly queue: SyncQueue;

	private readonly clock: SyncServiceClock;
	private readonly windowInput?: SyncWindow | (() => SyncWindow);
	private readonly horizon: SyncHorizon;
	private readonly retry: Required<SyncServiceRetryOptions>;
	private readonly debounceMs: number;
	private readonly pollIntervalMs: number;
	private readonly maxPages: number;
	private readonly listeners = new Set<(status: SyncServiceStatusSnapshot) => void>();
	private state: SyncState = createDefaultSyncState();
	private loaded = false;
	private started = false;
	private intervalHandle?: unknown;
	private runController?: AbortController;
	private runPromise?: Promise<SyncRunResult>;
	private unsubscribeDeletion?: () => void;
	private internalWriteDepth = 0;
	private readonly internalWriteHashes = new Map<string, string>();
	private readonly pendingDeletions: LocalCalendarEventDeletion[] = [];
	private stateDirty = false;
	private statusSnapshot: SyncServiceStatusSnapshot;

	constructor(options: SyncServiceOptions) {
		this.provider = options.provider;
		this.repository = options.repository;
		this.stateStore = options.stateStore;
		this.session = options.session;
		this.calendarId = options.calendarId;
		this.mode = options.mode ?? options.syncMode ?? 'disabled';
		this.clock = options.clock ?? defaultClock;
		this.windowInput = options.window;
		this.horizon = options.horizon ?? { pastDays: 365, futureDays: 730 };
		this.retry = {
			maxAttempts: Math.max(1, Math.floor(options.retry?.maxAttempts ?? 3)),
			baseDelayMs: Math.max(0, options.retry?.baseDelayMs ?? 250),
			maxDelayMs: Math.max(options.retry?.baseDelayMs ?? 250, options.retry?.maxDelayMs ?? 5_000),
		};
		this.debounceMs = Math.max(0, options.debounceMs ?? 25);
		this.pollIntervalMs = Math.max(
			1,
			Math.floor(options.pollIntervalMs ?? (options.pollIntervalMinutes ?? 5) * 60_000),
		);
		this.maxPages = Math.max(1, Math.floor(options.maxPages ?? 100));
		this.queue = options.queue ?? new SyncQueue(options.queueScheduler);
		this.statusSnapshot = this.makeStatus('idle');
		this.unsubscribeDeletion = this.repository.onLocalDeletion?.(deletion => this.onLocalDeletion(deletion));
		if (options.autoStart) void this.start();
	}

	get status(): SyncServiceStatusSnapshot {
		return this.statusSnapshot;
	}

	get isStarted(): boolean {
		return this.started;
	}

	get isInternalWrite(): boolean {
		return this.internalWriteDepth > 0;
	}

	get conflicts(): readonly SyncConflictView[] {
		return Object.entries(this.state.conflicts).map(([key, value]) => ({ key, ...value }));
	}

	/** Cached remote events, including events that have no Markdown note. */
	listCachedEvents(): readonly CachedCalendarEventView[] {
		const state = this.stateStore.getState?.() ?? this.state;
		return Object.entries(state.remoteEvents).map(([key, value]) => ({ key, ...value }));
	}

	/** Create a provider event directly, without creating a Markdown note. */
	async createCalendarEvent(input: CalendarEventInputLike): Promise<CachedCalendarEventView> {
		await this.ensureLoaded();
		this.assertProviderWritesEnabled();
		const event = normalizeCalendarEvent(input);
		const remote = await this.runQueuedProviderWrite(
			makeSyncStateKey(this.provider.id, this.session.accountId, this.calendarId, 'create', event.uid),
			signal => this.provider.createEvent(this.session, this.calendarId, event, signal),
		);
		const cached = this.cacheRemoteEvent(remote);
		this.stateDirty = true;
		await this.saveState();
		return cached;
	}

	/** Update a cached provider event directly; its canonical UID is immutable. */
	async updateCalendarEvent(key: string, input: CalendarEventInputLike): Promise<CachedCalendarEventView> {
		await this.ensureLoaded();
		this.assertProviderWritesEnabled();
		const current = this.state.remoteEvents[key];
		if (!current || current.status === 'remote_deleted') throw new Error(`Cached calendar event "${key}" was not found`);
		if (current.status === 'unsupported' || current.recurrence === 'unsupported') {
			throw new Error('Recurring Google Calendar events cannot be edited from Continuous Calendar');
		}
		const candidate = normalizeCalendarEvent(input);
		if (candidate.uid !== current.event.uid) throw new Error('Calendar event UID cannot be changed');
		const remote = await this.runQueuedProviderWrite(key, signal => this.provider.updateEvent(
			this.session,
			this.calendarId,
			current.remoteEventId,
			candidate,
			current.version,
			signal,
		));
		const cached = this.cacheRemoteEvent(remote, current.notePath, current.noteUid);
		await this.mirrorRemoteEventToLinkedNote(cached);
		this.stateDirty = true;
		await this.saveState();
		return cached;
	}

	/** Delete only the provider event. A linked note remains in the vault. */
	async deleteCalendarEvent(key: string): Promise<boolean> {
		await this.ensureLoaded();
		if (this.mode !== 'bidirectional') return false;
		const current = this.state.remoteEvents[key];
		if (!current || current.status === 'remote_deleted') return false;
		if (current.status === 'unsupported' || current.recurrence === 'unsupported') {
			throw new Error('Recurring Google Calendar events cannot be deleted from Continuous Calendar');
		}
		try {
			await this.runQueuedProviderWrite(key, signal => this.provider.deleteEvent(
				this.session,
				this.calendarId,
				current.remoteEventId,
				current.version,
				signal,
			));
		} catch (error) {
			await this.recordError(error);
			return false;
		}
		const deleted: CachedCalendarEvent = { ...current, status: 'remote_deleted' };
		this.state.remoteEvents[key] = deleted;
		await this.mirrorRemoteEventToLinkedNote(deleted);
		this.stateDirty = true;
		await this.saveState();
		return true;
	}

	/** Attach an already-created note to a cached event, without provider writes. */
	async linkNote(key: string, path: string, uid: string): Promise<CachedCalendarEventView> {
		await this.ensureLoaded();
		const cached = this.state.remoteEvents[key];
		if (!cached || cached.status === 'remote_deleted') throw new Error(`Cached calendar event "${key}" was not found`);
		const note = this.repository.getByPath(path) ?? this.repository.getByUid(uid);
		if (!note || note.path !== path || note.event.uid !== uid) throw new Error(`Calendar event note "${path}" was not found`);
		const linked = { ...cached, notePath: note.path, noteUid: uid };
		const mapped = this.linkMapping(linked);
		const localized = { ...linked.event, uid };
		await this.withInternalWrite(uid, () => this.repository.update(note.path, localized, {
			status: linked.status === 'unsupported' ? 'unsupported' : 'synced',
			association: makeAssociation(this.provider.id, this.session.accountId, this.calendarId, linked.remoteEventId, linked.status === 'unsupported' ? 'unsupported' : 'synced'),
		}));
		this.state.remoteEvents[key] = linked;
		this.state.mappings[mapped.key] = mapped.mapping;
		const snapshot = createCalendarEventSnapshot(localized, nowIso(this.clock));
		this.state.snapshots[mapped.key] = { local: snapshot, remote: snapshot };
		this.stateDirty = true;
		await this.saveState();
		return { key, ...linked };
	}

	subscribe(listener: (status: SyncServiceStatusSnapshot) => void): () => void {
		this.listeners.add(listener);
		listener(this.statusSnapshot);
		return () => this.listeners.delete(listener);
	}

	onStatus(listener: (status: SyncServiceStatusSnapshot) => void): () => void {
		return this.subscribe(listener);
	}

	async start(): Promise<SyncRunResult> {
		if (this.started && this.runPromise) return this.runPromise;
		this.started = true;
		this.setStatus(this.mode === 'disabled' ? 'disabled' : 'starting');
		try {
			await this.ensureLoaded();
			this.flushPendingDeletions();
			if (this.mode === 'disabled') {
				return this.skippedResult('startup', 'disabled');
			}
			const result = await this.syncNow('startup');
			this.scheduleInterval();
			return result;
		} catch (error) {
			this.setStatus(isCancellation(error) ? 'cancelled' : 'error', error);
			throw error;
		}
	}

	async stop(): Promise<void> {
		this.started = false;
		if (this.intervalHandle !== undefined) {
			this.clock.clearInterval(this.intervalHandle);
			this.intervalHandle = undefined;
		}
		this.runController?.abort(new Error('Sync service stopped'));
		this.queue.cancel('Sync service stopped');
		this.setStatus('stopped');
	}

	dispose(): void {
		void this.stop();
		this.unsubscribeDeletion?.();
		this.unsubscribeDeletion = undefined;
	}

	async syncNow(trigger: SyncRunTrigger = 'manual', signal?: AbortSignal): Promise<SyncRunResult> {
		if (this.runPromise) return this.runPromise;
		const controller = new AbortController();
		this.runController = controller;
		let removeExternalAbortListener: (() => void) | undefined;
		if (signal) {
			if (signal.aborted) controller.abort(signal.reason);
			else {
				const onAbort = () => controller.abort(signal.reason);
				signal.addEventListener('abort', onAbort, { once: true });
				removeExternalAbortListener = () => signal.removeEventListener('abort', onAbort);
			}
		}
		const runSignal = controller.signal;
		this.runPromise = this.run(trigger, runSignal).finally(() => {
			removeExternalAbortListener?.();
			this.runPromise = undefined;
			if (this.runController === controller) this.runController = undefined;
		});
		return this.runPromise;
	}

	async pullNow(signal?: AbortSignal): Promise<SyncRunResult> {
		return this.syncNow('manual', signal);
	}

	async resolveConflict(
		key: string,
		choice: ConflictChoice | CalendarEvent,
	): Promise<SyncConflictResolutionResult> {
		await this.ensureLoaded();
		const record = this.state.conflicts[key];
		if (!record) throw new Error(`Sync conflict "${key}" was not found`);
		if (this.mode === 'disabled' || this.mode === 'dry-run') {
			throw new Error(`Conflict resolution is unavailable in ${this.mode} mode`);
		}
		if (choice !== 'remote') {
			throw new Error('Google Calendar is authoritative for event fields; local conflict choices are unavailable');
		}
		const candidate = this.readConflictCandidate(record);
		const resolvedEvent = candidate.remote.event;
		const binding = this.findBindingByKey(key) ?? this.findBindingByLocalUid(record.localUid);
		if (!binding) throw new Error(`Conflict "${key}" has no local mapping`);
		const localUid = binding.localUid;
		const local = this.repository.getByUid(localUid);
		if (!local) throw new Error(`Conflict "${key}" local note is missing`);
		const remoteId = providerRemoteId(binding.mapping);
		const localized = { ...resolvedEvent, uid: localUid };
		await this.withInternalWrite(localUid, () => this.repository.update(local.path, localized as CalendarEventInputLike, {
			status: 'synced',
			...(remoteId === undefined ? {} : {
				association: makeAssociation(this.provider.id, this.session.accountId, this.calendarId, remoteId, 'synced'),
			}),
		}));
		const snapshot = createCalendarEventSnapshot(localized, nowIso(this.clock));
		this.state.snapshots[key] = { local: snapshot, remote: snapshot };
		this.state.mappings[key] = {
			...binding.mapping,
			status: 'synced',
			notePath: local.path,
		};
		delete this.state.conflicts[key];
		this.stateDirty = true;
		await this.saveState();
		this.setStatus('idle');
		return { key, event: localized, status: 'resolved' };
	}

	async deleteSyncedEvent(localUid: string, signal?: AbortSignal): Promise<boolean> {
		await this.ensureLoaded();
		void signal;
		const key = Object.entries(this.state.remoteEvents).find(([, cached]) => cached.noteUid === localUid)?.[0];
		return key ? this.deleteCalendarEvent(key) : false;
	}

	private async run(trigger: SyncRunTrigger, signal: AbortSignal): Promise<SyncRunResult> {
		const counters: MutableRunCounters = {
			pulled: 0,
			imported: 0,
			localUpdated: 0,
			remoteCreated: 0,
			remoteUpdated: 0,
			deleted: 0,
			fullResync: false,
			conflicts: [],
		};
		if (!isSyncMode(this.mode) || this.mode === 'disabled') return this.skippedResult(trigger, 'disabled', counters);
		this.setStatus(this.mode === 'dry-run' ? 'dry-run' : 'running', undefined, trigger);
		const startedAt = nowIso(this.clock);
		try {
			await this.ensureLoaded();
			abortIfNeeded(signal);
			const reload = await this.repository.reload();
			this.reconcileReloadDeletions(reload);
			await this.pullChanges(signal, counters, trigger);
			await this.mirrorCachedEventsToLinkedNotes();
			this.refreshLinkedNotePaths();
			await this.queue.flush();
			await this.saveState();
			const status: SyncServiceStatus = this.mode === 'dry-run'
				? 'dry-run'
				: counters.conflicts.length > 0 ? 'conflict' : 'idle';
			this.setStatus(status, undefined, trigger, startedAt);
			return { ...counters, trigger, status, conflicts: counters.conflicts };
		} catch (error) {
			if (isCancellation(error)) {
				await this.saveState();
				this.setStatus('cancelled', error, trigger, startedAt);
				return { ...counters, trigger, status: 'cancelled', conflicts: counters.conflicts, error: sanitizedErrorMessage(error) };
			}
			const status: SyncServiceStatus = isRetryable(error) ? 'offline' : 'error';
			await this.recordError(error);
			this.setStatus(status, error, trigger, startedAt);
			return { ...counters, trigger, status, conflicts: counters.conflicts, error: sanitizedErrorMessage(error) };
		}
	}

	private async pullChanges(signal: AbortSignal, counters: MutableRunCounters, trigger: SyncRunTrigger): Promise<void> {
		const cursorKey = makeSyncStateKey(this.provider.id, this.session.accountId, this.calendarId);
		const seenRemoteEvents = new Set<string>();
		let fullResync = trigger === 'full-resync' || this.state.eventCacheInitialized[cursorKey] !== true;
		let cursor = fullResync ? undefined : this.readCursor(cursorKey);
		if (fullResync) {
			counters.fullResync = true;
			delete this.state.eventCacheInitialized[cursorKey];
		}
		let fullResyncAttempted = false;
		for (let pageNumber = 0; pageNumber < this.maxPages; pageNumber += 1) {
			abortIfNeeded(signal);
			let page: ChangePage;
			try {
				page = await this.callWithRetry('pullChanges', callbackSignal => this.provider.pullChanges({
					session: this.session,
					calendarId: this.calendarId,
					cursor,
					window: this.resolveWindow(),
					signal: callbackSignal,
				}), signal);
			} catch (error) {
				if (isCursorExpired(error) && !fullResyncAttempted) {
					fullResyncAttempted = true;
					fullResync = true;
					counters.fullResync = true;
					cursor = undefined;
					delete this.state.eventCacheInitialized[cursorKey];
					delete this.state.cursors[cursorKey];
					this.stateDirty = true;
					continue;
				}
				throw error;
			}
			for (const change of page.changes) {
				abortIfNeeded(signal);
				counters.pulled += 1;
				const remoteId = change.type === 'upsert' ? change.value.remoteId : change.remoteId;
				seenRemoteEvents.add(makeSyncStateKey(this.provider.id, this.session.accountId, this.calendarId, remoteId));
				await this.applyRemoteChange(change, counters, signal);
				await this.saveState();
			}
			if (page.nextCursor !== undefined) {
				cursor = page.nextCursor;
				this.state.cursors[cursorKey] = {
					providerId: this.provider.id,
					accountId: this.session.accountId,
					calendarId: this.calendarId,
					cursor: page.nextCursor,
					updatedAt: nowIso(this.clock),
				};
				this.stateDirty = true;
				await this.saveState();
			}
			if (!page.hasMore) {
				if (fullResync) {
					await this.reconcileFullResync(seenRemoteEvents, this.resolveWindow());
					this.state.eventCacheInitialized[cursorKey] = true;
					this.stateDirty = true;
					await this.saveState();
				}
				return;
			}
			if (page.nextCursor === undefined && cursor === undefined) throw new Error('Provider returned hasMore without a cursor');
		}
		throw new Error(`Provider change pull exceeded ${this.maxPages} pages`);
	}

	private async applyRemoteChange(change: RemoteChange, counters: MutableRunCounters, signal: AbortSignal): Promise<void> {
		if (change.type === 'delete') {
			await this.applyRemoteDeletion(change, counters);
			return;
		}
		await this.applyRemoteUpsert(change.value, counters, signal);
	}

	private async applyRemoteDeletion(
		change: Extract<RemoteChange, { type: 'delete' }>,
		counters: MutableRunCounters,
	): Promise<void> {
		if (change.providerId !== this.provider.id || change.calendarId !== this.calendarId) return;
		if (this.mode === 'dry-run') return;
		const key = makeSyncStateKey(this.provider.id, this.session.accountId, this.calendarId, change.remoteId);
		let cached = this.state.remoteEvents[key];
		if (!cached) {
			// During the first cache migration, a cancelled Google event may be the
			// first record we see. Recover its canonical value from its old sync
			// snapshot so a linked legacy note still receives the deleted status.
			const binding = this.findBindingByRemote(change.remoteId);
			if (!binding) return;
			const snapshotRecord = this.state.snapshots[binding.key] as {
				readonly event?: CalendarEvent;
				readonly remote?: CalendarEventSnapshot;
			} | undefined;
			const eventValue = snapshotRecord?.event ?? snapshotRecord?.remote?.event ?? this.repository.getByUid(binding.localUid)?.event;
			if (!eventValue) return;
			cached = {
				providerId: this.provider.id,
				accountId: this.session.accountId,
				calendarId: this.calendarId,
				remoteEventId: change.remoteId,
				event: cloneEvent(eventValue),
				version: binding.mapping.version,
				recurrence: 'none',
				status: 'synced',
				...(binding.mapping.notePath === undefined ? {} : { notePath: binding.mapping.notePath }),
				noteUid: binding.localUid,
			};
		}
		if (cached.status === 'remote_deleted') return;
		const deleted = { ...cached, status: 'remote_deleted' as const };
		this.state.remoteEvents[key] = deleted;
		await this.mirrorRemoteEventToLinkedNote(deleted);
		const binding = this.findBindingByRemote(change.remoteId);
		if (binding) this.state.mappings[binding.key] = { ...binding.mapping, status: 'remote_deleted' };
		this.stateDirty = true;
		counters.deleted += 1;
	}

	private async applyRemoteUpsert(
		remote: RemoteCalendarEvent,
		counters: MutableRunCounters,
		_signal: AbortSignal,
	): Promise<void> {
		if (remote.providerId !== this.provider.id || remote.calendarId !== this.calendarId) return;
		if (this.mode === 'dry-run') return;
		const remoteKey = makeSyncStateKey(this.provider.id, this.session.accountId, this.calendarId, remote.remoteId);
		const existing = this.state.remoteEvents[remoteKey];
		const mapping = this.findBindingByRemote(remote.remoteId);
		let noteUid = existing?.noteUid ?? mapping?.localUid;
		let note = noteUid ? this.repository.getByUid(noteUid) : undefined;
		if (!note) {
			const associatedNotes = this.repository.list().filter(candidate => {
				const reference = candidate.association?.reference;
				return reference?.providerId === this.provider.id &&
					reference.accountId === this.session.accountId &&
					reference.calendarId === this.calendarId &&
					reference.remoteEventId === remote.remoteId;
			});
			if (associatedNotes.length === 1) {
				note = associatedNotes[0];
				noteUid = note.event.uid;
			}
		}
		// Legacy providers wrote the local note UID into private event metadata.
		// Use that only to recover an existing link; never create a note from it.
		if (!note && remote.calendarUid) {
			const candidate = this.repository.getByUid(remote.calendarUid);
			const reference = candidate?.association?.reference;
			if (
				candidate && reference?.providerId === this.provider.id &&
				reference.accountId === this.session.accountId &&
				reference.calendarId === this.calendarId &&
				reference.remoteEventId === remote.remoteId
			) {
				note = candidate;
				noteUid = candidate.event.uid;
			}
		}
		if (!note) noteUid = undefined;
		// Some providers cannot apply the date window while using incremental
		// cursors. Keep the configured horizon at the cache boundary while still
		// updating previously cached or explicitly linked events when they move
		// outside it.
		if (!existing && !mapping && !note && !eventIntersectsWindow(remote.event, this.resolveWindow())) return;

		const cached = this.cacheRemoteEvent(remote, note?.path, noteUid);
		if (note && noteUid) {
			const linkedNote = note;
			const localKey = keyForBinding(this.provider.id, this.session.accountId, this.calendarId, noteUid);
			const status = cached.status === 'unsupported' ? 'unsupported' : 'synced';
			const localized = { ...cached.event, uid: noteUid };
			if (hashCalendarEvent(linkedNote.event) !== hashCalendarEvent(localized) || linkedNote.status !== status) {
				await this.withInternalWrite(noteUid, () => this.repository.update(linkedNote.path, localized, {
					status,
					association: makeAssociation(this.provider.id, this.session.accountId, this.calendarId, remote.remoteId, status),
				}));
				counters.localUpdated += 1;
			}
			const nextMapping = {
				...(mapping?.mapping ?? {}),
				localUid: noteUid,
				notePath: linkedNote.path,
				providerId: this.provider.id,
				accountId: this.session.accountId,
				calendarId: this.calendarId,
				remoteEventId: remote.remoteId,
				version: remote.version,
				status,
			};
			this.state.mappings[localKey] = nextMapping;
			const snapshot = createCalendarEventSnapshot(localized, nowIso(this.clock));
			this.state.snapshots[localKey] = { local: snapshot, remote: snapshot };
		}
		this.stateDirty = true;
	}

	private enqueueProviderWrite<T>(
		key: string,
		work: (signal: AbortSignal) => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		if (signal) abortIfNeeded(signal);
		return this.queue.enqueue(key, context => {
			const providerSignal = signal ?? context.signal;
			abortIfNeeded(providerSignal);
			return work(providerSignal);
		}, {
			debounceMs: this.debounceMs,
			signal,
			maxAttempts: this.retry.maxAttempts,
			baseDelayMs: this.retry.baseDelayMs,
			maxDelayMs: this.retry.maxDelayMs,
			shouldRetry: error => isRetryable(error),
		});
	}

	private async runQueuedProviderWrite<T>(
		key: string,
		work: (signal: AbortSignal) => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		const operation = this.enqueueProviderWrite(key, work, signal);
		await this.queue.flush();
		return operation;
	}

	private findBindingByLocalUid(localUid: string | undefined): Binding | undefined {
		if (!localUid) return undefined;
		for (const [key, mapping] of Object.entries(this.state.mappings)) {
			if (mapping.localUid === localUid && mappingMatchesBinding(mapping, this.provider.id, this.session.accountId, this.calendarId)) {
				return { key, mapping, localUid };
			}
		}
		return undefined;
	}

	private findBindingByRemote(remoteId: string): Binding | undefined {
		for (const [key, mapping] of Object.entries(this.state.mappings)) {
			if (
				providerRemoteId(mapping) === remoteId &&
				mappingMatchesBinding(mapping, this.provider.id, this.session.accountId, this.calendarId) &&
				typeof mapping.localUid === 'string'
			) return { key, mapping, localUid: mapping.localUid };
		}
		return undefined;
	}

	private findBindingByKey(key: string): Binding | undefined {
		const mapping = this.state.mappings[key];
		return mapping && typeof mapping.localUid === 'string'
			? { key, mapping, localUid: mapping.localUid }
			: undefined;
	}

	private readConflictCandidate(record: SyncConflictRecord): SyncConflictCandidate {
		const base = record.base as CalendarEventSnapshot | undefined;
		const local = record.local as CalendarEventSnapshot | undefined;
		const remote = record.remote as CalendarEventSnapshot | undefined;
		if (!base?.event || !local?.event || !remote?.event) throw new Error('Sync conflict candidates are incomplete');
		return { base, local, remote, conflicts: [] };
	}

	private onLocalDeletion(deletion: LocalCalendarEventDeletion): void {
		if (this.internalWriteDepth > 0) return;
		if (!this.loaded) {
			this.pendingDeletions.push(deletion);
			return;
		}
		this.recordLocalDeletion(deletion);
		void this.saveState();
	}

	/**
	 * The repository emits a missing old path before rebuilding its index. A
	 * rename therefore appears in the same reload result as a deletion; restore
	 * the existing UID binding when the UID is present at a new path.
	 */
	private reconcileReloadDeletions(reload: CalendarEventReloadResult): void {
		for (const deletion of reload.deleted) {
			const moved = reload.records.find(record => record.event.uid === deletion.uid);
			if (!moved) {
				if (!this.unsubscribeDeletion) this.recordLocalDeletion(deletion);
				continue;
			}
			const binding = this.findBindingByLocalUid(deletion.uid);
			if (!binding) continue;
			const tombstone = this.state.tombstones[binding.key];
			if (tombstone?.reason !== 'local-delete') continue;
			delete this.state.tombstones[binding.key];
			this.state.mappings[binding.key] = {
				...binding.mapping,
				notePath: moved.path,
				status: moved.status ?? 'synced',
			};
			this.stateDirty = true;
		}
	}

	private recordLocalDeletion(deletion: LocalCalendarEventDeletion): void {
		for (const [remoteKey, cached] of Object.entries(this.state.remoteEvents)) {
			if (cached.noteUid === deletion.uid) {
				this.state.remoteEvents[remoteKey] = { ...cached, notePath: undefined, noteUid: undefined };
			}
		}
		const binding = this.findBindingByLocalUid(deletion.uid);
		if (binding) {
			delete this.state.mappings[binding.key];
			delete this.state.snapshots[binding.key];
			delete this.state.conflicts[binding.key];
			delete this.state.tombstones[binding.key];
		}
		this.stateDirty = true;
	}

	private flushPendingDeletions(): void {
		for (const deletion of this.pendingDeletions.splice(0)) this.recordLocalDeletion(deletion);
	}

	private async withInternalWrite<T>(localUid: string, operation: () => Promise<T>): Promise<T> {
		this.internalWriteDepth += 1;
		try {
			const result = await operation();
			if (localUid) {
				const note = this.repository.getByUid(localUid);
				if (note) this.internalWriteHashes.set(localUid, hashCalendarEvent(note.event));
			}
			return result;
		} finally {
			this.internalWriteDepth -= 1;
		}
	}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		this.state = await this.stateStore.load();
		this.loaded = true;
	}

	private async saveState(): Promise<void> {
		if (!this.loaded || !this.stateDirty || this.mode === 'dry-run') return;
		await this.stateStore.save(this.state);
		this.stateDirty = false;
	}

	private assertProviderWritesEnabled(): void {
		if (this.mode !== 'bidirectional') {
			throw new Error(`Provider event writes are unavailable in ${this.mode} mode`);
		}
	}

	private cacheRemoteEvent(
		remote: RemoteCalendarEvent,
		notePath?: string,
		noteUid?: string,
	): CachedCalendarEventView {
		const key = makeSyncStateKey(remote.providerId, this.session.accountId, remote.calendarId, remote.remoteId);
		const status = remote.recurrence === 'unsupported' ? 'unsupported' : 'synced';
		const cached: CachedCalendarEvent = {
			providerId: remote.providerId,
			accountId: this.session.accountId,
			calendarId: remote.calendarId,
			remoteEventId: remote.remoteId,
			event: cloneEvent(remote.event),
			version: remote.version,
			remoteUpdatedAt: remote.remoteUpdatedAt,
			recurrence: remote.recurrence,
			status,
			...(notePath === undefined ? {} : { notePath }),
			...(noteUid === undefined ? {} : { noteUid }),
		};
		this.state.remoteEvents[key] = cached;
		return { key, ...cached };
	}

	private async reconcileFullResync(seenRemoteEvents: ReadonlySet<string>, window: SyncWindow): Promise<void> {
		if (this.mode === 'dry-run') return;
		const from = Date.parse(window.from);
		const to = Date.parse(window.to);
		for (const [key, cached] of Object.entries(this.state.remoteEvents)) {
			if (
				cached.providerId !== this.provider.id ||
				cached.accountId !== this.session.accountId ||
				cached.calendarId !== this.calendarId ||
				cached.status === 'remote_deleted' ||
				seenRemoteEvents.has(key)
			) continue;
			const startsAt = Date.parse(cached.event.start);
			// A bounded full sync cannot infer deletion for events that have fallen
			// outside the requested horizon.
			if (!Number.isFinite(startsAt) || startsAt < from || startsAt >= to) continue;
			const deleted: CachedCalendarEvent = { ...cached, status: 'remote_deleted' };
			this.state.remoteEvents[key] = deleted;
			await this.mirrorRemoteEventToLinkedNote(deleted);
			const binding = this.findBindingByRemote(cached.remoteEventId);
			if (binding) this.state.mappings[binding.key] = { ...binding.mapping, status: 'remote_deleted' };
			this.stateDirty = true;
		}
	}

	private linkMapping(cached: CachedCalendarEvent): { key: string; mapping: SyncMapping } {
		const previous = this.findBindingByRemote(cached.remoteEventId);
		const key = keyForBinding(this.provider.id, this.session.accountId, this.calendarId, cached.noteUid ?? '');
		return {
			key,
			mapping: {
				...(previous?.mapping ?? {}),
				localUid: cached.noteUid,
				notePath: cached.notePath,
				providerId: this.provider.id,
				accountId: this.session.accountId,
				calendarId: this.calendarId,
				remoteEventId: cached.remoteEventId,
				version: cached.version,
				status: cached.status,
			},
		};
	}

	private async mirrorRemoteEventToLinkedNote(cached: CachedCalendarEvent): Promise<void> {
		if (!cached.noteUid) return;
		const note = this.repository.getByUid(cached.noteUid) ?? (cached.notePath ? this.repository.getByPath(cached.notePath) : undefined);
		if (!note) return;
		if (cached.status === 'remote_deleted') {
			if (note.status !== 'remote_deleted') {
				await this.withInternalWrite(note.event.uid, () => this.repository.markRemoteDeleted(note.path));
				this.stateDirty = true;
			}
			const binding = this.findBindingByRemote(cached.remoteEventId);
			if (binding && (binding.mapping.notePath !== note.path || binding.mapping.status !== 'remote_deleted')) {
				this.state.mappings[binding.key] = { ...binding.mapping, notePath: note.path, status: 'remote_deleted' };
				this.stateDirty = true;
			}
			return;
		}
		const localized = { ...cached.event, uid: note.event.uid };
		const syncStatus = cached.status === 'unsupported' ? 'unsupported' : 'synced';
		if (hashCalendarEvent(note.event) !== hashCalendarEvent(localized) || note.status !== syncStatus) {
			await this.withInternalWrite(note.event.uid, () => this.repository.update(note.path, localized, {
				status: syncStatus,
				association: makeAssociation(this.provider.id, this.session.accountId, this.calendarId, cached.remoteEventId, syncStatus),
			}));
			this.stateDirty = true;
		}
		const mapping = this.linkMapping({ ...cached, noteUid: note.event.uid, notePath: note.path });
		const existingMapping = this.state.mappings[mapping.key];
		if (!existingMapping || existingMapping.notePath !== mapping.mapping.notePath || existingMapping.status !== mapping.mapping.status || existingMapping.version !== mapping.mapping.version) {
			this.state.mappings[mapping.key] = mapping.mapping;
			this.stateDirty = true;
		}
		const snapshot = createCalendarEventSnapshot(localized, nowIso(this.clock));
		const existingSnapshot = this.state.snapshots[mapping.key] as { local?: CalendarEventSnapshot; remote?: CalendarEventSnapshot } | undefined;
		if (existingSnapshot?.local?.hash !== snapshot.hash || existingSnapshot?.remote?.hash !== snapshot.hash) {
			this.state.snapshots[mapping.key] = { local: snapshot, remote: snapshot };
			this.stateDirty = true;
		}
	}

	private async mirrorCachedEventsToLinkedNotes(): Promise<void> {
		if (this.mode === 'dry-run') return;
		for (const cached of Object.values(this.state.remoteEvents)) {
			if (
				cached.providerId === this.provider.id &&
				cached.accountId === this.session.accountId &&
				cached.calendarId === this.calendarId &&
				cached.noteUid
			) await this.mirrorRemoteEventToLinkedNote(cached);
		}
	}

	private refreshLinkedNotePaths(): void {
		for (const [key, cached] of Object.entries(this.state.remoteEvents)) {
			if (!cached.noteUid) continue;
			const note = this.repository.getByUid(cached.noteUid);
			if (note) {
				if (cached.notePath !== note.path) {
					this.state.remoteEvents[key] = { ...cached, notePath: note.path };
					const binding = this.findBindingByRemote(cached.remoteEventId);
					if (binding) this.state.mappings[binding.key] = { ...binding.mapping, notePath: note.path };
					this.stateDirty = true;
				}
				continue;
			}
			this.state.remoteEvents[key] = { ...cached, notePath: undefined, noteUid: undefined };
			const binding = this.findBindingByRemote(cached.remoteEventId);
			if (binding) {
				delete this.state.mappings[binding.key];
				delete this.state.snapshots[binding.key];
				delete this.state.conflicts[binding.key];
				delete this.state.tombstones[binding.key];
			}
			this.stateDirty = true;
		}
	}

	private async recordError(error: unknown): Promise<void> {
		if (this.mode === 'dry-run') return;
		this.state = withSyncStateError(this.state, error, nowIso(this.clock));
		this.stateDirty = true;
		await this.saveState();
	}

	private readCursor(key: string): OpaqueCursor | undefined {
		const value = this.state.cursors[key] as SyncCursor | string | undefined;
		if (typeof value === 'string') return value;
		if (value && typeof value.cursor === 'string') return value.cursor;
		if (value && typeof value.value === 'string') return value.value;
		return undefined;
	}

	private resolveWindow(): SyncWindow {
		if (typeof this.windowInput === 'function') return this.windowInput();
		if (this.windowInput) return this.windowInput;
		return defaultWindow(this.clock, this.horizon);
	}

	private async callWithRetry<T>(
		operation: string,
		call: (signal: AbortSignal) => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		let attempt = 0;
		while (attempt < this.retry.maxAttempts) {
			attempt += 1;
			const operationSignal = signal ?? new AbortController().signal;
			abortIfNeeded(operationSignal);
			try {
				return await call(operationSignal);
			} catch (error) {
				if (!isRetryable(error) || attempt >= this.retry.maxAttempts) throw error;
				const delay = this.retryDelay(error, attempt);
				await this.sleep(delay, signal);
			}
		}
		throw new Error(`${operation} failed after ${this.retry.maxAttempts} attempts`);
	}

	private retryDelay(error: unknown, attempt: number): number {
		const retryAfter = isProviderError(error) ? error.retryAfterMs : undefined;
		const exponential = this.retry.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
		return Math.min(this.retry.maxDelayMs, Math.max(0, retryAfter ?? exponential));
	}

	private sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
		if (delayMs <= 0) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				this.clock.clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				const error = new Error('Sync cancelled');
				error.name = 'AbortError';
				reject(error);
			};
			const timer = this.clock.setTimeout(() => {
				signal?.removeEventListener('abort', onAbort);
				resolve();
			}, delayMs);
			if (signal) signal.addEventListener('abort', onAbort, { once: true });
		});
	}

	private scheduleInterval(): void {
		if (!this.started || this.mode === 'disabled' || this.intervalHandle !== undefined) return;
		this.intervalHandle = this.clock.setInterval(() => {
			void this.syncNow('interval');
		}, this.pollIntervalMs);
	}

	private skippedResult(trigger: SyncRunTrigger, reason: string, counters: MutableRunCounters = {
		pulled: 0,
		imported: 0,
		localUpdated: 0,
		remoteCreated: 0,
		remoteUpdated: 0,
		deleted: 0,
		fullResync: false,
		conflicts: [],
	}): SyncRunResult {
		this.setStatus(this.mode === 'disabled' ? 'disabled' : 'dry-run');
		return { ...counters, trigger, status: this.mode === 'disabled' ? 'disabled' : 'dry-run', skippedReason: reason };
	}

	private makeStatus(
		status: SyncServiceStatus,
		_error?: unknown,
		_trigger?: SyncRunTrigger,
		_startedAt?: string,
	): SyncServiceStatusSnapshot {
		return {
			status,
			mode: this.mode,
			trigger: _trigger,
			startedAt: _startedAt,
			completedAt: status === 'idle' || status === 'error' || status === 'offline' || status === 'cancelled'
				? nowIso(this.clock)
				: undefined,
			conflictCount: Object.keys(this.state.conflicts).length,
			pendingOutbound: this.queue.pendingKeys.length,
			lastError: _error === undefined ? undefined : sanitizedErrorMessage(_error),
		};
	}

	private setStatus(
		status: SyncServiceStatus,
		error?: unknown,
		trigger?: SyncRunTrigger,
		startedAt?: string,
	): void {
		this.statusSnapshot = this.makeStatus(status, error, trigger, startedAt);
		for (const listener of this.listeners) listener(this.statusSnapshot);
	}
}

export const CalendarSyncService = SyncService;
