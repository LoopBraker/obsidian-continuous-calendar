import { useMemo } from 'react';
import {
    addDays,
    isSameDay,
    getDate,
    getDay,
    format
} from 'date-fns';
import { IndexService } from '../services/IndexService';


export const useWeekData = (startOfWeek: Date, noteIndex: IndexService, settings: any, focusedMonths: Set<string>, engagedDate: string | null) => {
    const dayData = useMemo(() => {
        const days = Array.from({ length: 7 }).map((_, i) => addDays(startOfWeek, i));
        const now = new Date();
        const currentMonth = now.getMonth();
        const currentYear = now.getFullYear();

        return days.map(day => {
            const dateKey = format(day, 'yyyy-MM-dd');
            const dayOfMonth = getDate(day);
            const isToday = isSameDay(day, now);
            const status = noteIndex.getDateStatus(dateKey);
            const displaySymbols = settings
                ? noteIndex.getDisplaySymbols(dateKey, settings.tagAppearance, settings.defaultDotColor, settings.collapseDuplicateTagSymbols, 50, settings.useDotsOnlyForTags, settings.useDotsOnlyForProperties)
                : [];
            const holidays = noteIndex.getHolidaysForDate(dateKey);
            const hasHoliday = holidays.length > 0;
            const holidayColor = hasHoliday ? holidays[0].color : undefined;
            const isFirstOfMonth = dayOfMonth === 1;
            const isFirstWeek = dayOfMonth <= 7;
            const dayOfWeek = getDay(day);
            const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
            const isEngaged = engagedDate === dateKey;

            // Outline Logic
            const dayMonth = day.getMonth();
            const dayYear = day.getFullYear();
            const isCurrentMonth = dayMonth === currentMonth && dayYear === currentYear;
            const isFocusedMonth = focusedMonths.has(`${dayYear}-${dayMonth}`);
            const shouldHaveOutline = isCurrentMonth || isFocusedMonth;

            // Odd month logic: Jan (0) is odd (1st), Feb (1) is even (2nd).
            // So even index = odd month.
            const isOddMonth = dayMonth % 2 === 0;

            let needsTopBorder = false;
            let needsBottomBorder = false;
            let needsLeftBorder = false;
            let needsRightBorder = false;

            if (shouldHaveOutline) {
                const dayAbove = addDays(day, -7);
                const dayBelow = addDays(day, 7);
                const dayLeft = addDays(day, -1);
                const dayRight = addDays(day, 1);

                const isNeighborOutlined = (neighborDay: Date) => {
                    const neighborMonth = neighborDay.getMonth();
                    const neighborYear = neighborDay.getFullYear();
                    const isNeighborCurrent = neighborMonth === currentMonth && neighborYear === currentYear;
                    const isNeighborFocused = focusedMonths.has(`${neighborYear}-${neighborMonth}`);
                    return isNeighborCurrent || isNeighborFocused;
                };

                needsTopBorder = !isNeighborOutlined(dayAbove);
                needsBottomBorder = !isNeighborOutlined(dayBelow);
                const isoDayOfWeek = (dayOfWeek === 0) ? 7 : dayOfWeek;
                needsLeftBorder = isoDayOfWeek === 1 || !isNeighborOutlined(dayLeft);
                needsRightBorder = isoDayOfWeek === 7 || !isNeighborOutlined(dayRight);
            }

            const borderClasses = [];
            if (needsTopBorder) borderClasses.push('border-outline-top');
            if (needsBottomBorder) borderClasses.push('border-outline-bottom');
            if (needsLeftBorder) borderClasses.push('border-outline-left');
            if (needsRightBorder) borderClasses.push('border-outline-right');
            if (needsTopBorder && needsLeftBorder) borderClasses.push('corner-top-left');
            if (needsTopBorder && needsRightBorder) borderClasses.push('corner-top-right');
            if (needsBottomBorder && needsLeftBorder) borderClasses.push('corner-bottom-left');
            if (needsBottomBorder && needsRightBorder) borderClasses.push('corner-bottom-right');

            const ranges = noteIndex.getRangesForDate(dateKey);
            const rangeSlots = noteIndex.getRangeSlots(dateKey);

            return {
                dateKey,
                dayOfMonth,
                isToday,
                status,
                displaySymbols,
                holidays,
                hasHoliday,
                holidayColor,
                isFirstOfMonth,
                isFirstWeek,
                isWeekend,
                isEngaged,
                isCurrentMonth,
                isFocusedMonth,
                borderClasses,
                ranges,
                rangeSlots,
                isOddMonth,
                day
            };
        });
    }, [startOfWeek, noteIndex, settings, focusedMonths, engagedDate]);

    return dayData;
};
