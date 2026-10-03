/**
 * Provider-neutral values used by the synchronization domain.
 *
 * This module deliberately has no Obsidian, provider SDK, or runtime-specific
 * imports. Provider transport/session contracts belong to the provider layer.
 */

export const CALENDAR_EVENT_FIELDS = [
	'uid',
	'title',
	'start',
	'end',
	'allDay',
	'timezone',
	'location',
	'description',
	'recurrence',
] as const;

export type CalendarEventField = (typeof CALENDAR_EVENT_FIELDS)[number];

/** The deliberately small recurrence subset supported by the sync model. */
export type EventRecurrenceFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface EventRecurrence {
	readonly frequency: EventRecurrenceFrequency;
	readonly interval: number;
	/** ISO weekdays: Monday is 1 and Sunday is 7. Weekly rules only. */
	readonly weekdays?: readonly number[];
	readonly count?: number;
	/** Inclusive civil date in YYYY-MM-DD form. */
	readonly until?: string;
}

/**
 * The canonical event representation.
 *
 * Timed `start`/`end` values are RFC 3339 timestamps with an explicit offset.
 * All-day values are `YYYY-MM-DD`, and `end` is exclusive. Optional text
 * fields are represented as empty strings after normalization.
 */
export interface CalendarEvent {
	readonly uid: string;
	readonly title: string;
	readonly start: string;
	readonly end: string;
	readonly allDay: boolean;
	readonly timezone: string;
	readonly location: string;
	readonly description: string;
	readonly recurrence?: EventRecurrence;
}

/**
 * Untrusted event-shaped data accepted by the validator. Both canonical
 * property names and event-note frontmatter names are accepted at the input
 * boundary; only canonical camel-case fields leave the boundary.
 */
export interface CalendarEventInput {
	readonly uid?: unknown;
	readonly title?: unknown;
	readonly start?: unknown;
	readonly end?: unknown;
	readonly allDay?: unknown;
	readonly all_day?: unknown;
	readonly timezone?: unknown;
	readonly location?: unknown;
	readonly description?: unknown;
	readonly calendar_uid?: unknown;
	readonly calendar_title?: unknown;
	readonly calendar_start?: unknown;
	readonly calendar_end?: unknown;
	readonly calendar_all_day?: unknown;
	readonly calendar_timezone?: unknown;
	readonly calendar_location?: unknown;
	readonly calendar_description?: unknown;
	readonly recurrence?: unknown;
	readonly recurrenceRule?: unknown;
	readonly calendar_recurrence?: unknown;
	readonly [key: string]: unknown;
}

/** A stable association to a provider object, without provider wire data. */
export interface ProviderReference<ProviderId extends string = string> {
	readonly providerId: ProviderId;
	readonly accountId: string;
	readonly calendarId: string;
	readonly remoteEventId: string;
	readonly version?: string;
}

/** A local event's visible provider association. */
export interface CalendarEventAssociation<ProviderId extends string = string> {
	readonly calendarUid: string;
	readonly reference: ProviderReference<ProviderId>;
	readonly status: SyncStatus;
}

/** Compatibility alias for callers using the longer name. */
export type CalendarEventProviderReference<ProviderId extends string = string> =
	ProviderReference<ProviderId>;

/** Status values allowed in the event-note/read-model projection. */
export type SyncStatus =
	| 'pending'
	| 'synced'
	| 'conflict'
	| 'remote_deleted'
	| 'unsupported'
	| 'error';

/** A last-synchronized canonical event and its deterministic content hash. */
export interface CalendarEventSnapshot {
	readonly event: CalendarEvent;
	readonly hash: string;
	readonly capturedAt?: string;
}

/**
 * Canonical information returned by an adapter. Provider transport/change-page
 * types are intentionally not declared here; this is only the model portion.
 */
export interface CanonicalRemoteEvent<ProviderId extends string = string> {
	readonly event: CalendarEvent;
	readonly reference: ProviderReference<ProviderId>;
	readonly version?: string;
	readonly remoteUpdatedAt?: string;
}

/** Alias emphasizing that this is a canonical snapshot, not wire payload. */
export type RemoteCalendarEventSnapshot<ProviderId extends string = string> =
	CanonicalRemoteEvent<ProviderId>;

export type CalendarEventValue = CalendarEvent[CalendarEventField];

export interface CalendarEventFieldChange {
	readonly field: CalendarEventField;
	readonly before: CalendarEventValue;
	readonly after: CalendarEventValue;
}

/** A deterministic field-level diff between two canonical event values. */
export interface CalendarEventDiff {
	readonly changes: readonly CalendarEventFieldChange[];
	readonly changedFields: readonly CalendarEventField[];
	readonly hasChanges: boolean;
}

export interface CalendarEventConflict {
	readonly field: CalendarEventField;
	readonly base: CalendarEventValue;
	readonly local: CalendarEventValue;
	readonly remote: CalendarEventValue;
	readonly reason?: 'divergent-edit' | 'immutable-identity' | 'invalid-merged-event';
	readonly validationErrors?: readonly CalendarEventMergeValidationError[];
}

/** Validation details attached when a field-wise merge violates an invariant. */
export interface CalendarEventMergeValidationError {
	readonly code: string;
	readonly field: string;
	readonly message: string;
}

export type CalendarEventMergeStatus = 'merged' | 'conflict';

export interface CalendarEventMergeResult {
	readonly status: CalendarEventMergeStatus;
	readonly event?: CalendarEvent;
	/** Alias retained for consumers that name the successful value `mergedEvent`. */
	readonly mergedEvent?: CalendarEvent;
	readonly conflicts: readonly CalendarEventConflict[];
}

export interface ValidationSuccess<T> {
	readonly ok: true;
	readonly valid: true;
	readonly success: true;
	readonly value: T;
	readonly errors: readonly [];
}

export interface ValidationFailure<E> {
	readonly ok: false;
	readonly valid: false;
	readonly success: false;
	readonly errors: readonly E[];
}

export type ValidationResult<T, E> = ValidationSuccess<T> | ValidationFailure<E>;
