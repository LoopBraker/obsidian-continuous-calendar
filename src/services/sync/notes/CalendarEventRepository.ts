import type {
	CalendarEvent,
	CalendarEventInput,
	SyncStatus,
} from '../model/CalendarEvent';
import { normalizeCalendarEvent, type CalendarEventValidationError } from '../model/CalendarEventValidation';
import {
	applyCalendarEventFrontmatter,
	decodeCalendarEventNote,
	encodeCalendarEventNote,
	type CalendarEventFrontmatterOptions,
	type CalendarEventNote,
	type FrontmatterRecord,
} from './FrontmatterEventCodec';
import {
	CalendarEventIndex,
	CalendarEventIndexError,
	CalendarEventPathCollisionError,
	DuplicateCalendarEventUidError,
	type IndexedCalendarEvent,
} from './CalendarEventIndex';

/** A minimal file descriptor understood by the injected vault operations. */
export interface CalendarVaultFile {
	readonly path: string;
	readonly name?: string;
	readonly extension?: string;
	/** Native TFile-like value used by the optional Obsidian adapter. */
	readonly native?: unknown;
}

export type CalendarVaultFileLike = CalendarVaultFile | string;

export type CalendarEventInputLike = CalendarEvent | CalendarEventInput;

export type FrontmatterProcessor = (frontmatter: FrontmatterRecord) => void;

/**
 * Runtime-neutral vault operations. Tests can provide an in-memory object;
 * production code can inject an adapter around Obsidian's Vault/TFile API.
 */
export interface CalendarEventVault {
	getMarkdownFiles?(): readonly CalendarVaultFileLike[] | Promise<readonly CalendarVaultFileLike[]>;
	listMarkdownFiles?(): readonly CalendarVaultFileLike[] | Promise<readonly CalendarVaultFileLike[]>;
	read(file: CalendarVaultFileLike): string | Promise<string>;
	create(path: string, content: string): CalendarVaultFileLike | void | Promise<CalendarVaultFileLike | void>;
	processFrontMatter(file: CalendarVaultFileLike, processor: FrontmatterProcessor): Promise<void> | void;
	rename(file: CalendarVaultFileLike, newPath: string): Promise<void> | void;
	trash?(file: CalendarVaultFileLike): Promise<void> | void;
}

export interface CalendarEventRepositoryOptions extends CalendarEventFrontmatterOptions {
	readonly folder?: string;
	readonly eventFolder?: string;
	readonly uuidFactory?: () => string;
	readonly filenameFactory?: (event: CalendarEvent | CalendarEventInput, uid: string) => string;
	readonly onLocalDeletion?: (deletion: LocalCalendarEventDeletion) => void;
}

export interface CalendarEventCreateOptions extends CalendarEventFrontmatterOptions {
	readonly body?: string;
	/** An explicit path is never silently suffixed when it already exists. */
	readonly path?: string;
	/** A filename relative to the configured folder. */
	readonly filename?: string;
}

export type CalendarEventUpdateOptions = CalendarEventFrontmatterOptions;

export interface CalendarEventNoteRecord extends IndexedCalendarEvent {
	readonly body: string;
	readonly frontmatter: FrontmatterRecord;
}

export interface LocalCalendarEventDeletion {
	readonly path: string;
	readonly uid: string;
	readonly event: CalendarEventNoteRecord['event'];
	readonly reason: 'missing-from-vault' | 'deleted';
}

export type CalendarEventRepositoryErrorCode =
	| 'duplicate-uid'
	| 'duplicate-path'
	| 'invalid-event-note'
	| 'not-found'
	| 'immutable-uid'
	| 'invalid-path';

export class CalendarEventRepositoryError extends Error {
	readonly code: CalendarEventRepositoryErrorCode;
	readonly path?: string;
	readonly uid?: string;
	readonly validationErrors?: readonly CalendarEventValidationError[];
	readonly cause?: unknown;

	constructor(
		code: CalendarEventRepositoryErrorCode,
		message: string,
		metadata: {
			path?: string;
			uid?: string;
			validationErrors?: readonly CalendarEventValidationError[];
			cause?: unknown;
		} = {},
	) {
		super(message);
		this.name = 'CalendarEventRepositoryError';
		this.code = code;
		this.path = metadata.path;
		this.uid = metadata.uid;
		this.validationErrors = metadata.validationErrors;
		this.cause = metadata.cause;
		Object.setPrototypeOf(this, CalendarEventRepositoryError.prototype);
	}
}

