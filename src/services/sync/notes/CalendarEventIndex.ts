import type {
	CalendarEvent,
	CalendarEventAssociation,
	SyncStatus,
} from '../model/CalendarEvent';
import type { FrontmatterRecord } from './FrontmatterEventCodec';

export interface IndexedCalendarEvent {
	readonly path: string;
	readonly event: CalendarEvent;
	readonly status?: SyncStatus;
	readonly association?: CalendarEventAssociation;
	/** The parsed frontmatter is retained for diagnostics/read-model consumers. */
	readonly frontmatter?: FrontmatterRecord;
	/** The body is retained as an observed value; the repository never rewrites it. */
	readonly body?: string;
}

export type CalendarEventIndexErrorCode = 'duplicate-uid' | 'duplicate-path';

/** Recoverable, deterministic index collision. */
export class CalendarEventIndexError extends Error {
	readonly code: CalendarEventIndexErrorCode;
	readonly uid?: string;
	readonly path: string;
	readonly conflictingPath?: string;

	constructor(
		code: CalendarEventIndexErrorCode,
		message: string,
		metadata: {
			uid?: string;
			path: string;
			conflictingPath?: string;
		},
	) {
		super(message);
		this.name = 'CalendarEventIndexError';
		this.code = code;
		this.uid = metadata.uid;
		this.path = metadata.path;
		this.conflictingPath = metadata.conflictingPath;
		Object.setPrototypeOf(this, CalendarEventIndexError.prototype);
	}
}

export class DuplicateCalendarEventUidError extends CalendarEventIndexError {
	constructor(uid: string, path: string, conflictingPath: string) {
		super(
			'duplicate-uid',
			`Duplicate calendar_uid "${uid}" at "${path}"; already mapped to "${conflictingPath}"`,
			{ uid, path, conflictingPath },
		);
		this.name = 'DuplicateCalendarEventUidError';
		Object.setPrototypeOf(this, DuplicateCalendarEventUidError.prototype);
	}
}

