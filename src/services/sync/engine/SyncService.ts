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
	type SyncSnapshotRecord,
	type SyncState,
	type SyncStateStore,
	type SyncTombstone,
	createDefaultSyncState,
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
import type {
	CalendarEventCreateOptions,
	CalendarEventInputLike,
	CalendarEventNoteRecord,
	CalendarEventRepository,
	CalendarEventReloadResult,
	LocalCalendarEventDeletion,
	CalendarEventUpdateOptions,
} from '../notes';
import { ConflictResolver, type ConflictChoice, type SyncConflictCandidate } from './ConflictResolver';
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

interface SnapshotPair {
	readonly local?: CalendarEventSnapshot;
	readonly remote?: CalendarEventSnapshot;
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

function localizeRemoteEvent(remote: RemoteCalendarEvent, localUid: string): CalendarEvent {
	return remote.event.uid === localUid ? cloneEvent(remote.event) : { ...remote.event, uid: localUid };
}

function readSnapshotPair(value: SyncSnapshotRecord | CalendarEventSnapshot | undefined): SnapshotPair {
	if (!value) return {};
	if ('event' in value && 'hash' in value && value.event && typeof value.hash === 'string') {
		return { local: value as CalendarEventSnapshot };
	}
	const record = value as SyncSnapshotRecord;
	return {
		local: record.local,
		remote: record.remote,
	};
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
	private readonly conflictResolver: ConflictResolver;
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
		this.conflictResolver = new ConflictResolver();
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
		const candidate = this.readConflictCandidate(record);
		const resolved = this.conflictResolver.choose(candidate, choice);
		if (!resolved.event) throw new Error(`Conflict "${key}" has no resolvable event`);
		const binding = this.findBindingByKey(key) ?? this.findBindingByLocalUid(record.localUid);
		if (!binding) throw new Error(`Conflict "${key}" has no local mapping`);
		const mapping = binding.mapping;
		const localUid = binding.localUid;
		const local = this.repository.getByUid(localUid);
		if (!local) throw new Error(`Conflict "${key}" local note is missing`);
		const signal = this.runController?.signal;
		await this.withInternalWrite(localUid, () => this.repository.update(local.path, resolved.event as CalendarEventInputLike, {
			status: 'pending',
		}));
		const remoteId = providerRemoteId(mapping);
		let resolvedMapping = { ...mapping };
		let resolvedRemote: RemoteCalendarEvent | undefined;
		let localProjectionSynced = false;
		if (this.mode === 'bidirectional' && remoteId && hashCalendarEvent(resolved.event) !== candidate.remote.hash) {
			const remote = await this.runQueuedProviderWrite(
				key,
				providerSignal => this.provider.updateEvent(
					this.session,
					this.calendarId,
					remoteId,
					resolved.event as CalendarEvent,
					mapping.version,
					providerSignal,
				),
				signal,
			);
			resolvedRemote = remote;
			resolvedMapping = {
				...resolvedMapping,
				version: remote.version,
				calendarUidPersisted: remote.calendarUid === localUid,
			};
			await this.withInternalWrite(localUid, () => this.repository.update(local.path, resolved.event as CalendarEventInputLike, {
				status: 'synced',
				association: makeAssociation(this.provider.id, this.session.accountId, this.calendarId, remoteId, 'synced'),
			}));
			localProjectionSynced = true;
		}
		const remoteSnapshot = candidate.remote;
		const remoteMatches = hashCalendarEvent(resolved.event) === remoteSnapshot.hash;
		if (remoteMatches && !localProjectionSynced) {
			await this.withInternalWrite(localUid, () => this.repository.update(local.path, resolved.event as CalendarEventInputLike, {
				status: 'synced',
				...(remoteId === undefined ? {} : {
					association: makeAssociation(this.provider.id, this.session.accountId, this.calendarId, remoteId, 'synced'),
				}),
			}));
			localProjectionSynced = true;
		}
		const snapshot = createCalendarEventSnapshot(resolved.event, nowIso(this.clock));
		const finalRemoteSnapshot = resolvedRemote
			? createCalendarEventSnapshot(localizeRemoteEvent(resolvedRemote, localUid), nowIso(this.clock))
			: remoteSnapshot;
		this.state.snapshots[key] = { local: snapshot, remote: finalRemoteSnapshot };
		this.state.mappings[key] = {
			...resolvedMapping,
			status: this.mode === 'import-only' && !remoteMatches ? 'pending' : 'synced',
			notePath: local.path,
		};
		delete this.state.conflicts[key];
		this.stateDirty = true;
		await this.saveState();
		this.setStatus('idle');
		return { key, event: resolved.event, status: 'resolved' };
	}

