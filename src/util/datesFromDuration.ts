//this is a util to determine a date in YYYY-MM-DD format from an initial date in YYYY-MM-DD and a duration string in minutes
import { parseISO, addMinutes, format } from "date-fns";

/**
 * Returns a YYYY-MM-DD string after adding minutes to the initial date.
 */
export function getEndDateFromDuration(
    startDateStr: string,
    durationMinutes: number
): string {
    const start = parseISO(startDateStr);
    const end = addMinutes(start, durationMinutes);
    return format(end, "yyyy-MM-dd");
}
