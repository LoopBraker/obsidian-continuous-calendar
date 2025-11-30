import { moment, setIcon, TFile } from "obsidian";
import MyCalendarPlugin from "./main";
import { IndexedCalendarData } from "./calendarDataService";
import { Holiday } from "./type";
import { getAllDailyNotes, getDailyNote } from "obsidian-daily-notes-interface";

const MAX_VISIBLE_RANGE_SLOTS = 4;

const BORDER_COLOR_MAP: Record<string, string> = {
    "var(--color-red-tint)": "var(--color-red-text)",
    "var(--color-grey-tint)": "var(--color-grey-text)",
    "var(--color-orange-tint)": "var(--color-orange-text)",
    "var(--color-yellow-tint)": "var(--color-yellow-text)",
    "var(--color-green-tint)": "var(--color-green-text)",
    "var(--color-mint-tint)": "var(--color-mint-text)",
    "var(--color-cyan-tint)": "var(--color-cyan-text)",
    "var(--color-blue-tint)": "var(--color-blue-text)",
    "var(--color-purple-tint)": "var(--color-purple-text)",
};
const DEFAULT_BORDER_COLOR = "var(--color-red-text)";

export class CalendarRenderer {
    plugin: MyCalendarPlugin;
    containerEl: HTMLElement;

    constructor(plugin: MyCalendarPlugin, containerEl: HTMLElement) {
        this.plugin = plugin;
        this.containerEl = containerEl;
    }