	async deleteSyncedEvent(localUid: string, signal?: AbortSignal): Promise<boolean> {
		await this.ensureLoaded();
		if (this.mode !== 'bidirectional') return false;
		const binding = this.findBindingByLocalUid(localUid);
		if (!binding) return false;
		const remoteId = providerRemoteId(binding.mapping);
		if (!remoteId) return false;
		const local = this.repository.getByUid(localUid);
		const trashOperation = this.repository.trash;
		if (!local || !trashOperation) return false;
		const trash = trashOperation.bind(this.repository);
		const runSignal = this.runController?.signal ?? signal;
		try {
			await this.runQueuedProviderWrite(binding.key, callbackSignal =>
				this.provider.deleteEvent(
					this.session,
					this.calendarId,
					remoteId,
					binding.mapping.version,
					callbackSignal,
				), runSignal);
		} catch (error) {
			if (!isCancellation(error)) await this.markNoteError(localUid);
			if (!isCancellation(error)) await this.recordError(error);
			return false;
		}
		let trashSucceeded = true;
		try {
			await this.withInternalWrite(localUid, () => trash(local.path));
		} catch (error) {
			trashSucceeded = false;
			await this.markNoteError(localUid);
			await this.recordError(error);
		}
		const tombstone: SyncTombstone = {
			localUid,
			providerId: this.provider.id,
			accountId: this.session.accountId,
			calendarId: this.calendarId,
			remoteEventId: remoteId,
			deletedAt: nowIso(this.clock),
			reason: 'explicit-delete',
		};
		this.state.tombstones[binding.key] = tombstone;
		this.state.mappings[binding.key] = { ...binding.mapping, status: 'deleted' };
		this.stateDirty = true;
		await this.saveState();
		return trashSucceeded;
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
			await this.pullChanges(signal, counters);
			await this.reconcileLocal(signal, counters);
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

	private async pullChanges(signal: AbortSignal, counters: MutableRunCounters): Promise<void> {
		const cursorKey = makeSyncStateKey(this.provider.id, this.session.accountId, this.calendarId);
		let cursor = this.readCursor(cursorKey);
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
					counters.fullResync = true;
					cursor = undefined;
					delete this.state.cursors[cursorKey];
					this.stateDirty = true;
					continue;
				}
				throw error;
			}
			for (const change of page.changes) {
				abortIfNeeded(signal);
				counters.pulled += 1;
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
			if (!page.hasMore) return;
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
		const binding = this.findBindingByRemote(change.remoteId);
		if (!binding || binding.mapping.status === 'remote_deleted' || binding.mapping.status === 'deleted') return;
		if (this.state.tombstones[binding.key]) return;
		const local = this.repository.getByUid(binding.localUid);
		if (local && this.mode !== 'dry-run') {
			await this.withInternalWrite(binding.localUid, () => this.repository.markRemoteDeleted(local.path));
		}
		this.state.mappings[binding.key] = { ...binding.mapping, status: 'remote_deleted' };
		this.state.tombstones[binding.key] = {
			localUid: binding.localUid,
			providerId: this.provider.id,
			accountId: this.session.accountId,
			calendarId: this.calendarId,
			remoteEventId: change.remoteId,
			deletedAt: nowIso(this.clock),
			reason: 'remote-delete',
		};
		this.stateDirty = true;
		counters.deleted += 1;
	}

