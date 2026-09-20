import { parseISO, addDays, subDays, format, differenceInDays } from 'date-fns';

export function exclusiveToInclusive(dateStr: string): string {
    try {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
        return format(subDays(parseISO(dateStr), 1), 'yyyy-MM-dd');
    } catch (e) {
        return dateStr;
    }
}

export function inclusiveToExclusive(dateStr: string): string {
    try {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
        return format(addDays(parseISO(dateStr), 1), 'yyyy-MM-dd');
    } catch (e) {
        return dateStr;
    }
}

export function isNextDay(start: string, end: string): boolean {
    try {
        return differenceInDays(parseISO(end), parseISO(start)) === 1;
    } catch (e) {
        return false;
    }
}
