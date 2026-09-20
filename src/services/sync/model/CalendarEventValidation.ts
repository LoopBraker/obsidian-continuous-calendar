import type {
	CalendarEvent,
	CalendarEventField,
	CalendarEventInput,
	ValidationResult,
} from './CalendarEvent';
import { inclusiveToExclusive } from '../util/date';

export type CalendarEventValidationErrorCode =
	| 'missing-field'
	| 'invalid-field'
	| 'invalid-uid'
	| 'invalid-title'
	| 'invalid-date'
	| 'invalid-rfc3339'
	| 'missing-offset'
	| 'invalid-timezone'
	| 'invalid-duration'
	| 'all-day-end-not-exclusive'
	| 'unsupported-recurrence';

export type CalendarEventValidationField =
	| CalendarEventField
	| 'event'
	| 'recurrence'
	| 'recurrenceRule'
	| 'calendar_recurrence'
	| string;

export interface CalendarEventValidationError {
	readonly code: CalendarEventValidationErrorCode;
	readonly field: CalendarEventValidationField;
	readonly message: string;
	readonly value?: unknown;
}

export type CalendarEventValidationResult = ValidationResult<
	CalendarEvent,
	CalendarEventValidationError
>;

/** Error thrown by the strict normalizer when input is not canonical. */
export class CalendarEventValidationException extends Error {
	readonly errors: readonly CalendarEventValidationError[];

	constructor(errors: readonly CalendarEventValidationError[]) {
		super(errors.map(errorValue => errorValue.message).join('; '));
		this.name = 'CalendarEventValidationException';
		this.errors = errors;
		Object.setPrototypeOf(this, CalendarEventValidationException.prototype);
	}
}

const RFC3339_TIMESTAMP =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MISSING = Symbol('missing');

interface CalendarDateParts {
	year: number;
	month: number;
	day: number;
}

interface TimestampParts extends CalendarDateParts {
	hour: number;
	minute: number;
	second: number;
	fraction: string;
	offsetSeconds: number;
}

