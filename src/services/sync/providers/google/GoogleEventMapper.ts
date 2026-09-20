import type { CalendarEventValidationError } from '../../model';
import { normalizeCalendarEvent } from '../../model/CalendarEventValidation';
import type { RemoteCalendarEvent } from '../CalendarProvider';

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
}): GoogleEventPayload {
	const start: GoogleEventDateResource = event.allDay
		? { date: event.start }
		: { dateTime: event.start, timeZone: event.timezone };
	const end: GoogleEventDateResource = event.allDay
		? { date: event.end }
		: { dateTime: event.end, timeZone: event.timezone };

	return {
		summary: event.title,
		description: event.description,
		location: event.location,
		start,
		end,
		extendedProperties: {
			private: { [GOOGLE_CALENDAR_UID_KEY]: event.uid },
		},
	};
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
	let event;
	try {
		event = normalizeCalendarEvent(candidate);
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
		recurrence: resource.recurrence && resource.recurrence.length > 0 ? 'unsupported' : 'none',
	};
	if (calendarUid !== undefined) return { ...result, calendarUid };
	return result;
}
