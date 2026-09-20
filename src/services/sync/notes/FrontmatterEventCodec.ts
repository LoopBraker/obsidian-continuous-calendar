import type {
	CalendarEvent,
	CalendarEventAssociation,
	CalendarEventInput,
	ProviderReference,
	SyncStatus,
} from '../model/CalendarEvent';
import {
	CalendarEventValidationException,
	normalizeCalendarEvent,
	validateCalendarEvent,
} from '../model/CalendarEventValidation';
import { exclusiveToInclusive, isNextDay } from '../util/date';
import type { CalendarEventValidationError } from '../model/CalendarEventValidation';

/** Values accepted by the vault's frontmatter object. */
export type FrontmatterValue =
	| string
	| number
	| boolean
	| null
	| FrontmatterValue[]
	| { [key: string]: FrontmatterValue };

export type FrontmatterRecord = Record<string, unknown>;

export interface ParsedFrontmatter {
	/** The object parsed from the YAML block. */
	readonly frontmatter: FrontmatterRecord;
	/** Bytes after the closing frontmatter delimiter, unchanged. */
	readonly body: string;
	/** Bytes in the YAML block, excluding the opening and closing delimiters. */
	readonly yaml: string;
	readonly hasFrontmatter: boolean;
}

export interface CalendarEventNote {
	readonly event: CalendarEvent;
	readonly body: string;
	readonly frontmatter: FrontmatterRecord;
	readonly status?: SyncStatus;
	readonly association?: CalendarEventAssociation;
}

export interface CalendarEventDecodeResult {
	readonly marked: boolean;
	readonly note?: CalendarEventNote;
	readonly errors: ReadonlyArray<CalendarEventValidationError>;
	readonly parsed: ParsedFrontmatter;
}

export interface CalendarEventFrontmatterOptions {
	readonly status?: SyncStatus;
	readonly association?: CalendarEventAssociation | ProviderReference;
	/** Additional frontmatter to retain when creating a new note. */
	readonly unknownFrontmatter?: FrontmatterRecord;
}

export interface CalendarEventNoteEncodingOptions extends CalendarEventFrontmatterOptions {
	readonly body?: string;
}

const SYNC_STATUSES: readonly SyncStatus[] = [
	'pending',
	'synced',
	'conflict',
	'remote_deleted',
	'unsupported',
	'error',
];

const CANONICAL_FRONTMATTER_KEYS = [
	'calendar_event',
	'calendar_uid',
	'calendar_title',
	'date',
	'dateStart',
	'dateEnd',
	'calendar_start',
	'calendar_end',
	'calendar_all_day',
	'calendar_timezone',
	'calendar_location',
	'calendar_description',
] as const;

