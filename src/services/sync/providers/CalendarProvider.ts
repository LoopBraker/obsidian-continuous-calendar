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
	/** Present on a Google exception instance; its master is guarded as unsupported. */
	readonly recurrenceMasterId?: string;
	readonly recurrenceHasExceptions?: boolean;
	/** Compatibility field for consumers persisted before typed recurrence support. */
	readonly recurrence: 'none' | 'unsupported';
}

export type RemoteChange =
	| { readonly type: 'upsert'; readonly value: RemoteCalendarEvent }
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
	createEvent(
		session: ProviderSession,
		calendarId: string,
		event: CalendarEvent,
		signal?: AbortSignal,
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
