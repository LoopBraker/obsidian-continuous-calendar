import { describe, expect, it } from 'vitest';

import {
	diffCalendarEventFields,
	mergeCalendarEvents,
	mergeCalendarEventSnapshots,
} from '../../../src/services/sync/model/CalendarEventMerge';
import { createCalendarEventSnapshot } from '../../../src/services/sync/model/CalendarEventHash';

const base = {
	uid: 'event-1',
	title: 'Project review',
	start: '2026-09-22T09:00:00-05:00',
	end: '2026-09-22T10:00:00-05:00',
	allDay: false,
	timezone: 'America/Bogota',
	location: 'Room 1',
	description: 'Discuss the release.',
};

describe('calendar event diffs and three-way merge', () => {
	it('reports field changes in canonical order', () => {
		const diff = diffCalendarEventFields(base, {
			...base,
			title: 'Architecture review',
			location: 'Room 2',
		});

		expect(diff.hasChanges).toBe(true);
		expect(diff.changedFields).toEqual(['title', 'location']);
		expect(diff.changes).toEqual([
			{ field: 'title', before: 'Project review', after: 'Architecture review' },
			{ field: 'location', before: 'Room 1', after: 'Room 2' },
		]);
	});

	it('merges disjoint local and remote edits', () => {
		const local = { ...base, title: 'Architecture review' };
		const remote = { ...base, description: 'Discuss the new release.' };
		const result = mergeCalendarEvents(base, local, remote);

		expect(result.status).toBe('merged');
		expect(result.conflicts).toEqual([]);
		expect(result.event).toEqual({
			...base,
			title: 'Architecture review',
			description: 'Discuss the new release.',
		});
		expect(result.mergedEvent).toBe(result.event);
	});

	it('accepts the same edit made on both sides', () => {
		const changed = { ...base, timezone: 'America/New_York' };
		const result = mergeCalendarEvents(base, changed, { ...changed });

		expect(result.status).toBe('merged');
		expect(result.event).toEqual(changed);
	});

	it('returns a conflict for divergent edits to the same field', () => {
		const local = { ...base, title: 'Architecture review' };
		const remote = { ...base, title: 'Release review' };
		const result = mergeCalendarEvents(base, local, remote);

		expect(result.status).toBe('conflict');
		expect(result.event).toBeUndefined();
		expect(result.conflicts).toEqual([
			{
				field: 'title',
				base: 'Project review',
				local: 'Architecture review',
				remote: 'Release review',
			},
		]);
	});

	it('treats UID changes as immutable-identity conflicts', () => {
		const result = mergeCalendarEvents(base, { ...base, uid: 'event-2' }, base);

		expect(result.status).toBe('conflict');
		expect(result.conflicts).toEqual([
			expect.objectContaining({
				field: 'uid',
				reason: 'immutable-identity',
				base: 'event-1',
				local: 'event-2',
				remote: 'event-1',
			}),
		]);
	});

	it('does not return an invalid merged event for cross-field all-day conflicts', () => {
		const result = mergeCalendarEvents(
			base,
			{ ...base, allDay: true },
			{ ...base, end: '2026-09-22T11:00:00-05:00' },
		);

		expect(result.status).toBe('conflict');
		expect(result.event).toBeUndefined();
		expect(result.conflicts.length).toBeGreaterThan(0);
		expect(result.conflicts.every(conflict => conflict.reason === 'invalid-merged-event')).toBe(true);
		expect(result.conflicts.flatMap(conflict => conflict.validationErrors ?? [])).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ code: 'invalid-date' }),
		]),
	);
	});

	it('merges snapshots using their canonical event values', () => {
		const result = mergeCalendarEventSnapshots(
			createCalendarEventSnapshot(base),
			createCalendarEventSnapshot({ ...base, start: '2026-09-22T09:30:00-05:00' }),
			createCalendarEventSnapshot({ ...base, location: 'Room 2' }),
		);

		expect(result.status).toBe('merged');
		expect(result.event).toMatchObject({
			start: '2026-09-22T09:30:00-05:00',
			location: 'Room 2',
		});
	});
});