const NON_FRONTMATTER_SYNC_KEYS = [
	'version',
	'etag',
	'change_key',
	'cursor',
	'last_synced',
	'last_synced_snapshot',
	'retry_state',
	'conflict',
	'tombstone',
	'error',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSyncStatus(value: unknown): value is SyncStatus {
	return typeof value === 'string' && (SYNC_STATUSES as readonly string[]).includes(value);
}

function hasProviderReferenceShape(value: FrontmatterRecord): boolean {
	return (
		typeof value.account_id === 'string' &&
		typeof value.calendar_id === 'string' &&
		(typeof value.event_id === 'string' || typeof value.remote_event_id === 'string')
	);
}

function sanitizeSyncFrontmatter(value: unknown): FrontmatterRecord {
	const sync = isRecord(value) ? { ...value } : {};
	for (const key of NON_FRONTMATTER_SYNC_KEYS) delete sync[key];
	for (const providerId of Object.keys(sync)) {
		if (!isRecord(sync[providerId])) continue;
		const provider = { ...(sync[providerId] as FrontmatterRecord) };
		for (const key of NON_FRONTMATTER_SYNC_KEYS) delete provider[key];
		sync[providerId] = provider;
	}
	return sync;
}

function cloneRecord(value: unknown): FrontmatterRecord {
	if (!isRecord(value)) return {};
	return { ...value };
}

function getMarkedValue(frontmatter: FrontmatterRecord): unknown {
	return frontmatter.calendar_event;
}

/**
 * Parse the delimited frontmatter at the beginning of a Markdown document.
 * This parser intentionally handles the YAML forms used by event notes and
 * preserves the original body exactly. Unknown frontmatter is retained in the
 * returned object and is never discarded by the repository.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
	if (!content.startsWith('---')) {
		return { frontmatter: {}, body: content, yaml: '', hasFrontmatter: false };
	}

	const openingEnd = content.startsWith('---\r\n')
		? 5
		: content.startsWith('---\n')
			? 4
			: -1;
	if (openingEnd < 0) {
		return { frontmatter: {}, body: content, yaml: '', hasFrontmatter: false };
	}

	const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(content.slice(openingEnd));
	if (!closing || closing.index < 0) {
		return { frontmatter: {}, body: content, yaml: '', hasFrontmatter: false };
	}

	const yamlStart = openingEnd;
	const yamlEnd = openingEnd + closing.index;
	const bodyStart = yamlEnd + closing[0].length;
	const yaml = content.slice(yamlStart, yamlEnd);
	const body = content.slice(bodyStart);
	return {
		frontmatter: parseYamlMap(yaml),
		body,
		yaml,
		hasFrontmatter: true,
	};
}

/** Return true only for a boolean YAML `calendar_event: true` marker. */
export function isCalendarEventFrontmatter(frontmatter: FrontmatterRecord): boolean {
	return getMarkedValue(frontmatter) === true;
}

function readProviderReference(
	providerId: string,
	value: unknown,
	status: SyncStatus | undefined,
): CalendarEventAssociation | undefined {
	if (!isRecord(value)) return undefined;
	const accountId = value.account_id;
	const calendarId = value.calendar_id;
	const remoteEventId = value.event_id ?? value.remote_event_id;
	if (
		typeof accountId !== 'string' ||
		typeof calendarId !== 'string' ||
		typeof remoteEventId !== 'string'
	) {
		return undefined;
	}
	const reference: ProviderReference = {
		providerId,
		accountId,
		calendarId,
		remoteEventId,
	};
	return {
		calendarUid: '',
		reference,
		status: status ?? (isSyncStatus(value.status) ? value.status : 'pending'),
	};
}

function decodeSync(
	frontmatter: FrontmatterRecord,
	event: CalendarEvent,
): Pick<CalendarEventNote, 'status' | 'association'> {
	const rawSync = frontmatter.calendar_sync;
	if (!isRecord(rawSync)) return {};

	const status = isSyncStatus(rawSync.status) ? rawSync.status : undefined;
	const providerEntries = Object.keys(rawSync)
		.filter(key => key !== 'status' && key !== 'error')
		.sort();
	for (const providerId of providerEntries) {
		const association = readProviderReference(providerId, rawSync[providerId], status);
		if (association) return { status: association.status, association: { ...association, calendarUid: event.uid } };
	}
	return status === undefined ? {} : { status };
}

/**
 * Decode one Markdown document. Unmarked notes return `marked: false` and are
 * deliberately not interpreted as calendar events.
 */
export function decodeCalendarEventNote(content: string): CalendarEventDecodeResult {
	const parsed = parseFrontmatter(content);
	if (!isCalendarEventFrontmatter(parsed.frontmatter)) {
		return { marked: false, errors: [], parsed };
	}

	const validation = validateCalendarEvent(parsed.frontmatter);
	if (!validation.ok) return { marked: true, errors: validation.errors, parsed };

	const sync = decodeSync(parsed.frontmatter, validation.value);
	return {
		marked: true,
		errors: [],
		parsed,
		note: {
			event: validation.value,
			body: parsed.body,
			frontmatter: parsed.frontmatter,
			...sync,
		},
	};
}

/** Naming aliases used by callers that prefer parser/codec terminology. */
export const decodeFrontmatterEvent = decodeCalendarEventNote;
export const parseCalendarEventNote = decodeCalendarEventNote;
export const decodeEventFrontmatter = decodeCalendarEventNote;

function providerAssociationValue(
	association: CalendarEventAssociation | ProviderReference,
	status: SyncStatus | undefined,
): FrontmatterRecord {
	const reference = 'reference' in association ? association.reference : association;
	return {
		account_id: reference.accountId,
		calendar_id: reference.calendarId,
		event_id: reference.remoteEventId,
		...(status === undefined
			? {}
			: { status }),
	};
}

/**
 * Produce the canonical fields for a processFrontMatter callback. The input
 * object is mutated intentionally, matching Obsidian's callback contract;
 * every unknown key is left in place.
 */
export function applyCalendarEventFrontmatter(
	frontmatter: FrontmatterRecord,
	eventInput: CalendarEventInput | CalendarEvent,
	options: CalendarEventFrontmatterOptions = {},
): CalendarEvent {
	const event = normalizeCalendarEvent(eventInput);
	frontmatter.calendar_event = true;
	frontmatter.calendar_uid = event.uid;
	frontmatter.calendar_title = event.title;
	
	const singleDay = event.allDay && isNextDay(event.start, event.end);
	
	let startDate = event.start;
	let endDate = event.end;
	
	// If it's a timed event, extract the date part (YYYY-MM-DD)
	if (!event.allDay) {
		startDate = event.start.substring(0, 10);
		endDate = event.end.substring(0, 10);
	}

	if (singleDay || (!event.allDay && startDate === endDate)) {
		frontmatter.date = startDate;
		delete frontmatter.dateStart;
		delete frontmatter.dateEnd;
	} else {
		frontmatter.dateStart = startDate;
		frontmatter.dateEnd = event.allDay ? exclusiveToInclusive(event.end) : endDate;
		delete frontmatter.date;
	}
	
	frontmatter.calendar_start = event.start;
	frontmatter.calendar_end = event.end;
	frontmatter.calendar_all_day = event.allDay;
	frontmatter.calendar_timezone = event.timezone;
	frontmatter.calendar_location = event.location;
	frontmatter.calendar_description = event.description;
	if (frontmatter.calendar_sync !== undefined) {
		frontmatter.calendar_sync = sanitizeSyncFrontmatter(frontmatter.calendar_sync);
	}

	if (options.status !== undefined || options.association !== undefined) {
		const currentSync = sanitizeSyncFrontmatter(frontmatter.calendar_sync);
		if (options.status !== undefined) {
			currentSync.status = options.status;
			for (const providerId of Object.keys(currentSync)) {
				if (providerId === 'status' || providerId === 'error' || !isRecord(currentSync[providerId])) continue;
				const providerValue = currentSync[providerId] as FrontmatterRecord;
				if (
					!hasProviderReferenceShape(providerValue) &&
					!isSyncStatus(providerValue.status)
				) continue;
				currentSync[providerId] = {
					...providerValue,
					status: options.status,
				};
			}
		}
		if (options.association !== undefined) {
			const association = options.association;
			const reference = 'reference' in association ? association.reference : association;
			const providerId = reference.providerId;
			const currentProvider: FrontmatterRecord = isRecord(currentSync[providerId])
				? { ...(currentSync[providerId] as FrontmatterRecord) }
				: {};
			currentSync[providerId] = {
				...currentProvider,
				...providerAssociationValue(association, options.status),
			};
		}
		frontmatter.calendar_sync = currentSync;
	}

	return event;
}

/** Build an event-note frontmatter object for a newly-created note. */
export function encodeCalendarEventFrontmatter(
	eventInput: CalendarEventInput | CalendarEvent,
	options: CalendarEventFrontmatterOptions = {},
): FrontmatterRecord {
	const frontmatter = cloneRecord(options.unknownFrontmatter);
	if (frontmatter.calendar_sync !== undefined) {
		frontmatter.calendar_sync = sanitizeSyncFrontmatter(frontmatter.calendar_sync);
	}
	applyCalendarEventFrontmatter(frontmatter, eventInput, options);
	return frontmatter;
}

/** Serialize a new note. Existing notes are updated through processFrontMatter. */
export function encodeCalendarEventNote(
	eventInput: CalendarEventInput | CalendarEvent,
	options: CalendarEventNoteEncodingOptions = {},
): string {
	const frontmatter = encodeCalendarEventFrontmatter(eventInput, options);
	const yaml = serializeYamlMap(frontmatter);
	return `---\n${yaml}---\n${options.body ?? ''}`;
}

export const encodeFrontmatterEvent = encodeCalendarEventFrontmatter;
export const encodeEventFrontmatter = encodeCalendarEventFrontmatter;

/** Small stateless facade for consumers that prefer an object codec. */
export class FrontmatterEventCodec {
	parse(content: string): ParsedFrontmatter {
		return parseFrontmatter(content);
	}

	decode(content: string): CalendarEventDecodeResult {
		return decodeCalendarEventNote(content);
	}

	encode(event: CalendarEventInput | CalendarEvent, options: CalendarEventNoteEncodingOptions = {}): string {
		return encodeCalendarEventNote(event, options);
	}

	encodeFrontmatter(
		event: CalendarEventInput | CalendarEvent,
		options: CalendarEventFrontmatterOptions = {},
	): FrontmatterRecord {
		return encodeCalendarEventFrontmatter(event, options);
	}

	apply(
		frontmatter: FrontmatterRecord,
		event: CalendarEventInput | CalendarEvent,
		options: CalendarEventFrontmatterOptions = {},
	): CalendarEvent {
		return applyCalendarEventFrontmatter(frontmatter, event, options);
	}
}

/** Throw a model-owned validation exception with the codec's public API. */
export function assertCalendarEventNote(content: string): CalendarEventNote {
	const result = decodeCalendarEventNote(content);
	if (!result.marked) throw new Error('Markdown note is not marked calendar_event: true');
	if (!result.note) throw new CalendarEventValidationException(result.errors);
	return result.note;
}

/* ------------------------------------------------------------------------- */
/* Small YAML reader/writer                                                   */
/* ------------------------------------------------------------------------- */

interface YamlLine {
	indent: number;
	raw: string;
	content: string;
	text: string;
	line: number;
	empty: boolean;
	hasNewline: boolean;
}

function stripYamlComment(value: string): string {
	let quote: string | undefined;
	let escaped = false;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === '\\' && quote === '"') {
			escaped = true;
			continue;
		}
		if ((character === '"' || character === "'") && (!quote || quote === character)) {
			quote = quote ? undefined : character;
			continue;
		}
		if (character === '#' && !quote && (index === 0 || /\s/.test(value[index - 1]))) {
			return value.slice(0, index).trimEnd();
		}
	}
	return value.trimEnd();
}

