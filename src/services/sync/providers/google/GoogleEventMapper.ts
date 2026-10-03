import type { CalendarEvent, CalendarEventValidationError, EventRecurrence } from '../../model';
import { normalizeCalendarEvent } from '../../model/CalendarEventValidation';
import { EventRecurrenceValidationError, normalizeEventRecurrence } from '../../model/EventRecurrence';
import type { RemoteCalendarEvent } from '../CalendarProvider';
import { civilDateKey, civilDateTimeAsUtc, civilDateTimeToInstant, rruleUtcTimestamp, utcAsCivilDateTime, zonedDateTime } from '../../util/timezone';

/** Google private extended-property key used for the immutable local UID. */
export const GOOGLE_CALENDAR_UID_KEY = 'calendar_uid';

export interface GoogleEventDateResource {
	readonly date?: string;
	readonly dateTime?: string;
	readonly timeZone?: string;
}

/** The subset of a Google event resource used by the first milestone. */
export interface GoogleEventResource {
	readonly id?: string;
	readonly status?: string;
	readonly etag?: string;
	readonly updated?: string;
	readonly summary?: unknown;
	readonly description?: unknown;
	readonly location?: unknown;
	readonly start?: GoogleEventDateResource;
	readonly end?: GoogleEventDateResource;
	readonly recurrence?: readonly string[];
	readonly recurringEventId?: string;
	readonly originalStartTime?: GoogleEventDateResource;
	readonly extendedProperties?: {
		readonly private?: Readonly<Record<string, string>>;
		readonly shared?: Readonly<Record<string, string>>;
	};
}

export interface GoogleEventPayload {
	readonly summary: string;
	readonly description?: string;
	readonly location?: string;
	readonly start: GoogleEventDateResource;
	readonly end: GoogleEventDateResource;
	readonly recurrence?: readonly string[];
	readonly extendedProperties: {
		readonly private: Readonly<Record<string, string>>;
	};
}

export interface GoogleEventMappingContext {
	readonly calendarId: string;
	readonly calendarTimezone?: string;
}

export class GoogleEventMappingError extends Error {
	readonly code: 'invalid-resource' | 'invalid-canonical-event';
	readonly errors?: readonly CalendarEventValidationError[];

	constructor(
		message: string,
		code: 'invalid-resource' | 'invalid-canonical-event',
		errors?: readonly CalendarEventValidationError[],
	) {
		super(message);
		this.name = 'GoogleEventMappingError';
		this.code = code;
		this.errors = errors;
		Object.setPrototypeOf(this, GoogleEventMappingError.prototype);
	}
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

/** Preserve provider text exactly; trim only to decide whether it is empty. */
function textWithContent(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.trim().length === 0) return undefined;
	return value;
}