    async render(
        data: IndexedCalendarData,
        holidays: Map<string, Holiday[]>,
        forceFocusMonths: Set<number>,
        forceOpaqueMonths: Set<number>
    ) {
        this.containerEl.empty();
        const scrollContainer = this.containerEl.createDiv({
            cls: "calendar-scroll-container",
        });

        const year = this.plugin.settings.year;
        const today = moment().format("YYYY-MM-DD");
        const DEFAULT_HOLIDAY_COLOR_VAR = "var(--color-red-tint)";
        const DEFAULT_DOT_COLOR = this.plugin.settings.defaultDotColor;
        const DEFAULT_BAR_COLOR = this.plugin.settings.defaultBarColor;
        const DEFAULT_BIRTHDAY_COLOR = this.plugin.settings.defaultBirthdayColor;
        const DEFAULT_DAILY_NOTE_SYMBOL =
            this.plugin.settings.defaultDailyNoteSymbol || "";

        const { notesByDate, birthdaysByDate, allRanges } = data;
        const allDNs = getAllDailyNotes();

        const table = scrollContainer.createEl("table", {
            cls: "my-calendar-table",
        });
        const thead = table.createEl("thead");
        const headerRow = thead.createEl("tr");
        headerRow.createEl("th", { text: "W" });
        const dayHeaders = "Mon Tue Wed Thu Fri Sat Sun".split(" ");
        dayHeaders.forEach((day) => headerRow.createEl("th", { text: day }));
        headerRow.createEl("th", { text: "M" });

        const tbody = table.createEl("tbody");
        const startDate = moment(`${year}-01-01`, "YYYY-MM-DD").startOf("isoWeek");
        const endDate = moment(`${year + 1}-01-31`, "YYYY-MM-DD").endOf("isoWeek");
        let currentWeek = startDate.clone();
        const now = moment();
        let lastDisplayedMonth = -1;
        const currentRealMonthIndex = now.month();

        while (
            currentWeek.isBefore(endDate) ||
            currentWeek.isSame(endDate, "day")
        ) {
            const weekRow = tbody.createEl("tr", { cls: "week-row" });
            const weekNumber = currentWeek.isoWeek();
            const isCurrentWeek = currentWeek.isSame(now, "isoWeek");

            const weekNumCell = weekRow.createEl("td", {
                cls: `week-number ${isCurrentWeek ? "current-week" : ""}`,
                attr: { "data-isoweek": weekNumber.toString() },
            });
            weekNumCell.createSpan({
                cls: "week-number-text",
                text: weekNumber.toString(),
            });

            let weekDays: moment.Moment[] = [];
            for (let i = 0; i < 7; i++) {
                weekDays.push(currentWeek.clone().add(i, "days"));
            }
            const firstMonth = weekDays[0].month();
            const boundaryIndex = weekDays.findIndex(
                (day) => day.month() !== firstMonth
            );
            const hasBoundary = boundaryIndex !== -1;

            // --- Range Logic ---
            interface RangeInfo {
                path: string;
                start: moment.Moment;
                end: moment.Moment;
            }

            const mappedRanges: RangeInfo[] = allRanges.map((p) => ({
                path: p.path,
                start: moment(p.dateStart, "YYYY-MM-DD"),
                end: moment(p.dateEnd, "YYYY-MM-DD"),
            }));

            const rangesStartingByDate = new Map<string, RangeInfo[]>();
            for (const r of mappedRanges) {
                const key = r.start.format("YYYY-MM-DD");
                if (!rangesStartingByDate.has(key)) {
                    rangesStartingByDate.set(key, []);
                }
                rangesStartingByDate.get(key)?.push(r);
            }

            const rangeSlotsByDate: Record<string, Map<string, number>> = {};
            const activeByPath = new Map<string, number>();
            const occupied = new Set<number>();

            function nextFreeSlot(): number | undefined {
                for (let i = 0; i < MAX_VISIBLE_RANGE_SLOTS; i++) {
                    if (!occupied.has(i)) return i;
                }
            }

            let cursor = moment(`${year}-01-01`);
            const last = moment(`${year}-12-31`);

            while (cursor.isSameOrBefore(last, "day")) {
                const todayStr = cursor.format("YYYY-MM-DD");

                for (const [path, slot] of [...activeByPath.entries()]) {
                    const r = mappedRanges.find((x) => x.path === path)!;
                    if (r.end.isBefore(cursor, "day")) {
                        activeByPath.delete(path);
                        occupied.delete(slot);
                    }
                }

                const starting = rangesStartingByDate.get(todayStr) ?? [];
                for (const r of starting) {
                    const slot = nextFreeSlot();
                    if (slot === undefined) continue;
                    activeByPath.set(r.path, slot);
                    occupied.add(slot);
                }

                rangeSlotsByDate[todayStr] = new Map(activeByPath);
                cursor.add(1, "day");
            }

            for (let i = 0; i < 7; i++) {
                const day = weekDays[i];
                const dateStr = day.format("YYYY-MM-DD");
                const dayNum = day.date();
                const inYear = day.year() === year;
                const monthIndex = day.month();

                const holidaysInfo = holidays.get(dateStr) || [];
                const isHoliday = holidaysInfo.length > 0;
                let holidayColorVar = DEFAULT_HOLIDAY_COLOR_VAR;

                if (isHoliday) {
                    if (holidaysInfo.length === 1 && holidaysInfo[0].color) {
                        holidayColorVar = holidaysInfo[0].color;
                    }
                }

                const isBoundaryDay = hasBoundary && i === boundaryIndex;
                const isFirstDayOfMonth = day.date() === 1;
                const isLastDayOfMonth = day.isSame(day.clone().endOf("month"), "day");
                const isFirstWeekOfMonth = day.isSame(
                    day.clone().startOf("month").startOf("isoWeek"),
                    "isoWeek"
                );
                const isLastWeekOfMonth = day.isSame(
                    day.clone().endOf("month").startOf("isoWeek"),
                    "isoWeek"
                );
                const isCurrentMonth =
                    day.isSame(now, "month") && day.isSame(now, "year");
                const isTodayDate = dateStr === today;

                const dailyNoteFileForThisDay = getDailyNote(day, allDNs);
                const hasDailyNote = !!dailyNoteFileForThisDay;

                const isForcedOpaque = forceOpaqueMonths.has(monthIndex);
                const isForcedFocus = forceFocusMonths.has(monthIndex);

                const matchingNotes = notesByDate.get(dateStr) || [];
                const matchingBirthdays =
                    birthdaysByDate.get(day.format("MM-DD")) || [];
                const matchingRanges = allRanges.filter(
                    (p) =>
                        moment(p.dateStart).isSameOrBefore(day, "day") &&
                        moment(p.dateEnd).isSameOrAfter(day, "day")
                );

                const cell = weekRow.createEl("td");
                cell.dataset.date = dateStr;
                cell.dataset.monthIndex = monthIndex.toString();

                const cellClasses = ["calendar-cell"];
                const isOddMonth = monthIndex % 2 === 1;
                cellClasses.push(isOddMonth ? "odd-month" : "even-month");

                if (isHoliday) {
                    cellClasses.push("holiday-colored");
                    cell.style.setProperty("--holiday-background-color", holidayColorVar);
                }
                if (!inYear) cellClasses.push("other-year");
                if (hasBoundary && i >= boundaryIndex) cellClasses.push("new-month");
                if (isCurrentMonth) cellClasses.push("current-month");
                if (isBoundaryDay) cellClasses.push("month-boundary");
                if (isFirstWeekOfMonth) cellClasses.push("month-top");
                if (isLastWeekOfMonth) cellClasses.push("month-bottom");
                if (isFirstDayOfMonth) cellClasses.push("month-start");
                if (isLastDayOfMonth) cellClasses.push("month-end");

                if (isForcedFocus) {
                    cellClasses.push("force-focused-month");
                }
                if (inYear && !isCurrentMonth && !isForcedFocus && !isForcedOpaque) {
                    cellClasses.push("is-faded");
                }

                cell.addClass(...cellClasses);

                if (isHoliday) {
                    cell.title = holidaysInfo.map((h) => h.name).join("\n");
                }

                const cellContentWrapper = cell.createDiv({ cls: "cell-content" });
                const topContentDiv = cellContentWrapper.createDiv({
                    cls: "top-content",
                });
                const dotAreaDiv = cellContentWrapper.createDiv({ cls: "dot-area" });

                const dayNumContainerSpan = topContentDiv.createSpan({
                    cls: `day-number ${isTodayDate ? "today" : ""}`,
                });

                const dayNumTextSpan = dayNumContainerSpan.createSpan({
                    cls: "day-number-text",
                    text: dayNum.toString(),
                });

                if (hasDailyNote && dailyNoteFileForThisDay) {
                    dayNumContainerSpan.dataset.dailyNotePath =
                        dailyNoteFileForThisDay.path;
                    dayNumTextSpan.addClass("has-daily-note-linkable");
                }

                const pencilIndicatorSpan = dayNumContainerSpan.createSpan({
                    text: "✎",
                });
                pencilIndicatorSpan.addClass("pencil-indicator");

                const dailyNoteRegex = /^\d{4}-\d{2}-\d{2}$/;
                const dailyNoteDots: HTMLElement[] = [];
                const birthdayDots: HTMLElement[] = [];
                const otherNoteDots: HTMLElement[] = [];

                const doc = this.containerEl.doc;
                const emittedSymbols = new Set<string>();

                matchingNotes.forEach((p) => {
                    const isDailyNote = dailyNoteRegex.test(p.name);
                    const dot = doc.createElement("span");
                    dot.addClass("dot", "note-dot");
                    if (isDailyNote) dot.addClass("daily-note-indicator");

                    let dotSymbol = isDailyNote
                        ? DEFAULT_DAILY_NOTE_SYMBOL
                        : p.symbol || p.defaultSymbolFromTag || "●";

                    const cameFromTag = !!p.defaultSymbolFromTag;

                    if (
                        this.plugin.settings.collapseDuplicateTagSymbols &&
                        !isDailyNote &&
                        cameFromTag &&
                        emittedSymbols.has(dotSymbol)
                    ) {
                        return; // skip duplicate
                    }
                    emittedSymbols.add(dotSymbol);

                    dot.textContent = dotSymbol;
                    dot.title = p.name;
                    dot.style.color =
                        p.color || p.defaultColorFromTag || DEFAULT_DOT_COLOR;

                    (isDailyNote ? dailyNoteDots : otherNoteDots).push(dot);
                });

                if (matchingBirthdays.length > 0) {
                    const dot = doc.createElement("span");
                    dot.addClass("dot", "birthday-dot");
                    const birthdaySymbol =
                        this.plugin.settings.defaultBirthdaySymbol || "🎂";
                    dot.textContent = birthdaySymbol;
                    dot.title = `${matchingBirthdays.length} birthday${matchingBirthdays.length > 1 ? "s" : ""}`;
                    dot.style.color =
                        matchingBirthdays[0].color ||
                        matchingBirthdays[0].defaultColorFromTag ||
                        DEFAULT_BIRTHDAY_COLOR;
                    birthdayDots.push(dot);
                }

                birthdayDots.forEach((dot) => dotAreaDiv.appendChild(dot));
                otherNoteDots.forEach((dot) => dotAreaDiv.appendChild(dot));

                if (matchingRanges.length > 0) {
                    const rangeBarArea = cellContentWrapper.createDiv({
                        cls: "range-bar-area",
                    });
                    for (let slot = 0; slot < MAX_VISIBLE_RANGE_SLOTS; slot++) {
                        rangeBarArea.createDiv({ cls: `range-slot slot-${slot}` });
                    }
                    matchingRanges.forEach((p) => {
                        const dateSlots = rangeSlotsByDate[dateStr];
                        const slotIndex = dateSlots?.get(p.path);
                        if (slotIndex === undefined) return;

                        const slot = rangeBarArea.querySelector(`.slot-${slotIndex}`);
                        if (!slot) return;

                        const bar = slot.createDiv({ cls: "range-bar", title: p.name });
                        const bgVar = p.color || p.defaultColorFromTag || DEFAULT_BAR_COLOR;
                        bar.style.backgroundColor = bgVar;
                        const borderVar = BORDER_COLOR_MAP[bgVar] || DEFAULT_BORDER_COLOR;
                        const isStart = moment(p.dateStart).isSame(day, "day");
                        const isEnd = moment(p.dateEnd).isSame(day, "day");

                        if (isStart) {
                            bar.addClass("range-start");
                            bar.style.borderLeft = `2px solid ${borderVar}`;
                        }
                        if (isEnd) {
                            bar.addClass("range-end");
                            bar.style.borderRight = `2px solid ${borderVar}`;
                        }
                    });
                }

                // Expanded Content HTML generation
                let expandedHTML = `<div class="expanded-content">`;
                expandedHTML += `<button class="close-button" aria-label="Close">×</button>`;
                const normalizedNow = now.clone().startOf("day");
                const normalizedDay = day.clone().startOf("day");
                const daysFromToday = normalizedDay.diff(normalizedNow, "days");
                let dayFromTodayText = `${daysFromToday} days from today`;
                if (daysFromToday === 0) dayFromTodayText = "Today";
                else if (daysFromToday === 1) dayFromTodayText = "Tomorrow";
                else if (daysFromToday === -1) dayFromTodayText = "Yesterday";
                const dayLabel = day.format("dddd, MMMM DD, YYYY");
                expandedHTML += `<strong>${dayLabel}</strong><br><em>${dayFromTodayText}</em><br><br>`;
                if (isHoliday) {
                    expandedHTML += `<strong>Holidays:</strong><ul class="expanded-holidays">${holidaysInfo.map((h) => `<li>${h.name}</li>`).join("")}</ul>`;
                }
                if (matchingBirthdays.length > 0) {
                    expandedHTML += `<strong>Birthdays:</strong><ul class="expanded-birthdays">${matchingBirthdays
                        .map((b) => {
                            const birthdayColor =
                                b.color || b.defaultColorFromTag || DEFAULT_BIRTHDAY_COLOR;
                            const linkStyleColor =
                                birthdayColor === "currentColor" ? "inherit" : birthdayColor;
                            return `<li><a class="internal-link birthday-link" data-href="${b.path}" href="${b.path}" style="color: ${linkStyleColor};">${b.name}</a></li>`;
                        })
                        .join("")}</ul>`;
                }
                if (matchingNotes.length > 0) {
                    expandedHTML += `<strong>Events/Notes:</strong><ul class="expanded-notes">${matchingNotes
                        .map((p) => {
                            const noteColor =
                                p.color || p.defaultColorFromTag || DEFAULT_DOT_COLOR;
                            const linkStyleColor =
                                noteColor === "currentColor" ? "inherit" : noteColor;
                            const symbol =
                                (p.symbol && p.symbol !== "") ? p.symbol :
                                    (p.defaultSymbolFromTag && p.defaultSymbolFromTag !== "") ? p.defaultSymbolFromTag : "";
                            return `<li><a class="internal-link" data-href="${p.path}" href="${p.path}" style="color: ${linkStyleColor};">${symbol ? symbol + " " : ""}${p.name}</a></li>`;
                        })
                        .join("")}</ul>`;
                }
                if (matchingRanges.length > 0) {
                    expandedHTML += `<strong>Ongoing Events:</strong><ul class="expanded-events">${matchingRanges
                        .map((p) => {
                            const barColor =
                                p.color || p.defaultColorFromTag || DEFAULT_BAR_COLOR;
                            const linkStyleColor =
                                barColor === "currentColor" ? "inherit" : barColor;
                            return `<li><a class="internal-link" data-href="${p.path}" href="${p.path}" style="color: ${linkStyleColor};">${p.name}</a></li>`;
                        })
                        .join("")}</ul>`;
                }
                if (
                    !isHoliday &&
                    matchingBirthdays.length === 0 &&
                    matchingNotes.length === 0 &&
                    matchingRanges.length === 0
                ) {
                    expandedHTML += `<p>No events or holidays for this day.</p>`;
                }
                expandedHTML += `</div>`;
                cell.dataset.cellContent = expandedHTML;
            }

            const monthCell = weekRow.createEl("td", { cls: "month-column" });
            const earliestMonthIndex = weekDays[0].month();
            const boundaryMonthIndex = hasBoundary
                ? weekDays[boundaryIndex].month()
                : earliestMonthIndex;
            const thisRowMonth = boundaryMonthIndex;

            if (thisRowMonth !== lastDisplayedMonth && weekDays[0].year() === year) {
                const monthMoment = hasBoundary ? weekDays[boundaryIndex] : weekDays[0];
                const monthName = monthMoment.format("MMM");
                const monthIndex = monthMoment.month();
                lastDisplayedMonth = thisRowMonth;
                const isCurrentDisplayMonth =
                    monthMoment.isSame(now, "month") && monthMoment.isSame(now, "year");

                const wrapper = monthCell.createDiv({ cls: "month-cell-wrapper" });
                const labelSpan = wrapper.createSpan({
                    cls: `month-label-text ${isCurrentDisplayMonth ? "current-month-label" : "other-month-label"}`,
                    text: monthName,
                });
                labelSpan.addClass("clickable-month-label");

                if (monthIndex !== currentRealMonthIndex) {
                    const opacityCell = wrapper.createDiv({ cls: "month-action-cell" });
                    const opacityIcon = opacityCell.createSpan({
                        cls: "month-action-icon month-toggle-opacity",
                        attr: {
                            "aria-label": forceOpaqueMonths.has(monthIndex)
                                ? "Make month visible"
                                : "Make month faded",
                        },
                    });
                    opacityIcon.dataset.monthIndex = monthIndex.toString();
                    setIcon(
                        opacityIcon,
                        forceOpaqueMonths.has(monthIndex) ||
                            forceFocusMonths.has(monthIndex)
                            ? "eye"
                            : "eye-off"
                    );

                    const focusCell = wrapper.createDiv({ cls: "month-action-cell" });
                    const focusIcon = focusCell.createSpan({
                        cls: "month-action-icon month-toggle-focus",
                        attr: {
                            "aria-label": forceFocusMonths.has(monthIndex)
                                ? "Remove focus"
                                : "Focus month",
                        },
                    });
                    focusIcon.dataset.monthIndex = monthIndex.toString();
                    setIcon(
                        focusIcon,
                        forceFocusMonths.has(monthIndex)
                            ? "minus-circle"
                            : "plus-circle"
                    );
                }

                monthCell.dataset.monthYear = monthMoment.year().toString();
                monthCell.dataset.monthIndex = monthIndex.toString();
                if (!isCurrentDisplayMonth) {
                    monthCell.addClass("other-month");
                }
            }

            currentWeek.add(7, "days");
        }

        const controlsBottomContainer = this.containerEl.createDiv({
            cls: "calendar-controls-bottom",
        });

        // Note: Event listeners for controls are not added here, but in the View or EventHandler
        // However, we need to create the elements.
        // Actually, it's better if the Renderer creates the structure and returns elements or assigns IDs/classes
        // that the EventHandler can attach to.
        // Or, we can pass callbacks to the render method?
        // For now, I'll create the structure. The EventHandler will attach listeners using delegation or by selecting elements.
        // The original code attached listeners directly.
        // I will leave the creation of controls here, but without listeners.
        // Wait, the original code attached listeners to `resetButton`, `relocateButton`, `updateButton`, `refreshButton`.
        // If I don't attach listeners here, I need to expose these elements or attach listeners after rendering.
        // Delegation is used for the calendar grid, but not for these buttons.
        // I'll add a method `createControls` that returns the buttons, or I can attach listeners if I pass callbacks.
        // But `CalendarEventHandler` is supposed to handle events.
        // I'll make `CalendarRenderer` expose a way to get these buttons or just use delegation for everything if possible.
        // But these are specific buttons.
        // I can add IDs or specific classes and let EventHandler find them.
        // The classes are already there: `reset-focus-button`, `relocate-button`, `year-update-button`, `calendar-refresh-button`.

        // So I will just create the DOM elements.

        const focusControlsGroup = controlsBottomContainer.createDiv({
            cls: "focus-controls",
        });

        const resetButton = focusControlsGroup.createEl("button", {
            text: "Reset Focus",
            cls: "reset-focus-button",
        });
        // Listener will be attached by EventHandler

        const relocateButton = focusControlsGroup.createEl("button", {
            cls: "relocate-button",
            attr: {
                "aria-label": "Relocate to current week",
            },
        });
        setIcon(relocateButton, "compass");
        // Listener will be attached by EventHandler

        this.addYearSelectorControls(controlsBottomContainer, year);

        const currentMonthIndex = now.month();
        this.applyOutlineStyles(tbody, year, currentMonthIndex, forceFocusMonths);
        this.scrollToCurrent(tbody, now, year);
    }

