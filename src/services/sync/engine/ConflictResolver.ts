import {
	mergeCalendarEventSnapshots,
	type CalendarEvent,
	type CalendarEventConflict,
	type CalendarEventSnapshot,
} from '../model';

export type ConflictChoice = 'local' | 'remote';

export interface SyncConflictCandidate {
	readonly base: CalendarEventSnapshot;
	readonly local: CalendarEventSnapshot;
	readonly remote: CalendarEventSnapshot;
	readonly conflicts: readonly CalendarEventConflict[];
}

export interface ConflictResolution {
	readonly status: 'merged' | 'conflict' | 'resolved';
	readonly event?: CalendarEvent;
	readonly conflicts: readonly CalendarEventConflict[];
}

/** Pure three-way conflict boundary used by SyncService and UI resolution. */
export class ConflictResolver {
	resolve(
		base: CalendarEventSnapshot,
		local: CalendarEventSnapshot,
		remote: CalendarEventSnapshot,
	): ConflictResolution {
		const result = mergeCalendarEventSnapshots(base, local, remote);
		return {
			status: result.status,
			event: result.event,
			conflicts: result.conflicts,
		};
	}

	/** Select one full candidate without mutating either input snapshot. */
	choose(
		candidate: SyncConflictCandidate,
		choice: ConflictChoice | CalendarEvent,
	): ConflictResolution {
		const event = typeof choice === 'string'
			? choice === 'local'
				? candidate.local.event
				: candidate.remote.event
			: choice;
		return { status: 'resolved', event, conflicts: [] };
	}
}

export function resolveCalendarEventConflict(
	base: CalendarEventSnapshot,
	local: CalendarEventSnapshot,
	remote: CalendarEventSnapshot,
): ConflictResolution {
	return new ConflictResolver().resolve(base, local, remote);
}

export const CalendarConflictResolver = ConflictResolver;
