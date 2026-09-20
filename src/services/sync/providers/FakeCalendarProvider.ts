import type {
	CalendarEvent,
	ProviderReference,
} from '../model/CalendarEvent';
import { normalizeCalendarEvent } from '../model/CalendarEventValidation';
import {
	CalendarProvider,
	CalendarProviderDependencies,
	ChangePage,
	OpaqueCursor,
	ProviderClock,
	ProviderId,
	ProviderSession,
	PullChangesRequest,
	RemoteCalendar,
	RemoteCalendarEvent,
	RemoteChange,
	SyncWindow,
} from './CalendarProvider';
import {
	authorizationError,
	conflictError,
	cursorExpiredError,
	ProviderError,
	ProviderCancelledError,
	permanentError,
} from './ProviderErrors';

export type FakeProviderOperation =
	| 'listCalendars'
	| 'pullChanges'
	| 'createEvent'
	| 'updateEvent'
	| 'deleteEvent';

export interface FakeCalendarProviderOptions extends CalendarProviderDependencies {
	readonly accountId?: string;
	readonly pageSize?: number;
	readonly cursorTtlMs?: number;
	readonly calendars?: readonly RemoteCalendar[];
}

export interface FakeEventOptions {
	readonly remoteId?: string;
	/** Simulated provider-private plugin UID metadata; absent by default. */
	readonly calendarUid?: string;
	readonly version?: string;
	readonly recurrence?: 'none' | 'unsupported';
	readonly remoteUpdatedAt?: string;
	readonly emitChange?: boolean;
}

export interface FakeCalendarInput {
	readonly calendarId: string;
	readonly name: string;
	readonly writable?: boolean;
	readonly timezone?: string;
	readonly accountId?: string;
}

export interface FakeProviderCall {
	readonly operation: FakeProviderOperation;
	readonly calendarId?: string;
	readonly remoteId?: string;
	readonly cursor?: string;
	readonly expectedVersion?: string;
	readonly at: number;
}

interface StoredEvent {
	remote: RemoteCalendarEvent;
	versionNumber: number;
}

interface ChangeRecord {
	readonly sequence: number;
	readonly change: RemoteChange;
}

interface CursorState {
	readonly calendarId: string;
	readonly sequence: number;
	readonly expiresAt: number;
}

const DEFAULT_ACCOUNT_ID = 'fake-account';
const DEFAULT_CALENDAR_ID = 'primary';

const defaultClock: ProviderClock = { now: () => Date.now() };

/**
 * Deterministic in-memory provider for domain/engine tests. It deliberately
 * stores canonical events only; no provider wire payload is introduced.
 */
export class FakeCalendarProvider implements CalendarProvider {
	readonly id: ProviderId;
	readonly http?: CalendarProviderDependencies['http'];
	readonly clock: ProviderClock;

	private readonly accountId: string;
	private readonly pageSize: number;
	private readonly cursorTtlMs: number;
	private readonly calendars = new Map<string, RemoteCalendar>();
	private readonly events = new Map<string, Map<string, StoredEvent>>();
	private readonly changes = new Map<string, ChangeRecord[]>();
	private readonly cursors = new Map<string, CursorState>();
	private readonly queuedErrors = new Map<FakeProviderOperation, ProviderError[]>();
	private readonly calls: FakeProviderCall[] = [];
	private nextRemoteId = 1;
	private nextSequence = 1;
	private nextCursor = 1;

	constructor(options: FakeCalendarProviderOptions = {}) {
		this.id = options.providerId ?? 'google';
		this.accountId = options.accountId ?? DEFAULT_ACCOUNT_ID;
		this.pageSize = Math.max(1, Math.floor(options.pageSize ?? 50));
		this.cursorTtlMs = Math.max(0, options.cursorTtlMs ?? 60_000);
		this.http = options.http;
		this.clock = options.clock ?? defaultClock;

		if (options.calendars && options.calendars.length > 0) {
			for (const calendar of options.calendars) this.addCalendar(calendar);
		} else {
			this.addCalendar({
				calendarId: DEFAULT_CALENDAR_ID,
				name: 'Primary',
				writable: true,
				timezone: 'UTC',
			});
		}
	}

	/** Register a calendar for subsequent discovery and CRUD operations. */
	addCalendar(calendar: RemoteCalendar | FakeCalendarInput): RemoteCalendar {
		const normalized: RemoteCalendar = {
			providerId: this.id,
			accountId: calendar.accountId ?? this.accountId,
			calendarId: calendar.calendarId,
			name: calendar.name,
			writable: calendar.writable ?? true,
			timezone: calendar.timezone,
		};
		this.calendars.set(normalized.calendarId, normalized);
		if (!this.events.has(normalized.calendarId)) {
			this.events.set(normalized.calendarId, new Map());
			this.changes.set(normalized.calendarId, []);
		}
		return normalized;
	}