	private async applyRemoteUpsert(
		remote: RemoteCalendarEvent,
		counters: MutableRunCounters,
		signal: AbortSignal,
	): Promise<void> {
		if (remote.providerId !== this.provider.id || remote.calendarId !== this.calendarId) return;
		const byRemote = this.findBindingByRemote(remote.remoteId);
		const byUid = remote.calendarUid === undefined
			? undefined
			: this.findBindingByLocalUid(remote.calendarUid);
		if (byRemote && this.state.tombstones[byRemote.key]) return;
		const existingNote = remote.calendarUid === undefined
			? undefined
			: this.repository.getByUid(remote.calendarUid);
		if (byRemote && remote.calendarUid !== undefined && byRemote.localUid !== remote.calendarUid) {
			await this.persistMappingConflict(byRemote.key, byRemote.localUid, remote, remote.calendarUid);
			counters.conflicts.push(byRemote.key);
			return;
		}
		if (byRemote && byUid && byRemote.localUid !== byUid.localUid) {
			await this.persistMappingConflict(byRemote.key, byRemote.localUid, remote, byUid.localUid);
			counters.conflicts.push(byRemote.key);
			return;
		}
		if (byUid && !this.sameBinding(byUid.mapping, remote)) {
			await this.persistMappingConflict(byUid.key, byUid.localUid, remote);
			counters.conflicts.push(byUid.key);
			return;
		}

		let binding = byRemote ?? byUid;
		let local = binding ? this.repository.getByUid(binding.localUid) : existingNote;
		if (!binding && local) {
			binding = {
				key: keyForBinding(this.provider.id, this.session.accountId, this.calendarId, local.event.uid),
				localUid: local.event.uid,
				mapping: {
					localUid: local.event.uid,
					notePath: local.path,
					providerId: this.provider.id,
					accountId: this.session.accountId,
					calendarId: this.calendarId,
					remoteEventId: remote.remoteId,
					version: remote.version,
					calendarUidPersisted: remote.calendarUid === local.event.uid,
					status: 'pending',
				},
			};
		}

		if (!binding) {
			if (this.mode === 'dry-run') return;
			const imported = await this.withInternalWrite('', () => this.repository.create(
				{ ...remote.event, uid: undefined },
				{
					status: remote.recurrence === 'unsupported' ? 'unsupported' : 'synced',
					association: makeAssociation(
						this.provider.id,
						this.session.accountId,
						this.calendarId,
						remote.remoteId,
						remote.recurrence === 'unsupported' ? 'unsupported' : 'synced',
					),
				},
			));
			local = imported;
			binding = {
				key: keyForBinding(this.provider.id, this.session.accountId, this.calendarId, imported.event.uid),
				localUid: imported.event.uid,
				mapping: {
					localUid: imported.event.uid,
					notePath: imported.path,
					providerId: this.provider.id,
					accountId: this.session.accountId,
					calendarId: this.calendarId,
					remoteEventId: remote.remoteId,
					version: remote.version,
					calendarUidPersisted: remote.calendarUid === imported.event.uid,
					status: remote.recurrence === 'unsupported' ? 'unsupported' : 'synced',
				},
			};
			this.state.mappings[binding.key] = binding.mapping;
			this.state.snapshots[binding.key] = {
				local: createCalendarEventSnapshot(imported.event, nowIso(this.clock)),
				remote: createCalendarEventSnapshot(localizeRemoteEvent(remote, imported.event.uid), nowIso(this.clock)),
			};
			this.stateDirty = true;
			counters.imported += 1;
			return;
		}

		if (!local) {
			if (this.state.tombstones[binding.key] || binding.mapping.status === 'local_deleted') return;
			// A missing local note is a local deletion. Preserve the remote mapping
			// as a tombstone instead of recreating a note or deleting the event.
			this.state.tombstones[binding.key] = {
				localUid: binding.localUid,
				providerId: this.provider.id,
				accountId: this.session.accountId,
				calendarId: this.calendarId,
				remoteEventId: remote.remoteId,
				deletedAt: nowIso(this.clock),
				reason: 'local-note-missing',
			};
			this.state.mappings[binding.key] = { ...binding.mapping, status: 'local_deleted' };
			this.stateDirty = true;
			return;
		}

		const mapping = {
			...binding.mapping,
			notePath: local.path,
			version: remote.version,
			remoteEventId: remote.remoteId,
			calendarUidPersisted: binding.mapping.calendarUidPersisted === true || remote.calendarUid === binding.localUid,
		};
		this.state.mappings[binding.key] = mapping;
		this.stateDirty = true;
		const localNote = local;
		const localized = localizeRemoteEvent(remote, binding.localUid);
		const pair = readSnapshotPair(this.state.snapshots[binding.key]);
		if (remote.recurrence === 'unsupported') {
			if (this.mode !== 'dry-run') await this.withInternalWrite(binding.localUid, () => this.repository.markUnsupported(localNote.path));
			this.state.mappings[binding.key] = { ...mapping, status: 'unsupported' };
			this.state.snapshots[binding.key] = {
				local: pair.local ?? createCalendarEventSnapshot(local.event, nowIso(this.clock)),
				remote: createCalendarEventSnapshot(localized, nowIso(this.clock)),
			};
			this.stateDirty = true;
			return;
		}

		const remoteSnapshot = createCalendarEventSnapshot(localized, nowIso(this.clock));
		if (this.mode === 'dry-run') return;
		const localSnapshot = createCalendarEventSnapshot(localNote.event, nowIso(this.clock));
		if (!pair.local || !pair.remote) {
			if (hashCalendarEvent(localNote.event) !== remoteSnapshot.hash && pair.local) {
				this.persistConflict(binding.key, binding.localUid, pair.local, localSnapshot, remoteSnapshot);
				counters.conflicts.push(binding.key);
				return;
			}
			await this.withInternalWrite(binding.localUid, () => this.repository.update(localNote.path, localized, {
				status: 'synced',
				association: makeAssociation(this.provider.id, this.session.accountId, this.calendarId, remote.remoteId, 'synced'),
			}));
			this.state.snapshots[binding.key] = { local: remoteSnapshot, remote: remoteSnapshot };
			this.state.mappings[binding.key] = { ...mapping, status: 'synced' };
			this.stateDirty = true;
			counters.localUpdated += 1;
			return;
		}

		const localChanged = hashCalendarEvent(localNote.event) !== pair.local.hash;
		const remoteChanged = remoteSnapshot.hash !== pair.remote.hash;
		if (!remoteChanged) {
			this.state.mappings[binding.key] = { ...mapping, status: 'synced' };
			return;
		}
		if (!localChanged) {
			await this.withInternalWrite(binding.localUid, () => this.repository.update(localNote.path, localized, {
				status: 'synced',
				association: makeAssociation(this.provider.id, this.session.accountId, this.calendarId, remote.remoteId, 'synced'),
			}));
			this.state.snapshots[binding.key] = { local: remoteSnapshot, remote: remoteSnapshot };
			this.state.mappings[binding.key] = { ...mapping, status: 'synced' };
			this.stateDirty = true;
			counters.localUpdated += 1;
			return;
		}

		const merged = this.conflictResolver.resolve(pair.local, localSnapshot, remoteSnapshot);
		if (merged.status === 'conflict' || !merged.event) {
			this.persistConflict(binding.key, binding.localUid, pair.local, localSnapshot, remoteSnapshot, merged.conflicts);
			await this.withInternalWrite(binding.localUid, () => this.repository.update(localNote.path, localNote.event, {
				status: 'conflict',
				association: makeAssociation(this.provider.id, this.session.accountId, this.calendarId, remote.remoteId, 'conflict'),
			}));
			counters.conflicts.push(binding.key);
			return;
		}
		await this.withInternalWrite(binding.localUid, () => this.repository.update(localNote.path, merged.event as CalendarEventInputLike, {
			status: 'pending',
			association: makeAssociation(this.provider.id, this.session.accountId, this.calendarId, remote.remoteId, 'pending'),
		}));
		let finalRemote = remote;
		if (this.mode === 'bidirectional') {
			finalRemote = await this.runQueuedProviderWrite(binding.key, callbackSignal => this.provider.updateEvent(
				this.session,
				this.calendarId,
				remote.remoteId,
				merged.event as CalendarEvent,
				remote.version,
				callbackSignal,
			), signal);
			counters.remoteUpdated += 1;
		}
		const finalSnapshot = createCalendarEventSnapshot(merged.event, nowIso(this.clock));
		const remoteMatches = finalSnapshot.hash === remoteSnapshot.hash;
		if (this.mode === 'import-only' && remoteMatches) {
			await this.withInternalWrite(binding.localUid, () => this.repository.update(localNote.path, merged.event as CalendarEventInputLike, {
				status: 'synced',
				association: makeAssociation(this.provider.id, this.session.accountId, this.calendarId, remote.remoteId, 'synced'),
			}));
		}
		const finalRemoteSnapshot = this.mode === 'import-only'
			? remoteSnapshot
			: createCalendarEventSnapshot(localizeRemoteEvent(finalRemote, binding.localUid), nowIso(this.clock));
		this.state.snapshots[binding.key] = { local: finalSnapshot, remote: finalRemoteSnapshot };
		this.state.mappings[binding.key] = {
			...mapping,
			version: finalRemote.version,
			calendarUidPersisted: finalRemote.calendarUid === binding.localUid,
			status: this.mode === 'import-only' && !remoteMatches ? 'pending' : 'synced',
		};
		this.stateDirty = true;
		counters.localUpdated += 1;
	}