    private addYearSelectorControls(
        controlsContainer: HTMLElement,
        currentYear: number
    ): void {
        const yearControlsContainer = controlsContainer.createDiv({
            cls: "year-update-controls",
        });

        const yearInput = yearControlsContainer.createEl("input", {
            type: "text",
            cls: "year-input",
        });
        yearInput.maxLength = 4;
        yearInput.placeholder = "YYYY";
        yearInput.value = currentYear.toString();

        const updateButton = yearControlsContainer.createEl("button", {
            text: "Load",
            cls: "year-update-button",
        });

        // Add refresh button before the year input controls
        const refreshButton = controlsContainer.createEl("button", {
            cls: "calendar-refresh-button",
            attr: {
                "aria-label": "Refresh calendar data",
            },
        });
        setIcon(refreshButton, "refresh-cw");
    }

    scrollToCurrent(
        tbody: HTMLTableSectionElement,
        now: moment.Moment,
        displayYear: number
    ) {
        if (now.year() !== displayYear) return;
        const currentWeekStartStr = now
            .clone()
            .startOf("isoWeek")
            .format("YYYY-MM-DD");
        const targetCell = tbody.querySelector(
            `td.calendar-cell[data-date="${currentWeekStartStr}"]`
        );
        if (targetCell) {
            const scrollContainer = this.containerEl.querySelector(
                ".calendar-scroll-container"
            );
            if (scrollContainer) {
                targetCell.scrollIntoView({ behavior: "auto", block: "center" });
            }
        }
    }