	/** Alias useful in fixture setup. */
	seedCalendar(calendar: RemoteCalendar | FakeCalendarInput): RemoteCalendar {
		return this.addCalendar(calendar);
	}

	/** Add a remote event and optionally emit its initial change. */
	seedEvent(
		calendarId: string,
		event: CalendarEvent,
		options: FakeEventOptions = {},
	): RemoteCalendarEvent {
		this.requireCalendar(calendarId);
		const canonical = normalizeCalendarEvent(event);
		const remoteId = options.remoteId ?? `fake-event-${this.nextRemoteId++}`;
		const versionNumber = this.parseVersion(options.version) ?? 1;
		const remote: RemoteCalendarEvent = {
			providerId: this.id,
			calendarId,
			remoteId,
			event: canonical,
			...(options.calendarUid === undefined ? {} : { calendarUid: options.calendarUid }),
			version: options.version ?? this.version(versionNumber),
			remoteUpdatedAt: options.remoteUpdatedAt ?? this.nowIso(),
			recurrence: options.recurrence ?? 'none',
		};
		this.events.get(calendarId)?.set(remoteId, { remote, versionNumber });
		if (options.emitChange !== false) this.appendChange(calendarId, { type: 'upsert', value: remote });
		return remote;
	}

	/** Alias useful in fixture setup. */
	seedRemoteEvent(
		calendarId: string,
		event: CalendarEvent,
		options: FakeEventOptions = {},
	): RemoteCalendarEvent {
		return this.seedEvent(calendarId, event, options);
	}

	listCalendars(session: ProviderSession, signal?: AbortSignal): Promise<RemoteCalendar[]> {
		return this.run('listCalendars', signal, () => {
			this.validateSession(session);
			return Array.from(this.calendars.values()).map(calendar => ({ ...calendar }));
		});
	}

	/**
	 * Pull changes after an opaque checkpoint. A terminal page always returns
	 * an opaque checkpoint when it consumed records, including records filtered
	 * out by the requested window. If an existing cursor is already at the end
	 * of the log, the result has no `nextCursor`; callers retain their supplied
	 * cursor unchanged.
	 */
	pullChanges(request: PullChangesRequest): Promise<ChangePage> {
		return this.run('pullChanges', request.signal, () => {
			this.validateSession(request.session);
			this.requireCalendar(request.calendarId);
			const records = this.changes.get(request.calendarId) ?? [];
			const startSequence = request.cursor
				? this.readCursor(request.cursor, request.calendarId).sequence
				: 0;

			let index = records.findIndex(record => record.sequence > startSequence);
			if (index < 0) index = records.length;
			const selected: RemoteChange[] = [];
			let lastScannedSequence = startSequence;
			while (index < records.length && selected.length < this.pageSize) {
				const record = records[index];
				lastScannedSequence = record.sequence;
				if (this.changeInWindow(record.change, request.window)) {
					selected.push(this.cloneChange(record.change));
				}
				index += 1;
			}

			const hasMore = records
				.slice(index)
				.some(record => this.changeInWindow(record.change, request.window));
			if (!hasMore) {
				// A full page can stop scanning immediately after its last matching
				// change even when filtered records trail it. Since there is no next
				// matching page, consume those trailing records into the terminal
				// checkpoint as well; otherwise the same filtered records would be
				// rescanned on every incremental pull.
				if (index < records.length) {
					lastScannedSequence = records[records.length - 1].sequence;
				}

				// Keep an end-of-page cursor as the incremental checkpoint. This is
				// important for a provider engine: after the final initial page it
				// must be able to pull only changes appended later.
				// When an existing cursor is already at the end of the change log,
				// omit nextCursor so callers retain that cursor unchanged.
				const nextCursor =
					lastScannedSequence > startSequence
						? this.issueCursor(request.calendarId, lastScannedSequence)
						: undefined;
				return nextCursor
					? { changes: selected, nextCursor, hasMore: false }
					: { changes: selected, hasMore: false };
			}

			const nextCursor = this.issueCursor(request.calendarId, lastScannedSequence);
			return { changes: selected, nextCursor, hasMore: true };
		}, { calendarId: request.calendarId, cursor: request.cursor });
	}