function yamlLines(yaml: string): YamlLine[] {
	return yaml
		.split(/\r?\n/)
		.map((raw, line, lines) => {
			const match = /^( *)/.exec(raw);
			const indent = match ? match[1].length : 0;
			const content = raw.slice(indent);
			return {
				indent,
				raw,
				content,
				text: stripYamlComment(content).trim(),
				line,
				empty: raw.trim() === '',
				hasNewline: line < lines.length - 1,
			};
		});
}

function splitYamlKey(value: string): { key: string; rest: string } | undefined {
	let quote: string | undefined;
	let escaped = false;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === '\\' && quote === '"') {
			escaped = true;
			continue;
		}
		if ((character === '"' || character === "'") && (!quote || quote === character)) {
			quote = quote ? undefined : character;
			continue;
		}
		if (character === ':' && !quote) {
			return { key: value.slice(0, index).trim(), rest: value.slice(index + 1).trim() };
		}
	}
	return undefined;
}

function unquote(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		try {
			const parsed = JSON.parse(value);
			return typeof parsed === 'string' ? parsed : value;
		} catch (_error) {
			return value.slice(1, -1);
		}
	}
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1).replace(/''/g, "'");
	}
	return value;
}

function parseFlow(value: string): unknown {
	if (value.startsWith('[') && value.endsWith(']')) {
		const inner = value.slice(1, -1).trim();
		if (!inner) return [];
		return splitFlow(inner).map(item => parseYamlScalar(item));
	}
	if (value.startsWith('{') && value.endsWith('}')) {
		const inner = value.slice(1, -1).trim();
		const result: FrontmatterRecord = {};
		if (!inner) return result;
		for (const item of splitFlow(inner)) {
			const pair = splitYamlKey(item);
			if (pair) result[unquote(pair.key)] = parseYamlScalar(pair.rest);
		}
		return result;
	}
	return undefined;
}