export class CalendarEventPathCollisionError extends CalendarEventIndexError {
	constructor(path: string, conflictingPath = path) {
		super(
			'duplicate-path',
			`Calendar event path collision at "${path}"`,
			{ path, conflictingPath },
		);
		this.name = 'CalendarEventPathCollisionError';
		Object.setPrototypeOf(this, CalendarEventPathCollisionError.prototype);
	}
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function comparePaths(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Bidirectional in-memory index for eligible event notes. It stores no remote
 * operations and therefore remains safe to use as the vault read model.
 */
export class CalendarEventIndex {
	private readonly uidToPathStorage = new Map<string, string>();
	private readonly pathToRecordStorage = new Map<string, IndexedCalendarEvent>();

	get uidToPath(): ReadonlyMap<string, string> {
		return this.uidToPathStorage;
	}

	get pathToEvent(): ReadonlyMap<string, CalendarEvent> {
		return this.pathToEventMap;
	}

	get pathToRecord(): ReadonlyMap<string, IndexedCalendarEvent> {
		return this.pathToRecordStorage;
	}

	/** A snapshot map exposed for read-only consumers. */
	get uidToPathMap(): ReadonlyMap<string, string> {
		return this.uidToPathStorage;
	}

	/** A snapshot map with events keyed by vault path. */
	get pathToEventMap(): ReadonlyMap<string, CalendarEvent> {
		const map = new Map<string, CalendarEvent>();
		for (const [path, record] of this.pathToRecordStorage) map.set(path, record.event);
		return map;
	}

	/** Full records are available for status and association projections. */
	get pathToRecordMap(): ReadonlyMap<string, IndexedCalendarEvent> {
		return this.pathToRecordStorage;
	}

	get size(): number {
		return this.pathToRecordStorage.size;
	}

	clear(): void {
		this.uidToPathStorage.clear();
		this.pathToRecordStorage.clear();
	}

	private assertCanSet(record: IndexedCalendarEvent): string {
		const path = normalizePath(record.path);
		const byPath = this.pathToRecordStorage.get(path);
		if (byPath && byPath.event.uid !== record.event.uid) {
			throw new CalendarEventPathCollisionError(path, byPath.path);
		}
		const existingPath = this.uidToPathStorage.get(record.event.uid);
		if (existingPath !== undefined && existingPath !== path) {
			throw new DuplicateCalendarEventUidError(record.event.uid, path, existingPath);
		}
		return path;
	}

	/** Add or replace one path, rejecting UID and path collisions atomically. */
	set(record: IndexedCalendarEvent): void {
		const path = this.assertCanSet(record);
		const normalizedRecord: IndexedCalendarEvent = { ...record, path };
		const existing = this.pathToRecordStorage.get(path);
		if (existing && existing.event.uid !== normalizedRecord.event.uid) {
			throw new CalendarEventPathCollisionError(path, existing.path);
		}
		this.pathToRecordStorage.set(path, normalizedRecord);
		this.uidToPathStorage.set(normalizedRecord.event.uid, path);
	}

	/** Alias emphasizing that callers are registering a newly observed note. */
	register(record: IndexedCalendarEvent): void {
		this.set(record);
	}

	add(record: IndexedCalendarEvent): void {
		this.set(record);
	}

	upsert(record: IndexedCalendarEvent): void {
		this.set(record);
	}

	/** Replace a path's event while retaining its path and immutable UID. */
	update(pathInput: string, event: CalendarEvent, extra: Omit<IndexedCalendarEvent, 'path' | 'event'> = {}): void {
		const path = normalizePath(pathInput);
		const existing = this.pathToRecordStorage.get(path);
		if (!existing) {
			this.set({ path, event, ...extra });
			return;
		}
		if (existing.event.uid !== event.uid) {
			throw new DuplicateCalendarEventUidError(event.uid, path, existing.path);
		}
		this.pathToRecordStorage.set(path, { ...existing, ...extra, event, path });
		this.uidToPathStorage.set(event.uid, path);
	}

	/** Move a mapping locally; this method does not perform vault I/O. */
	rename(pathInput: string, nextPathInput: string): IndexedCalendarEvent {
		const path = normalizePath(pathInput);
		const nextPath = normalizePath(nextPathInput);
		const record = this.pathToRecordStorage.get(path);
		if (!record) throw new Error(`Calendar event note not indexed at "${path}"`);
		if (path === nextPath) return record;
		const collision = this.pathToRecordStorage.get(nextPath);
		if (collision) throw new CalendarEventPathCollisionError(nextPath, collision.path);
		this.pathToRecordStorage.delete(path);
		const moved = { ...record, path: nextPath };
		this.pathToRecordStorage.set(nextPath, moved);
		this.uidToPathStorage.set(record.event.uid, nextPath);
		return moved;
	}

	removeByPath(pathInput: string): IndexedCalendarEvent | undefined {
		const path = normalizePath(pathInput);
		const record = this.pathToRecordStorage.get(path);
		if (!record) return undefined;
		this.pathToRecordStorage.delete(path);
		this.uidToPathStorage.delete(record.event.uid);
		return record;
	}

	removeByUid(uid: string): IndexedCalendarEvent | undefined {
		const path = this.uidToPathStorage.get(uid);
		return path === undefined ? undefined : this.removeByPath(path);
	}

	remove(path: string): IndexedCalendarEvent | undefined {
		return this.removeByPath(path);
	}

	getPath(uid: string): string | undefined {
		return this.uidToPathStorage.get(uid);
	}

	getPathForUid(uid: string): string | undefined {
		return this.getPath(uid);
	}

	getByUid(uid: string): IndexedCalendarEvent | undefined {
		const path = this.uidToPathStorage.get(uid);
		return path === undefined ? undefined : this.pathToRecordStorage.get(path);
	}

	getEventByUid(uid: string): CalendarEvent | undefined {
		return this.getByUid(uid)?.event;
	}

	getByPath(pathInput: string): IndexedCalendarEvent | undefined {
		return this.pathToRecordStorage.get(normalizePath(pathInput));
	}

	getEventByPath(pathInput: string): CalendarEvent | undefined {
		return this.getByPath(pathInput)?.event;
	}

	values(): IndexedCalendarEvent[] {
		return Array.from(this.pathToRecordStorage.values()).sort((left, right) => comparePaths(left.path, right.path));
	}

	entries(): Array<[string, IndexedCalendarEvent]> {
		return this.values().map(record => [record.path, record]);
	}

	/**
	 * Rebuild the maps in deterministic path order. The existing maps are left
	 * untouched if a collision is found, allowing the caller to recover.
	 */
	rebuild(records: readonly IndexedCalendarEvent[]): void {
		const candidate = new CalendarEventIndex();
		for (const record of [...records].sort((left, right) => comparePaths(normalizePath(left.path), normalizePath(right.path)))) {
			candidate.set(record);
		}
		this.uidToPathStorage.clear();
		this.pathToRecordStorage.clear();
		for (const [uid, path] of candidate.uidToPathStorage) this.uidToPathStorage.set(uid, path);
		for (const [path, record] of candidate.pathToRecordStorage) this.pathToRecordStorage.set(path, record);
	}
}

export function createCalendarEventIndex(
	records: readonly IndexedCalendarEvent[] = [],
): CalendarEventIndex {
	const index = new CalendarEventIndex();
	index.rebuild(records);
	return index;
}

export const CalendarEventIndexCollisionError = CalendarEventIndexError;