	createEvent(
		session: ProviderSession,
		calendarId: string,
		event: CalendarEvent,
		signal?: AbortSignal,
	): Promise<RemoteCalendarEvent> {
		return this.run('createEvent', signal, () => {
			this.validateSession(session);
			const calendar = this.requireWritableCalendar(calendarId);
			const created = this.seedEvent(calendar.calendarId, event, { calendarUid: event.uid });
			return this.cloneRemoteEvent(created);
		}, { calendarId });
	}

	updateEvent(
		session: ProviderSession,
		calendarId: string,
		remoteId: string,
		event: CalendarEvent,
		expectedVersion?: string,
		signal?: AbortSignal,
	): Promise<RemoteCalendarEvent> {
		return this.run('updateEvent', signal, () => {
			this.validateSession(session);
			const calendar = this.requireWritableCalendar(calendarId);
			const stored = this.events.get(calendar.calendarId)?.get(remoteId);
			if (!stored) throw permanentError('Remote event was not found', { code: 'not-found', status: 404 });
			this.requireVersion(stored, expectedVersion);

			const canonical = normalizeCalendarEvent(event);
			const versionNumber = stored.versionNumber + 1;
			const updated: RemoteCalendarEvent = {
				...stored.remote,
				event: canonical,
				// A plugin-originated update establishes/refreshes the private
				// association even when the imported event was initially untagged.
				calendarUid: canonical.uid,
				version: this.version(versionNumber),
				remoteUpdatedAt: this.nowIso(),
			};
			this.events.get(calendar.calendarId)?.set(remoteId, { remote: updated, versionNumber });
			this.appendChange(calendar.calendarId, { type: 'upsert', value: updated });
			return this.cloneRemoteEvent(updated);
		}, { calendarId, remoteId, expectedVersion });
	}

	deleteEvent(
		session: ProviderSession,
		calendarId: string,
		remoteId: string,
		expectedVersion?: string,
		signal?: AbortSignal,
	): Promise<void> {
		return this.run('deleteEvent', signal, () => {
			this.validateSession(session);
			const calendar = this.requireWritableCalendar(calendarId);
			const stored = this.events.get(calendar.calendarId)?.get(remoteId);
			if (!stored) throw permanentError('Remote event was not found', { code: 'not-found', status: 404 });
			this.requireVersion(stored, expectedVersion);
			this.events.get(calendar.calendarId)?.delete(remoteId);
			this.appendChange(calendar.calendarId, {
				type: 'delete',
				providerId: this.id,
				calendarId,
				remoteId,
			});
		}, { calendarId, remoteId, expectedVersion });
	}

	/** Queue an error for the next invocation of an operation. */
	queueError(operation: FakeProviderOperation, error: ProviderError): void {
		const queue = this.queuedErrors.get(operation) ?? [];
		queue.push(error);
		this.queuedErrors.set(operation, queue);
	}

	/** Alias for queueError used by retry-focused tests. */
	failNext(operation: FakeProviderOperation, error: ProviderError): void {
		this.queueError(operation, error);
	}

	/** Queue the same categorized failure more than once. */
	queueErrors(
		operation: FakeProviderOperation,
		errors: readonly ProviderError[],
	): void {
		for (const error of errors) this.queueError(operation, error);
	}

	/** Force a cursor to expire without relying on a wall-clock wait. */
	expireCursor(cursor: OpaqueCursor): void {
		const state = this.cursors.get(cursor);
		if (state) this.cursors.set(cursor, { ...state, expiresAt: this.clock.now() - 1 });
	}

	getCallLog(): readonly FakeProviderCall[] {
		return this.calls.map(call => ({ ...call }));
	}

	getCallCount(operation?: FakeProviderOperation): number {
		return operation === undefined
			? this.calls.length
			: this.calls.filter(call => call.operation === operation).length;
	}

	getEvents(calendarId: string): readonly RemoteCalendarEvent[] {
		return Array.from(this.events.get(calendarId)?.values() ?? []).map(stored =>
			this.cloneRemoteEvent(stored.remote),
		);
	}

	getEvent(calendarId: string, remoteId: string): RemoteCalendarEvent | undefined {
		const event = this.events.get(calendarId)?.get(remoteId)?.remote;
		return event ? this.cloneRemoteEvent(event) : undefined;
	}

	/** Opaque convenience binding for tests that need a provider reference. */
	getReference(calendarId: string, remoteId: string): ProviderReference<ProviderId> | undefined {
		const event = this.getEvent(calendarId, remoteId);
		if (!event) return undefined;
		return {
			providerId: this.id,
			accountId: this.accountId,
			calendarId,
			remoteEventId: remoteId,
			version: event.version,
		};
	}