function splitFlow(value: string): string[] {
	const result: string[] = [];
	let start = 0;
	let quote: string | undefined;
	let depth = 0;
	let escaped = false;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === '\\' && quote === '"') {
			escaped = true;
			continue;
		}
		if ((character === '"' || character === "'") && (!quote || quote === character)) {
			quote = quote ? undefined : character;
			continue;
		}
		if (!quote && (character === '[' || character === '{')) depth += 1;
		if (!quote && (character === ']' || character === '}')) depth -= 1;
		if (character === ',' && !quote && depth === 0) {
			result.push(value.slice(start, index).trim());
			start = index + 1;
		}
	}
	result.push(value.slice(start).trim());
	return result;
}

function parseYamlScalar(raw: string): unknown {
	const value = raw.trim();
	if (!value) return null;
	const flow = parseFlow(value);
	if (flow !== undefined) return flow;
	if (value === 'true' || value === 'True' || value === 'TRUE') return true;
	if (value === 'false' || value === 'False' || value === 'FALSE') return false;
	if (value === 'null' || value === 'Null' || value === 'NULL' || value === '~') return null;
	if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
	return unquote(value);
}

function parseYamlMap(yaml: string): FrontmatterRecord {
	const lines = yamlLines(yaml);
	if (lines.length === 0) return {};
	const first = nextMeaningfulYamlLine(lines, 0);
	if (first === undefined) return {};
	const [value] = parseYamlNode(lines, first, lines[first].indent);
	return isRecord(value) ? value : {};
}

