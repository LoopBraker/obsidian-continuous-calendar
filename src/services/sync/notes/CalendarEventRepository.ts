import type {
	CalendarEvent,
	CalendarEventInput,
	CalendarEventAssociation,
	ProviderReference,
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
	CalendarEventPathCollisionError,
	CalendarNoteTargetRepresentationConflictError,
	DuplicateCalendarNoteTargetError,
	DuplicateCalendarEventUidError,
	type IndexedCalendarEvent,
} from './CalendarEventIndex';
import {
	addCivilDays,
	calendarNoteTargetClaim,
	calendarNoteTargetMatchesProviderReference,
	decodeCalendarNoteTarget,
	encodeCalendarNoteTarget,
	eventDateForDayOffset,
	occurrenceTargetKey,
	targetKey,
	type CalendarNoteTarget,
	type CalendarNoteTargetClaim,
} from './CalendarNoteTarget';

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

export interface CalendarNoteDayConfirmation {
	readonly action: 'accept-proposed'
		| 'keep-unresolved'
		| 'rebind-offset';
	readonly newDayOffset?: number;
	readonly confirmedDate?: string;
	readonly occurrenceStartDate?: string;
	readonly occurrenceEndDateExclusive?: string;
}

export interface CalendarNoteTargetClaimant {
	readonly path: string;
	readonly uid?: string;
	readonly target?: CalendarNoteTarget;
	readonly targetErrors?: readonly string[];
	readonly record?: CalendarEventNoteRecord;
	readonly reference?: ProviderReference;
	readonly marked: boolean;
	readonly claim: CalendarNoteTargetClaim;
}

export interface CalendarNoteLegacyMigrationResult {
	readonly migrated: readonly CalendarEventNoteRecord[];
	readonly unresolved: readonly CalendarEventNoteRecord[];
	readonly alreadyTargeted: readonly CalendarEventNoteRecord[];
}

export type CalendarEventUpdateOptions = CalendarEventFrontmatterOptions;

export interface CalendarEventNoteRecord extends IndexedCalendarEvent {
	readonly body: string;
	readonly frontmatter: FrontmatterRecord;
	readonly targetErrors?: readonly string[];
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
	| 'immutable-association'
	| 'invalid-path'
	| 'invalid-target'
	| 'duplicate-target'
	| 'target-representation-conflict';

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
	readonly code:
		| 'invalid-event-note'
		| 'duplicate-uid'
		| 'duplicate-path'
		| 'invalid-target'
		| 'duplicate-target'
		| 'target-representation-conflict';
	readonly message: string;
	readonly validationErrors?: readonly CalendarEventValidationError[];
	readonly error: Error;
}

export interface CalendarEventReloadResult {
	readonly records: readonly CalendarEventNoteRecord[];
	readonly events: readonly CalendarEventNoteRecord[];
	readonly deleted: readonly LocalCalendarEventDeletion[];
	readonly errors: readonly CalendarEventRepositoryErrorReport[];
	readonly ownedPaths: readonly string[];
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
		['calendar_recurrence', 'recurrence'],
	];
	for (const [alias, canonical] of aliases) {
		if (!hasOwn(input, canonical) && hasOwn(input, alias)) patch[canonical] = record[alias];
	}
	return patch;
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

function providerReferenceOf(
	association: CalendarEventAssociation | ProviderReference,
): ProviderReference {
	return 'reference' in association ? association.reference : association;
}

function sameProviderReference(left: ProviderReference, right: ProviderReference): boolean {
	return left.providerId === right.providerId &&
		left.accountId === right.accountId &&
		left.calendarId === right.calendarId &&
		left.remoteEventId === right.remoteEventId;
}

function providerReferenceKey(reference: ProviderReference): string {
	return JSON.stringify([
		reference.providerId,
		reference.accountId,
		reference.calendarId,
		reference.remoteEventId,
	]);
}

