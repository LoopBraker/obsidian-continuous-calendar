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
	type CachedCalendarOccurrence,
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
	RemoteOccurrence,
	RemoteEventLookupResult,
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
	CalendarNoteOccurrenceTarget,
	CalendarNoteTarget,
} from '../notes';
import { calendarNoteTargetMatchesProviderReference, targetKey } from '../notes';
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
	readonly localRepairCount: number;
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
	getByTarget?(target: CalendarNoteTarget): CalendarEventNoteRecord | undefined;
	getTargetClaimants?(target: CalendarNoteTarget): readonly { readonly path: string }[];
	migrateLegacyTargets?(
		resolveVerifiedTarget: (record: CalendarEventNoteRecord) =>
			| CalendarNoteTarget
			| { readonly target: CalendarNoteTarget; readonly association?: CalendarEventAssociation }
			| undefined
			| Promise<CalendarNoteTarget | { readonly target: CalendarNoteTarget; readonly association?: CalendarEventAssociation } | undefined>,
	): Promise<unknown>;
	proposeDayTargetDate?(pathOrUid: string, nextEventInput: CalendarEventInputLike): Promise<CalendarEventNoteRecord>;
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

export interface CachedCalendarOccurrenceView extends CachedCalendarOccurrence {
	readonly key: string;
	readonly stale: boolean;
}

/** A confirmed occurrence write may still need local note repair. */
export interface CalendarOccurrenceWriteResult extends CachedCalendarOccurrenceView {
	readonly localRepairPending: boolean;
}