    clearAllOutlines(tbody: HTMLTableSectionElement): void {
        tbody
            .querySelectorAll(
                ".border-outline-top, .border-outline-bottom, .border-outline-left, .border-outline-right, .corner-top-left, .corner-top-right, .corner-bottom-left, .corner-bottom-right"
            )
            .forEach((cell) =>
                cell.classList.remove(
                    "border-outline-top",
                    "border-outline-bottom",
                    "border-outline-left",
                    "border-outline-right",
                    "corner-top-left",
                    "corner-top-right",
                    "corner-bottom-left",
                    "corner-bottom-right"
                )
            );
    }

    applyOutlineStyles(
        tbody: HTMLTableSectionElement,
        targetYear: number,
        currentActualMonthIndex: number,
        forceFocusMonths: Set<number>
    ): void {
        this.clearAllOutlines(tbody);

        const cellsMap = new Map<string, HTMLElement>();
        tbody
            .querySelectorAll("td.calendar-cell[data-date][data-month-index]")
            .forEach((cellNode) => {
                if (cellNode instanceof HTMLElement && cellNode.dataset.date) {
                    cellsMap.set(cellNode.dataset.date, cellNode);
                }
            });

        const monthsToOutline = new Set<number>([
            currentActualMonthIndex,
            ...forceFocusMonths,
        ]);

        tbody
            .querySelectorAll("td.calendar-cell[data-month-index]")
            .forEach((cellNode) => {
                if (
                    !(
                        cellNode instanceof HTMLElement &&
                        cellNode.dataset.date &&
                        cellNode.dataset.monthIndex
                    )
                )
                    return;

                const cellMonthIndex = parseInt(cellNode.dataset.monthIndex, 10);
                if (!monthsToOutline.has(cellMonthIndex)) return;

                const cell = cellNode;
                const cellMoment = moment(cell.dataset.date, "YYYY-MM-DD");

                if (!cellMoment.isValid() || cellMoment.year() !== targetYear) return;

                const isTargetNeighbor = (
                    neighborCell: HTMLElement | undefined
                ): boolean => {
                    if (
                        !neighborCell ||
                        !neighborCell.dataset.date ||
                        !neighborCell.dataset.monthIndex
                    )
                        return false;
                    const neighborMoment = moment(
                        neighborCell.dataset.date,
                        "YYYY-MM-DD"
                    );
                    if (!neighborMoment.isValid() || neighborMoment.year() !== targetYear)
                        return false;
                    const neighborMonth = parseInt(neighborCell.dataset.monthIndex, 10);
                    return monthsToOutline.has(neighborMonth);
                };

                const dateAbove = cellMoment
                    .clone()
                    .subtract(7, "days")
                    .format("YYYY-MM-DD");
                const dateBelow = cellMoment
                    .clone()
                    .add(7, "days")
                    .format("YYYY-MM-DD");
                const dateLeft = cellMoment
                    .clone()
                    .subtract(1, "day")
                    .format("YYYY-MM-DD");
                const dateRight = cellMoment.clone().add(1, "day").format("YYYY-MM-DD");

                const cellAbove = cellsMap.get(dateAbove);
                const cellBelow = cellsMap.get(dateBelow);
                const cellLeft = cellsMap.get(dateLeft);
                const cellRight = cellsMap.get(dateRight);

                const needsTopBorder = !isTargetNeighbor(cellAbove);
                const needsBottomBorder = !isTargetNeighbor(cellBelow);
                const isoDayOfWeek = cellMoment.isoWeekday();
                const needsLeftBorder =
                    isoDayOfWeek === 1 || !isTargetNeighbor(cellLeft);
                const needsRightBorder =
                    isoDayOfWeek === 7 || !isTargetNeighbor(cellRight);

                if (needsTopBorder) cell.classList.add("border-outline-top");
                if (needsBottomBorder) cell.classList.add("border-outline-bottom");
                if (needsLeftBorder) cell.classList.add("border-outline-left");
                if (needsRightBorder) cell.classList.add("border-outline-right");
                if (needsTopBorder && needsLeftBorder)
                    cell.classList.add("corner-top-left");
                if (needsTopBorder && needsRightBorder)
                    cell.classList.add("corner-top-right");
                if (needsBottomBorder && needsLeftBorder)
                    cell.classList.add("corner-bottom-left");
                if (needsBottomBorder && needsRightBorder)
                    cell.classList.add("corner-bottom-right");
            });
    }

