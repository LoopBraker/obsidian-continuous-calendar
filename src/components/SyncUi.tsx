import * as React from 'react';
import type { CalendarEvent, SyncStatus } from '../services/sync/model';
import { sanitizeSyncError } from '../services/sync/state/redaction';

/** Provider-neutral actions supplied by the plugin/lifecycle integration. */
export interface SyncUiActions {
	readonly syncNow?: () => Promise<unknown> | unknown;
	readonly connect?: () => Promise<void> | void;
	readonly reconnect?: () => Promise<void> | void;
	readonly disconnect?: () => Promise<void> | void;
	readonly listCalendars?: () => Promise<readonly SyncCalendarOption[]> | readonly SyncCalendarOption[];
	readonly deleteSyncedEvent?: (localUid: string) => Promise<boolean>;
	readonly resolveConflict?: (key: string, choice: 'local' | 'remote') => Promise<unknown>;
	readonly openConflict?: (localUid: string) => void;
	readonly getConflicts?: () => Promise<readonly SyncUiConflict[]> | readonly SyncUiConflict[];
	readonly getStatus?: () => SyncUiStatus | undefined;
}

export interface SyncCalendarOption {
	readonly calendarId: string;
	readonly name: string;
	readonly writable?: boolean;
}

export interface SyncUiConflict {
	readonly key: string;
	readonly localUid: string;
	readonly local: CalendarEvent;
	readonly remote: CalendarEvent;
}

export interface SyncUiStatus {
	readonly status?: string;
	readonly lastError?: string;
	readonly conflictCount?: number;
}

export interface SyncEventActions {
	readonly create?: (dateKey: string) => void;
	readonly edit?: (localUid: string) => void;
	readonly delete?: (localUid: string) => Promise<boolean>;
	readonly resolveConflict?: (localUid: string) => void;
}

export const SYNC_STATUS_LABELS: Readonly<Record<SyncStatus, string>> = {
	pending: 'Pending',
	synced: 'Synced',
	conflict: 'Conflict',
	remote_deleted: 'Remote deleted',
	unsupported: 'Unsupported',
	error: 'Error',
};

export function syncStatusLabel(status: SyncStatus | undefined): string | undefined {
	return status === undefined ? undefined : SYNC_STATUS_LABELS[status] ?? status;
}

function zonedDateKey(value: string, timezone: string): string | undefined {
	const instant = new Date(value);
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
		return year && month && day ? `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}` : undefined;
	} catch (_error) {
		return undefined;
	}
}

/** True when a canonical event intersects a civil date in its event timezone. */
export function calendarEventIntersectsDate(event: CalendarEvent, dateKey: string): boolean {
	if (event.allDay) return event.start <= dateKey && dateKey < event.end;
	const start = zonedDateKey(event.start, event.timezone);
	const endInstant = new Date(event.end);
	if (!start || !Number.isFinite(endInstant.getTime())) return false;
	const end = zonedDateKey(new Date(endInstant.getTime() - 1).toISOString(), event.timezone);
	return end !== undefined && start <= dateKey && dateKey <= end;
}

export type CalendarEventTime = Pick<CalendarEvent, 'start' | 'end' | 'allDay' | 'timezone'>;

function parseAllDayDate(dateStr: string): Date | null {
	const parts = dateStr.split('-').map(Number);
	if (parts.length !== 3 || parts.some(n => Number.isNaN(n))) return null;
	const [year, month, day] = parts;
	return new Date(Date.UTC(year, month - 1, day));
}

function formatZonedTimestamp(value: string, timezone: string): string {
	const instant = new Date(value);
	if (!Number.isFinite(instant.getTime())) return value;
	try {
		return new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
			timeZoneName: 'short',
		}).format(instant);
	} catch (_error) {
		return value;
	}
}