/** A confirmed provider write may still need local cache/note repair. */
export interface CalendarEventWriteResult extends CachedCalendarEventView {
	readonly localRepairPending: boolean;
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

function sameProviderOwnedFields(left: CalendarEvent, right: CalendarEvent): boolean {
	return left.title === right.title && left.start === right.start && left.end === right.end &&
		left.allDay === right.allDay && left.timezone === right.timezone &&
		left.location === right.location && left.description === right.description &&
		JSON.stringify(left.recurrence ?? null) === JSON.stringify(right.recurrence ?? null);
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

function cachedRecurrenceStatus(event: CachedCalendarEvent): 'none' | 'supported' | 'unsupported' {
	return event.recurrenceStatus ?? (event.recurrence === 'unsupported' ? 'unsupported' : 'none');
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

function newProviderCreateRequestId(): string {
	const bytes = new Uint8Array(16);
	const runtimeCrypto = (globalThis as unknown as { crypto?: { getRandomValues?: (values: Uint8Array) => Uint8Array } }).crypto;
	if (!runtimeCrypto?.getRandomValues) throw new Error('Secure event ID generation is unavailable');
	runtimeCrypto.getRandomValues(bytes);
	return `cc${Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')}`;
}

export class ProviderOutcomeUnknownError extends Error {
	constructor() {
		super('Google may have saved this event. Check its status before retrying.');
		this.name = 'ProviderOutcomeUnknownError';
	}
}

/** A provider rejected the write because its version changed; the engine never resends stale fields. */
export class ProviderWriteConflictError extends Error {
	readonly latest?: RemoteEventLookupResult;

	constructor(latest?: RemoteEventLookupResult) {
		super('The Google event changed before it could be saved. Review the latest version before trying again.');
		this.name = 'ProviderWriteConflictError';
		this.latest = latest;
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

function occurrenceSlotValue(
	slot: { readonly date?: string; readonly dateTime?: string; readonly timeZone?: string },
	masterTimezone?: string,
): string {
	return slot.date !== undefined
		? `date:${slot.date}`
		: `dateTime:${slot.dateTime ?? ''}:${slot.timeZone ?? masterTimezone ?? ''}`;
}

function slotWithMasterTimezone(
	slot: { readonly date?: string; readonly dateTime?: string; readonly timeZone?: string },
	masterTimezone?: string,
): { readonly date?: string; readonly dateTime?: string; readonly timeZone?: string } {
	if (slot.date !== undefined) return { date: slot.date };
	return {
		...(slot.dateTime === undefined ? {} : { dateTime: slot.dateTime }),
		...((slot.timeZone ?? masterTimezone) === undefined ? {} : { timeZone: slot.timeZone ?? masterTimezone }),
	};
}

function providerConflict(error: unknown): boolean {
	return isProviderError(error) && (error.category === 'conflict' || error.status === 412);
}

function sameSlotIdentity(
	left: { readonly date?: string; readonly dateTime?: string; readonly timeZone?: string },
	right: { readonly date?: string; readonly dateTime?: string; readonly timeZone?: string },
	masterTimezone?: string,
): boolean {
	if (left.date !== undefined || right.date !== undefined) return left.date === right.date;
	const normalizedLeft = slotWithMasterTimezone(left, masterTimezone);
	const normalizedRight = slotWithMasterTimezone(right, masterTimezone);
	return normalizedLeft.dateTime === normalizedRight.dateTime &&
		normalizedLeft.timeZone !== undefined && normalizedLeft.timeZone === normalizedRight.timeZone;
}

function uniqueTarget(targets: readonly CalendarNoteTarget[]): CalendarNoteTarget | undefined {
	const byKey = new Map<string, CalendarNoteTarget>();
	for (const target of targets) byKey.set(targetKey(target), target);
	return byKey.size === 1 ? byKey.values().next().value : undefined;
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

	/** Complete or last-known recurrence slots; stale rows remain visible offline. */
	listCachedOccurrences(): readonly CachedCalendarOccurrenceView[] {
		const state = this.stateStore.getState?.() ?? this.state;
		return Object.entries(state.remoteOccurrences).map(([key, value]) => {
			const coverage = state.occurrenceCoverage[this.coverageKey(value.masterRemoteId)];
			return { key, ...value, stale: !coverage?.completedAt || coverage.dirty === true || value.unresolved === true };
		});
	}

	private async fetchForWriteOutcome(remoteId: string): Promise<RemoteEventLookupResult | undefined> {
		if (!this.provider.fetchEvent) return undefined;
		try {
			return await this.provider.fetchEvent(this.session, this.calendarId, remoteId);
		} catch (_error) {
			return undefined;
		}
	}

	/** Create a provider event directly, without creating a Markdown note. */
	async createCalendarEvent(input: CalendarEventInputLike): Promise<CalendarEventWriteResult> {
		await this.ensureLoaded();
		this.assertProviderWritesEnabled();
		const event = normalizeCalendarEvent(input);
		const intentKey = makeSyncStateKey(this.provider.id, this.session.accountId, this.calendarId, 'create', event.uid);
		let intent = this.state.providerCreateIntents[intentKey];
		if (intent) {
			if (intent.status === 'confirmed' && intent.remoteEventId) {
				const cachedKey = makeSyncStateKey(this.provider.id, this.session.accountId, this.calendarId, intent.remoteEventId);
				const cached = this.state.remoteEvents[cachedKey];
				const repairKey = makeSyncStateKey(this.provider.id, this.session.accountId, this.calendarId, 'repair', intent.remoteEventId);
				if (cached) return { key: cachedKey, ...cached, localRepairPending: this.state.localRepairs[repairKey] !== undefined };
			}
			const lookup = await this.fetchForWriteOutcome(intent.requestId);
			if (!lookup) throw new ProviderOutcomeUnknownError();
			if (lookup.status === 'active') {
				if (lookup.event.remoteId !== intent.requestId || lookup.event.event.uid !== event.uid) throw new ProviderOutcomeUnknownError();
				this.state.providerCreateIntents[intentKey] = { ...intent, status: 'confirmed', remoteEventId: lookup.event.remoteId };
				const cached = this.cacheRemoteEvent(lookup.event);
				return this.finishCommittedWrite(cached);
			}
			// A confirmed intent is never POSTed again, even if a later lookup
			// cannot find it. Pending/unknown intents may retry with the same
			// provider event ID only after an exact not-found response.
			if (intent.status === 'confirmed' || lookup.status !== 'not-found' ||
				lookup.providerId !== this.provider.id || lookup.calendarId !== this.calendarId || lookup.remoteId !== intent.requestId) {
				throw new ProviderOutcomeUnknownError();
			}
			intent = { ...intent, status: 'pending' };
			this.state.providerCreateIntents[intentKey] = intent;
			this.stateDirty = true;
			await this.saveState();
		}
		intent ??= {
			providerId: this.provider.id,
			accountId: this.session.accountId,
			calendarId: this.calendarId,
			eventUid: event.uid,
			requestId: newProviderCreateRequestId(),
			status: 'pending',
			createdAt: nowIso(this.clock),
		};
		this.state.providerCreateIntents[intentKey] = intent;
		this.stateDirty = true;
		// Do not issue POST unless its stable identity is durably recoverable.
		await this.saveState();
		let remote: RemoteCalendarEvent;
		try {
			remote = await this.runQueuedProviderWrite(
				intentKey,
				signal => this.provider.createEvent(this.session, this.calendarId, event, signal, intent.requestId),
				undefined,
				1,
			);
		} catch (error) {
			this.state.providerCreateIntents[intentKey] = { ...intent, status: 'unknown' };
			this.stateDirty = true;
			try { await this.saveState(); } catch (_saveError) { /* The pending intent was saved before POST. */ }
			if (!isRetryable(error) && !isCancellation(error)) throw error;
			throw new ProviderOutcomeUnknownError();
		}
		this.state.providerCreateIntents[intentKey] = { ...intent, status: 'confirmed', remoteEventId: remote.remoteId };
		const cached = this.cacheRemoteEvent(remote);
		return this.finishCommittedWrite(cached);
	}

	/** Update a cached provider event directly; its canonical UID is immutable. */
	async updateCalendarEvent(key: string, input: CalendarEventInputLike): Promise<CalendarEventWriteResult> {
		await this.ensureLoaded();
		this.assertProviderWritesEnabled();
		const current = this.state.remoteEvents[key];
		if (!current || current.status === 'remote_deleted') throw new Error(`Cached calendar event "${key}" was not found`);
		if (current.recurrenceMasterId) throw new Error('Recurring occurrences must be edited by their occurrence target');
		if (current.status === 'unsupported' || cachedRecurrenceStatus(current) === 'unsupported') {
			throw new Error('Recurring Google Calendar events cannot be edited from Continuous Calendar');
		}
		const candidate = normalizeCalendarEvent(input);
		if (candidate.uid !== current.event.uid) throw new Error('Calendar event UID cannot be changed');
		let remote: RemoteCalendarEvent;
		try {
			remote = await this.runQueuedProviderWrite(key, signal => this.provider.updateEvent(
				this.session,
				this.calendarId,
				current.remoteEventId,
				candidate,
				current.version,
				signal,
			), undefined, 1);
		} catch (error) {
			if (providerConflict(error)) {
				const latest = await this.fetchForWriteOutcome(current.remoteEventId);
				throw new ProviderWriteConflictError(latest);
			}
			if (!isRetryable(error)) throw error;
			const lookup = await this.fetchForWriteOutcome(current.remoteEventId);
			if (!lookup) throw new ProviderOutcomeUnknownError();
			if (lookup.status !== 'active' || lookup.event.remoteId !== current.remoteEventId || !sameProviderOwnedFields(lookup.event.event, candidate)) {
				throw new ProviderOutcomeUnknownError();
			}
			remote = lookup.event;
		}
		const cached = this.cacheRemoteEvent(remote, current.notePath, current.noteUid);
		if (cached.event.recurrence || cached.recurrenceRaw?.length) {
			this.markOccurrenceCoverageDirty(cached.remoteEventId);
		}
		return this.finishCommittedWrite(cached, () => this.mirrorRemoteEventToLinkedNote(cached));
	}

	/** Update one immutable recurrence slot using its current provider instance ID and ETag. */
	async updateCalendarOccurrence(key: string, input: CalendarEventInputLike): Promise<CalendarOccurrenceWriteResult> {
		await this.ensureLoaded();
		this.assertProviderWritesEnabled();
		const current = this.state.remoteOccurrences[key];
		if (!current || current.cancelled || !current.event) throw new Error(`Cached calendar occurrence "${key}" was not found`);
		const coverage = this.state.occurrenceCoverage[this.coverageKey(current.masterRemoteId)];
		if (!coverage?.completedAt || coverage.dirty || current.unresolved) {
			throw new Error('This recurrence slot needs a complete refresh before it can be edited');
		}
		const updateOccurrence = this.provider.updateOccurrence;
		if (!updateOccurrence) throw new Error('This provider cannot edit individual recurring occurrences');
		const candidate = normalizeCalendarEvent(input);
		if (candidate.uid !== current.event.uid) throw new Error('Calendar event UID cannot be changed');
		const master = this.getCachedMaster(current.masterRemoteId);
		const originalStartTime = slotWithMasterTimezone(current.originalStartTime, master?.event.timezone);
		if (originalStartTime.dateTime !== undefined && !originalStartTime.timeZone) {
			throw new Error('This recurrence slot has no verified timezone and cannot be edited safely');
		}
		let updated: Extract<RemoteOccurrence, { readonly status: 'active' }>;
		try {
			updated = await this.runQueuedProviderWrite(key, signal => updateOccurrence.call(this.provider, {
				session: this.session,
				calendarId: this.calendarId,
				masterRemoteId: current.masterRemoteId,
				instanceRemoteId: current.instanceRemoteId,
				originalStartTime,
				event: candidate,
				expectedVersion: current.version,
				masterTimeZone: master?.event.timezone,
				signal,
			}), undefined, 1);
		} catch (error) {
			if (providerConflict(error)) {
				const latest = await this.fetchForWriteOutcome(current.instanceRemoteId);
				throw new ProviderWriteConflictError(latest);
			}
			if (!isRetryable(error)) throw error;
			const lookup = await this.fetchForWriteOutcome(current.instanceRemoteId);
			if (!lookup) throw new ProviderOutcomeUnknownError();
			if (
				lookup.status !== 'active' ||
				lookup.event.remoteId !== current.instanceRemoteId ||
				lookup.event.recurrenceMasterId !== current.masterRemoteId ||
				!lookup.event.originalStartTime ||
				!sameSlotIdentity(lookup.event.originalStartTime, current.originalStartTime, master?.event.timezone) ||
				!sameProviderOwnedFields(lookup.event.event, candidate)
			) throw new ProviderOutcomeUnknownError();
			updated = {
				status: 'active',
				providerId: lookup.event.providerId,
				calendarId: lookup.event.calendarId,
				masterRemoteId: current.masterRemoteId,
				instanceRemoteId: current.instanceRemoteId,
				originalStartTime: lookup.event.originalStartTime,
				event: lookup.event,
				actualStart: lookup.event.actualStart ?? {},
				actualEnd: lookup.event.actualEnd ?? {},
				version: lookup.event.version,
			};
		}
		if (
			updated.masterRemoteId !== current.masterRemoteId ||
			updated.instanceRemoteId !== current.instanceRemoteId ||
			!sameSlotIdentity(updated.originalStartTime, current.originalStartTime, master?.event.timezone)
		) throw new Error('Provider returned a different recurrence slot after the occurrence write');
		this.cacheOccurrence(updated);
		return this.finishCommittedOccurrenceWrite(key, this.state.remoteOccurrences[key]);
	}

	/** Delete only the provider event. A linked note remains in the vault. */
	async deleteCalendarEvent(key: string): Promise<boolean> {
		await this.ensureLoaded();
		if (this.mode !== 'bidirectional') return false;
		const current = this.state.remoteEvents[key];
		if (!current || current.status === 'remote_deleted') return false;
		if (current.status === 'unsupported' || cachedRecurrenceStatus(current) === 'unsupported') {
			throw new Error('Recurring Google Calendar events cannot be deleted from Continuous Calendar');
		}
		try {
			await this.runQueuedProviderWrite(key, signal => this.provider.deleteEvent(
				this.session,
				this.calendarId,
				current.remoteEventId,
				current.version,
				signal,
			), undefined, 1);
		} catch (error) {
			if (providerConflict(error)) {
				const latest = await this.fetchForWriteOutcome(current.remoteEventId);
				throw new ProviderWriteConflictError(latest);
			}
			if (isRetryable(error)) {
				const lookup = await this.fetchForWriteOutcome(current.remoteEventId);
				if (!lookup) throw new ProviderOutcomeUnknownError();
				if (lookup.status !== 'active') {
					// The provider confirms that the event is now cancelled or absent.
				} else {
					throw new ProviderOutcomeUnknownError();
				}
			} else {
				await this.recordError(error);
				throw error;
			}
		}
		const deleted: CachedCalendarEvent = { ...current, status: 'remote_deleted' };
		this.state.remoteEvents[key] = deleted;
		if (current.event.recurrence || current.recurrenceRaw?.length) {
			this.markChildTargetsUnresolved(current.remoteEventId);
		}
		await this.finishCommittedWrite({ key, ...deleted }, () => this.mirrorRemoteEventToLinkedNote(deleted));
		return true;
	}

	/** Persist the provider result before touching a note; local failures cannot undo a 2xx. */
	private async finishCommittedWrite(
		cached: CachedCalendarEventView,
		mirror?: () => Promise<void>,
	): Promise<CalendarEventWriteResult> {
		const repairKey = makeSyncStateKey(this.provider.id, this.session.accountId, this.calendarId, 'repair', cached.remoteEventId);
		this.state.localRepairs[repairKey] = {
			providerId: this.provider.id,
			accountId: this.session.accountId,
			calendarId: this.calendarId,
			remoteEventId: cached.remoteEventId,
			reason: 'post-provider-write',
			recordedAt: nowIso(this.clock),
		};
		this.stateDirty = true;
		let localRepairPending = false;
		try {
			await this.saveState();
		} catch (_error) {
			localRepairPending = true;
		}
		if (mirror) {
			try {
				await mirror();
			} catch (_error) {
				localRepairPending = true;
				this.state.localRepairs[repairKey] = {
					...this.state.localRepairs[repairKey],
					reason: 'note-reconciliation-failed',
				};
			}
		}
		if (!localRepairPending) delete this.state.localRepairs[repairKey];
		this.stateDirty = true;
		try {
			await this.saveState();
		} catch (_error) {
			localRepairPending = true;
		}
		return { ...cached, localRepairPending };
	}

	private async finishCommittedOccurrenceWrite(
	key: string,
	cached: CachedCalendarOccurrence,
	): Promise<CalendarOccurrenceWriteResult> {
		const target = this.targetForOccurrence(cached);
		const repairKey = makeSyncStateKey(
			this.provider.id,
			this.session.accountId,
			this.calendarId,
			'repair',
			target ? targetKey(target) : cached.masterRemoteId,
		);
		this.state.localRepairs[repairKey] = {
			providerId: this.provider.id,
			accountId: this.session.accountId,
			calendarId: this.calendarId,
			remoteEventId: cached.instanceRemoteId,
			...(target ? { targetKey: targetKey(target) } : {}),
			reason: 'post-provider-write',
			recordedAt: nowIso(this.clock),
		};
		this.stateDirty = true;
		let localRepairPending = false;
		try {
			await this.saveState();
		} catch (_error) {
			localRepairPending = true;
		}
		try {
			if (!target || !cached.event) throw new Error('Occurrence target or event is not available for note reconciliation');
			await this.mirrorTargetNote(target, cached.event, cached.cancelled ? 'remote_deleted' : 'synced');
		} catch (_error) {
			localRepairPending = true;
			this.state.localRepairs[repairKey] = {
				...this.state.localRepairs[repairKey],
				reason: 'note-reconciliation-failed',
			};
		}
		if (!localRepairPending) delete this.state.localRepairs[repairKey];
		this.stateDirty = true;
		try {
			await this.saveState();
		} catch (_error) {
			localRepairPending = true;
		}
		const coverage = this.state.occurrenceCoverage[this.coverageKey(cached.masterRemoteId)];
		return { key, ...cached, stale: !coverage?.completedAt || coverage.dirty === true || cached.unresolved === true, localRepairPending };
	}

	/** Attach an already-created note to a cached event, without provider writes. */
	async linkNote(key: string, path: string, uid: string): Promise<CachedCalendarEventView> {
		await this.ensureLoaded();
		const cached = this.state.remoteEvents[key];
		if (!cached || cached.status === 'remote_deleted') throw new Error(`Cached calendar event "${key}" was not found`);
		const note = this.repository.getByPath(path);
		if (!note || note.path !== path || note.event.uid !== uid) throw new Error(`Calendar event note "${path}" was not found`);
		const target = this.targetForRemoteEvent(cached);
		if (!target) throw new Error('This provider event has no verified note target');
		if (note.target && targetKey(note.target) !== targetKey(target)) {
			throw new Error(`Calendar note "${path}" already belongs to a different provider target`);
		}
		const linked = { ...cached, notePath: note.path, noteUid: uid };
		const mapped = this.linkMapping(linked);
		const localized = { ...linked.event, uid };
		const status = linked.status === 'unsupported' ? 'unsupported' : 'synced';
		const association = this.associationForTarget(target, uid, status);
		await this.withInternalWrite(uid, () => this.repository.update(note.path, localized, {
			status,
			association,
			target,
		}));
		this.state.remoteEvents[key] = linked;
		this.state.mappings[mapped.key] = mapped.mapping;
		const snapshot = createCalendarEventSnapshot(localized, nowIso(this.clock));
		this.state.snapshots[mapped.key] = { local: snapshot, remote: snapshot };
		this.stateDirty = true;
		await this.mirrorTargetNote(target, cached.event, status);
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
			await this.migrateLegacyTargets();
			await this.refreshOccurrenceCoverage(signal);
			await this.mirrorCachedEventsToLinkedNotes();
			await this.queue.flush();
			await this.saveState();
			this.clearRecoveredProviderWriteRepairs();
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
				const remoteId = change.type === 'upsert'
					? change.value.remoteId
					: change.type === 'delete' ? change.remoteId
						: change.type === 'occurrence-cancelled' ? change.occurrence.instanceRemoteId : change.masterRemoteId;
				seenRemoteEvents.add(makeSyncStateKey(this.provider.id, this.session.accountId, this.calendarId, remoteId));
				await this.applyRemoteChange(change, counters, signal, fullResync);
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

	private async applyRemoteChange(
		change: RemoteChange,
		counters: MutableRunCounters,
		signal: AbortSignal,
		fullResync: boolean,
	): Promise<void> {
		if (change.type === 'delete') {
			await this.applyRemoteDeletion(change, counters);
			return;
		}
		if (change.type === 'series-unsupported') {
			await this.markSeriesUnsupported(change.masterRemoteId);
			return;
		}
		if (change.type === 'occurrence-cancelled') {
			// This change marks the current complete generation stale. Publish the
			// tombstone only with the next fully paginated instances response.
			this.markOccurrenceCoverageDirty(change.occurrence.masterRemoteId);
			this.stateDirty = true;
			return;
		}
		await this.applyRemoteUpsert(change.value, counters, signal, fullResync);
	}

	private async markSeriesUnsupported(masterRemoteId: string): Promise<void> {
		if (!masterRemoteId || this.mode === 'dry-run') return;
		const key = makeSyncStateKey(this.provider.id, this.session.accountId, this.calendarId, masterRemoteId);
		const current = this.state.remoteEvents[key];
		if (!current || current.status === 'remote_deleted') return;
		const guarded: CachedCalendarEvent = {
			...current,
			recurrenceStatus: 'unsupported',
			recurrence: 'unsupported',
			recurrenceHasExceptions: true,
			status: 'unsupported',
		};
		this.state.remoteEvents[key] = guarded;
		await this.mirrorRemoteEventToLinkedNote(guarded);
		const binding = this.findBindingByRemote(masterRemoteId);
		if (binding) this.state.mappings[binding.key] = { ...binding.mapping, status: 'unsupported' };
		this.stateDirty = true;
	}

	private async applyRemoteDeletion(
		change: Extract<RemoteChange, { type: 'delete' }>,
		counters: MutableRunCounters,
	): Promise<void> {
		if (change.providerId !== this.provider.id || change.calendarId !== this.calendarId) return;
		if (this.mode === 'dry-run') return;
		const key = makeSyncStateKey(this.provider.id, this.session.accountId, this.calendarId, change.remoteId);
		const cached = this.state.remoteEvents[key];
		// A delete without a cached provider object is not enough evidence to
		// distinguish a series master, one-off event, or stale legacy link.
		if (!cached) return;
		if (cached.status === 'remote_deleted') return;
		const deleted = { ...cached, status: 'remote_deleted' as const };
		this.state.remoteEvents[key] = deleted;
		if (!deleted.recurrenceMasterId && (deleted.event.recurrence || deleted.recurrenceRaw?.length)) {
			this.markChildTargetsUnresolved(deleted.remoteEventId);
		}
		this.stateDirty = true;
		counters.deleted += 1;
	}

	private async applyRemoteUpsert(
		remote: RemoteCalendarEvent,
		counters: MutableRunCounters,
		_signal: AbortSignal,
		fullResync = false,
	): Promise<void> {
		if (remote.providerId !== this.provider.id || remote.calendarId !== this.calendarId) return;
		if (this.mode === 'dry-run') return;
		const remoteKey = makeSyncStateKey(this.provider.id, this.session.accountId, this.calendarId, remote.remoteId);
		const existing = this.state.remoteEvents[remoteKey];
		if (!this.provider.listInstances && existing?.recurrenceHasExceptions && !(fullResync && remote.recurrenceHasExceptions !== true)) {
			remote = {
				...remote,
				recurrenceStatus: 'unsupported',
				recurrence: 'unsupported',
				recurrenceHasExceptions: true,
			};
		}
		// Some providers cannot apply the date window while using incremental
		// cursors. Keep the configured horizon at the cache boundary while still
		// updating previously cached or explicitly linked events when they move
		// outside it.
		const recurringMaster = !remote.recurrenceMasterId && (remote.event.recurrence !== undefined || !!remote.recurrenceRaw?.length);
		if (!existing && !recurringMaster && !eventIntersectsWindow(remote.event, this.resolveWindow())) return;
		if (remote.recurrenceMasterId) this.markOccurrenceCoverageDirty(remote.recurrenceMasterId);
		else if (remote.event.recurrence || remote.recurrenceRaw?.length) this.markOccurrenceCoverageDirty(remote.remoteId);

		this.cacheRemoteEvent(remote, existing?.notePath, existing?.noteUid);
		this.stateDirty = true;
	}

	private enqueueProviderWrite<T>(
		key: string,
		work: (signal: AbortSignal) => Promise<T>,
		signal?: AbortSignal,
		maxAttempts = this.retry.maxAttempts,
	): Promise<T> {
		if (signal) abortIfNeeded(signal);
		return this.queue.enqueue(key, context => {
			const providerSignal = signal ?? context.signal;
			abortIfNeeded(providerSignal);
			return work(providerSignal);
		}, {
			debounceMs: this.debounceMs,
			signal,
			maxAttempts,
			baseDelayMs: this.retry.baseDelayMs,
			maxDelayMs: this.retry.maxDelayMs,
			shouldRetry: error => isRetryable(error),
		});
	}

	private async runQueuedProviderWrite<T>(
		key: string,
		work: (signal: AbortSignal) => Promise<T>,
		signal?: AbortSignal,
		maxAttempts = this.retry.maxAttempts,
	): Promise<T> {
		const operation = this.enqueueProviderWrite(key, work, signal, maxAttempts);
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
		const recurrenceStatus = remote.recurrenceStatus ?? (remote.recurrence === 'unsupported' ? 'unsupported' : 'none');
		const legacyRecurrence = recurrenceStatus === 'unsupported' ? 'unsupported' : 'none';
		const status = recurrenceStatus === 'unsupported' ? 'unsupported' : 'synced';
		const cached: CachedCalendarEvent = {
			providerId: remote.providerId,
			accountId: this.session.accountId,
			calendarId: remote.calendarId,
			remoteEventId: remote.remoteId,
			event: cloneEvent(remote.event),
			version: remote.version,
			remoteUpdatedAt: remote.remoteUpdatedAt,
			recurrenceStatus,
			recurrenceRaw: remote.recurrenceRaw,
			recurrenceMasterId: remote.recurrenceMasterId,
			originalStartTime: remote.originalStartTime,
			actualStart: remote.actualStart,
			actualEnd: remote.actualEnd,
			recurrenceHasExceptions: remote.recurrenceHasExceptions,
			recurrence: legacyRecurrence,
			status,
			...(notePath === undefined ? {} : { notePath }),
			...(noteUid === undefined ? {} : { noteUid }),
		};
		this.state.remoteEvents[key] = cached;
		return { key, ...cached };
	}

	private occurrenceKey(occurrence: RemoteOccurrence): string {
		const master = this.getCachedMaster(occurrence.masterRemoteId);
		return makeSyncStateKey(
			this.provider.id,
			this.session.accountId,
			this.calendarId,
			'occurrence',
			occurrence.masterRemoteId,
			occurrenceSlotValue(occurrence.originalStartTime, master?.event.timezone),
		);
	}

	private coverageKey(masterRemoteId: string): string {
		return makeSyncStateKey(this.provider.id, this.session.accountId, this.calendarId, 'coverage', masterRemoteId);
	}

	private cacheOccurrence(occurrence: RemoteOccurrence): string {
		const key = this.occurrenceKey(occurrence);
		const previous = this.state.remoteOccurrences[key];
		this.state.remoteOccurrences[key] = {
			providerId: this.provider.id,
			accountId: this.session.accountId,
			calendarId: this.calendarId,
			masterRemoteId: occurrence.masterRemoteId,
			instanceRemoteId: occurrence.instanceRemoteId,
			originalStartTime: occurrence.originalStartTime,
			...(occurrence.status === 'active'
				? { event: cloneEvent(occurrence.event.event) }
				: previous?.event ? { event: previous.event } : {}),
			cancelled: occurrence.status === 'cancelled',
			version: occurrence.version,
			unresolved: false,
		};
		this.stateDirty = true;
		return key;
	}

	private markChildTargetsUnresolved(masterRemoteId: string): void {
		for (const [key, occurrence] of Object.entries(this.state.remoteOccurrences)) {
			if (occurrence.providerId !== this.provider.id || occurrence.accountId !== this.session.accountId ||
				occurrence.calendarId !== this.calendarId || occurrence.masterRemoteId !== masterRemoteId) continue;
			this.state.remoteOccurrences[key] = { ...occurrence, unresolved: true };
			this.stateDirty = true;
		}
		for (const note of this.repository.list()) {
			const target = note.target;
			if (!target || target.scope === 'series' || target.occurrence.kind !== 'recurrence' ||
				target.providerId !== this.provider.id || target.accountId !== this.session.accountId ||
				target.calendarId !== this.calendarId || target.occurrence.masterEventId !== masterRemoteId) continue;
			const key = makeSyncStateKey(this.provider.id, this.session.accountId, this.calendarId, 'repair', targetKey(target));
			this.state.localRepairs[key] = {
				providerId: this.provider.id,
				accountId: this.session.accountId,
				calendarId: this.calendarId,
				remoteEventId: masterRemoteId,
				noteUid: note.event.uid,
				targetKey: targetKey(target),
				reason: 'parent-series-deleted',
				recordedAt: nowIso(this.clock),
			};
			this.stateDirty = true;
		}
	}

	private markOccurrenceCoverageDirty(masterRemoteId: string): void {
		const key = this.coverageKey(masterRemoteId);
		const prior = this.state.occurrenceCoverage[key];
		const window = this.resolveWindow();
		this.state.occurrenceCoverage[key] = {
			providerId: this.provider.id,
			accountId: this.session.accountId,
			calendarId: this.calendarId,
			masterRemoteId,
			windowFrom: prior?.windowFrom ?? window.from,
			windowTo: prior?.windowTo ?? window.to,
			masterVersion: prior?.masterVersion,
			occurrenceKeys: prior?.occurrenceKeys ?? [],
			completedAt: prior?.completedAt,
			dirty: true,
		};
		this.stateDirty = true;
	}

	/** Publish only a complete instance response; retain prior rows if any page fails. */
	private async refreshOccurrenceCoverage(signal: AbortSignal): Promise<void> {
		const listInstances = this.provider.listInstances;
		if (this.mode === 'dry-run' || !listInstances) return;
		const window = this.resolveWindow();
		for (const master of Object.values(this.state.remoteEvents)) {
			if (
				master.providerId !== this.provider.id ||
				master.accountId !== this.session.accountId ||
				master.calendarId !== this.calendarId ||
				master.status === 'remote_deleted' ||
				master.recurrenceMasterId ||
				(!master.event.recurrence && !master.recurrenceRaw?.length)
			) continue;
			const coverageKey = this.coverageKey(master.remoteEventId);
			const prior = this.state.occurrenceCoverage[coverageKey];
			if (
				prior?.completedAt && !prior.dirty &&
				prior.masterVersion === master.version &&
				prior.windowFrom === window.from && prior.windowTo === window.to
			) continue;
			this.markOccurrenceCoverageDirty(master.remoteEventId);
			await this.saveState();
			const occurrences = await this.callWithRetry<RemoteOccurrence[]>('listInstances', callbackSignal => listInstances.call(this.provider, {
				session: this.session,
				calendarId: this.calendarId,
				masterRemoteId: master.remoteEventId,
				masterTimeZone: master.event.timezone,
				window,
				pinnedOriginalStarts: this.pinnedOriginalStarts(master.remoteEventId),
				signal: callbackSignal,
			}), signal);
			const staged = new Map<string, RemoteOccurrence>();
			for (const occurrence of occurrences) {
				if (occurrence.masterRemoteId !== master.remoteEventId || occurrence.calendarId !== this.calendarId) {
					throw new Error('Provider returned an occurrence for a different recurring master');
				}
				const key = this.occurrenceKey(occurrence);
				if (staged.has(key)) throw new Error('Provider returned duplicate recurrence slots');
				staged.set(key, occurrence);
			}
			const nextKeys = new Set(staged.keys());
			const pinnedTargets = this.pinnedTargetsForMaster(master.remoteEventId);
			const priorKeys = new Set([
				...(prior?.occurrenceKeys ?? []),
				...Object.entries(this.state.remoteOccurrences)
					.filter(([, occurrence]) =>
						occurrence.providerId === this.provider.id &&
						occurrence.accountId === this.session.accountId &&
						occurrence.calendarId === this.calendarId &&
						occurrence.masterRemoteId === master.remoteEventId)
					.map(([key]) => key),
			]);
			for (const oldKey of priorKeys) {
				if (nextKeys.has(oldKey)) continue;
				const old = this.state.remoteOccurrences[oldKey];
				if (!old || old.providerId !== this.provider.id || old.accountId !== this.session.accountId ||
					old.calendarId !== this.calendarId || old.masterRemoteId !== master.remoteEventId) continue;
				const returnedKey = [...staged.entries()].find(([, occurrence]) =>
					sameSlotIdentity(occurrence.originalStartTime, old.originalStartTime, master.event.timezone),
				)?.[0];
				if (returnedKey) {
					if (returnedKey !== oldKey) delete this.state.remoteOccurrences[oldKey];
					continue;
				}
				if (this.isPinnedOccurrence(old, pinnedTargets)) {
					this.state.remoteOccurrences[oldKey] = { ...old, unresolved: true };
					nextKeys.add(oldKey);
				} else {
					delete this.state.remoteOccurrences[oldKey];
				}
			}
			for (const occurrence of staged.values()) this.cacheOccurrence(occurrence);
			this.state.occurrenceCoverage[coverageKey] = {
				providerId: this.provider.id,
				accountId: this.session.accountId,
				calendarId: this.calendarId,
				masterRemoteId: master.remoteEventId,
				windowFrom: window.from,
				windowTo: window.to,
				masterVersion: master.version,
				occurrenceKeys: [...nextKeys],
				completedAt: nowIso(this.clock),
				dirty: false,
			};
			this.stateDirty = true;
			await this.saveState();
		}
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
			const isRecurringMaster = !cached.recurrenceMasterId &&
				(cached.event.recurrence !== undefined || !!cached.recurrenceRaw?.length);
			if (!isRecurringMaster && (!Number.isFinite(startsAt) || startsAt < from || startsAt >= to)) continue;
			const deleted: CachedCalendarEvent = { ...cached, status: 'remote_deleted' };
			this.state.remoteEvents[key] = deleted;
			if (isRecurringMaster) this.markChildTargetsUnresolved(deleted.remoteEventId);
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

	private getCachedMaster(masterRemoteId: string): CachedCalendarEvent | undefined {
		const key = makeSyncStateKey(this.provider.id, this.session.accountId, this.calendarId, masterRemoteId);
		const master = this.state.remoteEvents[key];
		return master && !master.recurrenceMasterId && master.remoteEventId === masterRemoteId
			? master
			: undefined;
	}

	private targetForOccurrence(occurrence: CachedCalendarOccurrence): CalendarNoteOccurrenceTarget | undefined {
		const master = this.getCachedMaster(occurrence.masterRemoteId);
		const slot = slotWithMasterTimezone(occurrence.originalStartTime, master?.event.timezone);
		if (slot.dateTime !== undefined && !slot.timeZone) return undefined;
		const originalStartTime = slot.date !== undefined
			? { date: slot.date }
			: slot.dateTime !== undefined && slot.timeZone
				? { dateTime: slot.dateTime, timeZone: slot.timeZone }
				: undefined;
		if (!originalStartTime) return undefined;
		return {
			version: 1,
			providerId: this.provider.id,
			accountId: this.session.accountId,
			calendarId: this.calendarId,
			scope: 'occurrence',
			occurrence: { kind: 'recurrence', masterEventId: occurrence.masterRemoteId, originalStartTime },
		};
	}

	private targetForRemoteEvent(cached: CachedCalendarEvent): CalendarNoteTarget | undefined {
		if (cached.recurrenceMasterId) {
			if (!cached.originalStartTime) return undefined;
			const master = this.getCachedMaster(cached.recurrenceMasterId);
			const slot = slotWithMasterTimezone(cached.originalStartTime, master?.event.timezone);
			if (slot.dateTime !== undefined && !slot.timeZone) return undefined;
			const originalStartTime = slot.date !== undefined
				? { date: slot.date }
				: slot.dateTime !== undefined && slot.timeZone
					? { dateTime: slot.dateTime, timeZone: slot.timeZone }
					: undefined;
			if (!originalStartTime) return undefined;
			return {
				version: 1,
				providerId: this.provider.id,
				accountId: this.session.accountId,
				calendarId: this.calendarId,
				scope: 'occurrence',
				occurrence: { kind: 'recurrence', masterEventId: cached.recurrenceMasterId, originalStartTime },
			};
		}
		if (cached.event.recurrence || cached.recurrenceRaw?.length) {
			return {
				version: 1,
				providerId: this.provider.id,
				accountId: this.session.accountId,
				calendarId: this.calendarId,
				scope: 'series',
				seriesId: cached.remoteEventId,
			};
		}
		return {
			version: 1,
			providerId: this.provider.id,
			accountId: this.session.accountId,
			calendarId: this.calendarId,
			scope: 'occurrence',
			occurrence: { kind: 'event', eventId: cached.remoteEventId },
		};
	}

	private async verifiedRemoteTarget(remote: RemoteCalendarEvent): Promise<CalendarNoteTarget | undefined> {
		if (remote.providerId !== this.provider.id || remote.calendarId !== this.calendarId) return undefined;
		if (remote.recurrenceMasterId) {
			if (!remote.originalStartTime) return undefined;
			let master = this.getCachedMaster(remote.recurrenceMasterId);
			if (!master && this.provider.fetchEvent) {
				const lookup = await this.provider.fetchEvent(this.session, this.calendarId, remote.recurrenceMasterId);
				if (lookup.status === 'active' && lookup.event.remoteId === remote.recurrenceMasterId) {
					master = this.cacheRemoteEvent(lookup.event);
				}
			}
			if (!master || (!master.event.recurrence && !master.recurrenceRaw?.length)) return undefined;
			const slot = slotWithMasterTimezone(remote.originalStartTime, master.event.timezone);
			if (slot.dateTime !== undefined && !slot.timeZone) return undefined;
			const originalStartTime = slot.date !== undefined
				? { date: slot.date }
				: slot.dateTime !== undefined && slot.timeZone
					? { dateTime: slot.dateTime, timeZone: slot.timeZone }
					: undefined;
			if (!originalStartTime) return undefined;
			return {
				version: 1,
				providerId: this.provider.id,
				accountId: this.session.accountId,
				calendarId: this.calendarId,
				scope: 'occurrence',
				occurrence: { kind: 'recurrence', masterEventId: remote.recurrenceMasterId, originalStartTime },
			};
		}
		return this.targetForRemoteEvent({
			providerId: remote.providerId,
			accountId: this.session.accountId,
			calendarId: remote.calendarId,
			remoteEventId: remote.remoteId,
			event: remote.event,
			version: remote.version,
			recurrenceStatus: remote.recurrenceStatus,
			recurrenceRaw: remote.recurrenceRaw,
			recurrenceMasterId: remote.recurrenceMasterId,
			recurrence: remote.recurrence,
			status: 'synced',
		});
	}

	private pinnedTargetsForMaster(masterRemoteId: string): CalendarNoteOccurrenceTarget[] {
		const targets: CalendarNoteOccurrenceTarget[] = [];
		for (const note of this.repository.list()) {
			const target = note.target;
			if (
				!target || target.providerId !== this.provider.id || target.accountId !== this.session.accountId ||
				target.calendarId !== this.calendarId || target.scope === 'series' ||
				target.occurrence.kind !== 'recurrence' || target.occurrence.masterEventId !== masterRemoteId
			) continue;
			targets.push({
				version: target.version,
				providerId: target.providerId,
				accountId: target.accountId,
				calendarId: target.calendarId,
				scope: 'occurrence',
				occurrence: target.occurrence,
			});
		}
		return targets;
	}

	private pinnedOriginalStarts(masterRemoteId: string): readonly { readonly date?: string; readonly dateTime?: string; readonly timeZone?: string }[] {
		const unique = new Map<string, { readonly date?: string; readonly dateTime?: string; readonly timeZone?: string }>();
		for (const target of this.pinnedTargetsForMaster(masterRemoteId)) {
			if (target.occurrence.kind !== 'recurrence') continue;
			const start = target.occurrence.originalStartTime;
			const value = 'date' in start ? { date: start.date } : { dateTime: start.dateTime, timeZone: start.timeZone };
			unique.set(occurrenceSlotValue(value), value);
		}
		return [...unique.values()];
	}

	private isPinnedOccurrence(
		occurrence: CachedCalendarOccurrence,
		targets: readonly CalendarNoteOccurrenceTarget[],
	): boolean {
		const target = this.targetForOccurrence(occurrence);
		if (target && targets.some(candidate => targetKey(candidate) === targetKey(target))) return true;
		// Retention only: a master timezone change may make an old sparse slot
		// impossible to match exactly. Keep its historical row unresolved without
		// using this loose match to relink or mirror a note.
		return targets.some(candidate => {
			if (candidate.occurrence.kind !== 'recurrence' ||
				candidate.occurrence.masterEventId !== occurrence.masterRemoteId) return false;
			const pinned = candidate.occurrence.originalStartTime;
			return occurrence.originalStartTime.date !== undefined
				? 'date' in pinned && pinned.date === occurrence.originalStartTime.date
				: 'dateTime' in pinned && pinned.dateTime === occurrence.originalStartTime.dateTime;
		});
	}

	private async targetForLegacyRecord(record: CalendarEventNoteRecord): Promise<
		| CalendarNoteTarget
		| { readonly target: CalendarNoteTarget; readonly association: CalendarEventAssociation }
		| undefined
	> {
		const reference = record.association?.reference;
		if (
			!reference || reference.providerId !== this.provider.id || reference.accountId !== this.session.accountId ||
			reference.calendarId !== this.calendarId
		) return undefined;
		const targets: CalendarNoteTarget[] = [];
		const cached = this.state.remoteEvents[makeSyncStateKey(this.provider.id, this.session.accountId, this.calendarId, reference.remoteEventId)];
		if (cached) {
			const target = this.targetForRemoteEvent(cached);
			if (target) targets.push(target);
		}
		for (const occurrence of Object.values(this.state.remoteOccurrences)) {
			if (
				occurrence.providerId === this.provider.id && occurrence.accountId === this.session.accountId &&
				occurrence.calendarId === this.calendarId && occurrence.instanceRemoteId === reference.remoteEventId
			) {
				const target = this.targetForOccurrence(occurrence);
				if (target) targets.push(target);
			}
		}
		let target = uniqueTarget(targets);
		if (!target && this.provider.fetchEvent) {
			let lookup: RemoteEventLookupResult;
			try {
				lookup = await this.provider.fetchEvent(this.session, this.calendarId, reference.remoteEventId);
			} catch (_error) {
				// A legacy link without verified identity remains untouched if the
				// targeted lookup is unavailable; it must not abort other sync work.
				return undefined;
			}
			if (lookup.status === 'active' && lookup.event.remoteId === reference.remoteEventId) {
				try {
					target = await this.verifiedRemoteTarget(lookup.event);
				} catch (_error) {
					return undefined;
				}
			} else if (lookup.status === 'cancelled') {
				const tombstone = lookup.tombstone;
				if (tombstone.remoteId === reference.remoteEventId && tombstone.recurrenceMasterId && tombstone.originalStartTime) {
					const master = this.getCachedMaster(tombstone.recurrenceMasterId);
					if (master) {
						const slot = slotWithMasterTimezone(tombstone.originalStartTime, master.event.timezone);
						if (slot.date !== undefined) {
							target = {
								version: 1, providerId: this.provider.id, accountId: this.session.accountId,
								calendarId: this.calendarId, scope: 'occurrence',
								occurrence: { kind: 'recurrence', masterEventId: tombstone.recurrenceMasterId, originalStartTime: { date: slot.date } },
							};
						} else if (slot.dateTime && slot.timeZone) {
							target = {
								version: 1, providerId: this.provider.id, accountId: this.session.accountId,
								calendarId: this.calendarId, scope: 'occurrence',
								occurrence: { kind: 'recurrence', masterEventId: tombstone.recurrenceMasterId, originalStartTime: { dateTime: slot.dateTime, timeZone: slot.timeZone } },
							};
						}
					}
				}
			}
		}
		if (!target || !record.association) return undefined;
		if (!calendarNoteTargetMatchesProviderReference(target, reference)) {
			const remoteEventId = target.scope === 'series'
				? target.seriesId
				: target.occurrence.kind === 'event' ? target.occurrence.eventId : target.occurrence.masterEventId;
			const association: CalendarEventAssociation = {
				...makeAssociation(this.provider.id, this.session.accountId, this.calendarId, remoteEventId, record.association.status ?? 'synced'),
				calendarUid: record.event.uid,
			};
			return { target, association };
		}
		return target;
	}

	private async migrateLegacyTargets(): Promise<void> {
		if (this.mode === 'dry-run' || !this.repository.migrateLegacyTargets) return;
		await this.repository.migrateLegacyTargets(record => this.targetForLegacyRecord(record));
	}

	private associationForTarget(target: CalendarNoteTarget, uid: string, status: 'pending' | 'synced' | 'conflict' | 'remote_deleted' | 'unsupported' | 'error'): CalendarEventAssociation {
		const remoteEventId = target.scope === 'series'
			? target.seriesId
			: target.occurrence.kind === 'event' ? target.occurrence.eventId : target.occurrence.masterEventId;
		return {
			...makeAssociation(this.provider.id, this.session.accountId, this.calendarId, remoteEventId, status),
			calendarUid: uid,
		};
	}

	private getTargetNote(target: CalendarNoteTarget): CalendarEventNoteRecord | undefined {
		if (!this.repository.getByTarget || !this.repository.getTargetClaimants) return undefined;
		const claimants = this.repository.getTargetClaimants(target);
		if (claimants.length > 1) throw new Error(`Calendar target has duplicate claimants: ${claimants.map(value => value.path).join(', ')}`);
		const note = this.repository.getByTarget(target);
		if (!note) {
			if (claimants.length > 0) throw new Error(`Calendar target claimant at "${claimants[0].path}" needs repair`);
			return undefined;
		}
		if (!note.target || targetKey(note.target) !== targetKey(target)) throw new Error('Calendar target index returned a different note target');
		if (!note.association || !calendarNoteTargetMatchesProviderReference(note.target, note.association.reference)) {
			throw new Error(`Calendar target note "${note.path}" has a mismatched provider association`);
		}
		return note;
	}

	private async mirrorTargetNote(
		target: CalendarNoteTarget,
		remoteEvent: CalendarEvent,
		status: 'synced' | 'unsupported' | 'remote_deleted',
	): Promise<void> {
		const note = this.getTargetNote(target);
		if (!note) return;
		if (status === 'remote_deleted') {
			if (note.status !== 'remote_deleted') {
				await this.withInternalWrite(note.event.uid, () => this.repository.markRemoteDeleted(note.path));
				this.stateDirty = true;
			}
			return;
		}
		if (target.scope === 'occurrence-day') {
			await this.repository.proposeDayTargetDate?.(note.path, remoteEvent);
		}
		const localized: CalendarEvent = target.scope === 'occurrence-day'
			? {
				...remoteEvent,
				uid: note.event.uid,
				start: note.event.start,
				end: note.event.end,
				allDay: note.event.allDay,
				timezone: note.event.timezone,
			}
			: { ...remoteEvent, uid: note.event.uid };
		const association = this.associationForTarget(target, note.event.uid, status);
		if (
			hashCalendarEvent(note.event) !== hashCalendarEvent(localized) || note.status !== status ||
			note.association?.status !== status
		) {
			await this.withInternalWrite(note.event.uid, () => this.repository.update(note.path, localized, { status, association }));
			this.stateDirty = true;
		}
	}

	private findOccurrenceForTarget(target: CalendarNoteOccurrenceTarget): CachedCalendarOccurrence | undefined {
		const identity = target.occurrence;
		if (identity.kind !== 'recurrence') return undefined;
		const master = this.getCachedMaster(identity.masterEventId);
		const matches = Object.values(this.state.remoteOccurrences).filter(occurrence =>
			occurrence.providerId === target.providerId && occurrence.accountId === target.accountId &&
			occurrence.calendarId === target.calendarId && occurrence.masterRemoteId === identity.masterEventId &&
			sameSlotIdentity(occurrence.originalStartTime, identity.originalStartTime, master?.event.timezone),
		);
		return matches.length === 1 ? matches[0] : undefined;
	}

	private async mirrorRemoteEventToLinkedNote(cached: CachedCalendarEvent): Promise<void> {
		const target = this.targetForRemoteEvent(cached);
		if (!target) return;
		await this.mirrorTargetNote(target, cached.event, cached.status === 'remote_deleted' ? 'remote_deleted' : cached.status === 'unsupported' ? 'unsupported' : 'synced');
	}

	private async mirrorCachedEventsToLinkedNotes(): Promise<void> {
		if (this.mode === 'dry-run') return;
		for (const note of this.repository.list()) {
			const target = note.target;
			if (
				!target || note.targetErrors || target.providerId !== this.provider.id ||
				target.accountId !== this.session.accountId || target.calendarId !== this.calendarId
			) continue;
			const repairKey = makeSyncStateKey(this.provider.id, this.session.accountId, this.calendarId, 'repair', targetKey(target));
			try {
				let event: CalendarEvent | undefined;
				let status: 'synced' | 'unsupported' | 'remote_deleted' = 'synced';
				let remoteEventId: string | undefined;
				if (target.scope === 'series') {
					const cached = this.getCachedMaster(target.seriesId);
					if (!cached) continue;
					event = cached.event;
					remoteEventId = cached.remoteEventId;
					status = cached.status === 'remote_deleted' ? 'remote_deleted' : cached.status === 'unsupported' ? 'unsupported' : 'synced';
				} else if (target.occurrence.kind === 'event') {
					const cached = this.state.remoteEvents[makeSyncStateKey(this.provider.id, this.session.accountId, this.calendarId, target.occurrence.eventId)];
					if (!cached || cached.recurrenceMasterId || cached.event.recurrence || cached.recurrenceRaw?.length) continue;
					event = cached.event;
					remoteEventId = cached.remoteEventId;
					status = cached.status === 'remote_deleted' ? 'remote_deleted' : cached.status === 'unsupported' ? 'unsupported' : 'synced';
				} else {
					const master = this.getCachedMaster(target.occurrence.masterEventId);
					if (master?.status === 'remote_deleted') {
						this.state.localRepairs[repairKey] = {
							providerId: this.provider.id, accountId: this.session.accountId, calendarId: this.calendarId,
							remoteEventId: master.remoteEventId, noteUid: note.event.uid,
							targetKey: targetKey(target), reason: 'parent-series-deleted', recordedAt: nowIso(this.clock),
						};
						this.stateDirty = true;
						continue;
					}
					const occurrenceTarget = target.scope === 'occurrence'
						? target
						: { ...target, scope: 'occurrence' as const };
					const occurrence = this.findOccurrenceForTarget(occurrenceTarget);
					const coverage = this.state.occurrenceCoverage[this.coverageKey(target.occurrence.masterEventId)];
					if (!occurrence) {
						if (coverage?.completedAt && !coverage.dirty) {
						this.state.localRepairs[repairKey] = {
							providerId: this.provider.id, accountId: this.session.accountId, calendarId: this.calendarId,
							targetKey: targetKey(target), reason: 'pinned-occurrence-missing', recordedAt: nowIso(this.clock),
						};
						this.stateDirty = true;
					}
					continue;
					}
					if (occurrence.unresolved) {
						this.state.localRepairs[repairKey] = {
							providerId: this.provider.id, accountId: this.session.accountId, calendarId: this.calendarId,
							remoteEventId: occurrence.instanceRemoteId, targetKey: targetKey(target),
							reason: 'pinned-occurrence-missing', recordedAt: nowIso(this.clock),
						};
						this.stateDirty = true;
						continue;
					}
					remoteEventId = occurrence.instanceRemoteId;
					if (occurrence.cancelled) status = 'remote_deleted';
					else if (occurrence.event) event = occurrence.event;
					else continue;
				}
				if (event) await this.mirrorTargetNote(target, event, status);
				else if (status === 'remote_deleted') await this.mirrorTargetNote(target, note.event, status);
				else continue;
				if (this.state.localRepairs[repairKey]) {
					delete this.state.localRepairs[repairKey];
					this.stateDirty = true;
				}
				if (remoteEventId) {
					const eventRepairKey = makeSyncStateKey(this.provider.id, this.session.accountId, this.calendarId, 'repair', remoteEventId);
					if (this.state.localRepairs[eventRepairKey]) {
						delete this.state.localRepairs[eventRepairKey];
						this.stateDirty = true;
					}
				}
			} catch (_error) {
				this.state.localRepairs[repairKey] = {
					providerId: this.provider.id,
					accountId: this.session.accountId,
					calendarId: this.calendarId,
					...(note.target.scope === 'series'
						? { remoteEventId: note.target.seriesId }
						: { remoteEventId: note.target.occurrence.kind === 'event' ? note.target.occurrence.eventId : note.target.occurrence.masterEventId }),
					noteUid: note.event.uid,
					targetKey: targetKey(note.target),
					reason: 'note-reconciliation-failed',
					recordedAt: nowIso(this.clock),
				};
				this.stateDirty = true;
			}
		}
	}

	private clearRecoveredProviderWriteRepairs(): void {
		for (const [key, repair] of Object.entries(this.state.localRepairs)) {
			if (repair.reason !== 'post-provider-write' ||
				repair.providerId !== this.provider.id || repair.accountId !== this.session.accountId ||
				repair.calendarId !== this.calendarId || !repair.remoteEventId) continue;
			const cachedEvent = this.state.remoteEvents[makeSyncStateKey(
				this.provider.id, this.session.accountId, this.calendarId, repair.remoteEventId)];
			const cachedOccurrence = Object.values(this.state.remoteOccurrences).some(occurrence =>
				occurrence.providerId === this.provider.id && occurrence.accountId === this.session.accountId &&
				occurrence.calendarId === this.calendarId && occurrence.instanceRemoteId === repair.remoteEventId);
			if (!cachedEvent && !cachedOccurrence) continue;
			delete this.state.localRepairs[key];
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
			localRepairCount: Object.keys(this.state.localRepairs).length,
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