function rawProviderReference(frontmatter: FrontmatterRecord): ProviderReference | undefined {
	const rawSync = frontmatter.calendar_sync;
	if (typeof rawSync !== 'object' || rawSync === null || Array.isArray(rawSync)) return undefined;
	const sync = rawSync as Record<string, unknown>;
	for (const providerId of Object.keys(sync).filter(key => key !== 'status' && key !== 'error').sort()) {
		const rawProvider = sync[providerId];
		if (typeof rawProvider !== 'object' || rawProvider === null || Array.isArray(rawProvider)) continue;
		const provider = rawProvider as Record<string, unknown>;
		const accountId = provider.account_id;
		const calendarId = provider.calendar_id;
		const remoteEventId = provider.event_id ?? provider.remote_event_id;
		if (
			typeof accountId === 'string' && accountId.length > 0 &&
			typeof calendarId === 'string' && calendarId.length > 0 &&
			typeof remoteEventId === 'string' && remoteEventId.length > 0
		) return { providerId, accountId, calendarId, remoteEventId };
	}
	return undefined;
}

function civilDateSpan(startDate: string, endDateExclusive: string): number | undefined {
	const nextDay = addCivilDays(startDate, 0);
	if (!nextDay || !addCivilDays(endDateExclusive, 0) || endDateExclusive <= startDate) return undefined;
	let count = 0;
	let cursor = startDate;
	while (cursor < endDateExclusive && count < 4000) {
		count += 1;
		cursor = addCivilDays(cursor, 1) ?? '';
	}
	return cursor === endDateExclusive ? count : undefined;
}