    revertWeekNumbers(container: HTMLElement) {
        container.querySelectorAll("td.week-number").forEach((cell) => {
            const isoWeekVal = cell.getAttribute("data-isoweek");
            const labelSpan = cell.querySelector(".week-number-text");
            if (labelSpan && isoWeekVal) {
                labelSpan.textContent = isoWeekVal;
            }
            cell.classList.remove("relative-week-mode");
        });
    }

    renumberWeeks(container: HTMLElement, clickedWeekIso: number) {
        container.querySelectorAll("td.week-number").forEach((cell) => {
            const isoWeekVal = parseInt(cell.getAttribute("data-isoweek") || "0", 10);
            const offset = isoWeekVal - clickedWeekIso;
            const labelSpan = cell.querySelector(".week-number-text");
            if (labelSpan) {
                labelSpan.textContent = isNaN(offset) ? "?" : offset.toString();
            }
            cell.classList.add("relative-week-mode");
        });
    }

    updateAllMonthIcons(forceFocusMonths: Set<number>, forceOpaqueMonths: Set<number>): void {
        const monthCells = this.containerEl.querySelectorAll(
            "td.month-column[data-month-index]"
        );
        monthCells.forEach((cellNode) => {
            if (!(cellNode instanceof HTMLElement)) return;
            const monthIndexStr = cellNode.dataset.monthIndex;
            if (!monthIndexStr) return;
            const monthIndex = parseInt(monthIndexStr, 10);

            const eyeIcon = cellNode.querySelector<HTMLElement>(
                ".month-toggle-opacity"
            );
            const focusIcon = cellNode.querySelector<HTMLElement>(
                ".month-toggle-focus"
            );

            if (eyeIcon) {
                const isEffectivelyOpaque =
                    forceOpaqueMonths.has(monthIndex) ||
                    forceFocusMonths.has(monthIndex);
                setIcon(eyeIcon, isEffectivelyOpaque ? "eye" : "eye-off");
                eyeIcon.setAttribute(
                    "aria-label",
                    isEffectivelyOpaque ? "Make month faded" : "Make month visible"
                );
            }
            if (focusIcon) {
                const isFocused = forceFocusMonths.has(monthIndex);
                setIcon(focusIcon, isFocused ? "minus-circle" : "plus-circle");
                focusIcon.setAttribute(
                    "aria-label",
                    isFocused ? "Remove month focus" : "Focus this month"
                );
            }
        });
    }