function nextMeaningfulYamlLine(lines: YamlLine[], start: number): number | undefined {
	for (let index = start; index < lines.length; index += 1) {
		if (!lines[index].empty && !lines[index].text.startsWith('#')) return index;
	}
	return undefined;
}

function parseBlockScalarIndicator(value: string):
	| { style: 'literal' | 'folded'; chomping: 'clip' | 'strip' | 'keep'; indentIndicator?: number }
	| undefined {
	const trimmed = value.trim();
	if (!/^[|>][1-9+-]{0,2}$/.test(trimmed)) return undefined;
	let indentIndicator: number | undefined;
	let chompingIndicator: '+' | '-' | undefined;
	for (const character of trimmed.slice(1)) {
		if (/\d/.test(character)) indentIndicator = Number(character);
		if (character === '+' || character === '-') chompingIndicator = character;
	}
	return {
		style: trimmed[0] === '|' ? 'literal' : 'folded',
		chomping: chompingIndicator === '-' ? 'strip' : chompingIndicator === '+' ? 'keep' : 'clip',
		...(indentIndicator === undefined ? {} : { indentIndicator }),
	};
}

function removeBlockIndent(line: YamlLine, contentIndent: number): string {
	if (line.empty) return '';
	return line.raw.slice(Math.min(contentIndent, line.raw.length));
}

function chompBlockScalar(value: string, chomping: 'clip' | 'strip' | 'keep'): string {
	if (chomping === 'keep' || value.length === 0) return value;
	const withoutTrailingNewlines = value.replace(/\n+$/, '');
	if (chomping === 'strip') return withoutTrailingNewlines;
	return withoutTrailingNewlines.length === value.length
		? value
		: `${withoutTrailingNewlines}\n`;
}

function parseBlockScalar(
	lines: YamlLine[],
	start: number,
	parentIndent: number,
	indicator: { style: 'literal' | 'folded'; chomping: 'clip' | 'strip' | 'keep'; indentIndicator?: number },
): { value: string; next: number } {
	const contentLines: YamlLine[] = [];
	let index = start;
	while (index < lines.length) {
		const line = lines[index];
		const isRootComment = !line.empty && line.text.startsWith('#') && line.indent <= parentIndent;
		if (isRootComment) {
			index += 1;
			continue;
		}
		if (!line.empty && !isRootComment && line.indent <= parentIndent) break;
		contentLines.push(line);
		index += 1;
	}

	const firstContent = contentLines.find(line => !line.empty);
	const contentIndent = indicator.indentIndicator === undefined
		? firstContent?.indent ?? parentIndent + 1
		: parentIndent + indicator.indentIndicator;
	const values = contentLines.map(line => ({
		line,
		value: removeBlockIndent(line, contentIndent),
	}));
	let value = '';
	for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
		const current = values[valueIndex];
		value += current.value;
		if (!current.line.hasNewline) continue;
		if (indicator.style === 'literal') {
			value += '\n';
			continue;
		}
		const next = values[valueIndex + 1];
		if (!next || current.value === '' || next.value === '' || current.line.indent > contentIndent || next.line.indent > contentIndent) {
			value += '\n';
		} else {
			value += ' ';
		}
	}
	return { value: chompBlockScalar(value, indicator.chomping), next: index };
}

