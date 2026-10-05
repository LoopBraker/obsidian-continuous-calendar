import { afterEach, describe, expect, it } from 'vitest';
import { App } from 'obsidian';
import {
	IndexService,
	registerCalendarEventSource,
	unregisterCalendarEventSource,
	type CalendarDisplayEvent,
} from '../../../src/services/IndexService';
import type { CalendarEvent } from '../../../src/services/sync/model/CalendarEvent';
import {
	getCalendarEventEditKey,
	getCalendarEventNoteActionScopes,
	getCalendarEventNoteRowActions,
} from '../../../src/DayDetailView';

const app = new App();
const date = '2026-10-04';

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
	return {
		uid: 'event-uid',
		title: 'Planning',
		start: date,
		end: '2026-10-05',
		allDay: true,
		timezone: 'UTC',
		location: '',
		description: '',
		...overrides,
	};
}

function makeDisplayEvent(overrides: Partial<CalendarDisplayEvent> = {}): CalendarDisplayEvent {
	return {
		key: 'display-key',
		event: makeEvent(),
		...overrides,
	};
}

afterEach(() => {
	unregisterCalendarEventSource(app);
});

describe('calendar event projection', () => {
	it('hides deleted events and series while retaining a cancelled instance tombstone', () => {
		registerCalendarEventSource(app, () => [
			makeDisplayEvent({ key: 'deleted-event', scope: 'occurrence', status: 'remote_deleted' }),
			makeDisplayEvent({ key: 'deleted-series', scope: 'series', status: 'remote_deleted' }),
			makeDisplayEvent({ key: 'cancelled-slot', scope: 'occurrence', masterRemoteId: 'series',
				status: 'remote_deleted', cancelled: true, providerResolved: true }),
		]);
		const index = new IndexService(app);
		expect(index.getCalendarEventsForDate(date).map(row => row.key)).toEqual(['cancelled-slot']);
		index.dispose();
	});

	it('keeps distinct provider rows and does not locally expand provider-resolved recurrence', () => {
		const rows = [
			makeDisplayEvent({
				key: 'series-row',
				scope: 'series',
				providerWriteKey: 'state-master-key',
				providerResolved: true,
				event: makeEvent({ recurrence: { frequency: 'daily', interval: 1, count: 3 } }),
			}),
			makeDisplayEvent({
				key: 'occurrence-row',
				scope: 'occurrence',
				providerWriteKey: 'state-occurrence-key',
				providerResolved: true,
			}),
		];
		registerCalendarEventSource(app, () => rows);
		const index = new IndexService(app);

		expect(index.getCalendarEventsForDate(date).map(row => row.key)).toEqual(['series-row', 'occurrence-row']);
		expect(index.getCalendarEventsForDate('2026-10-05')).toEqual([]);
		index.dispose();
	});

	it('selects date-specific note paths and leaves multiple targets unselected', () => {
		const row = makeDisplayEvent({
			key: 'occurrence-row',
			scope: 'occurrence',
			providerWriteKey: 'occurrence-key',
			providerResolved: true,
			masterRemoteId: 'remote-series',
			event: makeEvent({ end: '2026-10-07' }),
			notePaths: ['Events/series.md'],
			notePathsByDate: {
				'2026-10-05': ['Events/day-2.md'],
			},
		});
		registerCalendarEventSource(app, () => [row]);
		const index = new IndexService(app);

		expect(index.getCalendarEventsForDate('2026-10-04')[0].notePath).toBe('Events/series.md');
		expect(getCalendarEventNoteRowActions(index.getCalendarEventsForDate('2026-10-04')[0], '2026-10-04', true))
			.toEqual({
				notePaths: ['Events/series.md'],
				titleAction: 'open',
				showCreateNote: false,
				createNoteScopes: ['series', 'occurrence', 'occurrence-day'],
			});
		expect(index.getCalendarEventsForDate('2026-10-05')[0].notePath).toBeUndefined();
		expect(index.getCalendarEventsForDate('2026-10-05')[0].notePaths).toEqual(['Events/series.md', 'Events/day-2.md']);
		expect(getCalendarEventNoteRowActions(index.getCalendarEventsForDate('2026-10-05')[0], '2026-10-05', true))
			.toEqual({
				notePaths: ['Events/series.md', 'Events/day-2.md'],
				titleAction: 'choose',
				showCreateNote: false,
				createNoteScopes: ['series', 'occurrence', 'occurrence-day'],
			});
		expect(index.getCalendarEventsForDate('2026-10-06')[0].notePaths).toEqual(['Events/series.md']);
		expect(getCalendarEventNoteRowActions(index.getCalendarEventsForDate('2026-10-06')[0], '2026-10-06', true).titleAction)
			.toBe('open');
		index.dispose();
	});

	it('keeps note creation available for an unlinked one-off and hides it after linking', () => {
		const oneOff = makeDisplayEvent({
			scope: 'occurrence',
			providerWriteKey: 'one-off-key',
			providerResolved: true,
		});

		expect(getCalendarEventNoteRowActions(oneOff, date, true)).toEqual({
			notePaths: [],
			titleAction: 'none',
			showCreateNote: true,
			createNoteScopes: ['occurrence'],
		});
		expect(getCalendarEventNoteRowActions({ ...oneOff, notePaths: ['Events/planning.md'] }, date, true)).toEqual({
			notePaths: ['Events/planning.md'],
			titleAction: 'open',
			showCreateNote: false,
			createNoteScopes: ['occurrence'],
		});
	});

	it('suppresses every source-registered owned path from notes, ranges, recurrence, and symbols', () => {
		const ownedPaths = [
			'Events/orphan.md',
			'Events/invalid.md',
			'Events/duplicate-a.md',
			'Events/duplicate-b.md',
		];
		registerCalendarEventSource(app, () => [], () => ownedPaths);
		const index = new IndexService(app);
		index.setSettings({ taskSettings: {} } as Parameters<IndexService['setSettings']>[0]);

		for (const path of ownedPaths) {
			index.notesByDate.set(date, [
				...(index.notesByDate.get(date) ?? []),
				{ path, name: path, tags: ['#event'], symbol: 'x' },
			]);
			index.rangesByDate.set(date, [
				...(index.rangesByDate.get(date) ?? []),
				{ path, name: path, dateStart: date, dateEnd: date, tags: [] },
			]);
		}
		index.notesByDate.set(date, [
			...(index.notesByDate.get(date) ?? []),
			{ path: 'Notes/ordinary.md', name: 'ordinary', tags: [], symbol: 'o' },
		]);
		index.rangesByDate.set(date, [
			...(index.rangesByDate.get(date) ?? []),
			{ path: 'Notes/range.md', name: 'range', dateStart: date, dateEnd: date, tags: [] },
		]);
		index.recurringEventsCache.set(date, [
			{ path: 'Events/invalid.md', name: 'invalid recurring', tags: [], symbol: 'r' },
			{ path: 'Notes/ordinary-recurring.md', name: 'ordinary recurring', tags: [], symbol: 'c' },
		]);
		index.recurringEventsCache.set('2026-10-05', [
			{ path: 'Events/orphan.md', name: 'orphan recurring only', tags: ['#event'], symbol: 'x' },
		]);

		expect(index.getCalendarEventOwnedPaths()).toEqual(ownedPaths);
		expect(index.getNotesForDate(date).map(note => note.path)).toEqual(['Notes/ordinary.md', 'Notes/ordinary-recurring.md']);
		expect(index.getRangesForDate(date).map(range => range.path)).toEqual(['Notes/range.md']);
		expect(index.getDisplaySymbols(date, {}, 'gray').map(symbol => symbol.symbol)).toEqual(['o', 'c']);
		expect(index.getDateStatus(date).tags).toEqual([]);
		expect(index.getDateStatus('2026-10-05').hasProperty).toBe(false);
		index.dispose();
	});

	it('offers exact note scopes and edit keys only for rows with safe provider identity', () => {
		const multiDayOccurrence = makeDisplayEvent({
			scope: 'occurrence',
			providerWriteKey: 'occurrence-state-key',
			providerResolved: true,
			event: makeEvent({ end: '2026-10-06' }),
		});
		expect(getCalendarEventNoteActionScopes(multiDayOccurrence, '2026-10-05')).toEqual(['occurrence', 'occurrence-day']);
		expect(getCalendarEventNoteActionScopes({
			...multiDayOccurrence,
			event: makeEvent(),
		}, date)).toEqual(['occurrence']);
		expect(getCalendarEventNoteActionScopes({ ...multiDayOccurrence, masterRemoteId: 'remote-master' }, date))
			.toEqual(['series', 'occurrence', 'occurrence-day']);
		expect(getCalendarEventNoteActionScopes({
			...multiDayOccurrence,
			masterRemoteId: 'remote-master',
			stale: true,
		}, date)).toEqual(['series']);
		expect(getCalendarEventNoteActionScopes({
			...multiDayOccurrence,
			masterRemoteId: 'remote-master',
			unresolved: true,
		}, date)).toEqual(['series']);
		expect(getCalendarEventNoteActionScopes({ ...multiDayOccurrence, providerResolved: false }, date)).toEqual([]);
		expect(getCalendarEventNoteActionScopes(makeDisplayEvent({
			scope: 'series',
			providerWriteKey: 'master-state-key',
			providerResolved: false,
		}), date)).toEqual(['series']);

		const generatedApproximation = makeDisplayEvent({
			key: 'series-display-key',
			providerWriteKey: 'master-state-key',
			providerResolved: false,
		});
		expect(getCalendarEventEditKey(generatedApproximation)).toBeUndefined();
		expect(getCalendarEventEditKey({ ...generatedApproximation, providerResolved: true, unresolved: true })).toBeUndefined();
		expect(getCalendarEventEditKey({
			...generatedApproximation,
			key: 'occurrence-display-key',
			providerWriteKey: 'occurrence-state-key',
			providerResolved: true,
		})).toBe('occurrence-state-key');
	});
});
