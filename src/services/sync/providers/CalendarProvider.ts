import type { CalendarEvent } from '../model/CalendarEvent';

/** Providers implemented by the synchronization milestone. */
export type ProviderId = 'google' | 'microsoft';

/**
 * An authenticated provider session. The session is intentionally opaque to
 * the sync engine; adapters may attach provider-specific in-memory details.
 * Access tokens are runtime values and must never be serialized to plugin
 * data, frontmatter, logs, or error messages.
 */
export interface ProviderSession {
	readonly providerId: ProviderId;
	readonly accountId: string;
	readonly expiresAt?: string;
	readonly accessToken?: string;
	readonly [key: string]: unknown;
}

/** A provider calendar discovered for the active account. */
export interface RemoteCalendar {
	readonly providerId: ProviderId;
	readonly accountId: string;
	readonly calendarId: string;
	readonly name: string;
	readonly writable: boolean;
	readonly timezone?: string;
}

/** A bounded civil-time window used for initial and incremental pulls. */
export interface SyncWindow {
	readonly from: string;
	readonly to: string;
}

/** Provider date/date-time object preserved without canonical normalization. */
export interface ProviderDateTimeValue {
	readonly date?: string;
	readonly dateTime?: string;
	readonly timeZone?: string;
}

/**
 * Cursors are opaque to the engine. This alias remains structurally a string
 * so adapters can return a cursor received from their SDK without exposing
 * its shape to callers.
 */
export type OpaqueCursor = string;
export type ProviderCursor = OpaqueCursor;

export interface PullChangesRequest {
	readonly session: ProviderSession;
	readonly calendarId: string;
	readonly cursor?: OpaqueCursor;
	readonly window: SyncWindow;
	readonly signal?: AbortSignal;
}

/**
 * An event in the canonical model plus the provider's immutable identity.
 *
 * `calendarUid` is present only when the provider carried this plugin's
 * private calendar UID metadata. A provider event's canonical `event.uid`
 * value may be a placeholder or provider-derived value; consumers must not
 * treat it as evidence that private plugin metadata was present.
 */
export interface RemoteCalendarEvent {
	readonly providerId: ProviderId;
	readonly calendarId: string;
	readonly remoteId: string;
	readonly event: CalendarEvent;
	readonly calendarUid?: string;
	readonly version?: string;
	readonly remoteUpdatedAt?: string;
	readonly recurrenceStatus: 'none' | 'supported' | 'unsupported';
	/** Exact Google recurrence lines retained for unsupported rules. */
	readonly recurrenceRaw?: readonly string[];
	/** Present on a Google exception instance. */
	readonly recurrenceMasterId?: string;
	/** Exact recurrence-slot identity returned for a provider occurrence. */
	readonly originalStartTime?: ProviderDateTimeValue;
	/** Exact provider actual range, kept separately from canonical event values. */
	readonly actualStart?: ProviderDateTimeValue;
	readonly actualEnd?: ProviderDateTimeValue;
	readonly recurrenceHasExceptions?: boolean;
	/** Compatibility field for consumers persisted before typed recurrence support. */
	readonly recurrence: 'none' | 'unsupported';
}

interface RemoteOccurrenceIdentity {
	readonly providerId: ProviderId;
	readonly calendarId: string;
	readonly masterRemoteId: string;
	readonly instanceRemoteId: string;
	readonly originalStartTime: ProviderDateTimeValue;
}

/** A recurrence occurrence, with cancellations represented without invented event fields. */
export type RemoteOccurrence =
	| (RemoteOccurrenceIdentity & {
		readonly status: 'active';
		readonly event: RemoteCalendarEvent;
		readonly actualStart: ProviderDateTimeValue;
		readonly actualEnd: ProviderDateTimeValue;
		readonly version?: string;
	})
	| (RemoteOccurrenceIdentity & {
		readonly status: 'cancelled';
		readonly actualStart?: ProviderDateTimeValue;
		readonly actualEnd?: ProviderDateTimeValue;
		readonly version?: string;
	});

export type CancelledRemoteOccurrence = Extract<RemoteOccurrence, { readonly status: 'cancelled' }>;

export interface RemoteEventTombstone {
	readonly providerId: ProviderId;
	readonly calendarId: string;
	readonly remoteId: string;
	readonly version?: string;
	/** Present with originalStartTime only for a cancelled recurring exception. */
	readonly recurrenceMasterId?: string;
	readonly originalStartTime?: ProviderDateTimeValue;
	readonly actualStart?: ProviderDateTimeValue;
	readonly actualEnd?: ProviderDateTimeValue;
}

