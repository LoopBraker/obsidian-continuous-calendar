import type { CalendarEvent } from '../model/CalendarEvent';
import { zonedDateTime } from '../util/timezone';

export interface CalendarNoteTargetBase {
	readonly version: 1;
	readonly providerId: string;
	readonly accountId: string;
	readonly calendarId: string;
}

export interface CalendarNoteSeriesTarget extends CalendarNoteTargetBase {
	readonly scope: 'series';
	readonly seriesId: string;
}

export type CalendarNoteOccurrenceIdentity =
	| {
			readonly kind: 'event';
			readonly eventId: string;
		}
	| {
			readonly kind: 'recurrence';
			readonly masterEventId: string;
			readonly originalStartTime:
				| { readonly date: string }
				| { readonly dateTime: string; readonly timeZone: string };
		};

export interface CalendarNoteOccurrenceTarget extends CalendarNoteTargetBase {
	readonly scope: 'occurrence';
	readonly occurrence: CalendarNoteOccurrenceIdentity;
}

export interface CalendarNoteOccurrenceDayTarget extends CalendarNoteTargetBase {
	readonly scope: 'occurrence-day';
	readonly occurrence: CalendarNoteOccurrenceIdentity;
	readonly dayOffset: number;
	/** The last date explicitly confirmed for this offset. */
	readonly confirmedDate?: string;
	/** Suggested local date after the occurrence moves or changes range. */
	readonly proposedDate?: string;
	readonly dayStatus?: 'confirmed' | 'unresolved';
}

export type CalendarNoteTarget =
	| CalendarNoteSeriesTarget
	| CalendarNoteOccurrenceTarget
	| CalendarNoteOccurrenceDayTarget;

export interface CalendarNoteTargetDecodeSuccess {
	readonly ok: true;
	readonly target: CalendarNoteTarget;
	readonly key: string;
}

export interface CalendarNoteTargetDecodeFailure {
	readonly ok: false;
	readonly errors: readonly string[];
}

export type CalendarNoteTargetDecodeResult =
	| CalendarNoteTargetDecodeSuccess
	| CalendarNoteTargetDecodeFailure;