    redrawClassesAndOutlines(forceFocusMonths: Set<number>, forceOpaqueMonths: Set<number>): void {
        const year = this.plugin.settings.year;
        const now = moment();
        const currentActualMonthIndex = now.month();
        const tbody = this.containerEl.querySelector("tbody");
        if (!tbody) return;

        tbody
            .querySelectorAll("td.calendar-cell[data-month-index]")
            .forEach((cellNode) => {
                if (!(cellNode instanceof HTMLElement)) return;
                const cell = cellNode;
                const monthIndexStr = cell.dataset.monthIndex;
                if (!monthIndexStr) return;
                const monthIndex = parseInt(monthIndexStr, 10);

                const isCurrentMonth =
                    monthIndex === currentActualMonthIndex && year === now.year();
                const isForcedOpaque = forceOpaqueMonths.has(monthIndex);
                const isForcedFocus = forceFocusMonths.has(monthIndex);

                cell.classList.remove("is-faded", "force-focused-month");

                if (isForcedFocus) {
                    cell.classList.add("force-focused-month");
                } else if (isCurrentMonth) {
                } else if (!isForcedOpaque) {
                    cell.classList.add("is-faded");
                }
            });

        this.clearAllOutlines(tbody);
        this.applyOutlineStyles(tbody, year, currentActualMonthIndex, forceFocusMonths);
    }
}