function isRecord(value: unknown): value is CalendarEventInput {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readFirst(input: CalendarEventInput, ...keys: string[]): unknown {
	for (const key of keys) {
		if (Object.prototype.hasOwnProperty.call(input, key)) return input[key];
	}
	return MISSING;
}

function makeError(
	code: CalendarEventValidationErrorCode,
	field: CalendarEventValidationField,
	message: string,
	value?: unknown,
): CalendarEventValidationError {
	return value === undefined ? { code, field, message } : { code, field, message, value };
}

function daysInMonth(year: number, month: number): number {
	if (month === 2) {
		const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
		return leap ? 29 : 28;
	}
	return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseCalendarDate(value: string): CalendarDateParts | undefined {
	const match = CALENDAR_DATE.exec(value);
	if (!match) return undefined;

	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
		return undefined;
	}
	return { year, month, day };
}

function parseOffsetSeconds(value: string): number | undefined {
	if (value === 'Z' || value === 'z') return 0;
	const hours = Number(value.slice(1, 3));
	const minutes = Number(value.slice(4, 6));
	if (hours > 23 || minutes > 59) return undefined;
	const sign = value[0] === '-' ? -1 : 1;
	return sign * (hours * 60 + minutes) * 60;
}

function parseRfc3339Timestamp(value: string): TimestampParts | undefined {
	const match = RFC3339_TIMESTAMP.exec(value);
	if (!match) return undefined;

	const date = parseCalendarDate(`${match[1]}-${match[2]}-${match[3]}`);
	if (!date) return undefined;

	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	if (hour > 23 || minute > 59 || second > 59) return undefined;

	const offsetSeconds = parseOffsetSeconds(match[8]);
	if (offsetSeconds === undefined) return undefined;

	return {
		...date,
		hour,
		minute,
		second,
		fraction: match[7] ?? '',
		offsetSeconds,
	};
}

function isValidRfc3339Timestamp(value: string): boolean {
	return parseRfc3339Timestamp(value) !== undefined;
}

/** Returns true when the runtime recognizes the supplied IANA time zone. */
export function isValidIanaTimezone(value: string): boolean {
	if (!value || value.trim() !== value || value.startsWith('+') || value.startsWith('-')) {
		return false;
	}

	try {
		new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
		return true;
	} catch (_error) {
		return false;
	}
}

/** US spelling alias used by provider-facing callers. */
export const isValidIanaTimeZone = isValidIanaTimezone;

function requiredString(
	value: unknown,
	field: CalendarEventValidationField,
	label: string,
	code: CalendarEventValidationErrorCode,
	rejectSurroundingWhitespace = false,
): { value?: string; error?: CalendarEventValidationError } {
	if (value === MISSING || value === undefined) {
		return { error: makeError('missing-field', field, `${label} is required`) };
	}
	if (typeof value !== 'string') {
		return { error: makeError(code, field, `${label} must be a string`, value) };
	}

	const normalized = value.trim();
	if (!normalized) {
		return { error: makeError(code, field, `${label} must not be empty`, value) };
	}
	if (rejectSurroundingWhitespace && normalized !== value) {
		return {
			error: makeError(code, field, `${label} must not have surrounding whitespace`, value),
		};
	}
	return { value };
}

function optionalString(
	value: unknown,
	field: CalendarEventValidationField,
	label: string,
): { value: string; error?: CalendarEventValidationError } {
	if (value === MISSING || value === undefined) return { value: '' };
	if (typeof value !== 'string') {
		return {
			value: '',
			error: makeError('invalid-field', field, `${label} must be a string`, value),
		};
	}
	return { value };
}

function recurrenceIsAbsent(value: unknown): boolean {
	return (
		value === MISSING ||
		value === undefined ||
		value === null ||
		value === false ||
		value === '' ||
		value === 'none' ||
		(typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'none')
	);
}

function validationFailure(
	errors: readonly CalendarEventValidationError[],
): CalendarEventValidationResult {
	return { ok: false, valid: false, success: false, errors };
}

/**
 * Return the signed number of whole days since an arbitrary fixed epoch.
 * The civil-calendar algorithm avoids Date.UTC's special handling of years
 * 0000-0099 and is used only for comparing instants, not for formatting.
 */
function daysFromCivil(year: number, month: number, day: number): number {
	const adjustedYear = year - (month <= 2 ? 1 : 0);
	const era = Math.floor(adjustedYear / 400);
	const yearOfEra = adjustedYear - era * 400;
	const monthFromMarch = month + (month > 2 ? -3 : 9);
	const dayOfYear = Math.floor((153 * monthFromMarch + 2) / 5) + day - 1;
	const dayOfEra =
		yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
	return era * 146097 + dayOfEra;
}

function compareFractions(left: string, right: string): number {
	const leftTrimmed = left.replace(/0+$/, '');
	const rightTrimmed = right.replace(/0+$/, '');
	const width = Math.max(leftTrimmed.length, rightTrimmed.length);
	const leftPadded = leftTrimmed + new Array(width - leftTrimmed.length + 1).join('0');
	const rightPadded = rightTrimmed + new Array(width - rightTrimmed.length + 1).join('0');
	return leftPadded < rightPadded ? -1 : leftPadded > rightPadded ? 1 : 0;
}

function compareTimestamps(left: TimestampParts, right: TimestampParts): number {
	const leftWholeSeconds =
		daysFromCivil(left.year, left.month, left.day) * 86400 +
		left.hour * 3600 +
		left.minute * 60 +
		left.second -
		left.offsetSeconds;
	const rightWholeSeconds =
		daysFromCivil(right.year, right.month, right.day) * 86400 +
		right.hour * 3600 +
		right.minute * 60 +
		right.second -
		right.offsetSeconds;

	if (leftWholeSeconds !== rightWholeSeconds) {
		return leftWholeSeconds < rightWholeSeconds ? -1 : 1;
	}
	return compareFractions(left.fraction, right.fraction);
}

/**
 * Validate and normalize an event without throwing. Errors are emitted in a
 * deterministic field order so callers can display or test them reliably.
 */
export function validateCalendarEvent(input: unknown): CalendarEventValidationResult {
	if (!isRecord(input)) {
		return validationFailure([
			makeError('invalid-field', 'event', 'Calendar event must be an object', input),
		]);
	}

	const errors: CalendarEventValidationError[] = [];
	const uidResult = requiredString(
		readFirst(input, 'uid', 'calendar_uid'),
		'uid',
		'uid',
		'invalid-uid',
		true,
	);
	if (uidResult.error) errors.push(uidResult.error);

	const titleResult = requiredString(
		readFirst(input, 'title', 'calendar_title'),
		'title',
		'title',
		'invalid-title',
	);
	if (titleResult.error) errors.push(titleResult.error);

	const locationResult = optionalString(
		readFirst(input, 'location', 'calendar_location'),
		'location',
		'location',
	);
	if (locationResult.error) errors.push(locationResult.error);

	const descriptionResult = optionalString(
		readFirst(input, 'description', 'calendar_description'),
		'description',
		'description',
	);
	if (descriptionResult.error) errors.push(descriptionResult.error);

	let start = readFirst(input, 'calendar_start', 'start');
	let end = readFirst(input, 'calendar_end', 'end');
	let allDay = readFirst(input, 'calendar_all_day', 'allDay', 'all_day');

	const hasCanonicalEnd = end !== MISSING;
	
	if (start === MISSING) start = readFirst(input, 'dateStart', 'date');
	if (end === MISSING) end = readFirst(input, 'dateEnd');

	const date = readFirst(input, 'date');
	if (date !== MISSING && date !== undefined && !hasCanonicalEnd) {
		end = typeof start === 'string' ? inclusiveToExclusive(start) : MISSING;
		if (allDay === MISSING) allDay = typeof start === 'string' && start.includes('T') ? false : true;
	} else if (readFirst(input, 'dateEnd') !== MISSING && !hasCanonicalEnd) {
		if (typeof end === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(end.trim())) {
			end = inclusiveToExclusive(end);
		}
		if (allDay === MISSING) allDay = typeof start === 'string' && start.includes('T') ? false : true;
	}
	const timezone = readFirst(input, 'timezone', 'calendar_timezone');

	let normalizedStart: string | undefined;
	if (start === MISSING || start === undefined) {
		errors.push(makeError('missing-field', 'start', 'start is required'));
	} else if (typeof start !== 'string') {
		errors.push(makeError('invalid-field', 'start', 'start must be a string', start));
	} else {
		normalizedStart = start.trim();
	}

	let normalizedEnd: string | undefined;
	if (end === MISSING || end === undefined) {
		errors.push(makeError('missing-field', 'end', 'end is required'));
	} else if (typeof end !== 'string') {
		errors.push(makeError('invalid-field', 'end', 'end must be a string', end));
	} else {
		normalizedEnd = end.trim();
	}

	if (allDay === MISSING || allDay === undefined) {
		errors.push(makeError('missing-field', 'allDay', 'allDay is required'));
	} else if (typeof allDay !== 'boolean') {
		errors.push(makeError('invalid-field', 'allDay', 'allDay must be a boolean', allDay));
	}

	let normalizedTimezone: string | undefined;
	if (timezone === MISSING || timezone === undefined) {
		errors.push(makeError('missing-field', 'timezone', 'timezone is required'));
	} else if (typeof timezone !== 'string' || !isValidIanaTimezone(timezone)) {
		errors.push(
			makeError('invalid-timezone', 'timezone', 'timezone must be a valid IANA time zone', timezone),
		);
	} else {
		normalizedTimezone = timezone;
	}

	const recurrence = readFirst(input, 'recurrence', 'recurrenceRule', 'calendar_recurrence');
	if (!recurrenceIsAbsent(recurrence)) {
		const field = Object.prototype.hasOwnProperty.call(input, 'recurrenceRule')
			? 'recurrenceRule'
			: Object.prototype.hasOwnProperty.call(input, 'calendar_recurrence')
				? 'calendar_recurrence'
				: 'recurrence';
		errors.push(
			makeError(
				'unsupported-recurrence',
				field,
				'Recurring events are not supported by the canonical sync model',
				recurrence,
			),
		);
	}

	if (normalizedStart !== undefined && normalizedEnd !== undefined) {
		if (allDay === true) {
			const startDate = parseCalendarDate(normalizedStart);
			const endDate = parseCalendarDate(normalizedEnd);
			if (!startDate) {
				errors.push(
					makeError(
						'invalid-date',
						'start',
						'all-day start must be a valid YYYY-MM-DD date',
						start,
					),
				);
			}
			if (!endDate) {
				errors.push(
					makeError(
						'invalid-date',
						'end',
						'all-day end must be a valid YYYY-MM-DD date',
						end,
					),
				);
			}
			if (startDate && endDate && normalizedEnd <= normalizedStart) {
				errors.push(
					makeError(
						normalizedEnd === normalizedStart
							? 'all-day-end-not-exclusive'
							: 'invalid-duration',
						'end',
						'All-day end must be later than start because it is exclusive',
						end,
					),
				);
			}
		} else if (allDay === false) {
			const startTimestamp = parseRfc3339Timestamp(normalizedStart);
			const endTimestamp = parseRfc3339Timestamp(normalizedEnd);
			if (!startTimestamp) {
				errors.push(
					makeError(
						normalizedStart.includes('T') && !/[zZ]|[+-]\d{2}:\d{2}$/.test(normalizedStart)
							? 'missing-offset'
							: 'invalid-rfc3339',
						'start',
						'Timed start must be an RFC 3339 timestamp with an explicit offset',
						start,
					),
				);
			}
			if (!endTimestamp) {
				errors.push(
					makeError(
						normalizedEnd.includes('T') && !/[zZ]|[+-]\d{2}:\d{2}$/.test(normalizedEnd)
							? 'missing-offset'
							: 'invalid-rfc3339',
						'end',
						'Timed end must be an RFC 3339 timestamp with an explicit offset',
						end,
					),
				);
			}
			if (
				startTimestamp &&
				endTimestamp &&
				compareTimestamps(startTimestamp, endTimestamp) >= 0
			) {
				errors.push(
					makeError('invalid-duration', 'end', 'Timed end must be later than start', end),
				);
			}
		}
	}

	if (errors.length > 0) return validationFailure(errors);

	const event: CalendarEvent = {
		uid: uidResult.value as string,
		title: titleResult.value as string,
		start: normalizedStart as string,
		end: normalizedEnd as string,
		allDay: allDay as boolean,
		timezone: normalizedTimezone as string,
		location: locationResult.value,
		description: descriptionResult.value,
	};
	return { ok: true, valid: true, success: true, value: event, errors: [] };
}

/** Normalize a valid event or throw a structured validation exception. */
export function normalizeCalendarEvent(input: unknown): CalendarEvent {
	const result = validateCalendarEvent(input);
	if (!result.ok) throw new CalendarEventValidationException(result.errors);
	return result.value;
}

/** Result-oriented alias for callers that do not want exceptions. */
export const tryNormalizeCalendarEvent = validateCalendarEvent;

/** British spelling alias retained for consistency with existing docs. */
export const normaliseCalendarEvent = normalizeCalendarEvent;

export function isCalendarEvent(value: unknown): value is CalendarEvent {
	return validateCalendarEvent(value).ok;
}

/** Expose strict timestamp validity for pure model tests and adapters. */
export const isValidRfc3339 = isValidRfc3339Timestamp;
