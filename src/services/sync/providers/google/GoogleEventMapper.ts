import type { CalendarEvent, CalendarEventValidationError, EventRecurrence } from '../../model';
import { normalizeCalendarEvent } from '../../model/CalendarEventValidation';
import { EventRecurrenceValidationError, normalizeEventRecurrence } from '../../model/EventRecurrence';
import type {
	CancelledRemoteOccurrence,
	ProviderDateTimeValue,
	RemoteCalendarEvent,
	RemoteOccurrence,
} from '../CalendarProvider';
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

/** Occurrence PATCH payload deliberately excludes recurrence and private metadata. */
export interface GoogleEventInstancePatch {
	readonly summary: string;
	readonly description?: string;
	readonly location?: string;
	readonly start: GoogleEventDateResource;
	readonly end: GoogleEventDateResource;
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

function validCivilDate(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const date = new Date(0);
	date.setUTCHours(0, 0, 0, 0);
	date.setUTCFullYear(year, month - 1, day);
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validTimeZone(value: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: value });
		return true;
	} catch (_error) {
		return false;
	}
}

/** Copy and validate a Google date/dateTime without converting its identity representation. */
export function googleDateTimeToProviderValue(value: GoogleEventDateResource | undefined): ProviderDateTimeValue | undefined {
	if (!value) return undefined;
	const hasDate = typeof value.date === 'string' && value.date.length > 0;
	const hasDateTime = typeof value.dateTime === 'string' && value.dateTime.length > 0;
	if (hasDate === hasDateTime) return undefined;
	if (hasDate && !validCivilDate(value.date as string)) return undefined;
	if (hasDateTime) {
		const dateTime = value.dateTime as string;
		const match = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.exec(dateTime);
		if (!match || !validCivilDate(match[1]) || !Number.isFinite(Date.parse(dateTime))) return undefined;
		if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(dateTime) && !nonEmptyString(value.timeZone)) return undefined;
	}
	const timeZone = typeof value.timeZone === 'string' && value.timeZone.length > 0 ? value.timeZone : undefined;
	if (timeZone !== undefined && !validTimeZone(timeZone)) return undefined;
	return {
		...(hasDate ? { date: value.date } : {}),
		...(hasDateTime ? { dateTime: value.dateTime } : {}),
		...(timeZone === undefined ? {} : { timeZone }),
	};
}

function requiredProviderDateTime(
	value: GoogleEventDateResource | undefined,
	field: string,
): ProviderDateTimeValue {
	const mapped = googleDateTimeToProviderValue(value);
	if (!mapped) mappingFailure(`Google event has an invalid ${field}`);
	return mapped;
}

function optionalProviderDateTime(
	value: GoogleEventDateResource | undefined,
	field: string,
): ProviderDateTimeValue | undefined {
	if (!value) return undefined;
	const mapped = googleDateTimeToProviderValue(value);
	if (!mapped) mappingFailure(`Google event has an invalid ${field}`);
	return mapped;
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
	const { start, end } = canonicalRangeToGoogleDates(event);

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

/** Build an occurrence-only patch without recurrence rules or local UID metadata. */
export function calendarEventToGoogleInstancePatch(event: {
	readonly title: string;
	readonly start: string;
	readonly end: string;
	readonly allDay: boolean;
	readonly timezone: string;
	readonly location: string;
	readonly description: string;
}): GoogleEventInstancePatch {
	const { start, end } = canonicalRangeToGoogleDates(event);
	return {
		summary: event.title,
		description: event.description,
		location: event.location,
		start,
		end,
	};
}

function canonicalRangeToGoogleDates(event: {
	readonly start: string;
	readonly end: string;
	readonly allDay: boolean;
	readonly timezone: string;
	readonly recurrence?: EventRecurrence;
}): { readonly start: GoogleEventDateResource; readonly end: GoogleEventDateResource } {
	const start: GoogleEventDateResource = event.allDay
		? { date: event.start, ...(event.recurrence ? { timeZone: event.timezone } : {}) }
		: { dateTime: event.start, timeZone: event.timezone };
	const end: GoogleEventDateResource = event.allDay
		? { date: event.end, ...(event.recurrence ? { timeZone: event.timezone } : {}) }
		: { dateTime: event.end, timeZone: event.timezone };
	return { start, end };
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
		actualStart: requiredProviderDateTime(resource.start, 'actual start'),
		actualEnd: requiredProviderDateTime(resource.end, 'actual end'),
		...(nonEmptyString(resource.recurringEventId) === undefined ? {} : {
			recurrenceMasterId: nonEmptyString(resource.recurringEventId),
			originalStartTime: requiredProviderDateTime(resource.originalStartTime, 'originalStartTime'),
		}),
	};
	if (resource.originalStartTime && !nonEmptyString(resource.recurringEventId)) {
		mappingFailure('Google event has originalStartTime without a recurring master id');
	}
	if (calendarUid !== undefined) return { ...result, calendarUid };
	return result;
}

/** Map an active or cancelled Google instance while retaining its immutable slot identity. */
export function googleResourceToRemoteOccurrence(
	resource: GoogleEventResource,
	context: GoogleEventMappingContext,
): RemoteOccurrence {
	const instanceRemoteId = nonEmptyString(resource.id);
	const masterRemoteId = nonEmptyString(resource.recurringEventId);
	if (!instanceRemoteId || !masterRemoteId) mappingFailure('Google occurrence is missing its instance or master id');
	const originalStartTime = requiredProviderDateTime(resource.originalStartTime, 'originalStartTime');
	const actualStart = optionalProviderDateTime(resource.start, 'actual start');
	const actualEnd = optionalProviderDateTime(resource.end, 'actual end');
	const version = nonEmptyString(resource.etag);
	if (resource.status === 'cancelled') {
		const cancelled: CancelledRemoteOccurrence = {
			status: 'cancelled',
			providerId: 'google',
			calendarId: context.calendarId,
			masterRemoteId,
			instanceRemoteId,
			originalStartTime,
			...(actualStart === undefined ? {} : { actualStart }),
			...(actualEnd === undefined ? {} : { actualEnd }),
			...(version === undefined ? {} : { version }),
		};
		return cancelled;
	}
	const event = googleResourceToRemoteEvent(resource, context);
	if (event.recurrenceMasterId !== masterRemoteId || !event.actualStart || !event.actualEnd) {
		mappingFailure('Google returned an invalid recurring occurrence');
	}
	return {
		status: 'active',
		providerId: 'google',
		calendarId: context.calendarId,
		masterRemoteId,
		instanceRemoteId,
		originalStartTime,
		actualStart: event.actualStart,
		actualEnd: event.actualEnd,
		event: { ...event, originalStartTime },
		...(event.version === undefined ? {} : { version: event.version }),
	};
}