/** Format canonical bounds in the event timezone without relying on the host timezone. */
export function formatCalendarEventTime(event: CalendarEventTime): string {
	if (event.allDay) {
		const startDate = parseAllDayDate(event.start);
		const endDate = parseAllDayDate(event.end);
		if (!startDate) return `${event.start} (All-day)`;

		const monthDayFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
		const fullDateFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });

		if (!endDate || endDate.getTime() <= startDate.getTime()) {
			return `${monthDayFormat.format(startDate)} (All-day)`;
		}

		// End is exclusive in canonical representation: inclusive end is endDate - 1 day
		const inclusiveEnd = new Date(endDate.getTime() - 86_400_000);
		if (inclusiveEnd.getTime() <= startDate.getTime()) {
			return `${monthDayFormat.format(startDate)} (All-day)`;
		}

		if (startDate.getUTCFullYear() !== inclusiveEnd.getUTCFullYear()) {
			return `${fullDateFormat.format(startDate)} – ${fullDateFormat.format(inclusiveEnd)} (All-day)`;
		}
		return `${monthDayFormat.format(startDate)} – ${monthDayFormat.format(inclusiveEnd)} (All-day)`;
	}

	const startInstant = new Date(event.start);
	const endInstant = new Date(event.end);
	if (!Number.isFinite(startInstant.getTime()) || !Number.isFinite(endInstant.getTime())) {
		return `${event.start} – ${event.end}`;
	}

	try {
		const startKey = zonedDateKey(event.start, event.timezone);
		const endKey = zonedDateKey(event.end, event.timezone);

		const timeFormat = new Intl.DateTimeFormat('en-US', {
			timeZone: event.timezone,
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		});

		const tzFormat = new Intl.DateTimeFormat('en-US', {
			timeZone: event.timezone,
			timeZoneName: 'short',
		});
		const tzParts = tzFormat.formatToParts(startInstant);
		const tzName = tzParts.find(p => p.type === 'timeZoneName')?.value ?? '';
		const tzSuffix = tzName ? ` ${tzName}` : '';

		if (startKey && startKey === endKey) {
			const dateFormat = new Intl.DateTimeFormat('en-US', {
				timeZone: event.timezone,
				month: 'short',
				day: 'numeric',
			});
			return `${dateFormat.format(startInstant)}, ${timeFormat.format(startInstant)} – ${timeFormat.format(endInstant)}${tzSuffix}`;
		}

		return `${formatZonedTimestamp(event.start, event.timezone)} – ${formatZonedTimestamp(event.end, event.timezone)}`;
	} catch (_error) {
		return `${event.start} – ${event.end}`;
	}
}

function pad(value: number): string {
	return String(value).padStart(2, '0');
}

function offsetMinutesAt(instantMs: number, timezone: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: timezone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(new Date(instantMs));
	const read = (type: string) => Number(parts.find(part => part.type === type)?.value);
	return Math.round((Date.UTC(read('year'), read('month') - 1, read('day'), read('hour'), read('minute'), read('second')) - instantMs) / 60_000);
}

/** Build an RFC 3339 wall time whose offset matches the selected IANA zone. */
export function zonedDraftTimestamp(dateKey: string, hour: number, timezone: string): string {
	const [year, month, day] = dateKey.split('-').map(Number);
	const wallClockUtc = Date.UTC(year, month - 1, day, hour, 0, 0);
	try {
		let offset = offsetMinutesAt(wallClockUtc, timezone);
		const instant = wallClockUtc - offset * 60_000;
		offset = offsetMinutesAt(instant, timezone);
		const sign = offset >= 0 ? '+' : '-';
		const absolute = Math.abs(offset);
		return `${dateKey}T${pad(hour)}:00:00${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
	} catch (_error) {
		return `${dateKey}T${pad(hour)}:00:00+00:00`;
	}
}

/** Keep provider/auth details out of notices and visible diagnostics. */
export function sanitizeSyncUiError(error: unknown): string {
	return sanitizeSyncError(error).message.slice(0, 240);
}

export function SyncStatusBadge({ status }: { readonly status?: SyncStatus }): React.ReactElement | null {
	if (!status) return null;
	return (
		<span
			className={`sync-status-badge sync-status-${status}`}
			role="status"
			aria-label={`Sync status: ${syncStatusLabel(status)}`}
		>
			{syncStatusLabel(status)}
		</span>
	);
}
