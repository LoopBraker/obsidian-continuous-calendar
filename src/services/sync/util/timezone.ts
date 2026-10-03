export interface CivilDateTime {
	readonly year: number;
	readonly month: number;
	readonly day: number;
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
	readonly millisecond: number;
}

function twoDigits(value: number): string {
	return String(value).padStart(2, '0');
}

export function civilDateKey(parts: Pick<CivilDateTime, 'year' | 'month' | 'day'>): string {
	return `${String(parts.year).padStart(4, '0')}-${twoDigits(parts.month)}-${twoDigits(parts.day)}`;
}

/** Create an epoch value with civil fields treated as UTC (a floating wall time). */
export function civilDateTimeAsUtc(parts: CivilDateTime): number {
	const date = new Date(0);
	date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
	date.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond);
	return date.getTime();
}

export function utcAsCivilDateTime(value: number): CivilDateTime {
	const date = new Date(value);
	return {
		year: date.getUTCFullYear(),
		month: date.getUTCMonth() + 1,
		day: date.getUTCDate(),
		hour: date.getUTCHours(),
		minute: date.getUTCMinutes(),
		second: date.getUTCSeconds(),
		millisecond: date.getUTCMilliseconds(),
	};
}

export function zonedDateTime(value: string | number | Date, timezone: string): CivilDateTime | undefined {
	const instant = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
	if (!Number.isFinite(instant)) return undefined;
	try {
		const parts = new Intl.DateTimeFormat('en-CA', {
			timeZone: timezone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hourCycle: 'h23',
		}).formatToParts(new Date(instant));
		const read = (type: string) => Number(parts.find(part => part.type === type)?.value);
		const result: CivilDateTime = {
			year: read('year'),
			month: read('month'),
			day: read('day'),
			hour: read('hour'),
			minute: read('minute'),
			second: read('second'),
			millisecond: new Date(instant).getUTCMilliseconds(),
		};
		if (Object.values(result).some(component => !Number.isFinite(component))) return undefined;
		return result;
	} catch (_error) {
		return undefined;
	}
}

function offsetAt(instant: number, timezone: string): number | undefined {
	const parts = zonedDateTime(instant, timezone);
	if (!parts) return undefined;
	const secondInstant = Math.floor(instant / 1000) * 1000;
	return civilDateTimeAsUtc(parts) - parts.millisecond - secondInstant;
}

/**
 * Resolve a civil wall time in an IANA zone. Ambiguous fall-back times select
 * the earlier instant. Nonexistent spring-forward times are skipped by
 * default; event end bounds may request the first valid time after the gap.
 */
export function civilDateTimeToInstant(
	parts: CivilDateTime,
	timezone: string,
	gapPolicy: 'skip' | 'forward' = 'skip',
): number | undefined {
	const wallTime = civilDateTimeAsUtc(parts);
	const offsets = new Set<number>();
	for (const hours of [-36, -12, 0, 12, 36]) {
		const offset = offsetAt(wallTime + hours * 3_600_000, timezone);
		if (offset !== undefined) offsets.add(offset);
	}
	const exact: number[] = [];
	const forward: Array<{ instant: number; difference: number }> = [];
	for (const offset of offsets) {
		const instant = wallTime - offset;
		const actual = zonedDateTime(instant, timezone);
		if (!actual) continue;
		const actualWall = civilDateTimeAsUtc(actual);
		if (actualWall === wallTime) exact.push(instant);
		else if (actualWall > wallTime) forward.push({ instant, difference: actualWall - wallTime });
	}
	if (exact.length > 0) return Math.min(...exact);
	if (gapPolicy === 'forward' && forward.length > 0) {
		forward.sort((left, right) => left.difference - right.difference || left.instant - right.instant);
		return forward[0].instant;
	}
	return undefined;
}

export function rruleUtcTimestamp(instant: number): string {
	return new Date(instant).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
