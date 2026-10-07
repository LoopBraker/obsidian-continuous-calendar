import { afterEach, describe, expect, it } from 'vitest';
import { App } from 'obsidian';
import {
	IndexService,
	notifyCalendarEventIndexChanged,
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

function makeConcreteEvent(
	key: string,
	eventOverrides: Partial<CalendarEvent> = {},
	rowOverrides: Partial<CalendarDisplayEvent> = {},
): CalendarDisplayEvent {
	return makeDisplayEvent({
		key,
		scope: 'occurrence',
		providerWriteKey: `google:${key}`,
		providerResolved: true,
		event: makeEvent(eventOverrides),
		...rowOverrides,
	});
}

function configureDisplaySymbols(index: IndexService): void {
	index.setSettings({ taskSettings: {} } as Parameters<IndexService['setSettings']>[0]);
}

afterEach(() => {
	unregisterCalendarEventSource(app);
});

describe('calendar event projection', () => {
	it('projects all-day multi-day events as exclusive-end range bars and keeps the detail ranges local', () => {
		registerCalendarEventSource(app, () => [makeConcreteEvent('multi-day', { end: '2026-10-07' })]);
		const index = new IndexService(app);
		index.allRanges = [{ path: 'Notes/local-range.md', name: 'Local range', dateStart: date,
			dateEnd: '2026-10-06', tags: [] }];
		index.assignRangeSlots();

		const bars = index.getCalendarBarRangesForDate('2026-10-05');
		const googleBar = bars.find(range => range.name === 'Planning');
		expect(googleBar).toMatchObject({ dateStart: date, dateEnd: '2026-10-06' });
		expect(index.getCalendarBarRangesForDate('2026-10-07')).toEqual([]);
		expect(index.getRangesForDate('2026-10-05').map(range => range.path)).toEqual(['Notes/local-range.md']);
		expect(bars).toHaveLength(2);
		const slots = index.getRangeSlots('2026-10-05');
		expect(slots.get('Notes/local-range.md')).toBeDefined();
		const googlePath = googleBar?.path ?? '';
		expect(slots.get(googlePath)).toBeDefined();
		expect(slots.get('Notes/local-range.md')).not.toBe(slots.get(googlePath));
		index.dispose();
	});

	it('uses timezone civil bounds for timed events that end at midnight', () => {
		registerCalendarEventSource(app, () => [makeConcreteEvent('timed-midnight', {
			start: '2026-10-04T23:30:00-04:00',
			end: '2026-10-06T00:00:00-04:00',
			allDay: false,
			timezone: 'America/New_York',
		})]);
		const index = new IndexService(app);

		expect(index.getCalendarBarRangesForDate('2026-10-04').map(range => [range.dateStart, range.dateEnd]))
			.toEqual([[date, '2026-10-05']]);
		expect(index.getCalendarBarRangesForDate('2026-10-06')).toEqual([]);
		index.dispose();
	});

	it('keeps single-day midnight events as dots and suppresses duplicate dots for bars', () => {
		registerCalendarEventSource(app, () => [
			makeConcreteEvent('multi-day', { end: '2026-10-06' }),
			makeConcreteEvent('single-day', {
				start: '2026-10-04T23:00:00-04:00',
				end: '2026-10-05T00:00:00-04:00',
				allDay: false,
				timezone: 'America/New_York',
			}),
		]);
		const index = new IndexService(app);
		configureDisplaySymbols(index);

		expect(index.getCalendarBarRangesForDate(date).map(range => range.name)).toEqual(['Planning']);
		expect(index.getDisplaySymbols(date, {}, 'gray').map(symbol => symbol.color)).toEqual(['gray']);
		expect(index.getCalendarEventsForDate(date).map(row => row.key)).toEqual(['multi-day', 'single-day']);
		index.dispose();
	});

	it('uses stable occurrence keys and refreshes bars while excluding stale and unresolved rows', () => {
		let rows: CalendarDisplayEvent[] = [
			makeConcreteEvent('occurrence-a', { end: '2026-10-06' }, {
				providerWriteKey: 'google-occurrence-a',
				originalStartTime: { dateTime: '2026-10-04T09:00:00', timeZone: 'UTC' },
			}),
			makeConcreteEvent('stale', { end: '2026-10-06' }, { stale: true }),
			makeConcreteEvent('unresolved', { end: '2026-10-06' }, { unresolved: true }),
			makeConcreteEvent('cancelled', { end: '2026-10-06' }, { cancelled: true }),
			makeConcreteEvent('deleted', { end: '2026-10-06' }, { status: 'remote_deleted' }),
			makeConcreteEvent('series', { end: '2026-10-06', recurrence: { frequency: 'daily', interval: 1 } },
				{ scope: 'series' }),
		];
		registerCalendarEventSource(app, () => rows);
		const index = new IndexService(app);
		configureDisplaySymbols(index);
		const firstPath = index.getCalendarBarRangesForDate(date)[0]?.path;

		expect(index.getCalendarBarRangesForDate(date)).toHaveLength(1);
		expect(firstPath).toContain(encodeURIComponent('google-occurrence-a'));
		expect(index.getDisplaySymbols(date, {}, 'gray')).toHaveLength(4);

		rows = [makeConcreteEvent('occurrence-a', { start: '2026-10-05', end: '2026-10-08' }, {
			providerWriteKey: 'google-occurrence-a',
			originalStartTime: { dateTime: '2026-10-04T09:00:00', timeZone: 'UTC' },
		})];
		notifyCalendarEventIndexChanged(app);
		expect(index.getCalendarBarRangesForDate('2026-10-04')).toEqual([]);
		expect(index.getCalendarBarRangesForDate('2026-10-05')[0]).toMatchObject({
			path: firstPath,
			dateStart: '2026-10-05',
			dateEnd: '2026-10-07',
		});
		expect(index.getDisplaySymbols('2026-10-05', {}, 'gray')).toEqual([]);
		index.dispose();
	});

	it('removes bars and symbol suppression when the refreshed projection is empty', () => {
		let rows: CalendarDisplayEvent[] = [makeConcreteEvent('removed', { end: '2026-10-06' })];
		registerCalendarEventSource(app, () => rows);
		const index = new IndexService(app);
		configureDisplaySymbols(index);

		expect(index.getCalendarBarRangesForDate(date)).toHaveLength(1);
		expect(index.getDisplaySymbols(date, {}, 'gray')).toEqual([]);

		rows = [];
		notifyCalendarEventIndexChanged(app);
		expect(index.getCalendarBarRangesForDate(date)).toEqual([]);
		expect(index.getCalendarEventsForDate(date)).toEqual([]);
		expect(index.getDisplaySymbols(date, {}, 'gray')).toEqual([]);

		rows = [makeConcreteEvent('removed', { end: '2026-10-05' })];
		notifyCalendarEventIndexChanged(app);
		expect(index.getCalendarBarRangesForDate(date)).toEqual([]);
		expect(index.getDisplaySymbols(date, {}, 'gray')).toEqual([{ symbol: undefined, color: 'gray' }]);
		index.dispose();
	});

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