function parseYamlNode(lines: YamlLine[], start: number, indent: number): [unknown, number] {
	const isList = lines[start]?.indent === indent && lines[start].text.startsWith('- ');
	const object: FrontmatterRecord = {};
	const list: unknown[] = [];
	let index = start;
	while (index < lines.length) {
		const line = lines[index];
		if (line.empty || line.text.startsWith('#')) {
			index += 1;
			continue;
		}
		if (line.indent !== indent) break;
		if (isList) {
			if (!line.text.startsWith('- ')) break;
			const item = line.text.slice(2).trim();
			if (item) list.push(parseYamlScalar(item));
			else if (index + 1 < lines.length && lines[index + 1].indent > indent) {
				const [nested, next] = parseYamlNode(lines, index + 1, lines[index + 1].indent);
				list.push(nested);
				index = next;
				continue;
			} else list.push(null);
			index += 1;
			continue;
		}

		const pair = splitYamlKey(line.text);
		if (!pair) {
			index += 1;
			continue;
		}
		const key = unquote(pair.key);
		const blockIndicator = parseBlockScalarIndicator(pair.rest);
		if (blockIndicator) {
			const block = parseBlockScalar(lines, index + 1, indent, blockIndicator);
			object[key] = block.value;
			index = block.next;
			continue;
		}
		const nestedStart = nextMeaningfulYamlLine(lines, index + 1);
		if (pair.rest === '' && nestedStart !== undefined && lines[nestedStart].indent > indent) {
			const [nested, next] = parseYamlNode(lines, nestedStart, lines[nestedStart].indent);
			object[key] = nested;
			index = next;
			continue;
		}
		object[key] = parseYamlScalar(pair.rest);
		index += 1;
	}
	return [isList ? list : object, index];
}

function yamlKey(key: string): string {
	return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : JSON.stringify(key);
}

function serializeYamlScalar(value: unknown): string {
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'string') return JSON.stringify(value);
	if (typeof value === 'boolean' || typeof value === 'number') return String(value);
	return JSON.stringify(value);
}

function serializeYamlValue(value: unknown, indent: number): string[] {
	const prefix = ' '.repeat(indent);
	if (Array.isArray(value)) {
		if (value.length === 0) return [`${prefix}[]`];
		return value.flatMap(item => {
			if (isRecord(item) || Array.isArray(item)) {
				return [`${prefix}-`, ...serializeYamlValue(item, indent + 2)];
			}
			return [`${prefix}- ${serializeYamlScalar(item)}`];
		});
	}
	if (isRecord(value)) {
		const lines: string[] = [];
		for (const key of Object.keys(value)) {
			const child = value[key];
			if (isRecord(child) || Array.isArray(child)) {
				lines.push(`${prefix}${yamlKey(key)}:`);
				lines.push(...serializeYamlValue(child, indent + 2));
			} else {
				lines.push(`${prefix}${yamlKey(key)}: ${serializeYamlScalar(child)}`);
			}
		}
		return lines;
	}
	return [`${prefix}${serializeYamlScalar(value)}`];
}

function serializeYamlMap(frontmatter: FrontmatterRecord): string {
	return `${serializeYamlValue(frontmatter, 0).join('\n')}\n`;
}

/** Serialize only a frontmatter object, without Markdown delimiters. */
export function serializeFrontmatter(frontmatter: FrontmatterRecord): string {
	return serializeYamlMap(frontmatter);
}

/** The canonical keys are exported for consumers that build selective patches. */
export { CANONICAL_FRONTMATTER_KEYS };