	private async run<T>(
		operation: FakeProviderOperation,
		signal: AbortSignal | undefined,
		callback: () => T,
		metadata: Omit<FakeProviderCall, 'operation' | 'at'> = {},
	): Promise<T> {
		this.throwIfAborted(signal);
		this.calls.push({ operation, at: this.clock.now(), ...metadata });
		const queued = this.queuedErrors.get(operation)?.shift();
		if (queued) {
			this.throwIfAborted(signal);
			throw queued;
		}
		const value = callback();
		this.throwIfAborted(signal);
		return value;
	}

	private validateSession(session: ProviderSession): void {
		if (session.providerId !== this.id) {
			throw authorizationError('Provider session does not belong to this adapter', {
				code: 'wrong-provider',
			});
		}
		if (!session.accountId) {
			throw authorizationError('Provider session is missing an account id', { code: 'invalid-session' });
		}
	}

	private requireCalendar(calendarId: string): RemoteCalendar {
		const calendar = this.calendars.get(calendarId);
		if (!calendar) {
			throw permanentError('Remote calendar was not found', { code: 'calendar-not-found', status: 404 });
		}
		return calendar;
	}

	private requireWritableCalendar(calendarId: string): RemoteCalendar {
		const calendar = this.requireCalendar(calendarId);
		if (!calendar.writable) {
			throw authorizationError('Remote calendar is read-only', { code: 'calendar-read-only', status: 403 });
		}
		return calendar;
	}

	private requireVersion(stored: StoredEvent, expectedVersion: string | undefined): void {
		if (expectedVersion !== undefined && expectedVersion !== stored.remote.version) {
			throw conflictError('Remote event version does not match', {
				providerId: this.id,
				status: 412,
				code: 'version-mismatch',
				details: { expectedVersion, currentVersion: stored.remote.version },
			});
		}
	}

	private appendChange(calendarId: string, change: RemoteChange): void {
		const records = this.changes.get(calendarId) ?? [];
		records.push({ sequence: this.nextSequence++, change: this.cloneChange(change) });
		this.changes.set(calendarId, records);
	}

	private issueCursor(calendarId: string, sequence: number): OpaqueCursor {
		const cursor = `fake-cursor-${this.nextCursor++}`;
		this.cursors.set(cursor, {
			calendarId,
			sequence,
			expiresAt: this.clock.now() + this.cursorTtlMs,
		});
		return cursor;
	}

	private readCursor(cursor: OpaqueCursor, calendarId: string): CursorState {
		const state = this.cursors.get(cursor);
		if (!state || state.calendarId !== calendarId || this.clock.now() >= state.expiresAt) {
			throw cursorExpiredError('Change cursor is invalid or expired', {
				providerId: this.id,
				code: 'cursor-expired',
			});
		}
		return state;
	}

	private changeInWindow(change: RemoteChange, window: SyncWindow): boolean {
		if (change.type === 'delete') return true;
		const event = change.value.event;
		const windowStart = Date.parse(window.from);
		const windowEnd = Date.parse(window.to);
		if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) return true;
		const eventStart = event.allDay
			? Date.parse(`${event.start}T00:00:00Z`)
			: Date.parse(event.start);
		const eventEnd = event.allDay ? Date.parse(`${event.end}T00:00:00Z`) : Date.parse(event.end);
		if (!Number.isFinite(eventStart) || !Number.isFinite(eventEnd)) return true;
		return eventStart < windowEnd && eventEnd > windowStart;
	}

	private cloneRemoteEvent(remote: RemoteCalendarEvent): RemoteCalendarEvent {
		return { ...remote, event: { ...remote.event } };
	}

	private cloneChange(change: RemoteChange): RemoteChange {
		return change.type === 'upsert'
			? { type: 'upsert', value: this.cloneRemoteEvent(change.value) }
			: { ...change };
	}

	private parseVersion(version: string | undefined): number | undefined {
		if (!version) return undefined;
		const match = /^v(\d+)$/.exec(version);
		return match ? Number(match[1]) : undefined;
	}

	private version(number: number): string {
		return `v${number}`;
	}

	private nowIso(): string {
		return new Date(this.clock.now()).toISOString();
	}

	private throwIfAborted(signal: AbortSignal | undefined): void {
		if (signal?.aborted) throw new ProviderCancelledError('Provider operation was cancelled', this.id);
	}
}

export function fakeProviderDependencies(
	clock: ProviderClock = defaultClock,
	): CalendarProviderDependencies {
	return { clock };
}

/** Construct a valid session for fake-provider fixtures. */
export function fakeProviderSession(
	providerId: ProviderId = 'google',
	accountId = DEFAULT_ACCOUNT_ID,
): ProviderSession {
	return { providerId, accountId };
}
