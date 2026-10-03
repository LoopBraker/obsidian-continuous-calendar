import type { EventRecurrence, EventRecurrenceFrequency } from './CalendarEvent';

export type EventRecurrenceValidationCode = 'invalid-recurrence' | 'unsupported-recurrence';

export class EventRecurrenceValidationError extends Error {
	readonly code: EventRecurrenceValidationCode;

	constructor(message: string, code: EventRecurrenceValidationCode = 'invalid-recurrence') {
		super(message);
		this.name = 'EventRecurrenceValidationError';
		this.code = code;
		Object.setPrototypeOf(this, EventRecurrenceValidationError.prototype);
	}
}

const FREQUENCIES: readonly EventRecurrenceFrequency[] = ['daily', 'weekly', 'monthly', 'yearly'];
const RECURRENCE_KEYS = new Set(['frequency', 'interval', 'weekdays', 'count', 'until']);

export function isAbsentEventRecurrence(value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		value === false ||
		value === '' ||
		value === 'none' ||
		(typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'none')
	);
}

/** Validate and normalize the supported typed recurrence subset. */
export function normalizeEventRecurrence(value: unknown): EventRecurrence | undefined {
	if (isAbsentEventRecurrence(value)) return undefined;
	if (Array.isArray(value) || typeof value === 'string') {
		throw new EventRecurrenceValidationError(
			'Recurrence rules must use the supported typed recurrence shape',
			'unsupported-recurrence',
		);
	}
	if (typeof value !== 'object' || value === null) {
		throw new EventRecurrenceValidationError('recurrence must be an object');
	}
	const input = value as Record<string, unknown>;
	for (const key of Object.keys(input)) {
		if (!RECURRENCE_KEYS.has(key)) {
			throw new EventRecurrenceValidationError(`recurrence field "${key}" is not supported`);
		}
	}
	if (typeof input.frequency !== 'string' || !FREQUENCIES.includes(input.frequency as EventRecurrenceFrequency)) {
		throw new EventRecurrenceValidationError('recurrence frequency must be daily, weekly, monthly, or yearly');
	}
	const frequency = input.frequency as EventRecurrenceFrequency;
	if (!Number.isInteger(input.interval) || (input.interval as number) < 1) {
		throw new EventRecurrenceValidationError('recurrence interval must be a positive integer');
	}
	let weekdays: number[] | undefined;
	if (input.weekdays !== undefined) {
		if (frequency !== 'weekly' || !Array.isArray(input.weekdays) || input.weekdays.length === 0) {
			throw new EventRecurrenceValidationError('weekdays are only supported as a non-empty weekly list');
		}
		if (input.weekdays.some(day => !Number.isInteger(day) || (day as number) < 1 || (day as number) > 7)) {
			throw new EventRecurrenceValidationError('weekly weekdays must use ISO numbers from 1 through 7');
		}
		weekdays = [...new Set(input.weekdays as number[])].sort((left, right) => left - right);
		if (weekdays.length !== input.weekdays.length) {
			throw new EventRecurrenceValidationError('weekly weekdays must not contain duplicates');
		}
	}
	const hasCount = input.count !== undefined;
	const hasUntil = input.until !== undefined;
	if (hasCount && hasUntil) {
		throw new EventRecurrenceValidationError('recurrence can use count or until, but not both');
	}
	let count: number | undefined;
	if (hasCount) {
		if (!Number.isInteger(input.count) || (input.count as number) < 1) {
			throw new EventRecurrenceValidationError('recurrence count must be a positive integer');
		}
		count = input.count as number;
	}
	let until: string | undefined;
	if (hasUntil) {
		if (typeof input.until !== 'string' || !isValidCivilDate(input.until)) {
			throw new EventRecurrenceValidationError('recurrence until must be a valid YYYY-MM-DD date');
		}
		until = input.until;
	}
	return {
		frequency,
		interval: input.interval as number,
		...(weekdays === undefined ? {} : { weekdays }),
		...(count === undefined ? {} : { count }),
		...(until === undefined ? {} : { until }),
	};
}

export function isValidCivilDate(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (month < 1 || month > 12 || day < 1) return false;
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Date shown by a timed event in its own IANA zone. */
export function civilDateInTimezone(timestamp: string, timezone: string): string | undefined {
	const instant = new Date(timestamp);
	if (!Number.isFinite(instant.getTime())) return undefined;
	try {
		const parts = new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		}).formatToParts(instant);
		const year = parts.find(part => part.type === 'year')?.value;
		const month = parts.find(part => part.type === 'month')?.value;
		const day = parts.find(part => part.type === 'day')?.value;
		return year && month && day ? `${year}-${month}-${day}` : undefined;
	} catch (_error) {
		return undefined;
	}
}

export function recurrenceStartDate(event: {
	readonly start: string;
	readonly allDay: boolean;
	readonly timezone: string;
}): string | undefined {
	return event.allDay ? event.start : civilDateInTimezone(event.start, event.timezone);
}