export interface CalendarEventRepositoryErrorReport {
	readonly path: string;
	readonly code: 'invalid-event-note' | 'duplicate-uid' | 'duplicate-path';
	readonly message: string;
	readonly validationErrors?: readonly CalendarEventValidationError[];
	readonly error: Error;
}

export interface CalendarEventReloadResult {
	readonly records: readonly CalendarEventNoteRecord[];
	readonly events: readonly CalendarEventNoteRecord[];
	readonly deleted: readonly LocalCalendarEventDeletion[];
	readonly errors: readonly CalendarEventRepositoryErrorReport[];
}

export type LocalDeletionListener = (deletion: LocalCalendarEventDeletion) => void;

function isVaultFile(value: CalendarVaultFileLike): value is CalendarVaultFile {
	return typeof value === 'object' && value !== null && typeof value.path === 'string';
}

function filePath(value: CalendarVaultFileLike): string {
	return typeof value === 'string' ? value : value.path;
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

function comparePaths(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeFolder(folder: string): string {
	return normalizePath(folder.trim()).replace(/\/+$/, '');
}

function joinPath(folder: string, child: string): string {
	const normalizedChild = normalizePath(child).replace(/^\/+/, '');
	return folder ? `${folder}/${normalizedChild}` : normalizedChild;
}

function isMarkdownPath(path: string): boolean {
	return path.toLowerCase().endsWith('.md');
}

function slugifyTitle(title: string): string {
	const normalized = title
		.trim()
		.replace(/[\\/:*?"<>|]/g, '-')
		.replace(/\s+/g, ' ')
		.replace(/\.+$/g, '');
	return normalized.split('').filter(character => character >= ' ' || character === '\t').join('') || 'Calendar event';
}

function ensureMarkdownExtension(filename: string): string {
	return filename.toLowerCase().endsWith('.md') ? filename : `${filename}.md`;
}

function defaultUuid(): string {
	const runtimeCrypto = (globalThis as unknown as {
		crypto?: { randomUUID?: () => string; getRandomValues?: (values: Uint8Array) => Uint8Array };
	}).crypto;
	if (runtimeCrypto?.randomUUID) return runtimeCrypto.randomUUID();
	if (runtimeCrypto?.getRandomValues) {
		const bytes = runtimeCrypto.getRandomValues(new Uint8Array(16));
		bytes[6] = (bytes[6] & 0x0f) | 0x40;
		bytes[8] = (bytes[8] & 0x3f) | 0x80;
		const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	}
	let value = '';
	for (let index = 0; index < 32; index += 1) value += Math.floor(Math.random() * 16).toString(16);
	return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20)}`;
}

function hasOwn(value: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function getUidInput(input: CalendarEventInputLike): unknown {
	const record = input as Record<string, unknown>;
	if (hasOwn(input, 'uid')) return record.uid;
	if (hasOwn(input, 'calendar_uid')) return record.calendar_uid;
	return undefined;
}

function canonicalPatch(input: CalendarEventInputLike): Record<string, unknown> {
	const patch: Record<string, unknown> = { ...input };
	const record = input as Record<string, unknown>;
	const aliases: ReadonlyArray<readonly [string, string]> = [
		['calendar_uid', 'uid'],
		['calendar_title', 'title'],
		['date', 'start'],
		['dateStart', 'start'],
		['dateEnd', 'end'],
		['calendar_all_day', 'allDay'],
		['all_day', 'allDay'],
		['calendar_timezone', 'timezone'],
		['calendar_location', 'location'],
		['calendar_description', 'description'],
	];
	for (const [alias, canonical] of aliases) {
		if (!hasOwn(input, canonical) && hasOwn(input, alias)) patch[canonical] = record[alias];
	}
	return patch;
}

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

function pathOrUidError(pathOrUid: string): CalendarEventRepositoryError {
	return new CalendarEventRepositoryError(
		'not-found',
		`Calendar event note "${pathOrUid}" is not indexed`,
		{ path: pathOrUid, uid: pathOrUid },
	);
}

function recordAssociation(
	eventUid: string,
	association: CalendarEventFrontmatterOptions['association'] | undefined,
	status: SyncStatus | undefined,
): CalendarEventNoteRecord['association'] {
	if (association === undefined) return undefined;
	if ('reference' in association) return { ...association, calendarUid: eventUid };
	return {
		calendarUid: eventUid,
		reference: association,
		status: status ?? 'pending',
	};
}

/**
 * Vault-backed repository for explicitly marked Markdown event notes.
 * Provider APIs are intentionally absent: renames, updates, and deletion
 * signals are all local operations until the canonical sync engine handles
 * them.
 */
export class CalendarEventRepository {
	readonly index: CalendarEventIndex;
	readonly folder: string;
	readonly trash?: (pathOrUid: string) => Promise<void>;
	private readonly vault: CalendarEventVault;
	private readonly uuidFactory: () => string;
	private readonly filenameFactory?: CalendarEventRepositoryOptions['filenameFactory'];
	private readonly deletionListeners = new Set<LocalDeletionListener>();
	private lastReloadResult: CalendarEventReloadResult = {
		records: [],
		events: [],
		deleted: [],
		errors: [],
	};

	constructor(
		vault: CalendarEventVault,
		options: CalendarEventRepositoryOptions,
	);
	constructor(
		vault: CalendarEventVault,
		folder: string,
		options?: Omit<CalendarEventRepositoryOptions, 'folder'>,
	);
	constructor(
		vault: CalendarEventVault,
		optionsOrFolder: CalendarEventRepositoryOptions | string,
		legacyOptions: Omit<CalendarEventRepositoryOptions, 'folder'> = {},
	) {
		const options: CalendarEventRepositoryOptions =
			typeof optionsOrFolder === 'string'
				? { ...legacyOptions, folder: optionsOrFolder }
				: optionsOrFolder;
		this.vault = vault;
		this.folder = normalizeFolder(options.folder ?? options.eventFolder ?? '');
		this.uuidFactory = options.uuidFactory ?? defaultUuid;
		this.filenameFactory = options.filenameFactory;
		this.index = new CalendarEventIndex();
		if (this.vault.trash) this.trash = pathOrUid => this.trashExisting(pathOrUid);
		if (options.onLocalDeletion) this.deletionListeners.add(options.onLocalDeletion);
	}

	private async trashExisting(pathOrUid: string): Promise<void> {
		const path = this.resolveExistingPath(pathOrUid);
		const files = await this.listMarkdownFiles();
		const file = this.findFile(files, path) ?? path;
		await this.vault.trash?.(file);
		this.index.removeByPath(path);
	}

	get lastReload(): CalendarEventReloadResult {
		return this.lastReloadResult;
	}

	get errors(): readonly CalendarEventRepositoryErrorReport[] {
		return this.lastReloadResult.errors;
	}

	subscribeLocalDeletions(listener: LocalDeletionListener): () => void {
		this.deletionListeners.add(listener);
		return () => this.deletionListeners.delete(listener);
	}

	onLocalDeletion(listener: LocalDeletionListener): () => void {
		return this.subscribeLocalDeletions(listener);
	}

	private emitDeletion(deletion: LocalCalendarEventDeletion): void {
		for (const listener of this.deletionListeners) listener(deletion);
	}

	private async listMarkdownFiles(): Promise<CalendarVaultFileLike[]> {
		const list = this.vault.getMarkdownFiles ?? this.vault.listMarkdownFiles;
		if (!list) throw new Error('Calendar event vault must expose getMarkdownFiles or listMarkdownFiles');
		const files = await list.call(this.vault);
		return [...files]
			.filter(file => isMarkdownPath(filePath(file)))
			.sort((left, right) => comparePaths(normalizePath(filePath(left)), normalizePath(filePath(right))));
	}

	private findFile(files: readonly CalendarVaultFileLike[], pathInput: string): CalendarVaultFileLike | undefined {
		const path = normalizePath(pathInput);
		return files.find(file => normalizePath(filePath(file)) === path);
	}

	private async readPath(path: string, files?: readonly CalendarVaultFileLike[]): Promise<string> {
		const availableFiles = files ?? (await this.listMarkdownFiles());
		const file = this.findFile(availableFiles, path);
		return this.vault.read(file ?? normalizePath(path));
	}

	private async processPath(
		path: string,
		processor: FrontmatterProcessor,
		files?: readonly CalendarVaultFileLike[],
	): Promise<void> {
		const availableFiles = files ?? (await this.listMarkdownFiles());
		const file = this.findFile(availableFiles, path);
		await this.vault.processFrontMatter(file ?? normalizePath(path), processor);
	}

	private async reloadRecords(
		files: readonly CalendarVaultFileLike[],
	): Promise<{
		records: CalendarEventNoteRecord[];
		errors: CalendarEventRepositoryErrorReport[];
	}> {
		const records: CalendarEventNoteRecord[] = [];
		const errors: CalendarEventRepositoryErrorReport[] = [];
		for (const file of files) {
			const path = normalizePath(filePath(file));
			const content = await this.vault.read(file);
			const decoded = decodeCalendarEventNote(content);
			if (!decoded.marked) continue;
			if (!decoded.note) {
				const error = new CalendarEventRepositoryError(
					'invalid-event-note',
					`Invalid calendar event frontmatter in "${path}"`,
					{ path, validationErrors: decoded.errors },
				);
				errors.push({
					path,
					code: 'invalid-event-note',
					message: error.message,
					validationErrors: decoded.errors,
					error,
				});
				continue;
			}
			records.push({
				path,
				event: decoded.note.event,
				status: decoded.note.status,
				association: decoded.note.association,
				frontmatter: decoded.note.frontmatter,
				body: decoded.note.body,
			});
		}
		return { records, errors };
	}

	/**
	 * Scan the vault, replacing only the eligible-note read model. Deletions are
	 * emitted while the old index still contains the mapping, before loss.
	 */
	async reload(): Promise<CalendarEventReloadResult> {
		const files = await this.listMarkdownFiles();
		const oldRecords = this.index.values();
		const currentPaths = new Set(files.map(file => normalizePath(filePath(file))));
		const deleted: LocalCalendarEventDeletion[] = [];
		for (const oldRecord of oldRecords) {
			if (!currentPaths.has(oldRecord.path)) {
				const deletion: LocalCalendarEventDeletion = {
					path: oldRecord.path,
					uid: oldRecord.event.uid,
					event: oldRecord.event,
					reason: 'missing-from-vault',
				};
				deleted.push(deletion);
				this.emitDeletion(deletion);
			}
		}

		const scanned = await this.reloadRecords(files);
		const acceptedRecords: CalendarEventNoteRecord[] = [];
		for (const record of scanned.records) {
			try {
				const candidate = new CalendarEventIndex();
				candidate.rebuild([...acceptedRecords, record]);
				acceptedRecords.push(record);
			} catch (value) {
				const error = value instanceof CalendarEventIndexError ? value : asError(value);
				scanned.errors.push({
					path: record.path,
					code: error instanceof CalendarEventIndexError && error.code === 'duplicate-path'
						? 'duplicate-path'
						: 'duplicate-uid',
					message: error.message,
					error,
				});
			}
		}

		this.index.rebuild(acceptedRecords);
		const records: CalendarEventNoteRecord[] = this.index.values().map(record => ({
			...record,
			frontmatter: record.frontmatter ?? {},
			body: record.body ?? '',
		}));
		this.lastReloadResult = { records, events: records, deleted, errors: scanned.errors };
		return this.lastReloadResult;
	}

	/** Aliases useful to lifecycle callers. */
	load(): Promise<CalendarEventReloadResult> {
		return this.reload();
	}

	scan(): Promise<CalendarEventReloadResult> {
		return this.reload();
	}

	async reloadOrThrow(): Promise<CalendarEventReloadResult> {
		const result = await this.reload();
		if (result.errors.length > 0) throw result.errors[0].error;
		return result;
	}

	private resolveExistingPath(pathOrUid: string): string {
		const byPath = this.index.getByPath(pathOrUid);
		if (byPath) return byPath.path;
		const byUid = this.index.getPath(pathOrUid);
		if (byUid) return byUid;
		throw pathOrUidError(pathOrUid);
	}

	private async occupiedPaths(): Promise<Set<string>> {
		const files = await this.listMarkdownFiles();
		return new Set(files.map(file => normalizePath(filePath(file))));
	}

	private makeFilename(event: CalendarEvent | CalendarEventInput, uid: string): string {
		const proposed = this.filenameFactory
			? this.filenameFactory(event, uid)
			: slugifyTitle(String(event.title ?? 'Calendar event'));
		return ensureMarkdownExtension(proposed);
	}

	private async createPath(
		event: CalendarEvent | CalendarEventInput,
		uid: string,
		requestedPath: string | undefined,
		requestedFilename: string | undefined,
	): Promise<string> {
		const occupied = await this.occupiedPaths();
		if (requestedPath !== undefined) {
			const path = normalizePath(requestedPath);
			if (!isMarkdownPath(path)) throw new CalendarEventRepositoryError('invalid-path', `Calendar event path must end in .md: "${path}"`, { path });
			if (this.folder && path !== this.folder && !path.startsWith(`${this.folder}/`)) {
				throw new CalendarEventRepositoryError(
					'invalid-path',
					`Calendar event note must be created in configured folder "${this.folder}"`,
					{ path },
				);
			}
			if (occupied.has(path) || this.index.getByPath(path)) {
				throw new CalendarEventPathCollisionError(path, path);
			}
			return path;
		}

		const base = ensureMarkdownExtension(
			requestedFilename === undefined ? this.makeFilename(event, uid) : requestedFilename,
		);
		const folder = this.folder;
		let candidate = joinPath(folder, base);
		let suffix = 2;
		while (occupied.has(candidate) || this.index.getByPath(candidate)) {
			const extensionIndex = base.toLowerCase().endsWith('.md') ? base.length - 3 : base.length;
			candidate = joinPath(folder, `${base.slice(0, extensionIndex)} (${suffix}).md`);
			suffix += 1;
		}
		return candidate;
	}

	private throwIfUidExists(uid: string): void {
		const existingPath = this.index.getPath(uid);
		if (existingPath !== undefined) {
			throw new DuplicateCalendarEventUidError(uid, existingPath, existingPath);
		}
	}

	/** Create one marked note; a missing UID receives one immutable generated UID. */
	async create(
		input: CalendarEventInputLike,
		options: CalendarEventCreateOptions = {},
	): Promise<CalendarEventNoteRecord> {
		const rawInput: Record<string, unknown> = { ...input };
		const suppliedUid = getUidInput(rawInput);
		if (suppliedUid === undefined) rawInput.uid = this.uuidFactory();
		const event = normalizeCalendarEvent(rawInput);
		this.throwIfUidExists(event.uid);
		const path = await this.createPath(event, event.uid, options.path, options.filename);
		const content = encodeCalendarEventNote(event, {
			...options,
			body: options.body ?? '',
		});
		let createdFile: CalendarVaultFileLike | void;
		try {
			createdFile = await this.vault.create(path, content);
		} catch (value) {
			throw new CalendarEventRepositoryError('duplicate-path', `Could not create calendar event note at "${path}"`, {
				path,
				cause: value,
			});
		}
		const record: CalendarEventNoteRecord = {
			path: normalizePath(filePath(createdFile ?? path)),
			event,
			status: options.status,
			association: recordAssociation(event.uid, options.association, options.status),
			frontmatter: encodeFrontmatterForRecord(event, options),
			body: options.body ?? '',
		};
		this.index.set(record);
		return record;
	}

	createEvent(
		input: CalendarEventInputLike,
		options: CalendarEventCreateOptions = {},
	): Promise<CalendarEventNoteRecord> {
		return this.create(input, options);
	}

	createNote(
		input: CalendarEventInputLike,
		options: CalendarEventCreateOptions = {},
	): Promise<CalendarEventNoteRecord> {
		return this.create(input, options);
	}

	/** Read one indexed or path-addressable note; unmarked notes return undefined. */
	async read(pathInput: string): Promise<CalendarEventNoteRecord | undefined> {
		const path = this.index.getByPath(pathInput)?.path ?? this.index.getPath(pathInput) ?? normalizePath(pathInput);
		const content = await this.readPath(path);
		const decoded = decodeCalendarEventNote(content);
		if (!decoded.marked) return undefined;
		if (!decoded.note) {
			throw new CalendarEventRepositoryError(
				'invalid-event-note',
				`Invalid calendar event frontmatter in "${path}"`,
				{ path, validationErrors: decoded.errors },
			);
		}
		return {
			path,
			event: decoded.note.event,
			status: decoded.note.status,
			association: decoded.note.association,
			frontmatter: decoded.note.frontmatter,
			body: decoded.note.body,
		};
	}

	getByPath(path: string): CalendarEventNoteRecord | undefined {
		return this.index.getByPath(path) as CalendarEventNoteRecord | undefined;
	}

	getByUid(uid: string): CalendarEventNoteRecord | undefined {
		return this.index.getByUid(uid) as CalendarEventNoteRecord | undefined;
	}

	get(pathOrUid: string): CalendarEventNoteRecord | undefined {
		return this.getByPath(pathOrUid) ?? this.getByUid(pathOrUid);
	}

	list(): CalendarEventNoteRecord[] {
		return this.index.values() as CalendarEventNoteRecord[];
	}

	private mergedEventInput(
		existing: CalendarEventNoteRecord,
		input: CalendarEventInputLike,
	): CalendarEventInput {
		const suppliedUid = getUidInput(input);
		if (suppliedUid !== undefined && suppliedUid !== existing.event.uid) {
			throw new CalendarEventRepositoryError(
				'immutable-uid',
				`calendar_uid is immutable for "${existing.path}" (expected "${existing.event.uid}")`,
				{ path: existing.path, uid: String(suppliedUid) },
			);
		}
		return {
			...existing.event,
			...canonicalPatch(input),
			uid: existing.event.uid,
			calendar_uid: existing.event.uid,
		};
	}

	/**
	 * Update canonical fields through processFrontMatter only. No read/write
	 * operation is used, so the Markdown body remains byte-for-byte untouched.
	 */
	async update(
		pathOrUid: string,
		input: CalendarEventInputLike,
		options: CalendarEventUpdateOptions = {},
	): Promise<CalendarEventNoteRecord> {
		const path = this.resolveExistingPath(pathOrUid);
		const existing = this.index.getByPath(path) as CalendarEventNoteRecord;
		const event = normalizeCalendarEvent(this.mergedEventInput(existing, input));
		const status = options.status ?? existing.status;
		const association = options.association ?? existing.association;
		const frontmatterForRecord = { ...existing.frontmatter };
		await this.processPath(path, frontmatter => {
			applyCalendarEventFrontmatter(frontmatter, event, {
				...options,
				...(status === undefined ? {} : { status }),
				...(association === undefined ? {} : { association }),
			});
			Object.assign(frontmatterForRecord, frontmatter);
		});
		const record: CalendarEventNoteRecord = {
			...existing,
			event,
			status,
			association: recordAssociation(event.uid, association, status) ?? existing.association,
			frontmatter: frontmatterForRecord,
		};
		this.index.update(path, event, {
			status: record.status,
			association: record.association,
			frontmatter: record.frontmatter,
		});
		return record;
	}

	updateEvent(pathOrUid: string, input: CalendarEventInputLike, options: CalendarEventUpdateOptions = {}): Promise<CalendarEventNoteRecord> {
		return this.update(pathOrUid, input, options);
	}

	updateByUid(uid: string, input: CalendarEventInputLike, options: CalendarEventUpdateOptions = {}): Promise<CalendarEventNoteRecord> {
		return this.update(uid, input, options);
	}

	private async updateStatus(
		pathOrUid: string,
		status: SyncStatus,
	): Promise<CalendarEventNoteRecord> {
		const path = this.resolveExistingPath(pathOrUid);
		const existing = this.index.getByPath(path) as CalendarEventNoteRecord;
		const frontmatterForRecord = { ...existing.frontmatter };
		await this.processPath(path, frontmatter => {
			applyCalendarEventFrontmatter(frontmatter, existing.event, { status });
			Object.assign(frontmatterForRecord, frontmatter);
		});
		const record: CalendarEventNoteRecord = { ...existing, status, frontmatter: frontmatterForRecord };
		this.index.update(path, existing.event, { status, frontmatter: frontmatterForRecord });
		return record;
	}

	markRemoteDeleted(pathOrUid: string): Promise<CalendarEventNoteRecord> {
		return this.updateStatus(pathOrUid, 'remote_deleted');
	}

	markUnsupported(pathOrUid: string): Promise<CalendarEventNoteRecord> {
		return this.updateStatus(pathOrUid, 'unsupported');
	}

	markError(pathOrUid: string): Promise<CalendarEventNoteRecord> {
		return this.updateStatus(pathOrUid, 'error');
	}

	/** Signal a local deletion before removing its UID/path mapping. */
	notifyLocalDeletion(pathInput: string): LocalCalendarEventDeletion | undefined {
		const path = normalizePath(pathInput);
		const record = this.index.getByPath(path) as CalendarEventNoteRecord | undefined;
		if (!record) return undefined;
		const deletion: LocalCalendarEventDeletion = {
			path,
			uid: record.event.uid,
			event: record.event,
			reason: 'deleted',
		};
		this.emitDeletion(deletion);
		this.index.removeByPath(path);
		return deletion;
	}

	/** Alias for file-event handlers. */
	handleLocalDeletion(path: string): LocalCalendarEventDeletion | undefined {
		return this.notifyLocalDeletion(path);
	}

	async rename(pathOrUid: string, newPathInput: string): Promise<CalendarEventNoteRecord> {
		const path = this.resolveExistingPath(pathOrUid);
		const normalizedTarget = normalizePath(newPathInput);
		const nextPath = normalizedTarget.includes('/')
			? normalizedTarget
			: joinPath(this.folder, normalizedTarget);
		if (!isMarkdownPath(nextPath)) {
			throw new CalendarEventRepositoryError('invalid-path', `Calendar event path must end in .md: "${nextPath}"`, {
				path: nextPath,
			});
		}
		if (path === nextPath) return this.index.getByPath(path) as CalendarEventNoteRecord;
		const files = await this.listMarkdownFiles();
		const existingTarget = this.findFile(files, nextPath);
		if (existingTarget || this.index.getByPath(nextPath)) {
			throw new CalendarEventPathCollisionError(nextPath, nextPath);
		}
		const source = this.findFile(files, path) ?? path;
		await this.vault.rename(source, nextPath);
		return this.index.rename(path, nextPath) as CalendarEventNoteRecord;
	}

	renameByUid(uid: string, newPath: string): Promise<CalendarEventNoteRecord> {
		return this.rename(uid, newPath);
	}
}

function encodeFrontmatterForRecord(
	event: CalendarEventNoteRecord['event'],
	options: CalendarEventFrontmatterOptions,
): FrontmatterRecord {
	const content = encodeCalendarEventNote(event, options);
	return decodeCalendarEventNote(content).note?.frontmatter ?? {};
}

/**
 * Adapter for production Obsidian Vault objects. It is deliberately typed by
 * the operations used here, so tests do not need to instantiate Obsidian.
 */
export interface ObsidianVaultLike {
	getMarkdownFiles(): ReadonlyArray<{ path: string; name?: string; extension?: string }>;
	read(file: unknown): Promise<string>;
	create(path: string, content: string): Promise<{ path: string; name?: string; extension?: string }>;
	processFrontMatter(file: unknown, processor: FrontmatterProcessor): Promise<void>;
	rename(file: unknown, newPath: string): Promise<void>;
	trash?(file: unknown): Promise<void>;
	getAbstractFileByPath?(path: string): unknown;
}

export class ObsidianCalendarEventVaultAdapter implements CalendarEventVault {
	constructor(private readonly vault: ObsidianVaultLike) {}

	getMarkdownFiles(): readonly CalendarVaultFile[] {
		return this.vault.getMarkdownFiles().map(file => ({ ...file, native: file }));
	}

	private nativeFile(file: CalendarVaultFileLike): unknown {
		if (isVaultFile(file) && file.native !== undefined) return file.native;
		const path = filePath(file);
		return this.vault.getAbstractFileByPath?.(path) ?? file;
	}

	read(file: CalendarVaultFileLike): Promise<string> {
		return this.vault.read(this.nativeFile(file));
	}

	async create(path: string, content: string): Promise<CalendarVaultFile> {
		const file = await this.vault.create(path, content);
		return { ...file, native: file };
	}

	processFrontMatter(file: CalendarVaultFileLike, processor: FrontmatterProcessor): Promise<void> {
		return this.vault.processFrontMatter(this.nativeFile(file), processor);
	}

	rename(file: CalendarVaultFileLike, newPath: string): Promise<void> {
		return this.vault.rename(this.nativeFile(file), newPath);
	}

	trash(file: CalendarVaultFileLike): Promise<void> {
		if (!this.vault.trash) return Promise.reject(new Error('Obsidian vault trash is unavailable'));
		return this.vault.trash(this.nativeFile(file));
	}
}

export function createObsidianCalendarEventVault(vault: ObsidianVaultLike): CalendarEventVault {
	return new ObsidianCalendarEventVaultAdapter(vault);
}

export const ObsidianVaultAdapter = ObsidianCalendarEventVaultAdapter;

export function createCalendarEventRepository(
	vault: CalendarEventVault,
	options: CalendarEventRepositoryOptions,
): CalendarEventRepository {
	return new CalendarEventRepository(vault, options);
}

export type { CalendarEventNote };