function mapText(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function hasPrivateCalendarUid(resource: GoogleEventResource): string | undefined {
	return nonEmptyString(resource.extendedProperties?.private?.[GOOGLE_CALENDAR_UID_KEY]);
}

function mappingFailure(message: string): never {
	throw new GoogleEventMappingError(message, 'invalid-resource');
}

function makePlaceholderUid(calendarId: string, remoteId: string): string {
	return `google:${calendarId}:${remoteId}`;
}

/**
 * Map a canonical event to the provider-owned fields supported by this
 * milestone. PATCH callers can safely use this payload without overwriting
 * attendees, reminders, conferencing, or other provider-owned fields.
 */
export function calendarEventToGoogleResource(event: {
	readonly uid: string;
	readonly title: string;
	readonly start: string;
	readonly end: string;
	readonly allDay: boolean;
	readonly timezone: string;
	readonly location: string;
	readonly description: string;
	readonly recurrence?: EventRecurrence;
}, includeEmptyRecurrence = false): GoogleEventPayload {
	const start: GoogleEventDateResource = event.allDay
		? { date: event.start, ...(event.recurrence ? { timeZone: event.timezone } : {}) }
		: { dateTime: event.start, timeZone: event.timezone };
	const end: GoogleEventDateResource = event.allDay
		? { date: event.end, ...(event.recurrence ? { timeZone: event.timezone } : {}) }
		: { dateTime: event.end, timeZone: event.timezone };

	const recurrence = event.recurrence ? [eventRecurrenceToGoogleRRule(event.recurrence, event)] : undefined;
	return {
		summary: event.title,
		description: event.description,
		location: event.location,
		start,
		end,
		...(recurrence === undefined && !includeEmptyRecurrence ? {} : { recurrence: recurrence ?? [] }),
		extendedProperties: {
			private: { [GOOGLE_CALENDAR_UID_KEY]: event.uid },
		},
	};
}

const GOOGLE_WEEKDAYS: Readonly<Record<number, string>> = {
	1: 'MO', 2: 'TU', 3: 'WE', 4: 'TH', 5: 'FR', 6: 'SA', 7: 'SU',
};
const ISO_WEEKDAYS: Readonly<Record<string, number>> = {
	MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7,
};

function recurrenceUntilToGoogle(until: string, event: { allDay: boolean; timezone: string }): string {
	if (event.allDay) return until.replace(/-/g, '');
	const [year, month, day] = until.split('-').map(Number);
	const instant = civilDateTimeToInstant(
		{ year, month, day, hour: 23, minute: 59, second: 59, millisecond: 0 },
		event.timezone,
		'forward',
	);
	if (instant === undefined) throw new Error('Could not resolve recurrence end date in the event timezone');
	return rruleUtcTimestamp(instant);
}

function eventRecurrenceToGoogleRRule(
	recurrence: EventRecurrence,
	event: { allDay: boolean; timezone: string },
): string {
	const fields = [`FREQ=${recurrence.frequency.toUpperCase()}`];
	if (recurrence.interval !== 1) fields.push(`INTERVAL=${recurrence.interval}`);
	if (recurrence.weekdays) fields.push(`BYDAY=${recurrence.weekdays.map(day => GOOGLE_WEEKDAYS[day]).join(',')}`);
	if (recurrence.count !== undefined) fields.push(`COUNT=${recurrence.count}`);
	if (recurrence.until !== undefined) fields.push(`UNTIL=${recurrenceUntilToGoogle(recurrence.until, event)}`);
	return `RRULE:${fields.join(';')}`;
}

function recurrenceFromGoogle(
	resource: GoogleEventResource,
	event: Pick<CalendarEvent, 'start' | 'allDay' | 'timezone'>,
): { recurrenceStatus: RemoteCalendarEvent['recurrenceStatus']; recurrence?: EventRecurrence; recurrenceRaw?: readonly string[] } {
	const raw = resource.recurrence && resource.recurrence.length > 0 ? [...resource.recurrence] : undefined;
	if (nonEmptyString(resource.recurringEventId)) {
		return { recurrenceStatus: 'unsupported', ...(raw === undefined ? {} : { recurrenceRaw: raw }) };
	}
	if (!raw) return { recurrenceStatus: 'none' };
	if (raw.length !== 1 || !/^RRULE:/i.test(raw[0].trim())) {
		return { recurrenceStatus: 'unsupported', recurrenceRaw: raw };
	}
	const value = raw[0].trim().slice(raw[0].trim().indexOf(':') + 1);
	const fields: Record<string, string> = {};
	for (const token of value.split(';')) {
		const equalsAt = token.indexOf('=');
		if (equalsAt <= 0 || equalsAt === token.length - 1) return { recurrenceStatus: 'unsupported', recurrenceRaw: raw };
		const key = token.slice(0, equalsAt).toUpperCase();
		if (Object.prototype.hasOwnProperty.call(fields, key)) return { recurrenceStatus: 'unsupported', recurrenceRaw: raw };
		fields[key] = token.slice(equalsAt + 1).toUpperCase();
	}
	const allowed = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'COUNT', 'UNTIL', 'WKST']);
	if (Object.keys(fields).some(key => !allowed.has(key)) || (fields.WKST !== undefined && fields.WKST !== 'MO')) {
		return { recurrenceStatus: 'unsupported', recurrenceRaw: raw };
	}
	const frequency = fields.FREQ?.toLowerCase();
	const interval = fields.INTERVAL === undefined
		? 1
		: /^\d+$/.test(fields.INTERVAL) ? Number(fields.INTERVAL) : undefined;
	let weekdays: number[] | undefined;
	if (fields.BYDAY !== undefined) {
		if (frequency !== 'weekly') return { recurrenceStatus: 'unsupported', recurrenceRaw: raw };
		const parsedWeekdays = fields.BYDAY.split(',').map(day => ISO_WEEKDAYS[day]);
		if (parsedWeekdays.some(day => day === undefined)) return { recurrenceStatus: 'unsupported', recurrenceRaw: raw };
		weekdays = parsedWeekdays as number[];
	}
	const count = fields.COUNT === undefined
		? undefined
		: /^\d+$/.test(fields.COUNT) ? Number(fields.COUNT) : undefined;
	if (fields.COUNT !== undefined && count === undefined) return { recurrenceStatus: 'unsupported', recurrenceRaw: raw };
	let until: string | undefined;
	if (fields.UNTIL !== undefined) {
		if (/^\d{8}$/.test(fields.UNTIL)) {
			if (!event.allDay) return { recurrenceStatus: 'unsupported', recurrenceRaw: raw };
			until = `${fields.UNTIL.slice(0, 4)}-${fields.UNTIL.slice(4, 6)}-${fields.UNTIL.slice(6, 8)}`;
		} else if (/^\d{8}T\d{6}Z$/.test(fields.UNTIL)) {
			const compact = fields.UNTIL;
			const timestamp = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T${compact.slice(9, 11)}:${compact.slice(11, 13)}:${compact.slice(13, 15)}Z`;
			const localDate = zonedDateTime(timestamp, event.timezone);
			if (event.allDay || !localDate) return { recurrenceStatus: 'unsupported', recurrenceRaw: raw };
			const localStart = zonedDateTime(event.start, event.timezone);
			if (!localStart) return { recurrenceStatus: 'unsupported', recurrenceRaw: raw };
			const untilClock = ((localDate.hour * 60 + localDate.minute) * 60) + localDate.second;
			const startClock = ((localStart.hour * 60 + localStart.minute) * 60) + localStart.second;
			const inclusiveDate = untilClock < startClock
				? utcAsCivilDateTime(civilDateTimeAsUtc({ ...localDate, hour: 0, minute: 0, second: 0, millisecond: 0 }) - 86_400_000)
				: localDate;
			until = civilDateKey(inclusiveDate);
		} else {
			return { recurrenceStatus: 'unsupported', recurrenceRaw: raw };
		}
	}
	try {
		const recurrence = normalizeEventRecurrence({ frequency, interval, weekdays, count, until });
		return recurrence
			? { recurrenceStatus: 'supported', recurrence, recurrenceRaw: raw }
			: { recurrenceStatus: 'unsupported', recurrenceRaw: raw };
	} catch (error) {
		if (!(error instanceof EventRecurrenceValidationError)) throw error;
		return { recurrenceStatus: 'unsupported', recurrenceRaw: raw };
	}
}

/**
 * Convert a Google resource to the canonical model. A remote event without
 * private plugin metadata receives a deterministic placeholder `event.uid`,
 * but the returned object deliberately omits `calendarUid` in that case.
 */
export function googleResourceToRemoteEvent(
	resource: GoogleEventResource,
	context: GoogleEventMappingContext,
): RemoteCalendarEvent {
	const remoteId = nonEmptyString(resource.id);
	if (!remoteId) mappingFailure('Google event resource is missing an id');
	if (!resource.start || !resource.end) mappingFailure('Google event resource is missing start or end');

	const startDate = nonEmptyString(resource.start.date);
	const endDate = nonEmptyString(resource.end.date);
	const startDateTime = nonEmptyString(resource.start.dateTime);
	const endDateTime = nonEmptyString(resource.end.dateTime);
	const allDay = startDate !== undefined || endDate !== undefined;
	if (allDay && (!startDate || !endDate || startDateTime || endDateTime)) {
		mappingFailure('Google event has an incomplete or mixed all-day range');
	}
	if (!allDay && (!startDateTime || !endDateTime || startDate || endDate)) {
		mappingFailure('Google event has an incomplete or mixed timed range');
	}

	const privateUid = hasPrivateCalendarUid(resource);
	const calendarUid = privateUid;
	const uid = privateUid ?? makePlaceholderUid(context.calendarId, remoteId);
	const timezone =
		nonEmptyString(resource.start.timeZone) ??
		nonEmptyString(resource.end.timeZone) ??
		nonEmptyString(context.calendarTimezone) ??
		'UTC';
	const candidate = {
		uid,
		title: textWithContent(resource.summary) ?? '(untitled event)',
		start: allDay ? (startDate as string) : (startDateTime as string),
		end: allDay ? (endDate as string) : (endDateTime as string),
		allDay,
		timezone,
		location: mapText(resource.location),
		description: mapText(resource.description),
	};
	const recurrenceInfo = recurrenceFromGoogle(resource, {
		start: allDay ? (startDate as string) : (startDateTime as string),
		allDay,
		timezone,
	});
	const candidateWithRecurrence = recurrenceInfo.recurrence
		? { ...candidate, recurrence: recurrenceInfo.recurrence }
		: candidate;
	let event;
	try {
		event = normalizeCalendarEvent(candidateWithRecurrence);
	} catch (error) {
		const validationErrors =
			error instanceof Error && 'errors' in error
				? (error as Error & { errors?: readonly CalendarEventValidationError[] }).errors
				: undefined;
		throw new GoogleEventMappingError(
				'Google event fields are not valid canonical values',
				'invalid-canonical-event',
				validationErrors,
		);
	}

	const result: RemoteCalendarEvent = {
		providerId: 'google',
		calendarId: context.calendarId,
		remoteId,
		event,
		version: nonEmptyString(resource.etag),
		remoteUpdatedAt: nonEmptyString(resource.updated),
		recurrenceStatus: recurrenceInfo.recurrenceStatus,
		recurrence: recurrenceInfo.recurrenceStatus === 'unsupported' ? 'unsupported' : 'none',
		...(recurrenceInfo.recurrenceRaw === undefined ? {} : { recurrenceRaw: recurrenceInfo.recurrenceRaw }),
		...(nonEmptyString(resource.recurringEventId) === undefined
			? {}
			: { recurrenceMasterId: nonEmptyString(resource.recurringEventId) }),
	};
	if (calendarUid !== undefined) return { ...result, calendarUid };
	return result;
}
