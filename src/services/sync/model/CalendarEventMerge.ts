import {
	CALENDAR_EVENT_FIELDS,
	type CalendarEvent,
	type CalendarEventConflict,
	type CalendarEventDiff,
	type CalendarEventField,
	type CalendarEventFieldChange,
	type CalendarEventMergeValidationError,
	type CalendarEventMergeResult,
	type CalendarEventSnapshot,
	type CalendarEventValue,
} from './CalendarEvent';
import {
	CalendarEventValidationException,
	validateCalendarEvent,
	normalizeCalendarEvent,
} from './CalendarEventValidation';

function readField(event: CalendarEvent, field: CalendarEventField): CalendarEventValue {
	return event[field];
}

function isCanonicalFieldShape(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.uid === 'string' &&
		typeof record.title === 'string' &&
		typeof record.start === 'string' &&
		typeof record.end === 'string' &&
		typeof record.allDay === 'boolean' &&
		typeof record.timezone === 'string' &&
		(record.location === undefined || typeof record.location === 'string') &&
		(record.description === undefined || typeof record.description === 'string')
	);
}

/**
 * Normalize ordinary inputs, while retaining field-shaped values long enough
 * to validate the merged candidate. This lets the merge report an invariant
 * conflict for a mixed all-day/timed result rather than throwing before that
 * candidate can be inspected.
 */
function prepareMergeEvent(input: unknown): CalendarEvent {
	const result = validateCalendarEvent(input);
	if (result.ok) return result.value;
	if (!isCanonicalFieldShape(input)) throw new CalendarEventValidationException(result.errors);

	const record = input;
	return {
		uid: record.uid as string,
		title: record.title as string,
		start: record.start as string,
		end: record.end as string,
		allDay: record.allDay as boolean,
		timezone: record.timezone as string,
		location: (record.location as string | undefined) ?? '',
		description: (record.description as string | undefined) ?? '',
	};
}

/** Return a stable diff in canonical field order. */
export function diffCalendarEvents(beforeInput: unknown, afterInput: unknown): CalendarEventDiff {
	const before = normalizeCalendarEvent(beforeInput);
	const after = normalizeCalendarEvent(afterInput);
	const changes: CalendarEventFieldChange[] = [];

	for (const field of CALENDAR_EVENT_FIELDS) {
		const beforeValue = readField(before, field);
		const afterValue = readField(after, field);
		if (beforeValue !== afterValue) {
			changes.push({ field, before: beforeValue, after: afterValue });
		}
	}

	return {
		changes,
		changedFields: changes.map(change => change.field),
		hasChanges: changes.length > 0,
	};
}

/** Naming aliases for field-level diff consumers. */
export const diffCalendarEventFields = diffCalendarEvents;
export const diffCalendarEvent = diffCalendarEvents;

function isChanged(value: CalendarEventValue, base: CalendarEventValue): boolean {
	return value !== base;
}

function makeConflict(
	field: CalendarEventField,
	base: CalendarEvent,
	local: CalendarEvent,
	remote: CalendarEvent,
): CalendarEventConflict {
	return {
		field,
		base: readField(base, field),
		local: readField(local, field),
		remote: readField(remote, field),
	};
}

function isCalendarEventField(value: string): value is CalendarEventField {
	return (CALENDAR_EVENT_FIELDS as readonly string[]).includes(value);
}

function makeInvariantConflicts(
	errors: readonly {
		code: string;
		field: string;
		message: string;
	}[],
	base: CalendarEvent,
	local: CalendarEvent,
	remote: CalendarEvent,
): CalendarEventConflict[] {
	return errors.map(errorValue => {
		const field = isCalendarEventField(errorValue.field) ? errorValue.field : 'uid';
		const validationError: CalendarEventMergeValidationError = {
			code: errorValue.code,
			field: errorValue.field,
			message: errorValue.message,
		};
		return {
			field,
			base: readField(base, field),
			local: readField(local, field),
			remote: readField(remote, field),
			reason: 'invalid-merged-event' as const,
			validationErrors: [validationError],
		};
	});
}

/**
 * Merge local and remote changes relative to the last synchronized base.
 *
 * A field changed on one side is accepted; an identical change on both sides
 * is also accepted. Divergent changes to the same field are returned as
 * conflicts and never overwrite either candidate.
 */
export function mergeCalendarEvents(
	baseInput: unknown,
	localInput: unknown,
	remoteInput: unknown,
): CalendarEventMergeResult {
	const base = prepareMergeEvent(baseInput);
	const local = prepareMergeEvent(localInput);
	const remote = prepareMergeEvent(remoteInput);

	if (base.uid !== local.uid || base.uid !== remote.uid) {
		return {
			status: 'conflict',
			conflicts: [
				{
					field: 'uid',
					base: base.uid,
					local: local.uid,
					remote: remote.uid,
					reason: 'immutable-identity',
				},
			],
		};
	}

	const merged: CalendarEvent = { ...base };
	const conflicts: CalendarEventConflict[] = [];

	for (const field of CALENDAR_EVENT_FIELDS) {
		const baseValue = readField(base, field);
		const localValue = readField(local, field);
		const remoteValue = readField(remote, field);
		const localChanged = isChanged(localValue, baseValue);
		const remoteChanged = isChanged(remoteValue, baseValue);

		if (localChanged && remoteChanged && localValue !== remoteValue) {
			conflicts.push(makeConflict(field, base, local, remote));
			continue;
		}

		const value = localChanged ? localValue : remoteChanged ? remoteValue : baseValue;
		// The event is a freshly-created value, so this assignment cannot mutate
		// any caller-owned snapshot despite the public fields being readonly.
		(merged as Record<CalendarEventField, CalendarEventValue>)[field] = value;
	}

	if (conflicts.length > 0) return { status: 'conflict', conflicts };

	const candidate = validateCalendarEvent(merged);
	if (!candidate.ok) {
		return {
			status: 'conflict',
			conflicts: makeInvariantConflicts(candidate.errors, base, local, remote),
		};
	}

	return {
		status: 'merged',
		event: candidate.value,
		mergedEvent: candidate.value,
		conflicts: [],
	};
}

export function mergeCalendarEventSnapshots(
	base: CalendarEventSnapshot,
	local: CalendarEventSnapshot,
	remote: CalendarEventSnapshot,
): CalendarEventMergeResult {
	return mergeCalendarEvents(base.event, local.event, remote.event);
}

/** Naming aliases for three-way merge consumers. */
export const threeWayMergeCalendarEvents = mergeCalendarEvents;
export const mergeThreeWay = mergeCalendarEvents;
