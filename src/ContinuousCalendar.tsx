import * as React from 'react';
import { useMemo, useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { Virtuoso, type VirtuosoHandle, type ListRange } from 'react-virtuoso';
import { App } from 'obsidian';
import { IndexService } from './services/IndexService';
import { DayDetailView } from './DayDetailView';

// ==========================================
// TYPES & HELPERS
// ==========================================

interface DayItem {
    date: Date;
}

interface SelectionState {
    date: Date;
    type: 'cell' | 'number';
}

type WeekData = DayItem[];

interface BorderResult {
    path: string | null;
    separator: string | null;
}

const toDateKey = (date: Date): string => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
};

const getWeekNumber = (d: Date): number => {
    const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    target.setUTCDate(target.getUTCDate() + 4 - (target.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
    return Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
};

const convertTintToTextColor = (color: string | undefined): string | undefined => {
    if (!color) return color;
    if (color.includes('-tint')) return color.replace('-tint', '-text');
    if (color.includes('-text')) return color.replace('-text', '-tint');
    return color;
};

// ==========================================
// COMPONENT: DotArea
// ==========================================

const ICON_WIDTH = 5;
const GAP_WIDTH = 2;
const OVERFLOW_MIN_WIDTH = 20;

// 1. Add isCompact to props
const DotArea = ({
    symbols,
    isCompact = false
}: {
    symbols: Array<{ symbol?: string; color?: string }>;
    isCompact?: boolean;
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [visibleCount, setVisibleCount] = useState(symbols.length);

    const calculateVisibleCount = useCallback(() => {
        if (!containerRef.current) return;
        const containerWidth = containerRef.current.offsetWidth;
        const totalSymbols = symbols.length;
        if (totalSymbols === 0) {
            setVisibleCount(0);
            return;
        }

        // In compact mode, items might be smaller (e.g., 4px dots), 
        // but sticking to standard math is safer to avoid overcrowding.
        let itemWidth = ICON_WIDTH;

        let maxFit = Math.floor((containerWidth + GAP_WIDTH) / (itemWidth + GAP_WIDTH));
        maxFit = Math.max(0, maxFit);

        if (maxFit >= totalSymbols) {
            setVisibleCount(totalSymbols);
        } else {
            const availableForIcons = containerWidth - OVERFLOW_MIN_WIDTH - GAP_WIDTH;
            let iconsToShow = Math.floor((availableForIcons + GAP_WIDTH) / (itemWidth + GAP_WIDTH));
            iconsToShow = Math.max(0, iconsToShow);
            setVisibleCount(iconsToShow);
        }
    }, [symbols.length]);

    useLayoutEffect(() => {
        calculateVisibleCount();
        const resizeObserver = new ResizeObserver(() => calculateVisibleCount());
        if (containerRef.current) resizeObserver.observe(containerRef.current);
        return () => resizeObserver.disconnect();
    }, [calculateVisibleCount]);

    const overflowCount = symbols.length - visibleCount;
    const visibleSymbols = symbols.slice(0, visibleCount);

    return (
        <div ref={containerRef} className="dot-area">
            {visibleSymbols.map((item, idx) => {
                // 2. LOGIC CHANGE: 
                // Only show the Icon/Character if a symbol exists AND we are NOT in compact mode.
                const showAsSymbol = item.symbol && !isCompact;

                if (showAsSymbol) {
                    return (
                        <span key={idx} className="tag-symbol" style={{ color: item.color || 'var(--text-muted)' }}>
                            {item.symbol}
                        </span>
                    );
                } else {
                    // Otherwise, render as a simple colored dot
                    return (
                        <div
                            key={idx}
                            className="dot-indicator"
                            style={{ backgroundColor: item.color || 'var(--interactive-accent)' }}
                        />
                    );
                }
            })}
            {overflowCount > 0 && (
                <span className="dot-overflow">+{overflowCount}</span>
            )}
        </div>
    );
};

// ==========================================
// COMPONENT: RangeBarArea
// ==========================================

interface RangeBarAreaProps {
    dateKey: string;
    indexService: IndexService;
    isCompact?: boolean;
}

const RangeBarArea = ({ dateKey, indexService, isCompact = false }: RangeBarAreaProps) => {
    const ranges = indexService.getRangesForDate(dateKey);
    const rangeSlots = indexService.getRangeSlots(dateKey);
    const settings = indexService.settings;

    if (ranges.length === 0) return null;

    // --- COMPACT MODE: DOTS REPRESENTATION ---
    if (isCompact) {
        // Limit to 5 dots max to fit the small cell
        const MAX_DOTS = 4;
        const visibleRanges = ranges.slice(0, MAX_DOTS);
        const overflowCount = ranges.length - MAX_DOTS;

        return (
            <div className="range-bar-area compact-mode-dots">
                {visibleRanges.map((range: any, idx: number) => {
                    // 1. Resolve Color
                    let rangeColor = range.color;
                    if (!rangeColor && range.tags && settings?.tagAppearance) {
                        for (const tag of range.tags) {
                            if (settings.tagAppearance[tag]?.color) {
                                rangeColor = settings.tagAppearance[tag].color;
                                break;
                            }
                        }
                    }
                    const finalColor = rangeColor || settings?.defaultBarColor || 'var(--interactive-accent)';

                    // 2. Determine Shape (Optional: visual cue for Start/End)
                    // We stick to a simple square for compactness, but you could add classes here

                    return (
                        <div
                            key={idx}
                            className="range-compact-dot"
                            style={{ backgroundColor: finalColor }}
                            title={range.name}
                        />
                    );
                })}

                {/* Overflow Dot (if any) */}
                {overflowCount > 0 && (
                    <div className="range-compact-overflow-dot" title={`${overflowCount} more`}>+</div>
                )}
            </div>
        );
    }

    // --- NORMAL MODE: BAR REPRESENTATION (Unchanged) ---
    const hasForcedOverflow = ranges.some((r: any) => rangeSlots.get(r.path) === undefined);
    const hasOverflow = ranges.length > 4 || hasForcedOverflow;

    const dotRanges: any[] = [];
    if (hasOverflow) {
        ranges.forEach((r: any) => {
            const slot = rangeSlots.get(r.path);
            if (slot === undefined || slot >= 3) {
                dotRanges.push(r);
            }
        });
    }

    return (
        <div className="range-bar-area">
            {[0, 1, 2, 3].map(slotIndex => {
                const isOverflowSlot = slotIndex === 3 && hasOverflow;

                if (isOverflowSlot) {
                    return (
                        <div key={slotIndex} className={`range-slot slot-${slotIndex}`}>
                            <div className="range-overflow-container" title={`${dotRanges.length} range(s)`}>
                                {dotRanges.map((dotRange, idx) => {
                                    let dotColor = dotRange.color;
                                    const finalDotColor = dotColor || settings?.defaultBarColor || 'var(--interactive-accent)';

                                    let shapeClass = 'range-overflow-dot';
                                    if (dotRange.dateStart === dateKey) shapeClass = 'range-triangle-start';
                                    else if (dotRange.dateEnd === dateKey) shapeClass = 'range-triangle-end';

                                    const dotStyle: React.CSSProperties = {};
                                    if (shapeClass === 'range-overflow-dot') {
                                        dotStyle.backgroundColor = finalDotColor;
                                    } else if (shapeClass === 'range-triangle-start') {
                                        dotStyle.borderLeftColor = finalDotColor;
                                        dotStyle.borderTopColor = finalDotColor;
                                        dotStyle.borderBottomColor = finalDotColor;
                                        dotStyle.color = convertTintToTextColor(finalDotColor);
                                        dotStyle.backgroundColor = convertTintToTextColor(finalDotColor);
                                    } else if (shapeClass === 'range-triangle-end') {
                                        dotStyle.borderRightColor = finalDotColor;
                                        dotStyle.borderTopColor = finalDotColor;
                                        dotStyle.borderBottomColor = finalDotColor;
                                        dotStyle.color = convertTintToTextColor(finalDotColor);
                                        dotStyle.backgroundColor = convertTintToTextColor(finalDotColor);
                                    }

                                    return <div key={idx} className={shapeClass} style={dotStyle} />;
                                })}
                            </div>
                        </div>
                    );
                }

                const range = ranges.find((r: any) => rangeSlots.get(r.path) === slotIndex);
                if (!range) return <div key={slotIndex} className={`range-slot slot-${slotIndex}`} />;

                let rangeColor = range.color;
                if (!rangeColor && range.tags && settings?.tagAppearance) {
                    for (const tag of range.tags) {
                        if (settings.tagAppearance[tag]?.color) {
                            rangeColor = settings.tagAppearance[tag].color;
                            break;
                        }
                    }
                }

                const finalColor = rangeColor || settings?.defaultBarColor || 'var(--interactive-accent)';
                const borderColor = convertTintToTextColor(finalColor);

                const rangeBarStyle: React.CSSProperties = { backgroundColor: finalColor };
                if (range.dateStart === dateKey && borderColor) {
                    rangeBarStyle.borderLeft = `var(--range-bar-border-width, 2px) solid ${borderColor}`;
                }
                if (range.dateEnd === dateKey && borderColor) {
                    rangeBarStyle.borderRight = `var(--range-bar-border-width, 2px) solid ${borderColor}`;
                }

                const isEmergence = indexService.isRangeEmergence(range.path, dateKey);

                return (
                    <div key={slotIndex} className={`range-slot slot-${slotIndex}`}>
                        <div
                            className={`range-bar ${range.dateStart === dateKey ? 'range-start' : ''} ${range.dateEnd === dateKey ? 'range-end' : ''} ${isEmergence ? 'range-emergence' : ''}`}
                            style={rangeBarStyle}
                            title={range.name}
                        />
                    </div>
                );
            })}
        </div>
    );
};

// ==========================================
// COMPONENT: DayCell
// ==========================================

interface DayCellProps {
    date: Date;
    indexService: IndexService;
    isActive: boolean;
    isToday: boolean;
    isSelected: boolean;
    isCellSelected: boolean;
    isCompact: boolean;
    onNumberClick: (d: Date, e: React.MouseEvent) => void;
    onCellClick: (d: Date) => void;
}

const DayCell: React.FC<DayCellProps> = ({
    date,
    indexService,
    isActive,
    isToday,
    isSelected,
    isCellSelected,
    isCompact,
    onNumberClick,
    onCellClick
}) => {
    const dateKey = toDateKey(date);

    // 1. Get Metadata
    const dateStatus = indexService.getDateStatus(dateKey);
    const isDailyNote = dateStatus && dateStatus.isDailyNote;

    // 2. Get Holidays
    const holidays = indexService.getHolidaysForDate ? indexService.getHolidaysForDate(dateKey) : [];
    const hasHoliday = holidays.length > 0;
    const holidayColor = hasHoliday ? holidays[0].color : undefined;
    const holidayNames = hasHoliday ? holidays.map((h: any) => h.name).join(', ') : undefined;

    // 3. Get Dots
    const settings = indexService.settings;
    const displaySymbols = indexService.getDisplaySymbols(
        dateKey,
        settings?.tagAppearance,
        settings?.defaultDotColor,
        settings?.collapseDuplicateTagSymbols,
        50,
        settings?.useDotsOnlyForTags,
        settings?.useDotsOnlyForProperties
    );

    // 4. Build Classes
    let numClass = 'day-number';
    if (isToday) numClass += ' is-today';
    else if (isActive) numClass += ' is-active';
    else numClass += ' is-inactive';

    if (hasHoliday) numClass += ' has-holiday';
    if (isSelected) numClass += ' is-selected-number';
    if (isDailyNote) numClass += ' is-daily-note';
    if (isCellSelected) numClass += ' engaged range-start-engaged';

    // Create a variable for the container class
    const containerClass = `day-cell ${!isActive ? 'is-inactive-cell' : ''}`;

    // In compact mode, combine dots and ranges into a unified area
    const ranges = indexService.getRangesForDate(dateKey);
    const hasRanges = ranges.length > 0;
    const hasDots = displaySymbols.length > 0;
    const totalItems = displaySymbols.length + ranges.length;

    return (
        <div className={`${containerClass}${isCompact ? ' is-compact' : ''}`} onClick={() => onCellClick(date)}>
            <div className="cell-content">
                <div className="top-content">
                    <span
                        className={numClass}
                        style={hasHoliday && holidayColor ? { backgroundColor: holidayColor } : undefined}
                        title={holidayNames}
                        onClick={(e) => {
                            e.stopPropagation();
                            onNumberClick(date, e);
                        }}
                    >
                        {date.getDate()}
                    </span>
                </div>
                {isCompact ? (
                    /* Compact mode: unified combined area for dots + ranges */
                    <div className="compact-combined-area">
                        {/* PASS isCompact=true HERE */}
                        {hasDots && <DotArea symbols={displaySymbols} isCompact={true} />}
                        {hasRanges && <RangeBarArea dateKey={dateKey} indexService={indexService} isCompact={true} />}
                    </div>
                ) : (
                    /* Normal mode: separate areas for dots and ranges */
                    <>
                        {/* isCompact defaults to false here */}
                        {displaySymbols.length > 0 && <DotArea symbols={displaySymbols} />}
                        <RangeBarArea dateKey={dateKey} indexService={indexService} isCompact={false} />
                    </>
                )}
            </div>
            {isToday && <div className="today-marker" />}
        </div>
    );
};

// ==========================================
// COMPONENT: CalendarFooter (Restored)
// ==========================================

interface CalendarFooterProps {
    year: number;
    viewMode: 'Continuous' | 'month';
    onYearChange: (year: number) => void;
    onFocusAction: () => void;
    onGoToToday: () => void;
}

const CalendarFooter: React.FC<CalendarFooterProps> = ({
    year,
    viewMode,
    onYearChange,
    onFocusAction,
    onGoToToday
}) => (
    <div className="calendar-footer">
        <button className="footer-btn-text" onClick={onFocusAction}>
            {viewMode === 'month' ? 'Add Months' : 'Focus Year'}
        </button>

        <div className="footer-controls">
            <button className="footer-arrow" onClick={() => onYearChange(year - 1)}>
                <span className="arrow-icon">&larr;</span>
            </button>
            <div className="year-display">{year}</div>
            <button className="footer-arrow" onClick={() => onYearChange(year + 1)}>
                <span className="arrow-icon">&rarr;</span>
            </button>
        </div>

        <button className="footer-btn-text" onClick={onGoToToday}>
            Today
        </button>
    </div>
);

// ==========================================
// HELPERS (Border Logic)
// ==========================================

const getBorderSegment = (
    weekData: WeekData,
    isActiveFn: (d: Date) => boolean
): BorderResult => {
    const cellW = 100;
    const radius = 24;
    const h = 100;
    const r = radius;

    const validIndices = weekData
        .map((d, i) => (isActiveFn(d.date) ? i : -1))
        .filter((i) => i !== -1);

    if (validIndices.length === 0) return { path: null, separator: null };

    const startCol = validIndices[0];
    const endCol = validIndices[validIndices.length - 1];
    const startX = startCol * cellW;
    const endX = (endCol + 1) * cellW;

    const getRowRange = (offsetDays: number) => {
        let s = -1;
        let e = -1;
        const baseDate = weekData[0].date;
        for (let i = 0; i < 7; i++) {
            const d = new Date(baseDate);
            d.setDate(d.getDate() + i + offsetDays);
            if (isActiveFn(d)) {
                if (s === -1) s = i;
                e = i;
            }
        }
        if (s === -1) return null;
        return { startX: s * cellW, endX: (e + 1) * cellW };
    };

    const prev = getRowRange(-7);
    const next = getRowRange(7);

    let path = '';
    let leftWallStartY = 0;
    let leftWallEndY = h;

    if (prev && prev.startX <= startX && prev.endX >= startX) {
        leftWallStartY = 0;
        path += `M ${startX},0 `;
    } else {
        if (next && next.startX < startX) {
            leftWallStartY = h - r;
            path += `M ${startX},${h - r} `;
        } else {
            leftWallStartY = h;
            path += `M ${startX},${h} `;
        }
        path += `L ${startX},${r} Q ${startX},0 ${startX + r},0 `;
    }

    if (leftWallStartY === 0) {
        if (next && next.startX < startX) leftWallEndY = h - r;
        else if (next && next.startX <= startX) leftWallEndY = h;
        else leftWallEndY = h - r;
        path += `L ${startX},${leftWallEndY} `;
    }

    if (!prev || prev.startX > startX || prev.endX < startX) {
        if (prev && prev.startX > startX) {
            path += `L ${prev.startX - r},0 Q ${prev.startX},0 ${prev.startX},-${r} `;
        } else {
            path += `L ${endX - r},0 Q ${endX},0 ${endX},${r} `;
        }
    }

    if (prev && prev.endX > endX) path += `M ${endX},${r} `;
    else if (prev && prev.endX >= endX) path += `M ${endX},0 `;
    else if (prev && prev.startX > startX) path += `M ${endX},${r} `;

    if (next && next.startX <= endX && next.endX >= endX) {
        path += `L ${endX},${h} `;
    } else {
        if (next && next.endX < endX) {
            path += `L ${endX},${h - r} Q ${endX},${h} ${endX - r},${h} `;
            path += `L ${next.endX + r},${h} Q ${next.endX},${h} ${next.endX},${h + r} `;
        } else {
            path += `L ${endX},${h - r} Q ${endX},${h} ${endX - r},${h} `;
            if (next && next.startX > startX) {
                path += `L ${next.startX + r},${h} Q ${next.startX},${h} ${next.startX},${h + r} `;
            } else {
                path += `L ${startX + r},${h} Q ${startX},${h} ${startX},${h - r} `;
                if (leftWallEndY === h - r) path += `L ${startX},${leftWallEndY} `;
                else if (!prev || prev.startX > startX || prev.endX < startX)
                    path += `L ${startX},${r} `;
                else path += `L ${startX},0 `;
            }
        }
    }

    let separator = '';
    const firstOfMonthIndex = weekData.findIndex((d) => d.date.getDate() === 1);

    if (firstOfMonthIndex !== -1 && isActiveFn(weekData[firstOfMonthIndex].date)) {
        const pxX = firstOfMonthIndex * cellW;
        if (firstOfMonthIndex > 0) {
            const dayLeftDate = new Date(weekData[firstOfMonthIndex].date);
            dayLeftDate.setDate(dayLeftDate.getDate() - 1);
            if (isActiveFn(dayLeftDate)) {
                separator += `M ${pxX},0 L ${pxX},${h} `;
                const dayBelowLeft = new Date(dayLeftDate);
                dayBelowLeft.setDate(dayBelowLeft.getDate() + 7);
                if (isActiveFn(dayBelowLeft)) {
                    separator += `M ${startX},${h} L ${pxX},${h} `;
                }
            }
        }
        const dayAboveDate = new Date(weekData[firstOfMonthIndex].date);
        dayAboveDate.setDate(dayAboveDate.getDate() - 7);
        if (isActiveFn(dayAboveDate)) {
            separator += `M ${pxX},0 L ${endX},0 `;
        }
    }

    return { path, separator: separator || null };
};

// ==========================================
// COMPONENT: Week Row
// ==========================================

interface WeekRowProps {
    weekData: WeekData;
    index: number;
    indexService: IndexService;
    focusedMonths: Set<string>;
    toggleMonthFocus: (year: number, month: number) => void;
    resetFocus: () => void;
    selectedWeekIndex: number | null;
    onWeekClick: (index: number) => void;
    onPinClick?: (date: Date) => void;
    pinnedMonth?: string | null;
    onMonthNameClick?: (date: Date) => void;
    customIsActiveFn?: (date: Date) => boolean;
    viewMode: 'Continuous' | 'month';
    displayedMonth?: number;
    selection: SelectionState | null;
    onCellClick: (date: Date) => void;
    onNumberClick: (date: Date, e: React.MouseEvent) => void;
    currentYear?: number;
    isCompact?: boolean;
}

const WeekRow: React.FC<WeekRowProps> = ({
    weekData,
    index,
    indexService,
    focusedMonths,
    toggleMonthFocus,
    resetFocus,
    selectedWeekIndex,
    onWeekClick,
    onPinClick,
    pinnedMonth,
    onMonthNameClick,
    customIsActiveFn,
    viewMode,
    displayedMonth,
    selection,
    onCellClick,
    onNumberClick,
    currentYear,
    isCompact = false
}) => {
    // --- Active Logic ---
    const checkIsActive = (date: Date) => {
        if (customIsActiveFn) {
            return customIsActiveFn(date);
        }
        const y = date.getFullYear();
        const m = date.getMonth();
        const key = `${y}-${m}`;
        const now = new Date();
        if (y === now.getFullYear() && m === now.getMonth()) return true;
        if (focusedMonths.has(key)) return true;
        return false;
    };

    const { path: borderPath, separator: separatorPath } =
        getBorderSegment(weekData, checkIsActive);

    const firstDayOfMonth = weekData.find((d) => d.date.getDate() === 1);
    const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

    const shouldShowLabel = firstDayOfMonth && (
        viewMode === 'Continuous' ||
        (viewMode === 'month' && firstDayOfMonth.date.getMonth() === displayedMonth)
    );

    const isMonthFocused = firstDayOfMonth
        ? focusedMonths.has(`${firstDayOfMonth.date.getFullYear()}-${firstDayOfMonth.date.getMonth()}`)
        : false;

    const today = new Date();
    const isRealCurrentMonth = firstDayOfMonth
        ? firstDayOfMonth.date.getFullYear() === today.getFullYear() &&
        firstDayOfMonth.date.getMonth() === today.getMonth()
        : false;

    const isPinned = firstDayOfMonth
        ? pinnedMonth === `${firstDayOfMonth.date.getFullYear()}-${firstDayOfMonth.date.getMonth()}`
        : false;

    const isSelected = selectedWeekIndex === index;
    let weekLabel: string;
    if (selectedWeekIndex === null) {
        weekLabel = String(getWeekNumber(weekData[0].date));
    } else {
        const diff = index - selectedWeekIndex;
        if (diff === 0) weekLabel = '0';
        else weekLabel = diff > 0 ? `+${diff}` : `${diff}`;
    }

    const isWeekToday = weekData.some(d =>
        d.date.getDate() === today.getDate() &&
        d.date.getMonth() === today.getMonth() &&
        d.date.getFullYear() === today.getFullYear()
    );

    const isWeekActive = weekData.some(d => checkIsActive(d.date));
    let weekTextClass = 'week-num-text';
    if (isWeekToday) weekTextClass += ' is-today';
    else if (isWeekActive) weekTextClass += ' is-active';
    else weekTextClass += ' is-inactive';

    const checkSelection = (d: Date, type: 'cell' | 'number'): boolean => {
        if (!selection) return false;
        return selection.type === type &&
            selection.date.getDate() === d.getDate() &&
            selection.date.getMonth() === d.getMonth() &&
            selection.date.getFullYear() === d.getFullYear();
    };

    return (
        <div className="week-row">
            <div className={`week-num-col ${isSelected ? 'selected' : ''}`} onClick={() => onWeekClick(index)}>
                <span className={weekTextClass}>{weekLabel}</span>
            </div>

            <div className="day-grid-container">
                <div className="grid-layer background">
                    {weekData.map((d, i) => {
                        const isWeekend = d.date.getDay() === 0 || d.date.getDay() === 6;
                        return (
                            <div
                                key={i}
                                className={`day-cell-bg ${isWeekend ? 'weekend' : ''}`}
                                onClick={() => onCellClick(d.date)}
                            />
                        );
                    })}
                </div>

                <div className="grid-layer foreground">
                    {weekData.map((d, i) => {
                        const isActive = checkIsActive(d.date);
                        const isToday =
                            d.date.getDate() === today.getDate() &&
                            d.date.getMonth() === today.getMonth() &&
                            d.date.getFullYear() === today.getFullYear();

                        const isNumberSelected = checkSelection(d.date, 'number');
                        const isCellSelected = checkSelection(d.date, 'cell');

                        return (
                            <div key={i} className="day-cell-fg">
                                <DayCell
                                    date={d.date}
                                    indexService={indexService}
                                    isActive={isActive}
                                    isToday={isToday}
                                    isSelected={!!isNumberSelected}
                                    isCellSelected={!!isCellSelected}
                                    isCompact={isCompact}
                                    onNumberClick={onNumberClick}
                                    onCellClick={onCellClick}
                                />
                            </div>
                        );
                    })}
                </div>

                <div className="svg-layer">
                    <svg viewBox="0 -2 700 100" className="svg-content" preserveAspectRatio="none">
                        {borderPath && (
                            <path
                                d={borderPath}
                                fill="none"
                                stroke="var(--text-normal)"
                                strokeWidth="2"
                                strokeLinejoin="round"
                                vectorEffect="non-scaling-stroke"
                            />
                        )}
                        {separatorPath && (
                            <path
                                d={separatorPath}
                                fill="none"
                                stroke="var(--text-normal)"
                                strokeWidth="1"
                                strokeDasharray="6 8"
                                strokeLinecap="round"
                                vectorEffect="non-scaling-stroke"
                            />
                        )}
                    </svg>
                </div>
            </div>

            <div className="sidebar-col">
                {shouldShowLabel && (
                    <div className="month-label-group">
                        <div className="month-header-row">
                            <span
                                className={`month-name ${viewMode === 'Continuous' ? 'clickable' : ''}`}
                                onClick={() => {
                                    if (viewMode === 'Continuous' && onMonthNameClick) {
                                        onMonthNameClick(firstDayOfMonth.date);
                                    }
                                }}
                            >
                                {monthNames[firstDayOfMonth.date.getMonth()]}
                            </span>
                            {viewMode === 'Continuous' && onPinClick && firstDayOfMonth.date.getFullYear() <= (currentYear ?? today.getFullYear()) && (
                                <button
                                    className={`pin-btn ${isPinned ? 'pinned' : ''}`}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onPinClick(firstDayOfMonth.date);
                                    }}
                                    title={isPinned ? "Unpin Month" : "Pin Month"}
                                >
                                    <svg viewBox="0 0 24 24" fill="currentColor" className="pin-icon-svg">
                                        <path d="M16,12V4H17V2H7V4H8V12L6,14V16H11.2V22H12.8V16H18V14L16,12Z" />
                                    </svg>
                                </button>
                            )}
                        </div>
                        {viewMode === 'Continuous' && (
                            isRealCurrentMonth ? (
                                focusedMonths.size > 0 && (
                                    <button onClick={resetFocus} className="btn-focus reset">RESET</button>
                                )
                            ) : (
                                <button
                                    onClick={() => toggleMonthFocus(firstDayOfMonth.date.getFullYear(), firstDayOfMonth.date.getMonth())}
                                    className={`btn-focus ${isMonthFocused ? 'active' : 'inactive'}`}
                                >
                                    {isMonthFocused ? 'Active' : 'Focus'}
                                </button>
                            )
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

// ==========================================
// COMPONENT: Traditional Month View 
// ==========================================

const getWeeksForSingleMonth = (date: Date): WeekData[] => {
    const year = date.getFullYear();
    const month = date.getMonth();
    const firstDayOfMonth = new Date(year, month, 1);
    const startDay = firstDayOfMonth.getDay();
    const diff = firstDayOfMonth.getDate() - startDay + (startDay === 0 ? -6 : 1);
    const current = new Date(new Date(firstDayOfMonth).setDate(diff));
    const weeks: WeekData[] = [];
    let safetyCounter = 0;
    while (safetyCounter < 6) {
        const week: WeekData = [];
        for (let i = 0; i < 7; i++) {
            week.push({ date: new Date(current) });
            current.setDate(current.getDate() + 1);
        }
        const firstDayOfNewWeek = week[0].date;
        const isNextMonth = firstDayOfNewWeek.getMonth() !== month && firstDayOfNewWeek.getFullYear() >= year;
        const isWayPast = firstDayOfNewWeek.getFullYear() > year || firstDayOfNewWeek.getMonth() > month;
        if ((isNextMonth || isWayPast) && weeks.length > 0) {
            break;
        }
        weeks.push(week);
        const lastDayPushed = week[6].date;
        if (lastDayPushed.getMonth() !== month && lastDayPushed > new Date(year, month + 1, 0)) {
            if (weeks.length >= 4) break;
        }
        safetyCounter++;
    }
    return weeks;
};

interface TraditionalMonthViewProps {
    currentDate: Date;
    onMonthChange: (d: Date) => void;
    onClose: () => void;
    focusedMonths: Set<string>;
    selectedWeekIndex: number | null;
    onWeekClick: (index: number) => void;
    selection: SelectionState | null;
    onCellClick: (date: Date) => void;
    onNumberClick: (date: Date, e: React.MouseEvent) => void;
    indexService: IndexService;
    isCompact: boolean;
}

const TraditionalMonthView: React.FC<TraditionalMonthViewProps> = ({
    currentDate,
    onMonthChange,
    onClose,
    focusedMonths,
    selectedWeekIndex,
    onWeekClick,
    selection,
    onCellClick,
    onNumberClick,
    indexService,
    isCompact
}) => {
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const weeks = useMemo(() => getWeeksForSingleMonth(currentDate), [currentDate]);
    const isDayInCurrentMonth = (d: Date) => {
        return d.getMonth() === currentDate.getMonth() && d.getFullYear() === currentDate.getFullYear();
    };
    const handleNav = (direction: -1 | 1) => {
        const newDate = new Date(currentDate);
        newDate.setMonth(newDate.getMonth() + direction);
        onMonthChange(newDate);
    };

    return (
        <div className="month-view-container">
            <div className="month-view-header">
                <button className="back-btn" onClick={onClose}>&larr; Back to list</button>
                <div className="month-nav-controls">
                    <button className="nav-arrow" onClick={() => handleNav(-1)}>&lt;</button>
                    <button className="nav-dot" onClick={() => onMonthChange(new Date())} title="Go to Today"><div className="dot-inner"></div></button>
                    <button className="nav-arrow" onClick={() => handleNav(1)}>&gt;</button>
                </div>
                <div className="month-view-title">
                    <span className="title-month">{monthNames[currentDate.getMonth()]}</span>
                    <span className="title-year">{currentDate.getFullYear()}</span>
                </div>
            </div>
            <div className="month-view-list-wrapper">
                {weeks.map((week, i) => (
                    <WeekRow
                        key={i}
                        weekData={week}
                        index={i}
                        focusedMonths={focusedMonths}
                        toggleMonthFocus={() => { }}
                        resetFocus={() => { }}
                        selectedWeekIndex={selectedWeekIndex}
                        onWeekClick={onWeekClick}
                        viewMode="month"
                        customIsActiveFn={isDayInCurrentMonth}
                        displayedMonth={currentDate.getMonth()}
                        selection={selection}
                        onCellClick={onCellClick}
                        onNumberClick={onNumberClick}
                        indexService={indexService}
                        isCompact={isCompact}
                    />
                ))}
            </div>
        </div>
    );
};

// ==========================================
// COMPONENT: Continuous Calendar (Main)
// ==========================================

export interface ContinuousCalendarProps {
    index: IndexService;
    app: App;
    onOpenNote: (date: Date) => void;
    onCreateRange: (start: Date, end: Date) => void;
    onYearChange?: (year: number) => void;
}

export const ContinuousCalendar = (props: ContinuousCalendarProps) => {
    const { index, app, onOpenNote, onCreateRange, onYearChange } = props;

    const virtuosoRef = useRef<VirtuosoHandle>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const [currentYear, setCurrentYear] = useState<number>(new Date().getFullYear());
    const [minWeeksToFill, setMinWeeksToFill] = useState<number>(20);
    const [focusedMonths, setFocusedMonths] = useState<Set<string>>(new Set());
    const [selectedWeekIndex, setSelectedWeekIndex] = useState<number | null>(null);
    const [selection, setSelection] = useState<SelectionState | null>(null);

    const [dataVersion, setDataVersion] = useState(0);
    const [viewMode, setViewMode] = useState<'Continuous' | 'month'>('Continuous');
    const [monthViewDate, setMonthViewDate] = useState<Date>(new Date());
    const [pendingScrollDate, setPendingScrollDate] = useState<Date | null>(null);
    const [pinnedMonth, setPinnedMonth] = useState<string | null>(null);

    // Compact mode state - triggers when container width approaches min-width
    const COMPACT_MODE_THRESHOLD = 420; // Width at which we switch to compact mode
    const [isCompact, setIsCompact] = useState<boolean>(false);

    // Detect compact mode based on container width
    useLayoutEffect(() => {
        const checkCompactMode = () => {
            if (containerRef.current) {
                const width = containerRef.current.offsetWidth;
                setIsCompact(width <= COMPACT_MODE_THRESHOLD);
            }
        };

        checkCompactMode();
        const resizeObserver = new ResizeObserver(() => checkCompactMode());
        if (containerRef.current) {
            resizeObserver.observe(containerRef.current);
        }
        return () => resizeObserver.disconnect();
    }, []);

    useEffect(() => {
        const updateWeeks = () => {
            const weeks = Math.ceil(window.innerHeight / 62) + 2;
            setMinWeeksToFill(weeks);
        };
        updateWeeks();
        window.addEventListener('resize', updateWeeks);
        return () => window.removeEventListener('resize', updateWeeks);
    }, []);

    useEffect(() => {
        const unsubscribe = index.subscribe ? index.subscribe(() => {
            setDataVersion(v => v + 1);
        }) : () => { };
        return unsubscribe;
    }, [index]);

    const handleCellClick = (date: Date) => {
        if (selection?.type === 'cell' && selection.date.getTime() === date.getTime()) {
            setSelection(null);
        } else {
            setSelection({ date, type: 'cell' });
        }
    };

    const handlePrevDay = () => {
        if (selection && selection.type === 'cell') {
            const prev = new Date(selection.date);
            prev.setDate(prev.getDate() - 1);
            setSelection({ date: prev, type: 'cell' });
        }
    };

    const handleNextDay = () => {
        if (selection && selection.type === 'cell') {
            const next = new Date(selection.date);
            next.setDate(next.getDate() + 1);
            setSelection({ date: next, type: 'cell' });
        }
    };

    const handleYearChange = (newYear: number) => {
        setCurrentYear(newYear);
        if (onYearChange) onYearChange(newYear);
    };

    const handleNumberClick = (date: Date, e: React.MouseEvent) => {
        const isModKey = e.ctrlKey || e.metaKey;

        if (isModKey && selection) {
            if (selection.date.getTime() === date.getTime()) return;
            const d1 = selection.date;
            const d2 = date;
            const start = d1 < d2 ? d1 : d2;
            const end = d1 < d2 ? d2 : d1;
            onCreateRange(start, end);
            setSelection(null);
            return;
        }

        const isSameDate = selection?.type === 'number' &&
            selection.date.getDate() === date.getDate() &&
            selection.date.getMonth() === date.getMonth() &&
            selection.date.getFullYear() === date.getFullYear();

        if (isSameDate) {
            onOpenNote(date);
        } else {
            setSelection({ date, type: 'number' });
        }
    };

    const toggleMonthFocus = (year: number, month: number) => {
        const key = `${year}-${month}`;
        setFocusedMonths((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const resetFocus = () => {
        setFocusedMonths(new Set());
        setPinnedMonth(null);
    };

    const handleWeekClick = (index: number) => {
        if (selectedWeekIndex === index) setSelectedWeekIndex(null);
        else setSelectedWeekIndex(index);
    };

    const allWeeks = useMemo<WeekData[]>(() => {
        if (viewMode === 'month') return [];
        setSelectedWeekIndex(null);
        const start = new Date(currentYear - 1, 11, 1);
        const day = start.getDay();
        const diff = start.getDate() - day + (day === 0 ? -6 : 1);
        const current = new Date(start.setDate(diff));
        const decFirst = new Date(currentYear, 11, 1);
        const end = new Date(decFirst);
        end.setDate(decFirst.getDate() + minWeeksToFill * 7);
        const weeks: WeekData[] = [];
        while (current < end) {
            const week: WeekData = [];
            for (let i = 0; i < 7; i++) {
                week.push({ date: new Date(current) });
                current.setDate(current.getDate() + 1);
            }
            weeks.push(week);
        }
        return weeks;
    }, [currentYear, viewMode, minWeeksToFill]);

    const [visibleRange, setVisibleRange] = useState<ListRange>({ startIndex: 0, endIndex: 0 });

    const showTodayButton = useMemo(() => {
        if (viewMode !== 'Continuous') return false;
        if (pinnedMonth) return false;
        const now = new Date();
        const currentMonth = now.getMonth();
        const currentYearVal = now.getFullYear();
        const start = Math.max(0, visibleRange.startIndex);
        const end = Math.min(allWeeks.length - 1, visibleRange.endIndex);
        for (let i = start; i <= end; i++) {
            const week = allWeeks[i];
            if (!week) continue;
            const firstDay = week[0].date;
            const lastDay = week[6].date;
            if ((firstDay.getMonth() === currentMonth && firstDay.getFullYear() === currentYearVal) ||
                (lastDay.getMonth() === currentMonth && lastDay.getFullYear() === currentYearVal)) {
                return false;
            }
        }
        return true;
    }, [viewMode, pinnedMonth, visibleRange, allWeeks]);

    const initialWeekIndex = useMemo(() => {
        if (pinnedMonth) {
            const [pYear, pMonth] = pinnedMonth.split('-').map(Number);
            const idx = allWeeks.findIndex((week) =>
                week.some((d) => d.date.getFullYear() === pYear && d.date.getMonth() === pMonth && d.date.getDate() === 1)
            );
            if (idx !== -1) return idx;
        }
        const now = new Date();
        return allWeeks.findIndex((week) =>
            week.some((d) => d.date.getDate() === now.getDate() && d.date.getMonth() === now.getMonth() && d.date.getFullYear() === now.getFullYear())
        );
    }, [allWeeks, pinnedMonth]);

    const handleFocusAction = () => {
        if (viewMode === 'month') {
            console.log("Adding months... feature for later");
        } else {
            const allKeys = Array.from({ length: 12 }, (_, i) => `${currentYear}-${i}`);
            const allSelected = allKeys.every((k) => focusedMonths.has(k));
            setFocusedMonths((prev) => {
                const next = new Set(prev);
                allKeys.forEach((k) => {
                    if (allSelected) next.delete(k);
                    else next.add(k);
                });
                return next;
            });
        }
    };

    const scrollToDate = (date: Date) => {
        const idx = allWeeks.findIndex((w) =>
            w.some((d) => d.date.getDate() === date.getDate() && d.date.getMonth() === date.getMonth() && d.date.getFullYear() === date.getFullYear())
        );
        if (idx !== -1 && virtuosoRef.current) {
            virtuosoRef.current.scrollToIndex({ index: idx, align: 'center', behavior: 'smooth' });
        }
    };

    const handleGoToToday = () => {
        const now = new Date();
        if (viewMode === 'month') {
            setMonthViewDate(now);
            setCurrentYear(now.getFullYear());
        } else {
            const thisYear = now.getFullYear();
            if (thisYear !== currentYear) {
                handleYearChange(thisYear);
                setPendingScrollDate(now);
            } else {
                scrollToDate(now);
            }
        }
    };

    useEffect(() => {
        if (pendingScrollDate && allWeeks.length > 0) {
            scrollToDate(pendingScrollDate);
            setPendingScrollDate(null);
        }
    }, [allWeeks, pendingScrollDate]);

    const handlePinClick = (date: Date) => {
        const monthKey = `${date.getFullYear()}-${date.getMonth()}`;
        if (pinnedMonth === monthKey) {
            setPinnedMonth(null);
        } else {
            setPinnedMonth(monthKey);
            setFocusedMonths((prev) => {
                const next = new Set(prev);
                next.add(monthKey);
                return next;
            });
            const firstWeekIndex = allWeeks.findIndex(week =>
                week.some(d => d.date.getMonth() === date.getMonth() && d.date.getFullYear() === date.getFullYear() && d.date.getDate() === 1)
            );
            if (firstWeekIndex !== -1 && virtuosoRef.current) {
                virtuosoRef.current.scrollToIndex({ index: firstWeekIndex, align: 'start', behavior: 'smooth' });
            }
        }
    };

    const handleMonthNameClick = (date: Date) => {
        setMonthViewDate(date);
        setViewMode('month');
    };

    const handleMonthViewNav = (newDate: Date) => {
        setMonthViewDate(newDate);
        if (newDate.getFullYear() !== currentYear) {
            setCurrentYear(newDate.getFullYear());
        }
    };

    useEffect(() => {
        if (viewMode === 'Continuous') {
            handleGoToToday();
        }
    }, []);

    return (
        <div ref={containerRef} className={`calendar-container${isCompact ? ' is-compact-mode' : ''}`} style={{ position: 'relative' }}>
            {selection?.type === 'cell' && (
                <div
                    className="day-detail-overlay"
                    onClick={(e) => {
                        // Close when clicking the background
                        if (e.target === e.currentTarget) {
                            setSelection(null);
                        }
                    }}
                >
                    <DayDetailView
                        dateKey={toDateKey(selection.date)}
                        index={index}
                        app={app}
                        settings={index.settings} // Pass settings from index
                        onClose={() => setSelection(null)}
                        onPrev={handlePrevDay}
                        onNext={handleNextDay}
                        onOpenNote={(dateStr) => {
                            // Convert string back to Date for handler
                            const d = new Date(dateStr + 'T00:00:00');
                            onOpenNote(d);
                            // Optional: close after opening
                            // setSelection(null); 
                        }}
                    />
                </div>
            )}
            <div className="calendar-header">
                <div className="header-row">
                    <div className="header-spacer-left"></div>
                    <div className="header-days-grid">
                        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
                            <div key={i} className="header-day-label">{d}</div>
                        ))}
                    </div>
                    <div className="header-spacer-right"></div>
                </div>
            </div>

            <div className="calendar-list" style={{ position: 'relative' }}>
                {viewMode === 'Continuous' ? (
                    <>
                        {showTodayButton && (
                            <button className="floating-today-btn" onClick={handleGoToToday}>Today</button>
                        )}
                        <Virtuoso
                            ref={virtuosoRef}
                            rangeChanged={setVisibleRange}
                            context={{ dataVersion }}
                            style={{
                                height: '100%',
                                paddingTop: '2px',
                                overflowY: pinnedMonth ? 'hidden' : 'auto',
                                scrollbarGutter: 'stable'
                            }}
                            initialTopMostItemIndex={initialWeekIndex}
                            totalCount={allWeeks.length}
                            itemContent={(rowIndex) => (
                                <WeekRow
                                    weekData={allWeeks[rowIndex]}
                                    index={rowIndex}
                                    indexService={index}
                                    focusedMonths={focusedMonths}
                                    toggleMonthFocus={toggleMonthFocus}
                                    resetFocus={resetFocus}
                                    selectedWeekIndex={selectedWeekIndex}
                                    onWeekClick={handleWeekClick}
                                    onPinClick={handlePinClick}
                                    onMonthNameClick={handleMonthNameClick}
                                    pinnedMonth={pinnedMonth}
                                    viewMode="Continuous"
                                    selection={selection}
                                    onCellClick={handleCellClick}
                                    onNumberClick={handleNumberClick}
                                    currentYear={currentYear}
                                    isCompact={isCompact}
                                />
                            )}
                        />
                    </>
                ) : (
                    <TraditionalMonthView
                        currentDate={monthViewDate}
                        onMonthChange={handleMonthViewNav}
                        onClose={() => {
                            if (pinnedMonth) {
                                const [pYear] = pinnedMonth.split('-').map(Number);
                                if (pYear !== currentYear) setCurrentYear(pYear);
                            }
                            setViewMode('Continuous');
                        }}
                        focusedMonths={focusedMonths}
                        selectedWeekIndex={selectedWeekIndex}
                        onWeekClick={handleWeekClick}
                        selection={selection}
                        onCellClick={handleCellClick}
                        onNumberClick={handleNumberClick}
                        indexService={index}
                        isCompact={isCompact}
                    />
                )}
            </div>

            <CalendarFooter
                year={currentYear}
                viewMode={viewMode}
                onYearChange={handleYearChange}
                onFocusAction={handleFocusAction}
                onGoToToday={handleGoToToday}
            />
        </div>
    );
};