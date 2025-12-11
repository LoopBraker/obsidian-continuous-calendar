// services/index/RangeManager.ts
import { parseISO, format, isValid, eachDayOfInterval } from 'date-fns';
import { getEndDateFromDuration } from '../../util/datesFromDuration';
import { RangeNote } from './IndexTypes';

const MAX_RANGE_SLOTS = 4;

export class RangeManager {
    public allRanges: RangeNote[] = [];
    public rangesByDate: Map<string, RangeNote[]> = new Map();
    public rangeSlotsByDate: Map<string, Map<string, number>> = new Map();
    public rangeEmergenceByPath: Map<string, string> = new Map();

    public clear() {
        this.allRanges = [];
        this.rangesByDate.clear();
        this.rangeSlotsByDate.clear();
        this.rangeEmergenceByPath.clear();
    }

    public addRange(range: RangeNote) {
        if (range.scheduled && range.timeEstimate) {
            try {
                // User specified timeEstimate is in minutes
                const minutes = parseInt(String(range.timeEstimate), 10);
                if (!isNaN(minutes) && minutes > 0) {
                    // Use schedule as start date
                    range.dateStart = this.normalizeDate(range.scheduled);

                    // Calculate end date
                    // We subtract 1 minute to ensure that exact day multiples (e.g. 24h) 
                    // land on the correct inclusive end day.
                    // Example: 1 day (1440m) starting 2025-01-01.
                    // 2025-01-01 00:00 + 1440m = 2025-01-02 00:00.
                    // If we use 2025-01-02 as end date, range is [01, 02] (2 days).
                    // Subtacting 1m gives 2025-01-01 23:59 -> 2025-01-01. Range [01] (1 day).
                    range.dateEnd = getEndDateFromDuration(range.dateStart, minutes - 1);
                }
            } catch (e) {
                console.warn('Failed to calculate range from scheduled/timeEstimate', e);
            }
        }

        // Only add if we have valid start/end dates
        if (range.dateStart && range.dateEnd) {
            this.allRanges.push(range);
        }
    }

    private parseDurationToMinutes(duration: string): number {
        // Legacy support or fallback if needed, but per user request, assume raw minutes
        return parseInt(duration, 10);
    }

    private normalizeDate(dateValue: any): string {
        if (dateValue instanceof Date) {
            return format(dateValue, 'yyyy-MM-dd');
        } else if (typeof dateValue === 'string') {
            return dateValue.split('T')[0];
        }
        return '';
    }

    public removeRange(path: string): boolean {
        const initialLength = this.allRanges.length;
        this.allRanges = this.allRanges.filter(r => r.path !== path);
        return this.allRanges.length < initialLength;
    }

    public assignRangeSlots() {
        this.rangesByDate.clear();
        this.rangeSlotsByDate.clear();
        this.rangeEmergenceByPath.clear();

        // 1. Map ranges to specific dates
        for (const range of this.allRanges) {
            try {
                const start = parseISO(range.dateStart);
                const end = parseISO(range.dateEnd);
                if (!isValid(start) || !isValid(end)) continue;

                const days = eachDayOfInterval({ start, end });
                for (const day of days) {
                    const dateKey = format(day, 'yyyy-MM-dd');
                    if (!this.rangesByDate.has(dateKey)) {
                        this.rangesByDate.set(dateKey, []);
                    }
                    this.rangesByDate.get(dateKey)!.push(range);
                }
            } catch (e) {
                console.error('Error processing range:', range, e);
            }
        }

        // 2. Calculate Visual Slots (The Waterfall logic)
        const allDates = Array.from(this.rangesByDate.keys()).sort();
        if (allDates.length === 0) return;

        const startDate = parseISO(allDates[0]);
        const endDate = parseISO(allDates[allDates.length - 1]);
        const allDays = eachDayOfInterval({ start: startDate, end: endDate });

        const activeByPath = new Map<string, number>();
        const occupied = new Set<number>();
        const overflowRanges = new Set<string>();
        let prevVisiblePaths = new Set<string>();
        let prevDateKey: string | null = null;

        const rangesStartingByDate = new Map<string, RangeNote[]>();
        for (const range of this.allRanges) {
            if (!rangesStartingByDate.has(range.dateStart)) {
                rangesStartingByDate.set(range.dateStart, []);
            }
            rangesStartingByDate.get(range.dateStart)!.push(range);
        }

        for (const day of allDays) {
            const dateKey = format(day, 'yyyy-MM-dd');

            // Cleanup ended ranges
            for (const [path, slot] of Array.from(activeByPath.entries())) {
                const range = this.allRanges.find(r => r.path === path);
                if (range && range.dateEnd < dateKey) {
                    activeByPath.delete(path);
                    occupied.delete(slot);
                }
            }
            for (const path of Array.from(overflowRanges)) {
                const range = this.allRanges.find(r => r.path === path);
                if (range && range.dateEnd < dateKey) {
                    overflowRanges.delete(path);
                }
            }

            // Try to move overflow to active
            for (const path of Array.from(overflowRanges)) {
                const range = this.allRanges.find(r => r.path === path);
                if (!range) continue;

                if (range.dateEnd >= dateKey) {
                    const start = parseISO(range.dateStart);
                    const end = parseISO(range.dateEnd);
                    const duration = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
                    const isLongRange = duration > 5;

                    if (!isLongRange) {
                        const hasOtherOverflow = overflowRanges.size > 1;
                        const limit = hasOtherOverflow ? 3 : 4;
                        const slot = this.nextFreeSlot(occupied, limit);
                        if (slot !== undefined) {
                            activeByPath.set(path, slot);
                            occupied.add(slot);
                            overflowRanges.delete(path);
                        }
                    }
                }
            }

            // Process new starting ranges
            const starting = rangesStartingByDate.get(dateKey) || [];
            for (const range of starting) {
                const start = parseISO(range.dateStart);
                const end = parseISO(range.dateEnd);
                const duration = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
                const isLongRange = duration > 5;

                if (!isLongRange) {
                    const limit = overflowRanges.size > 0 ? 3 : 4;
                    const slot = this.nextFreeSlot(occupied, limit);
                    if (slot !== undefined) {
                        activeByPath.set(range.path, slot);
                        occupied.add(slot);
                    } else {
                        overflowRanges.add(range.path);
                    }
                } else {
                    overflowRanges.add(range.path);
                }
            }

            // Calculate visibility for Emergence tracking
            const isCrowded = (activeByPath.size + overflowRanges.size) > 4 || overflowRanges.size > 0;
            const currentVisiblePaths = new Set<string>();

            for (const [path, slot] of activeByPath.entries()) {
                if (slot <= 2) {
                    currentVisiblePaths.add(path);
                } else if (slot === 3 && !isCrowded) {
                    currentVisiblePaths.add(path);
                }
            }

            if (prevDateKey) {
                for (const path of currentVisiblePaths) {
                    if (!prevVisiblePaths.has(path)) {
                        const range = this.allRanges.find(r => r.path === path);
                        if (range && range.dateStart < dateKey) {
                            this.rangeEmergenceByPath.set(path, dateKey);
                        }
                    }
                }
            }

            this.rangeSlotsByDate.set(dateKey, new Map(activeByPath));
            prevVisiblePaths = currentVisiblePaths;
            prevDateKey = dateKey;
        }
    }

    private nextFreeSlot(occupied: Set<number>, maxSlots: number = MAX_RANGE_SLOTS): number | undefined {
        for (let i = 0; i < maxSlots; i++) {
            if (!occupied.has(i)) return i;
        }
        return undefined;
    }
}