export type RemoteEventLookupResult =
	| { readonly status: 'active'; readonly event: RemoteCalendarEvent }
	| { readonly status: 'cancelled'; readonly tombstone: RemoteEventTombstone }
	| { readonly status: 'not-found'; readonly providerId: ProviderId; readonly calendarId: string; readonly remoteId: string };

export interface ListInstancesRequest {
	readonly session: ProviderSession;
	readonly calendarId: string;
	readonly masterRemoteId: string;
	/** Verified current recurring master timezone for sparse originalStartTime values. */
	readonly masterTimeZone?: string;
	readonly window: SyncWindow;
	/** Original slots that must be returned even when outside the current horizon. */
	readonly pinnedOriginalStarts?: readonly ProviderDateTimeValue[];
	readonly signal?: AbortSignal;
}

export interface UpdateOccurrenceRequest {
	readonly session: ProviderSession;
	readonly calendarId: string;
	readonly masterRemoteId: string;
	/** Verified current recurring master timezone for sparse originalStartTime values. */
	readonly masterTimeZone?: string;
	readonly instanceRemoteId: string;
	readonly originalStartTime: ProviderDateTimeValue;
	readonly event: CalendarEvent;
	readonly expectedVersion?: string;
	readonly signal?: AbortSignal;
}

export type RemoteChange =
	| { readonly type: 'upsert'; readonly value: RemoteCalendarEvent }
	| { readonly type: 'occurrence-cancelled'; readonly occurrence: CancelledRemoteOccurrence }
	| {
		readonly type: 'delete';
		readonly providerId: ProviderId;
		readonly calendarId: string;
		readonly remoteId: string;
	}
	| {
		readonly type: 'series-unsupported';
		readonly providerId: ProviderId;
		readonly calendarId: string;
		readonly masterRemoteId: string;
	};

export interface ChangePage {
	readonly changes: RemoteChange[];
	readonly nextCursor?: OpaqueCursor;
	readonly hasMore: boolean;
}

/** A minimal injected request boundary for real adapters and deterministic fakes. */
export interface ProviderHttpRequest {
	readonly method: string;
	readonly url: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: string;
	readonly signal?: AbortSignal;
}

export interface ProviderHttpResponse {
	readonly status: number;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: unknown;
}

export interface ProviderHttpTransport {
	request(request: ProviderHttpRequest): Promise<ProviderHttpResponse>;
}

/** The clock is injectable so retry, cursor, and update-time tests are stable. */
export interface ProviderClock {
	now(): number;
}

export interface ProviderDependencies {
	readonly http?: ProviderHttpTransport;
	readonly clock?: ProviderClock;
}

export interface CalendarProvider {
	readonly id: ProviderId;
	listCalendars(session: ProviderSession, signal?: AbortSignal): Promise<RemoteCalendar[]>;
	pullChanges(request: PullChangesRequest): Promise<ChangePage>;
	/** Fetch a complete, paginated occurrence generation for one recurring master. */
	listInstances?(request: ListInstancesRequest): Promise<RemoteOccurrence[]>;
	/** Fetch the latest provider state for an event/occurrence ID. */
	fetchEvent?(
		session: ProviderSession,
		calendarId: string,
		remoteId: string,
		signal?: AbortSignal,
	): Promise<RemoteEventLookupResult>;
	/** Update only occurrence-owned fields after verifying master and original slot identity. */
	updateOccurrence?(request: UpdateOccurrenceRequest): Promise<Extract<RemoteOccurrence, { readonly status: 'active' }>>;
	/** Optional requestId is a provider-supported stable identity for safe create retries. */
	createEvent(
		session: ProviderSession,
		calendarId: string,
		event: CalendarEvent,
		signal?: AbortSignal,
		requestId?: string,
	): Promise<RemoteCalendarEvent>;
	/**
	 * A provider-originated write attaches the canonical event UID as private
	 * plugin metadata. This is the first permitted bidirectional write for an
	 * imported event and establishes its immutable `calendarUid` association.
	 */
	updateEvent(
		session: ProviderSession,
		calendarId: string,
		remoteId: string,
		event: CalendarEvent,
		expectedVersion?: string,
		signal?: AbortSignal,
	): Promise<RemoteCalendarEvent>;
	deleteEvent(
		session: ProviderSession,
		calendarId: string,
		remoteId: string,
		expectedVersion?: string,
		signal?: AbortSignal,
	): Promise<void>;
}

/** Optional constructor boundary shared by real adapters and the fake. */
export interface CalendarProviderDependencies extends ProviderDependencies {
	readonly providerId?: ProviderId;
}
