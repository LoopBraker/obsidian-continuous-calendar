import {
	CALENDAR_EVENT_FIELDS,
	type CalendarEvent,
	type CalendarEventSnapshot,
} from './CalendarEvent';
import { normalizeCalendarEvent } from './CalendarEventValidation';

/**
 * Serialize JSON-compatible data with object keys sorted recursively.
 * Arrays retain their order because array order is meaningful data.
 */
export function stableSerialize(value: unknown): string {
	if (value === null) return 'null';
	if (value === undefined) return 'null';

	switch (typeof value) {
		case 'string':
			return JSON.stringify(value);
		case 'boolean':
			return value ? 'true' : 'false';
		case 'number':
			if (!Number.isFinite(value)) throw new TypeError('Cannot serialize a non-finite number');
			return JSON.stringify(value);
		case 'object':
			if (Array.isArray(value)) {
				return `[${value.map(item => stableSerialize(item)).join(',')}]`;
			}
			return serializeRecord(value as Record<string, unknown>);
		default:
			throw new TypeError(`Cannot serialize value of type ${typeof value}`);
	}
}

function serializeRecord(value: Record<string, unknown>): string {
	const keys = Object.keys(value).sort();
	return `{${keys
		.map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
		.join(',')}}`;
}

/**
 * Serialize only the canonical event fields in their declared order. Unknown
 * properties are excluded, so provider/frontmatter extensions cannot affect a
 * synchronization hash.
 */
export function serializeCalendarEvent(input: unknown): string {
	const event = normalizeCalendarEvent(input);
	return `{${CALENDAR_EVENT_FIELDS
		.map(field => `${JSON.stringify(field)}:${stableSerialize(event[field])}`)
		.join(',')}}`;
}

/** Explicit alias for callers that want to name the canonical JSON form. */
export const canonicalCalendarEventJson = serializeCalendarEvent;

function hashLane(value: string, seed: number, prime: number): number {
	let hash = seed >>> 0;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, prime);
	}
	return hash >>> 0;
}

function hex32(value: number): string {
	const hexadecimal = (value >>> 0).toString(16);
	return `00000000${hexadecimal}`.slice(-8);
}

/**
 * Return a deterministic, non-cryptographic content hash. Two independent
 * 32-bit lanes make accidental collisions less likely without requiring a
 * Node-only crypto API in the Obsidian runtime.
 */
export function stableHash(value: string): string {
	return `${hex32(hashLane(value, 0x811c9dc5, 0x01000193))}${hex32(
		hashLane(value, 0x9e3779b1, 0x85ebca6b),
	)}`;
}

export function hashCalendarEvent(input: unknown): string {
	return stableHash(serializeCalendarEvent(input));
}

/** Naming aliases used by different sync-layer consumers. */
export const computeCalendarEventHash = hashCalendarEvent;
export const calendarEventHash = hashCalendarEvent;

export function createCalendarEventSnapshot(
	input: unknown,
	capturedAt?: string,
): CalendarEventSnapshot {
	const event: CalendarEvent = normalizeCalendarEvent(input);
	const hash = hashCalendarEvent(event);
	return capturedAt === undefined ? { event, hash } : { event, hash, capturedAt };
}