export interface CalendarNoteTargetClaim {
	readonly key?: string;
	readonly occurrenceKey?: string;
	readonly scope?: CalendarNoteTarget['scope'];
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every(key => allowed.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isValidCivilDate(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const match = DATE_PATTERN.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (month < 1 || month > 12) return false;
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	return day >= 1 && day <= monthDays[month - 1];
}

function isValidRfc3339DateTime(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const match = RFC3339_PATTERN.exec(value);
	if (!match) return false;
	const date = `${match[1]}-${match[2]}-${match[3]}`;
	if (!isValidCivilDate(date)) return false;
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	if (hour > 23 || minute > 59 || second > 59) return false;
	const offset = match[7];
	if (offset !== 'Z') {
		const offsetHour = Number(offset.slice(1, 3));
		const offsetMinute = Number(offset.slice(4, 6));
		if (offsetHour > 23 || offsetMinute > 59) return false;
	}
	return Number.isFinite(Date.parse(value));
}

function isValidTimezone(value: unknown): value is string {
	if (!isNonEmptyString(value)) return false;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
		return true;
	} catch (_error) {
		return false;
	}
}

function occurrenceIdentityKey(identity: CalendarNoteOccurrenceIdentity): string {
	if (identity.kind === 'event') return JSON.stringify(['event', identity.eventId]);
	if ('date' in identity.originalStartTime) {
		return JSON.stringify(['recurrence', identity.masterEventId, 'date', identity.originalStartTime.date]);
	}
	return JSON.stringify([
		'recurrence',
		identity.masterEventId,
		'dateTime',
		identity.originalStartTime.dateTime,
		identity.originalStartTime.timeZone,
	]);
}

export function occurrenceTargetKey(target: CalendarNoteTargetOccurrenceLike): string {
	return JSON.stringify([
		target.providerId,
		target.accountId,
		target.calendarId,
		occurrenceIdentityKey(target.occurrence),
	]);
}

type CalendarNoteTargetOccurrenceLike = CalendarNoteOccurrenceTarget | CalendarNoteOccurrenceDayTarget;

/**
 * Stable path-independent identity. Mutable day confirmation fields are
 * intentionally excluded so suggestions never detach an existing note.
 */
export function targetKey(target: CalendarNoteTarget): string {
	const owner = [target.providerId, target.accountId, target.calendarId];
	if (target.scope === 'series') return JSON.stringify([...owner, 'series', target.seriesId]);
	const occurrence = occurrenceIdentityKey(target.occurrence);
	if (target.scope === 'occurrence') return JSON.stringify([...owner, 'occurrence', occurrence]);
	return JSON.stringify([...owner, 'occurrence-day', occurrence, target.dayOffset]);
}

function decodeOccurrenceIdentity(value: unknown): CalendarNoteOccurrenceIdentity | undefined {
	if (!isRecord(value) || !isNonEmptyString(value.kind)) return undefined;
	if (value.kind === 'event' && hasOnlyKeys(value, ['kind', 'event_id']) && isNonEmptyString(value.event_id)) {
		return { kind: 'event', eventId: value.event_id };
	}
	if (
		value.kind !== 'recurrence' ||
		!hasOnlyKeys(value, ['kind', 'master_event_id', 'original_start_time']) ||
		!isNonEmptyString(value.master_event_id) ||
		!isRecord(value.original_start_time)
	) {
		return undefined;
	}
	const original = value.original_start_time;
	if (isValidCivilDate(original.date) && Object.keys(original).every(key => key === 'date')) {
		return { kind: 'recurrence', masterEventId: value.master_event_id, originalStartTime: { date: original.date } };
	}
	if (
		isValidRfc3339DateTime(original.date_time) &&
		isValidTimezone(original.time_zone) &&
		Object.keys(original).every(key => key === 'date_time' || key === 'time_zone')
	) {
		return {
			kind: 'recurrence',
			masterEventId: value.master_event_id,
			originalStartTime: { dateTime: original.date_time, timeZone: original.time_zone },
		};
	}
	return undefined;
}

function encodeTargetIdentity(target: CalendarNoteTarget): Record<string, unknown> {
	if (target.scope === 'series') return { series_id: target.seriesId };
	const occurrence = target.occurrence.kind === 'event'
		? { kind: 'event', event_id: target.occurrence.eventId }
		: {
			kind: 'recurrence',
			master_event_id: target.occurrence.masterEventId,
			original_start_time: 'date' in target.occurrence.originalStartTime
				? { date: target.occurrence.originalStartTime.date }
				: {
					date_time: target.occurrence.originalStartTime.dateTime,
					time_zone: target.occurrence.originalStartTime.timeZone,
				},
		};
	return target.scope === 'occurrence'
		? { occurrence }
		: {
			occurrence,
			day_offset: target.dayOffset,
			...(target.confirmedDate === undefined ? {} : { confirmed_date: target.confirmedDate }),
			...(target.proposedDate === undefined ? {} : { proposed_date: target.proposedDate }),
			...(target.dayStatus === undefined ? {} : { day_status: target.dayStatus }),
		};
}

/** Convert the public camel-case target to its stable frontmatter wire shape. */
export function encodeCalendarNoteTarget(target: CalendarNoteTarget): Record<string, unknown> {
	return {
		version: target.version,
		provider_id: target.providerId,
		account_id: target.accountId,
		calendar_id: target.calendarId,
		scope: target.scope,
		...encodeTargetIdentity(target),
	};
}

/** Strictly decode the versioned `calendar_note_target` frontmatter object. */
export function decodeCalendarNoteTarget(value: unknown): CalendarNoteTargetDecodeResult {
	const errors: string[] = [];
	if (!isRecord(value)) return { ok: false, errors: ['calendar_note_target must be an object'] };
	if (value.version !== 1) errors.push('calendar_note_target.version must be 1');
	if (!isNonEmptyString(value.provider_id)) errors.push('calendar_note_target.provider_id is required');
	if (!isNonEmptyString(value.account_id)) errors.push('calendar_note_target.account_id is required');
	if (!isNonEmptyString(value.calendar_id)) errors.push('calendar_note_target.calendar_id is required');
	if (value.scope !== 'series' && value.scope !== 'occurrence' && value.scope !== 'occurrence-day') {
		errors.push('calendar_note_target.scope is invalid');
	}
	const allowedTopLevel = value.scope === 'series'
		? ['version', 'provider_id', 'account_id', 'calendar_id', 'scope', 'series_id']
		: value.scope === 'occurrence'
			? ['version', 'provider_id', 'account_id', 'calendar_id', 'scope', 'occurrence']
			: ['version', 'provider_id', 'account_id', 'calendar_id', 'scope', 'occurrence', 'day_offset', 'confirmed_date', 'proposed_date', 'day_status'];
	if (!hasOnlyKeys(value, allowedTopLevel)) errors.push('calendar_note_target has fields that do not match its scope');
	if (errors.length > 0) return { ok: false, errors };

	const base = {
		version: 1 as const,
		providerId: value.provider_id as string,
		accountId: value.account_id as string,
		calendarId: value.calendar_id as string,
	};
	let target: CalendarNoteTarget | undefined;
	if (value.scope === 'series') {
		if (!isNonEmptyString(value.series_id)) errors.push('calendar_note_target.series_id is required for series scope');
		else target = { ...base, scope: 'series', seriesId: value.series_id };
	} else {
		const occurrence = decodeOccurrenceIdentity(value.occurrence);
		if (!occurrence) errors.push('calendar_note_target.occurrence is invalid');
		else if (value.scope === 'occurrence') target = { ...base, scope: 'occurrence', occurrence };
		else {
			if (!Number.isInteger(value.day_offset) || (value.day_offset as number) < 0) {
				errors.push('calendar_note_target.day_offset must be a non-negative integer');
			}
			if (value.confirmed_date !== undefined && !isValidCivilDate(value.confirmed_date)) {
				errors.push('calendar_note_target.confirmed_date must be a valid YYYY-MM-DD date');
			}
			if (value.proposed_date !== undefined && !isValidCivilDate(value.proposed_date)) {
				errors.push('calendar_note_target.proposed_date must be a valid YYYY-MM-DD date');
			}
			if (value.day_status !== undefined && value.day_status !== 'confirmed' && value.day_status !== 'unresolved') {
				errors.push('calendar_note_target.day_status is invalid');
			}
			if (errors.length === 0) {
				target = {
					...base,
					scope: 'occurrence-day',
					occurrence,
					dayOffset: value.day_offset as number,
					...(value.confirmed_date === undefined ? {} : { confirmedDate: value.confirmed_date as string }),
					...(value.proposed_date === undefined ? {} : { proposedDate: value.proposed_date as string }),
					...(value.day_status === undefined ? {} : { dayStatus: value.day_status as 'confirmed' | 'unresolved' }),
				};
			}
		}
	}
	if (!target || errors.length > 0) return { ok: false, errors };
	return { ok: true, target, key: targetKey(target) };
}

/**
 * Best-effort stable identity extraction for quarantining malformed targets.
 * Mutable day confirmation fields and the version are ignored so a typo in
 * those fields cannot make an existing claimant disappear from collision
 * checks. Invalid occurrence identity still remains an unresolved candidate.
 */
export function calendarNoteTargetClaim(value: unknown): CalendarNoteTargetClaim {
	if (!isRecord(value)) return {};
	const providerId = value.provider_id;
	const accountId = value.account_id;
	const calendarId = value.calendar_id;
	const scope = value.scope;
	if (!isNonEmptyString(providerId) || !isNonEmptyString(accountId) || !isNonEmptyString(calendarId)) return {};
	const owner = [providerId, accountId, calendarId];
	if (scope === 'series' && isNonEmptyString(value.series_id)) {
		return { scope, key: JSON.stringify([...owner, 'series', value.series_id]) };
	}
	if ((scope === 'occurrence' || scope === 'occurrence-day') && isRecord(value.occurrence)) {
		const occurrence = decodeOccurrenceIdentity(value.occurrence);
		if (!occurrence) return { scope };
		const occurrenceKey = JSON.stringify([...owner, occurrenceIdentityKey(occurrence)]);
		if (scope === 'occurrence') return { scope, key: JSON.stringify([...owner, 'occurrence', occurrenceIdentityKey(occurrence)]), occurrenceKey };
		if (Number.isInteger(value.day_offset) && (value.day_offset as number) >= 0) {
			return {
				scope,
				key: JSON.stringify([...owner, 'occurrence-day', occurrenceIdentityKey(occurrence), value.day_offset]),
				occurrenceKey,
			};
		}
		return { scope, occurrenceKey };
	}
	return {};
}

export function calendarNoteTargetMatchesProviderReference(
	target: CalendarNoteTarget,
	reference: { providerId: string; accountId: string; calendarId: string; remoteEventId: string },
): boolean {
	if (
		target.providerId !== reference.providerId ||
		target.accountId !== reference.accountId ||
		target.calendarId !== reference.calendarId
	) return false;
	if (target.scope === 'series') return target.seriesId === reference.remoteEventId;
	if (target.occurrence.kind === 'event') return target.occurrence.eventId === reference.remoteEventId;
	return target.occurrence.masterEventId === reference.remoteEventId;
}

function parseCivilDate(value: string): { year: number; month: number; day: number } | undefined {
	const match = DATE_PATTERN.exec(value);
	if (!match || !isValidCivilDate(value)) return undefined;
	return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function civilDayNumber(value: string): number | undefined {
	const parts = parseCivilDate(value);
	if (!parts) return undefined;
	const date = new Date(0);
	date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
	date.setUTCHours(0, 0, 0, 0);
	return Math.floor(date.getTime() / 86_400_000);
}

function dateFromCivilDayNumber(value: number): string {
	const date = new Date(value * 86_400_000);
	return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function addCivilDays(date: string, amount: number): string | undefined {
	if (!Number.isInteger(amount)) return undefined;
	const day = civilDayNumber(date);
	return day === undefined ? undefined : dateFromCivilDayNumber(day + amount);
}

/** Civil-day offset bounds for one displayed canonical event. */
export function eventCivilDayBounds(event: CalendarEvent): { startDate: string; endDateExclusive: string } | undefined {
	if (event.allDay) {
		if (!isValidCivilDate(event.start) || !isValidCivilDate(event.end) || event.end <= event.start) return undefined;
		return { startDate: event.start, endDateExclusive: event.end };
	}
	const start = zonedDateTime(event.start, event.timezone);
	const end = zonedDateTime(event.end, event.timezone);
	if (!start || !end) return undefined;
	const startDate = `${String(start.year).padStart(4, '0')}-${String(start.month).padStart(2, '0')}-${String(start.day).padStart(2, '0')}`;
	const endDate = `${String(end.year).padStart(4, '0')}-${String(end.month).padStart(2, '0')}-${String(end.day).padStart(2, '0')}`;
	const endsAtLocalMidnight = end.hour === 0 && end.minute === 0 && end.second === 0 && end.millisecond === 0;
	const endDateExclusive = endsAtLocalMidnight ? endDate : addCivilDays(endDate, 1);
	if (!endDateExclusive || endDateExclusive <= startDate) return undefined;
	return { startDate, endDateExclusive };
}

export function eventDateForDayOffset(event: CalendarEvent, dayOffset: number): string | undefined {
	if (!Number.isInteger(dayOffset) || dayOffset < 0) return undefined;
	const bounds = eventCivilDayBounds(event);
	if (!bounds) return undefined;
	const date = addCivilDays(bounds.startDate, dayOffset);
	return date && date < bounds.endDateExclusive ? date : undefined;
}
