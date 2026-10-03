import { RRule } from 'rrule';
import type { CalendarEvent, EventRecurrence } from './CalendarEvent';
import { civilDateTimeAsUtc, civilDateTimeToInstant, civilDateKey, utcAsCivilDateTime, zonedDateTime } from '../util/timezone';

const FREQUENCIES: Readonly<Record<EventRecurrence['frequency'], number>> = {
	daily: RRule.DAILY,
	weekly: RRule.WEEKLY,
	monthly: RRule.MONTHLY,
	yearly: RRule.YEARLY,
};

const WEEKDAYS = [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA, RRule.SU];
const MAX_OCCURRENCES_FOR_DATE = 256;

function midnightUtc(dateKey: string): number | undefined {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return undefined;
	const [year, month, day] = dateKey.split('-').map(Number);
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	date.setUTCHours(0, 0, 0, 0);
	if (civilDateKey(utcAsCivilDateTime(date.getTime())) !== dateKey) return undefined;
	return date.getTime();
}

function recurrenceRule(event: CalendarEvent): RRule | undefined {
	const recurrence = event.recurrence;
	if (!recurrence) return undefined;
	const start = event.allDay
		? { ...utcAsCivilDateTime(midnightUtc(event.start) ?? NaN), hour: 0, minute: 0, second: 0, millisecond: 0 }
		: (() => {
			const zoned = zonedDateTime(event.start, event.timezone);
			return zoned ? { ...zoned, millisecond: 0 } : undefined;
		})();
	if (!start || Object.values(start).some(value => !Number.isFinite(value))) return undefined;
	const dtstart = new Date(civilDateTimeAsUtc(start));
	const until = recurrence.until ? midnightUtc(recurrence.until) : undefined;
	const options = {
		freq: FREQUENCIES[recurrence.frequency],
		interval: recurrence.interval,
		dtstart,
		...(recurrence.count === undefined ? {} : { count: recurrence.count }),
		...(until === undefined ? {} : { until: new Date(until + 86_399_999) }),
		...(recurrence.weekdays === undefined ? {} : { byweekday: recurrence.weekdays.map(day => WEEKDAYS[day - 1]) }),
	};
	return new RRule(options);
}

function expandAllDayOccurrence(event: CalendarEvent, startWall: number, duration: number): CalendarEvent {
	const start = civilDateKey(utcAsCivilDateTime(startWall));
	const end = civilDateKey(utcAsCivilDateTime(startWall + duration));
	return { ...event, start, end };
}

function expandTimedOccurrence(
	event: CalendarEvent,
	startWall: number,
	baseStartWall: number,
	baseEndWall: number,
): CalendarEvent | undefined {
	const wallStart = utcAsCivilDateTime(startWall);
	const start = civilDateTimeToInstant(wallStart, event.timezone);
	if (start === undefined) return undefined;
	const endWall = utcAsCivilDateTime(startWall + (baseEndWall - baseStartWall));
	const end = civilDateTimeToInstant(endWall, event.timezone, 'forward');
	if (end === undefined || end <= start) return undefined;
	return { ...event, start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

/**
 * Expand one supported master only as far as needed to answer a single civil
 * date query. Returned event objects carry occurrence-specific bounds while
 * retaining the master UID and recurrence rule for series-level actions.
 */
export function expandCalendarEventForDate(event: CalendarEvent, dateKey: string): CalendarEvent[] {
	const rule = recurrenceRule(event);
	if (!rule || !event.recurrence) return [];
	const dayStart = midnightUtc(dateKey);
	if (dayStart === undefined) return [];
	const dayEnd = dayStart + 86_399_999;
	let baseStartWall: number;
	let baseEndWall: number;
	if (event.allDay) {
		const start = midnightUtc(event.start);
		const end = midnightUtc(event.end);
		if (start === undefined || end === undefined || end <= start) return [];
		baseStartWall = start;
		baseEndWall = end;
	} else {
		const start = zonedDateTime(event.start, event.timezone);
		const end = zonedDateTime(event.end, event.timezone);
		if (!start || !end) return [];
		baseStartWall = civilDateTimeAsUtc(start);
		baseEndWall = civilDateTimeAsUtc(end);
		if (baseEndWall <= baseStartWall) return [];
	}
	const wallDuration = baseEndWall - baseStartWall;
	const lookback = Math.ceil(wallDuration / 86_400_000);
	if (lookback > 366) return [];
	const after = new Date(dayStart - lookback * 86_400_000);
	const before = new Date(dayEnd);
	const starts = rule.between(after, before, true, (_date, length) => length <= MAX_OCCURRENCES_FOR_DATE);
	if (starts.length > MAX_OCCURRENCES_FOR_DATE) return [];
	const results: CalendarEvent[] = [];
	for (const value of starts) {
		const wallStart = value.getTime();
		const occurrence = event.allDay
			? expandAllDayOccurrence(event, wallStart, wallDuration)
			: expandTimedOccurrence(event, wallStart, baseStartWall, baseEndWall);
		if (!occurrence) continue;
		if (event.allDay) {
			if (occurrence.start <= dateKey && dateKey < occurrence.end) results.push(occurrence);
		} else {
			const startLocal = zonedDateTime(occurrence.start, occurrence.timezone);
			const endInstant = Date.parse(occurrence.end);
			const endLocal = zonedDateTime(endInstant - 1, occurrence.timezone);
			if (startLocal && endLocal && civilDateKey(startLocal) <= dateKey && dateKey <= civilDateKey(endLocal)) {
				results.push(occurrence);
			}
		}
	}
	return results;
}