function errorReport(
	path: string,
	code: CalendarEventRepositoryErrorReport['code'],
	message: string,
	error: Error,
): CalendarEventRepositoryErrorReport {
	return { path, code, message, error };
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
	private readonly linkedNoteCreations = new Map<string, Promise<CalendarEventNoteRecord>>();
	private readonly targetCreations = new Map<string, Promise<CalendarEventNoteRecord>>();
	private readonly targetClaimants = new Map<string, CalendarNoteTargetClaimant[]>();
	private readonly occurrenceClaimants = new Map<string, CalendarNoteTargetClaimant[]>();
	private readonly uidClaimants = new Map<string, CalendarNoteTargetClaimant[]>();
	private noteClaimants: CalendarNoteTargetClaimant[] = [];
	private ownedPathStorage: string[] = [];
	private lastReloadResult: CalendarEventReloadResult = {
		records: [],
		events: [],
		deleted: [],
		errors: [],
		ownedPaths: [],
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
		claimants: CalendarNoteTargetClaimant[];
		uidClaimants: Map<string, CalendarNoteTargetClaimant[]>;
		ownedPaths: string[];
	}> {
		const records: CalendarEventNoteRecord[] = [];
		const errors: CalendarEventRepositoryErrorReport[] = [];
		const claimants: CalendarNoteTargetClaimant[] = [];
		const uidClaimants = new Map<string, CalendarNoteTargetClaimant[]>();
		const ownedPaths: string[] = [];
		for (const file of files) {
			const path = normalizePath(filePath(file));
			const content = await this.vault.read(file);
			const decoded = decodeCalendarEventNote(content);
			const rawTarget = decoded.parsed.frontmatter.calendar_note_target;
			const hasTarget = Object.prototype.hasOwnProperty.call(decoded.parsed.frontmatter, 'calendar_note_target');
			if (!decoded.marked && !hasTarget) continue;
			if (decoded.marked || hasTarget) ownedPaths.push(path);
			const rawUid = decoded.parsed.frontmatter.calendar_uid;
			const decodedTarget = hasTarget ? decodeCalendarNoteTarget(rawTarget) : undefined;
			const target = decodedTarget?.ok ? decodedTarget.target : undefined;
			const reference = decoded.note?.association?.reference ?? rawProviderReference(decoded.parsed.frontmatter);
			const ownershipErrors = target
				? !reference
					? ['calendar_note_target has no matching provider association']
					: calendarNoteTargetMatchesProviderReference(target, reference)
						? []
						: ['calendar_note_target disagrees with its provider association']
				: [];
			const targetErrors = [
				...(decodedTarget && !decodedTarget.ok ? decodedTarget.errors : []),
				...ownershipErrors,
			];
			if (decoded.marked && !decoded.note) {
				const error = new CalendarEventRepositoryError(
					'invalid-event-note',
					`Invalid calendar event frontmatter in "${path}"`,
					{ path, validationErrors: decoded.errors },
				);
				errors.push({ path, code: 'invalid-event-note', message: error.message, validationErrors: decoded.errors, error });
			}
			let record: CalendarEventNoteRecord | undefined;
			if (decoded.note) {
				record = {
					path,
					event: decoded.note.event,
					status: decoded.note.status,
					association: decoded.note.association,
					...(target === undefined ? {} : { target }),
					...(targetErrors.length === 0 ? {} : { targetErrors }),
					frontmatter: decoded.note.frontmatter,
					body: decoded.note.body,
				};
				records.push(record);
			}
			if (targetErrors.length > 0) {
				const error = new CalendarEventRepositoryError(
					'invalid-target',
					`Invalid calendar_note_target in "${path}": ${targetErrors.join('; ')}`,
					{ path },
				);
				errors.push(errorReport(path, 'invalid-target', error.message, error));
			}
			const claimant: CalendarNoteTargetClaimant = {
				path,
				...(typeof rawUid === 'string' ? { uid: rawUid } : {}),
				...(target === undefined ? {} : { target }),
				...(targetErrors.length === 0 ? {} : { targetErrors }),
				...(record === undefined ? {} : { record }),
				...(reference === undefined ? {} : { reference }),
				marked: decoded.marked,
				claim: hasTarget ? calendarNoteTargetClaim(rawTarget) : {},
			};
			if (decoded.marked && typeof rawUid === 'string' && rawUid.length > 0) {
				const uidGroup = uidClaimants.get(rawUid) ?? [];
				uidGroup.push(claimant);
				uidClaimants.set(rawUid, uidGroup);
			}
			if (decoded.marked || hasTarget) claimants.push(claimant);
		}
		return { records, errors, claimants, uidClaimants, ownedPaths: ownedPaths.sort(comparePaths) };
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
		const quarantinedPaths = new Set(scanned.errors
			.filter(error => error.code === 'invalid-target')
			.map(error => error.path));
		const targetGroups = new Map<string, CalendarNoteTargetClaimant[]>();
		const occurrenceGroups = new Map<string, CalendarNoteTargetClaimant[]>();
		for (const claimant of scanned.claimants) {
			if (claimant.claim.key) {
				const group = targetGroups.get(claimant.claim.key) ?? [];
				group.push(claimant);
				targetGroups.set(claimant.claim.key, group);
			}
			if (claimant.claim.occurrenceKey) {
				const group = occurrenceGroups.get(claimant.claim.occurrenceKey) ?? [];
				group.push(claimant);
				occurrenceGroups.set(claimant.claim.occurrenceKey, group);
			}
		}

		for (const [uid, claimants] of scanned.uidClaimants) {
			if (claimants.length < 2) continue;
			for (const claimant of claimants) {
				quarantinedPaths.add(claimant.path);
				const conflict = claimants.find(candidate => candidate.path !== claimant.path);
				const error = new DuplicateCalendarEventUidError(uid, claimant.path, conflict?.path ?? claimant.path);
				scanned.errors.push(errorReport(claimant.path, 'duplicate-uid', error.message, error));
			}
		}
		for (const [key, claimants] of targetGroups) {
			if (claimants.length < 2) continue;
			for (const claimant of claimants) {
				quarantinedPaths.add(claimant.path);
				const conflict = claimants.find(candidate => candidate.path !== claimant.path);
				const error = new DuplicateCalendarNoteTargetError(key, claimant.path, conflict?.path ?? claimant.path);
				scanned.errors.push(errorReport(claimant.path, 'duplicate-target', error.message, error));
			}
		}
		for (const [key, claimants] of occurrenceGroups) {
			const hasWhole = claimants.some(claimant => claimant.claim.scope === 'occurrence');
			const hasDays = claimants.some(claimant => claimant.claim.scope === 'occurrence-day');
			if (!hasWhole || !hasDays) continue;
			for (const claimant of claimants.filter(candidate =>
				candidate.claim.scope === 'occurrence' || candidate.claim.scope === 'occurrence-day')) {
				quarantinedPaths.add(claimant.path);
				const conflict = claimants.find(candidate =>
					candidate.path !== claimant.path && candidate.claim.scope !== claimant.claim.scope &&
					(candidate.claim.scope === 'occurrence' || candidate.claim.scope === 'occurrence-day'),
				);
				const error = new CalendarNoteTargetRepresentationConflictError(key, claimant.path, conflict?.path ?? claimant.path);
				scanned.errors.push(errorReport(claimant.path, 'target-representation-conflict', error.message, error));
			}
		}

		const pathGroups = new Map<string, CalendarEventNoteRecord[]>();
		for (const record of scanned.records) {
			const group = pathGroups.get(record.path) ?? [];
			group.push(record);
			pathGroups.set(record.path, group);
		}
		for (const [path, group] of pathGroups) {
			if (group.length < 2) continue;
			quarantinedPaths.add(path);
			const error = new CalendarEventPathCollisionError(path, path);
			scanned.errors.push(errorReport(path, 'duplicate-path', error.message, error));
		}

		const acceptedRecords = scanned.records.filter(record => !quarantinedPaths.has(record.path));
		this.index.rebuild(acceptedRecords);
		this.targetClaimants.clear();
		this.occurrenceClaimants.clear();
		this.uidClaimants.clear();
		for (const [key, claimants] of targetGroups) this.targetClaimants.set(key, claimants);
		for (const [key, claimants] of occurrenceGroups) this.occurrenceClaimants.set(key, claimants);
		for (const [key, claimants] of scanned.uidClaimants) this.uidClaimants.set(key, claimants);
		this.noteClaimants = scanned.claimants;
		this.ownedPathStorage = scanned.ownedPaths;
		const records: CalendarEventNoteRecord[] = this.index.values().map(record => ({
			...record,
			frontmatter: record.frontmatter ?? {},
			body: record.body ?? '',
		}));
		this.lastReloadResult = { records, events: records, deleted, errors: scanned.errors, ownedPaths: this.ownedPathStorage };
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
		const existingPath = this.uidClaimants.get(uid)?.[0]?.path ?? this.index.getPath(uid);
		if (existingPath !== undefined) {
			const conflictPath = this.uidClaimants.get(uid)?.find(claimant => claimant.path !== existingPath)?.path ?? existingPath;
			throw new DuplicateCalendarEventUidError(uid, existingPath, conflictPath);
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
			...(options.target === undefined ? {} : { target: options.target }),
			frontmatter: encodeFrontmatterForRecord(event, options),
			body: options.body ?? '',
		};
		this.index.set(record);
		return record;
	}

	private targetRepresentationConflict(target: CalendarNoteTarget, excludingPath?: string): CalendarNoteTargetClaimant | undefined {
		if (target.scope === 'series') return undefined;
		return (this.occurrenceClaimants.get(occurrenceTargetKey(target)) ?? []).find(claimant =>
			claimant.path !== excludingPath &&
			((target.scope === 'occurrence' && claimant.claim.scope === 'occurrence-day') ||
				(target.scope === 'occurrence-day' && claimant.claim.scope === 'occurrence')),
		);
	}

	private async createTargetNote(
		input: CalendarEventInputLike,
		target: CalendarNoteTarget,
		reference: ProviderReference,
		options: Omit<CalendarEventCreateOptions, 'association' | 'target'>,
	): Promise<CalendarEventNoteRecord> {
		await this.reload();
		const key = targetKey(target);
		const claims = this.targetClaimants.get(key) ?? [];
		if (claims.length > 0) {
			if (claims.length > 1) {
				const conflict = new DuplicateCalendarNoteTargetError(key, claims[1].path, claims[0].path);
				throw new CalendarEventRepositoryError('duplicate-target', conflict.message, { path: claims[1].path, cause: conflict });
			}
			const claimant = claims[0];
			if (!claimant.record || claimant.targetErrors || !claimant.target) {
				throw new CalendarEventRepositoryError(
					'invalid-target',
					`Calendar note target at "${claimant.path}" is malformed and needs repair`,
					{ path: claimant.path, uid: claimant.uid },
				);
			}
			return claimant.record;
		}
		const unresolvedProviderClaim = this.noteClaimants.find(claimant =>
			claimant.marked &&
			claimant.reference !== undefined &&
			sameProviderReference(claimant.reference, reference) &&
			(!claimant.target || claimant.targetErrors !== undefined),
		);
		if (unresolvedProviderClaim) {
			throw new CalendarEventRepositoryError(
				'invalid-target',
				`Existing linked note at "${unresolvedProviderClaim.path}" has no verified target; resolve its legacy ownership before creating another note`,
				{ path: unresolvedProviderClaim.path, uid: unresolvedProviderClaim.uid },
			);
		}
		const representationConflict = this.targetRepresentationConflict(target);
		if (target.scope !== 'series' && representationConflict) {
			const conflict = new CalendarNoteTargetRepresentationConflictError(
				occurrenceTargetKey(target),
				'requested target',
				representationConflict.path,
			);
			throw new CalendarEventRepositoryError('target-representation-conflict', conflict.message, {
				path: representationConflict.path,
				cause: conflict,
			});
		}
		if (target.scope !== 'series') {
			const ambiguousSameScope = (this.occurrenceClaimants.get(occurrenceTargetKey(target)) ?? []).find(claimant =>
				claimant.claim.scope === target.scope && claimant.claim.key === undefined,
			);
			if (ambiguousSameScope) {
				throw new CalendarEventRepositoryError(
					'invalid-target',
					`Malformed ${target.scope} target metadata at "${ambiguousSameScope.path}" blocks creation until repaired`,
					{ path: ambiguousSameScope.path },
				);
			}
		}

		const previewEvent = target.scope === 'series'
			? undefined
			: normalizeCalendarEvent({ ...input, uid: getUidInput(input) ?? 'calendar-note-preview' });
		let finalTarget = target;
		let noteInput = input;
		let occurrenceDate = previewEvent ? eventDateForDayOffset(previewEvent, 0) : undefined;
		if (target.scope === 'occurrence-day') {
			if (!previewEvent) throw new CalendarEventRepositoryError('invalid-target', 'Occurrence event is missing');
			const expectedDate = eventDateForDayOffset(previewEvent, target.dayOffset);
			if (!expectedDate) {
				throw new CalendarEventRepositoryError(
					'invalid-target',
					`Day offset ${target.dayOffset} is outside the occurrence date range`,
				);
			}
			if (target.confirmedDate !== undefined && target.confirmedDate !== expectedDate) {
				throw new CalendarEventRepositoryError(
					'invalid-target',
					`Confirmed occurrence-day date must be ${expectedDate} for offset ${target.dayOffset}`,
				);
			}
			finalTarget = {
				...target,
				confirmedDate: target.confirmedDate ?? expectedDate,
				dayStatus: target.dayStatus ?? 'confirmed',
			};
			const nextDay = addCivilDays(expectedDate, 1);
			if (!nextDay) throw new CalendarEventRepositoryError('invalid-target', 'Occurrence day is invalid');
			noteInput = { ...input, start: expectedDate, end: nextDay, allDay: true, recurrence: undefined };
			occurrenceDate = expectedDate;
		}
		if (previewEvent && !occurrenceDate) {
			throw new CalendarEventRepositoryError('invalid-target', 'Occurrence has no valid civil date');
		}
		const filename = options.filename ?? (previewEvent && occurrenceDate
			? `${occurrenceDate} ${slugifyTitle(previewEvent.title)}`
			: undefined);
		const status = options.status ?? 'pending';
		try {
			await this.create(noteInput, {
				...options,
				filename,
				status,
				association: reference,
				target: finalTarget,
			});
		} catch (value) {
			// A create may have committed to the vault before reporting a failure.
			// Rescan by immutable target before deciding that the operation failed.
			await this.reload();
			const recovered = this.targetClaimants.get(targetKey(finalTarget)) ?? [];
			if (recovered.length === 1 && recovered[0].record && !recovered[0].targetErrors) return recovered[0].record;
			throw value;
		}
		await this.reload();
		const created = this.targetClaimants.get(targetKey(finalTarget)) ?? [];
		if (created.length !== 1 || !created[0].record || created[0].targetErrors) {
			throw new CalendarEventRepositoryError(
				'duplicate-target',
				`Created calendar note target could not be uniquely rediscovered`,
				{ path: created[0]?.path },
			);
		}
		return created[0].record;
	}

	/**
	 * Create or rediscover one explicitly requested target note. Calls for the
	 * same occurrence are serialized so whole-occurrence/day exclusivity is
	 * checked after any earlier request has completed.
	 */
	async createForTarget(
		input: CalendarEventInputLike,
		target: CalendarNoteTarget,
		association: CalendarEventAssociation | ProviderReference,
		options: Omit<CalendarEventCreateOptions, 'association' | 'target'> = {},
	): Promise<CalendarEventNoteRecord> {
		const reference = providerReferenceOf(association);
		const targetResult = decodeCalendarNoteTarget(encodeCalendarNoteTarget(target));
		if (!targetResult.ok) {
			throw new CalendarEventRepositoryError('invalid-target', targetResult.errors.join('; '));
		}
		const validTarget = targetResult.target;
		if (!calendarNoteTargetMatchesProviderReference(validTarget, reference)) {
			throw new CalendarEventRepositoryError(
				'immutable-association',
				'Calendar note target provider, account, calendar, or event identity does not match its provider association',
			);
		}
		const lockKey = validTarget.scope === 'series' ? targetKey(validTarget) : occurrenceTargetKey(validTarget);
		const active = this.targetCreations.get(lockKey);
		if (active) {
			const existing = await active;
			if (existing.target && targetKey(existing.target) === targetKey(validTarget)) return existing;
			return this.createForTarget(input, validTarget, association, options);
		}
		const status = options.status ?? ('reference' in association ? association.status : undefined);
		const operation = this.createTargetNote(input, validTarget, reference, {
			...options,
			...(status === undefined ? {} : { status }),
		});
		this.targetCreations.set(lockKey, operation);
		try {
			return await operation;
		} finally {
			if (this.targetCreations.get(lockKey) === operation) this.targetCreations.delete(lockKey);
		}
	}

	/**
	 * Create a note for an explicitly selected remote event. Repeated calls for
	 * the same provider object return its existing note, including notes created
	 * by earlier sync runs. Remote event imports never call this implicitly.
	 */
	async createLinkedNote(
		input: CalendarEventInputLike,
		association: CalendarEventAssociation | ProviderReference,
		options: Omit<CalendarEventCreateOptions, 'association'> = {},
	): Promise<CalendarEventNoteRecord> {
		const reference = providerReferenceOf(association);
		const existing = this.getByProviderReference(reference);
		if (existing) return existing;

		const key = providerReferenceKey(reference);
		const inFlight = this.linkedNoteCreations.get(key);
		if (inFlight) return inFlight;

		const status = options.status ?? ('reference' in association ? association.status : undefined);
		const creation = this.create(input, {
			...options,
			...(status === undefined ? {} : { status }),
			association: reference,
		});
		this.linkedNoteCreations.set(key, creation);
		try {
			return await creation;
		} finally {
			if (this.linkedNoteCreations.get(key) === creation) this.linkedNoteCreations.delete(key);
		}
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
			...(decoded.note.target === undefined ? {} : { target: decoded.note.target }),
			...(decoded.note.targetErrors === undefined ? {} : { targetErrors: decoded.note.targetErrors }),
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

	/** Find an existing note by its immutable provider object identity. */
	getByProviderReference(reference: ProviderReference): CalendarEventNoteRecord | undefined {
		return this.index.values().find(record =>
			record.association !== undefined && sameProviderReference(record.association.reference, reference),
		) as CalendarEventNoteRecord | undefined;
	}

	getByTarget(target: CalendarNoteTarget): CalendarEventNoteRecord | undefined {
		return this.index.getByTarget(target) as CalendarEventNoteRecord | undefined;
	}

	/** All frontmatter claimants, including quarantined or malformed candidates. */
	getTargetClaimants(target: CalendarNoteTarget): readonly CalendarNoteTargetClaimant[] {
		return [...(this.targetClaimants.get(targetKey(target)) ?? [])];
	}

	/** Every note marked as calendar-owned, including malformed or quarantined notes. */
	listOwnedPaths(): readonly string[] {
		return [...this.ownedPathStorage];
	}

	get(pathOrUid: string): CalendarEventNoteRecord | undefined {
		return this.getByPath(pathOrUid) ?? this.getByUid(pathOrUid);
	}

	list(): CalendarEventNoteRecord[] {
		return this.index.values() as CalendarEventNoteRecord[];
	}

	private async persistTarget(
		existing: CalendarEventNoteRecord,
		target: CalendarNoteTarget,
		association = existing.association,
	): Promise<CalendarEventNoteRecord> {
		if (existing.target && JSON.stringify(existing.target) === JSON.stringify(target) &&
			association === existing.association) return existing;
		const frontmatterForRecord = { ...existing.frontmatter };
		await this.processPath(existing.path, frontmatter => {
			applyCalendarEventFrontmatter(frontmatter, existing.event, {
				target,
				...(existing.status === undefined ? {} : { status: existing.status }),
				...(association === undefined ? {} : { association }),
			});
			Object.assign(frontmatterForRecord, frontmatter);
		});
		const updated: CalendarEventNoteRecord = { ...existing, association, target, targetErrors: undefined, frontmatter: frontmatterForRecord };
		this.index.update(existing.path, existing.event, {
			status: updated.status,
			association,
			target,
			targetErrors: undefined,
			frontmatter: frontmatterForRecord,
		});
		return updated;
	}

	/**
	 * Retain a suggested date until the user explicitly accepts or resolves it.
	 * Day keys remain stable because confirmation fields are excluded by targetKey.
	 */
	async proposeDayTargetDate(pathOrUid: string, nextEventInput: CalendarEventInputLike): Promise<CalendarEventNoteRecord> {
		const path = this.resolveExistingPath(pathOrUid);
		const existing = this.index.getByPath(path) as CalendarEventNoteRecord;
		if (existing.target?.scope !== 'occurrence-day') {
			throw new CalendarEventRepositoryError('invalid-target', `Calendar note "${path}" is not an occurrence-day target`, { path });
		}
		const nextEvent = normalizeCalendarEvent({ ...nextEventInput, uid: existing.event.uid });
		const nextDate = eventDateForDayOffset(nextEvent, existing.target.dayOffset);
		if (!existing.target.confirmedDate && nextDate) {
			return this.persistTarget(existing, { ...existing.target, confirmedDate: nextDate, dayStatus: 'confirmed' });
		}
		if (nextDate === existing.target.confirmedDate) {
			return this.persistTarget(existing, { ...existing.target, proposedDate: undefined, dayStatus: 'confirmed' });
		}
		if (nextDate) {
			return this.persistTarget(existing, { ...existing.target, proposedDate: nextDate, dayStatus: 'unresolved' });
		}
		return this.persistTarget(existing, { ...existing.target, proposedDate: undefined, dayStatus: 'unresolved' });
	}

	async confirmDayTarget(pathOrUid: string, decision: CalendarNoteDayConfirmation): Promise<CalendarEventNoteRecord> {
		const path = this.resolveExistingPath(pathOrUid);
		const existing = this.index.getByPath(path) as CalendarEventNoteRecord;
		const currentTarget = existing.target;
		if (currentTarget?.scope !== 'occurrence-day') {
			throw new CalendarEventRepositoryError('invalid-target', `Calendar note "${path}" is not an occurrence-day target`, { path });
		}
		let nextTarget: CalendarNoteTarget;
		if (decision.action === 'accept-proposed') {
			if (!currentTarget.proposedDate) {
				throw new CalendarEventRepositoryError('invalid-target', `Calendar note "${path}" has no proposed day to accept`, { path });
			}
			const { proposedDate, ...rest } = currentTarget;
			nextTarget = { ...rest, confirmedDate: proposedDate, dayStatus: 'confirmed' };
		} else if (decision.action === 'keep-unresolved') {
			nextTarget = { ...currentTarget, dayStatus: 'unresolved' };
		} else {
			const { newDayOffset, confirmedDate, occurrenceStartDate, occurrenceEndDateExclusive } = decision;
			if (
				!Number.isInteger(newDayOffset) || newDayOffset === undefined || newDayOffset < 0 ||
				!confirmedDate || !occurrenceStartDate || !occurrenceEndDateExclusive
			) {
				throw new CalendarEventRepositoryError('invalid-target', 'Rebinding a day target requires a valid offset and occurrence civil-date bounds', { path });
			}
			const span = civilDateSpan(occurrenceStartDate, occurrenceEndDateExclusive);
			const expectedDate = addCivilDays(occurrenceStartDate, newDayOffset);
			if (span === undefined || newDayOffset >= span || expectedDate !== confirmedDate) {
				throw new CalendarEventRepositoryError('invalid-target', 'The chosen offset is outside the occurrence or does not match its civil date', { path });
			}
			const candidate: CalendarNoteTarget = {
				...currentTarget,
				dayOffset: newDayOffset,
				confirmedDate,
				proposedDate: undefined,
				dayStatus: 'confirmed',
			};
			await this.reload();
			const conflicts = (this.targetClaimants.get(targetKey(candidate)) ?? []).filter(claimant => claimant.path !== path);
			if (conflicts.length > 0) {
				const conflict = new DuplicateCalendarNoteTargetError(targetKey(candidate), path, conflicts[0].path);
				throw new CalendarEventRepositoryError('duplicate-target', conflict.message, { path, uid: existing.event.uid, cause: conflict });
			}
			const representationConflict = this.targetRepresentationConflict(candidate, path);
			if (representationConflict) {
				const conflict = new CalendarNoteTargetRepresentationConflictError(
					occurrenceTargetKey(candidate), path, representationConflict.path,
				);
				throw new CalendarEventRepositoryError('target-representation-conflict', conflict.message, { path, uid: existing.event.uid, cause: conflict });
			}
			nextTarget = candidate;
		}
		const updated = await this.persistTarget(existing, nextTarget);
		await this.reload();
		return this.getByUid(updated.event.uid) ?? updated;
	}

	/**
	 * Apply only caller-verified target identities to legacy provider links.
	 * Returning undefined leaves that note unchanged for explicit reconciliation.
	 */
	async migrateLegacyTargets(
		resolveVerifiedTarget: (record: CalendarEventNoteRecord) =>
			| CalendarNoteTarget
			| { target: CalendarNoteTarget; association?: CalendarEventAssociation }
			| undefined
			| Promise<CalendarNoteTarget | { target: CalendarNoteTarget; association?: CalendarEventAssociation } | undefined>,
	): Promise<CalendarNoteLegacyMigrationResult> {
		await this.reload();
		const migratedUids: string[] = [];
		const unresolved: CalendarEventNoteRecord[] = [];
		const alreadyTargeted: CalendarEventNoteRecord[] = [];
		const reservedTargetKeys = new Set(this.targetClaimants.keys());
		const reservedOccurrenceModes = new Map<string, Set<string>>();
		for (const [occurrenceKey, claimants] of this.occurrenceClaimants) {
			reservedOccurrenceModes.set(occurrenceKey, new Set(claimants.map(claimant => claimant.claim.scope ?? 'unknown')));
		}
		for (const record of this.list()) {
			if (record.target || record.targetErrors) {
				if (record.target) alreadyTargeted.push(record);
				continue;
			}
			if (!record.association) {
				unresolved.push(record);
				continue;
			}
			const resolution = await resolveVerifiedTarget(record);
			if (!resolution) {
				unresolved.push(record);
				continue;
			}
			const target = 'target' in resolution ? resolution.target : resolution;
			const association = 'target' in resolution ? resolution.association ?? record.association : record.association;
			const decodedTarget = decodeCalendarNoteTarget(encodeCalendarNoteTarget(target));
			if (!decodedTarget.ok || !association || association.calendarUid !== record.event.uid ||
				!calendarNoteTargetMatchesProviderReference(target, association.reference) ||
				association.reference.providerId !== record.association.reference.providerId ||
				association.reference.accountId !== record.association.reference.accountId ||
				association.reference.calendarId !== record.association.reference.calendarId) {
				unresolved.push(record);
				continue;
			}
			const key = targetKey(target);
			const occurrenceKey = target.scope === 'series' ? undefined : occurrenceTargetKey(target);
			const modes = occurrenceKey === undefined ? new Set<string>() : reservedOccurrenceModes.get(occurrenceKey) ?? new Set<string>();
			const hasRepresentationConflict = target.scope === 'occurrence'
				? modes.has('occurrence-day')
				: target.scope === 'occurrence-day' && modes.has('occurrence');
			if (reservedTargetKeys.has(key) || hasRepresentationConflict) {
				unresolved.push(record);
				continue;
			}
			// Re-read just before the write: another vault action may have claimed
			// this target or moved/changed the legacy note while the resolver ran.
			await this.reload();
			const current = this.getByUid(record.event.uid);
			if (!current || current.path !== record.path || current.target || !current.association ||
				!sameProviderReference(current.association.reference, record.association.reference) ||
				(this.targetClaimants.get(key)?.length ?? 0) > 0 ||
				this.targetRepresentationConflict(target)) {
				unresolved.push(record);
				continue;
			}
			await this.persistTarget(current, target, association);
			migratedUids.push(record.event.uid);
			reservedTargetKeys.add(key);
			if (occurrenceKey !== undefined) {
				modes.add(target.scope);
				reservedOccurrenceModes.set(occurrenceKey, modes);
			}
		}
		await this.reload();
		const migrated = migratedUids
			.map(uid => this.getByUid(uid))
			.filter((record): record is CalendarEventNoteRecord => record !== undefined);
		return { migrated, unresolved, alreadyTargeted };
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
		if (
			existing.association !== undefined &&
			association !== undefined &&
			!sameProviderReference(existing.association.reference, providerReferenceOf(association))
		) {
			throw new CalendarEventRepositoryError(
				'immutable-association',
				`Provider association is immutable for "${existing.path}"`,
				{ path: existing.path, uid: existing.event.uid },
			);
		}
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