	private async reconcileLocal(signal: AbortSignal, counters: MutableRunCounters): Promise<void> {
		const operations: Promise<unknown>[] = [];
		for (const note of this.repository.list()) {
			abortIfNeeded(signal);
			const binding = this.findBindingByLocalUid(note.event.uid);
			if (!binding) {
				if (this.mode === 'bidirectional') {
					operations.push(this.enqueueCreate(note, counters, signal));
				}
				continue;
			}
			if (binding.mapping.notePath !== note.path) {
				this.state.mappings[binding.key] = { ...binding.mapping, notePath: note.path };
				this.stateDirty = true;
			}
			if (
				binding.mapping.status === 'remote_deleted' ||
				binding.mapping.status === 'deleted' ||
				binding.mapping.status === 'unsupported' ||
				binding.mapping.status === 'conflict' ||
				binding.mapping.status === 'local_deleted' ||
				this.state.tombstones[binding.key]
			) continue;
			operations.push(this.reconcileLocalNote(note, binding, counters, signal));
		}
		await this.queue.flush();
		const results = await Promise.all(operations.map(operation => operation.then(
			() => ({ ok: true as const }),
			error => ({ ok: false as const, error }),
		)));
		const failed = results.find(result => !result.ok);
		if (failed && !failed.ok) throw failed.error;
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

	private async reconcileLocalNote(
		note: CalendarEventNoteRecord,
		binding: Binding,
		counters: MutableRunCounters,
		signal: AbortSignal,
	): Promise<void> {
		try {
			await this.reconcileLocalNoteInternal(note, binding, counters, signal);
		} catch (error) {
			if (!isCancellation(error)) await this.markNoteError(binding.localUid);
			throw error;
		}
	}

	private async reconcileLocalNoteInternal(
		note: CalendarEventNoteRecord,
		binding: Binding,
		counters: MutableRunCounters,
		signal: AbortSignal,
	): Promise<void> {
		const pair = readSnapshotPair(this.state.snapshots[binding.key]);
		const localSnapshot = createCalendarEventSnapshot(note.event, nowIso(this.clock));
		const internalHash = this.internalWriteHashes.get(binding.localUid);
		if (internalHash !== undefined) {
			this.internalWriteHashes.delete(binding.localUid);
			if (internalHash === localSnapshot.hash) return;
		}
		const remoteId = providerRemoteId(binding.mapping);
		if (!pair.local) {
			this.state.snapshots[binding.key] = { ...pair, local: localSnapshot };
			this.stateDirty = true;
			return;
		}
		if (this.mode === 'bidirectional' && remoteId && binding.mapping.calendarUidPersisted !== true) {
			const remote = await this.runQueuedProviderWrite(binding.key, callbackSignal => this.provider.updateEvent(
				this.session,
				this.calendarId,
				remoteId,
				localSnapshot.event,
				binding.mapping.version,
				callbackSignal,
			), signal);
			const calendarUidPersisted = remote.calendarUid === binding.localUid;
			const remoteSnapshot = createCalendarEventSnapshot(
				localizeRemoteEvent(remote, binding.localUid),
				nowIso(this.clock),
			);
			const associationStatus = calendarUidPersisted ? 'synced' : 'pending';
			await this.withInternalWrite(binding.localUid, () => this.repository.update(note.path, localSnapshot.event, {
				status: associationStatus,
				association: makeAssociation(
					this.provider.id,
					this.session.accountId,
					this.calendarId,
					remoteId,
					associationStatus,
				),
			}));
			this.state.snapshots[binding.key] = { local: localSnapshot, remote: remoteSnapshot };
			this.state.mappings[binding.key] = {
				...binding.mapping,
				version: remote.version,
				calendarUidPersisted,
				status: associationStatus,
			};
			this.stateDirty = true;
			counters.remoteUpdated += 1;
			return;
		}
		if (localSnapshot.hash === pair.local.hash) {
			if (this.mode === 'bidirectional' && remoteId && pair.remote && pair.remote.hash !== pair.local.hash) {
			const remote = await this.runQueuedProviderWrite(binding.key, callbackSignal => this.provider.updateEvent(
					this.session,
					this.calendarId,
					remoteId,
					localSnapshot.event,
					binding.mapping.version,
					callbackSignal,
				), signal);
				await this.withInternalWrite(binding.localUid, () => this.repository.update(note.path, localSnapshot.event, {
					status: 'synced',
					association: makeAssociation(this.provider.id, this.session.accountId, this.calendarId, remoteId, 'synced'),
				}));
				this.state.snapshots[binding.key] = {
					local: localSnapshot,
					remote: createCalendarEventSnapshot(localizeRemoteEvent(remote, binding.localUid), nowIso(this.clock)),
				};
				this.state.mappings[binding.key] = {
					...binding.mapping,
					version: remote.version,
					calendarUidPersisted: remote.calendarUid === binding.localUid,
					status: 'synced',
				};
				this.stateDirty = true;
				counters.remoteUpdated += 1;
			}
			return;
		}
		if (!remoteId || !pair.remote || this.mode !== 'bidirectional') return;
		const remoteChanged = pair.remote.hash !== pair.local.hash;
		if (remoteChanged) {
			const merged = this.conflictResolver.resolve(pair.local, localSnapshot, pair.remote);
			if (merged.status === 'conflict' || !merged.event) {
				this.persistConflict(binding.key, binding.localUid, pair.local, localSnapshot, pair.remote, merged.conflicts);
				await this.withInternalWrite(binding.localUid, () => this.repository.update(note.path, note.event, { status: 'conflict' }));
				counters.conflicts.push(binding.key);
				return;
			}
			await this.withInternalWrite(binding.localUid, () => this.repository.update(note.path, merged.event as CalendarEventInputLike, { status: 'pending' }));
			const remote = await this.runQueuedProviderWrite(binding.key, callbackSignal => this.provider.updateEvent(
				this.session,
				this.calendarId,
				remoteId,
				merged.event as CalendarEvent,
				binding.mapping.version,
				callbackSignal,
			), signal);
			const snapshot = createCalendarEventSnapshot(merged.event, nowIso(this.clock));
			const remoteSnapshot = createCalendarEventSnapshot(
				localizeRemoteEvent(remote, binding.localUid),
				nowIso(this.clock),
			);
			this.state.snapshots[binding.key] = { local: snapshot, remote: remoteSnapshot };
			this.state.mappings[binding.key] = {
				...binding.mapping,
				version: remote.version,
				calendarUidPersisted: remote.calendarUid === binding.localUid,
				status: 'synced',
			};
			this.stateDirty = true;
			counters.remoteUpdated += 1;
			return;
		}
		const remote = await this.runQueuedProviderWrite(binding.key, callbackSignal => this.provider.updateEvent(
			this.session,
			this.calendarId,
			remoteId,
			localSnapshot.event,
			binding.mapping.version,
			callbackSignal,
		), signal);
		const remoteSnapshot = createCalendarEventSnapshot(
			localizeRemoteEvent(remote, binding.localUid),
			nowIso(this.clock),
		);
		this.state.snapshots[binding.key] = { local: localSnapshot, remote: remoteSnapshot };
		this.state.mappings[binding.key] = {
			...binding.mapping,
			version: remote.version,
			calendarUidPersisted: remote.calendarUid === binding.localUid,
			status: 'synced',
		};
		this.stateDirty = true;
		counters.remoteUpdated += 1;
	}

	private enqueueCreate(note: CalendarEventNoteRecord, counters: MutableRunCounters, signal: AbortSignal): Promise<void> {
		const key = keyForBinding(this.provider.id, this.session.accountId, this.calendarId, note.event.uid);
		const operation = this.enqueueProviderWrite(key, async providerSignal => {
			const pendingMapping: SyncMapping = {
				localUid: note.event.uid,
				notePath: note.path,
				providerId: this.provider.id,
				accountId: this.session.accountId,
				calendarId: this.calendarId,
				status: 'pending',
			};
			this.state.mappings[key] = pendingMapping;
			this.stateDirty = true;
			const remote = await this.provider.createEvent(this.session, this.calendarId, note.event, providerSignal);
			const mapping: SyncMapping = {
				...pendingMapping,
				remoteEventId: remote.remoteId,
				version: remote.version,
				calendarUidPersisted: remote.calendarUid === note.event.uid,
				status: 'synced',
			};
			const snapshot = createCalendarEventSnapshot(note.event, nowIso(this.clock));
			const remoteSnapshot = createCalendarEventSnapshot(
				localizeRemoteEvent(remote, note.event.uid),
				nowIso(this.clock),
			);
			this.state.mappings[key] = mapping;
			this.state.snapshots[key] = { local: snapshot, remote: remoteSnapshot };
			this.stateDirty = true;
			await this.withInternalWrite(note.event.uid, () => this.repository.update(note.path, note.event, {
				status: 'synced',
				association: makeAssociation(this.provider.id, this.session.accountId, this.calendarId, remote.remoteId, 'synced'),
			}));
			counters.remoteCreated += 1;
		}, signal);
		return operation.then(() => undefined).catch(async error => {
			if (isCancellation(error)) throw error;
			await this.markNoteError(note.event.uid);
			await this.recordError(error);
			throw error;
		});
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

	private sameBinding(binding: SyncMapping, remote: RemoteCalendarEvent): boolean {
		return (
			binding.providerId === remote.providerId &&
			binding.calendarId === remote.calendarId &&
			binding.accountId === this.session.accountId &&
				providerRemoteId(binding) === remote.remoteId &&
				(remote.calendarUid === undefined || binding.localUid === remote.calendarUid)
		);
	}

	private persistConflict(
		key: string,
		localUid: string,
		base: CalendarEventSnapshot,
		local: CalendarEventSnapshot,
		remote: CalendarEventSnapshot,
		conflicts: readonly { field: string }[] = [],
	): void {
		this.state.conflicts[key] = {
			localUid,
			fields: conflicts.length > 0 ? conflicts.map(conflict => conflict.field) : ['event'],
			base,
			local,
			remote,
			createdAt: nowIso(this.clock),
		};
		this.state.mappings[key] = { ...(this.state.mappings[key] ?? {}), localUid, status: 'conflict' };
		this.stateDirty = true;
	}

	private async persistMappingConflict(key: string, localUid: string, remote: RemoteCalendarEvent, otherLocalUid?: string): Promise<void> {
		const local = this.repository.getByUid(localUid);
		const localSnapshot = local ? createCalendarEventSnapshot(local.event, nowIso(this.clock)) : undefined;
		const remoteSnapshot = local
			? createCalendarEventSnapshot(localizeRemoteEvent(remote, localUid), nowIso(this.clock))
			: undefined;
		this.state.conflicts[key] = {
			localUid,
			fields: ['uid', 'remoteEventId'],
			base: otherLocalUid ? { localUid: otherLocalUid } : undefined,
			local: localSnapshot,
			remote: remoteSnapshot,
			createdAt: nowIso(this.clock),
		};
		this.state.mappings[key] = { ...(this.state.mappings[key] ?? {}), localUid, status: 'conflict' };
		this.stateDirty = true;
		if (local && this.mode !== 'dry-run') {
			await this.withInternalWrite(localUid, () => this.repository.update(local.path, local.event, {
				status: 'conflict',
				association: makeAssociation(this.provider.id, this.session.accountId, this.calendarId, remote.remoteId, 'conflict'),
			}));
		}
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
		const binding = this.findBindingByLocalUid(deletion.uid);
		const key = binding?.key ?? keyForBinding(this.provider.id, this.session.accountId, this.calendarId, deletion.uid);
		this.state.tombstones[key] = {
			localUid: deletion.uid,
			providerId: this.provider.id,
			accountId: this.session.accountId,
			calendarId: this.calendarId,
			remoteEventId: binding ? providerRemoteId(binding.mapping) : undefined,
			deletedAt: nowIso(this.clock),
			reason: 'local-delete',
		};
		if (binding) this.state.mappings[key] = { ...binding.mapping, notePath: undefined, status: 'local_deleted' };
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

	private async recordError(error: unknown): Promise<void> {
		if (this.mode === 'dry-run') return;
		this.state = withSyncStateError(this.state, error, nowIso(this.clock));
		this.stateDirty = true;
		await this.saveState();
	}

	private async markNoteError(localUid: string): Promise<void> {
		if (this.mode === 'dry-run') return;
		const note = this.repository.getByUid(localUid);
		if (!note) return;
		await this.withInternalWrite(localUid, () => this.repository.markError(note.path));
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
