import { App, Notice, setIcon, moment } from "obsidian";
import { MyCalendarPluginSettings } from "./type";
import { CalendarRenderer } from "./calendarRenderer";

export interface CalendarController {
    app: App;
    settings: MyCalendarPluginSettings;
    calendarContentEl: HTMLElement;
    renderer: CalendarRenderer;
    forceOpaqueMonths: Set<number>;
    forceFocusMonths: Set<number>;
    saveSettings(): Promise<void>;
    refresh(): Promise<void>;
    openOrCreateDailyNote(date: moment.Moment, event: MouseEvent): Promise<void>;
    openOrCreateMonthlyNote(monthMoment: moment.Moment, event: MouseEvent): Promise<void>;
    createRangeNote(startDate: moment.Moment, endDate: moment.Moment): Promise<void>;
}

export class CalendarEventHandler {
    controller: CalendarController;
    activeWeekCell: HTMLElement | null = null;
    engagedDayNumberEl: HTMLElement | null = null;
    startRangeDate: moment.Moment | null = null;
    engagedStartRangeEl: HTMLElement | null = null;

    constructor(controller: CalendarController) {
        this.controller = controller;
    }

    handleClick(event: MouseEvent) {
        const target = event.target as HTMLElement;
        const isCmdClick = event.metaKey || event.ctrlKey;

        const clickedCloseButton = target.closest("button.close-button");
        const clickedInternalLink = target.closest("a.internal-link");
        const clickedMonthLabelText = target.closest(
            ".month-label-text.clickable-month-label"
        );
        const clickedWeekNumber = target.closest("td.week-number");
        const clickedDayCell = target.closest(
            "td.calendar-cell:not(.month-column)"
        );
        const clickedOpacityToggle = target.closest(".month-toggle-opacity");
        const clickedFocusToggle = target.closest(".month-toggle-focus");
        const clickedDayNumber = target.closest(".day-number");

        // Check if click is on one of our interactive elements
        if (
            clickedCloseButton ||
            clickedInternalLink ||
            clickedMonthLabelText ||
            clickedWeekNumber ||
            clickedOpacityToggle ||
            clickedFocusToggle ||
            (clickedDayCell && !clickedDayNumber && !target.closest(".expanded-row"))
        ) {
            this.clearDayNumberEngagement();

            if (clickedCloseButton) {
                this.handleCloseButton(clickedCloseButton as HTMLElement);
            } else if (clickedInternalLink) {
                this.handleInternalLink(clickedInternalLink as HTMLElement, event);
            } else if (clickedMonthLabelText) {
                this.handleMonthLabel(clickedMonthLabelText as HTMLElement, event);
            } else if (clickedWeekNumber) {
                this.handleWeekNumber(clickedWeekNumber as HTMLElement);
            } else if (clickedOpacityToggle) {
                this.handleOpacityToggle(clickedOpacityToggle as HTMLElement, event);
            } else if (clickedFocusToggle) {
                this.handleFocusToggle(clickedFocusToggle as HTMLElement, event);
            } else if (clickedDayCell && !target.closest(".expanded-row")) {
                this.handleDayCellExpand(clickedDayCell as HTMLElement);
            }
            return;
        }

        if (clickedDayNumber && !clickedDayNumber.closest(".expanded-row")) {
            this.handleDayNumberClick(clickedDayNumber as HTMLElement, event, isCmdClick);
            return;
        }

        if (
            target.closest(".continuous-calendar") &&
            !clickedCloseButton &&
            !clickedInternalLink &&
            !clickedDayNumber &&
            !clickedWeekNumber &&
            !clickedDayCell &&
            !clickedMonthLabelText &&
            !clickedOpacityToggle &&
            !clickedFocusToggle
        ) {
            this.clearDayNumberEngagement();
            console.log("Clicked empty space, clearing engagement.");
        }
    }

    private handleCloseButton(button: HTMLElement) {
        const expandedRow = button.closest("tr.expanded-row");
        if (expandedRow) {
            const tbody = expandedRow.parentElement;
            expandedRow.removeClass("show");
            setTimeout(() => {
                expandedRow.remove();
                tbody
                    ?.querySelectorAll("td.calendar-cell.expanded")
                    .forEach((cell) => {
                        cell.classList.remove("expanded");
                    });
            }, 300);
        }
    }

    private handleInternalLink(link: HTMLElement, event: MouseEvent) {
        event.preventDefault();
        const path = link.dataset.href || link.getAttribute("href");
        if (path) {
            const openInNewPane = event.ctrlKey || event.metaKey;
            this.controller.app.workspace.openLinkText(path, "", openInNewPane);
        } else {
            console.warn("Continuous Calendar: Clicked internal link missing path", link);
        }
    }

    private handleMonthLabel(label: HTMLElement, event: MouseEvent) {
        const parentCell = label.closest("td.month-column") as HTMLElement;
        if (
            parentCell &&
            parentCell.dataset.monthYear &&
            parentCell.dataset.monthIndex
        ) {
            event.preventDefault();
            const year = parseInt(parentCell.dataset.monthYear, 10);
            const monthIndex = parseInt(parentCell.dataset.monthIndex, 10);
            if (!isNaN(year) && !isNaN(monthIndex)) {
                const monthMoment = moment({
                    year: year,
                    month: monthIndex,
                    day: 1,
                });
                this.controller.openOrCreateMonthlyNote(monthMoment, event);
            } else {
                console.error(
                    "Could not parse year/month data from month label parent:",
                    parentCell.dataset
                );
            }
        }
    }

    private handleWeekNumber(weekNumberCell: HTMLElement) {
        if (this.activeWeekCell === weekNumberCell) {
            this.controller.renderer.revertWeekNumbers(this.controller.calendarContentEl);
            this.activeWeekCell = null;
        } else {
            if (this.activeWeekCell) {
                this.controller.renderer.revertWeekNumbers(this.controller.calendarContentEl);
            }
            this.activeWeekCell = weekNumberCell;
            const isoWeekAttr = weekNumberCell.getAttribute("data-isoweek");
            const clickedWeekIso = isoWeekAttr ? parseInt(isoWeekAttr, 10) : NaN;
            if (!isNaN(clickedWeekIso)) {
                this.controller.renderer.renumberWeeks(this.controller.calendarContentEl, clickedWeekIso);
            } else {
                console.error(
                    "Could not parse data-isoweek from clicked cell:",
                    weekNumberCell
                );
                this.controller.renderer.revertWeekNumbers(this.controller.calendarContentEl);
                this.activeWeekCell = null;
            }
        }
    }

    private handleOpacityToggle(toggle: HTMLElement, event: MouseEvent) {
        event.stopPropagation();
        const monthIndexStr = toggle.dataset.monthIndex;
        if (monthIndexStr) {
            const monthIndex = parseInt(monthIndexStr, 10);
            if (!isNaN(monthIndex)) {
                this.toggleMonthOpacity(monthIndex);
                const isEffectivelyOpaque =
                    this.controller.forceOpaqueMonths.has(monthIndex) ||
                    this.controller.forceFocusMonths.has(monthIndex);
                setIcon(
                    toggle,
                    isEffectivelyOpaque ? "eye" : "eye-off"
                );
                toggle.setAttribute(
                    "aria-label",
                    isEffectivelyOpaque ? "Make month faded" : "Make month visible"
                );
            }
        }
    }

    private handleFocusToggle(toggle: HTMLElement, event: MouseEvent) {
        event.stopPropagation();
        const monthIndexStr = toggle.dataset.monthIndex;
        if (monthIndexStr) {
            const monthIndex = parseInt(monthIndexStr, 10);
            if (!isNaN(monthIndex)) {
                this.toggleMonthFocus(monthIndex);
                const isFocused = this.controller.forceFocusMonths.has(monthIndex);
                const isEffectivelyOpaque =
                    this.controller.forceOpaqueMonths.has(monthIndex) || isFocused;
                setIcon(
                    toggle,
                    isFocused ? "minus-circle" : "plus-circle"
                );
                toggle.setAttribute(
                    "aria-label",
                    isFocused ? "Remove month focus" : "Focus this month"
                );
                const parentWrapper = toggle.closest(
                    ".month-cell-wrapper"
                );
                const eyeIcon = parentWrapper?.querySelector<HTMLElement>(
                    ".month-toggle-opacity"
                );
                if (eyeIcon) {
                    setIcon(eyeIcon, isEffectivelyOpaque ? "eye" : "eye-off");
                    eyeIcon.setAttribute(
                        "aria-label",
                        isEffectivelyOpaque ? "Make month faded" : "Make month visible"
                    );
                }
            }
        }
    }

    private handleDayCellExpand(cell: HTMLElement) {
        const currentRow = cell.parentElement as HTMLTableRowElement;
        if (!currentRow) return;
        const tbody = currentRow.parentElement as HTMLTableSectionElement;
        if (!tbody) return;
        const existingExpanded = tbody.querySelector("tr.expanded-row");
        let clickedCellWasExpanded =
            cell.classList.contains("expanded");
        if (existingExpanded) {
            existingExpanded.remove();
            tbody
                .querySelectorAll("td.calendar-cell.expanded")
                .forEach((expandedCell) => {
                    expandedCell.classList.remove("expanded");
                });
        }
        if (!clickedCellWasExpanded) {
            const contentHtml = cell.dataset.cellContent;
            if (!contentHtml) return;
            cell.classList.add("expanded");
            const expandedRow = document.createElement("tr");
            expandedRow.classList.add("expanded-row");
            const colspan = 9;
            const expandedCell = document.createElement("td");
            expandedCell.setAttribute("colspan", colspan.toString());
            expandedCell.innerHTML = contentHtml;
            expandedRow.appendChild(expandedCell);
            currentRow.after(expandedRow);
            setTimeout(() => expandedRow.classList.add("show"), 10);
        }
    }

    private handleDayNumberClick(dayNumber: HTMLElement, event: MouseEvent, isCmdClick: boolean) {
        event.preventDefault();
        const cell = dayNumber.closest("td.calendar-cell") as HTMLElement;
        if (!cell || !cell.dataset.date) {
            console.warn("Could not find parent cell/date for day number click");
            this.clearDayNumberEngagement();
            return;
        }

        const dateStr = cell.dataset.date;
        const dateMoment = moment(dateStr, "YYYY-MM-DD");
        if (!dateMoment.isValid()) {
            console.warn("Invalid date on cell for day number click:", dateStr);
            this.clearDayNumberEngagement();
            return;
        }

        if (isCmdClick) {
            if (this.startRangeDate && this.engagedStartRangeEl) {
                const endRangeDate = dateMoment;

                let finalStartDate = this.startRangeDate;
                let finalEndDate = endRangeDate;
                if (endRangeDate.isBefore(finalStartDate)) {
                    console.log("End date is before start date, swapping.");
                    finalStartDate = endRangeDate;
                    finalEndDate = this.startRangeDate;
                }

                console.log(
                    `Cmd+Click: Range selected from ${finalStartDate.format("YYYY-MM-DD")} to ${finalEndDate.format("YYYY-MM-DD")}`
                );

                this.controller.createRangeNote(finalStartDate, finalEndDate);

                this.clearDayNumberEngagement();
            } else {
                new Notice("Please click a start date first (without Cmd/Ctrl).");
                this.clearDayNumberEngagement();
            }
        } else {
            if (this.engagedStartRangeEl === dayNumber) {
                console.log("Second normal click on same day number:", dateStr);
                this.controller.openOrCreateDailyNote(dateMoment, event);
                this.clearDayNumberEngagement();
            } else {
                console.log(
                    "Normal click, setting as potential range start:",
                    dateStr
                );
                this.clearDayNumberEngagement();

                this.startRangeDate = dateMoment;
                this.engagedStartRangeEl = dayNumber;
                this.engagedStartRangeEl.classList.add("range-start-engaged");

                this.engagedDayNumberEl = dayNumber;
                this.engagedDayNumberEl.classList.add("engaged");
            }
        }
    }

    clearDayNumberEngagement() {
        if (this.engagedDayNumberEl) {
            this.engagedDayNumberEl.classList.remove("engaged");
            this.engagedDayNumberEl = null;
        }
        if (this.engagedStartRangeEl) {
            this.engagedStartRangeEl.classList.remove("range-start-engaged");
            this.engagedStartRangeEl = null;
        }
        this.startRangeDate = null;
    }

    private toggleMonthOpacity(monthIndex: number): void {
        const dayCells = this.controller.calendarContentEl.querySelectorAll(
            `.calendar-cell[data-month-index="${monthIndex}"]`
        );
        const isCurrentlyForcedOpaque = this.controller.forceOpaqueMonths.has(monthIndex);
        const isCurrentlyForcedFocused = this.controller.forceFocusMonths.has(monthIndex);
        const now = moment();
        const currentActualMonthIndex = now.month();
        const isTheCurrentMonth =
            monthIndex === currentActualMonthIndex &&
            this.controller.settings.year === now.year();

        if (isCurrentlyForcedOpaque) {
            this.controller.forceOpaqueMonths.delete(monthIndex);
            if (!isTheCurrentMonth && !isCurrentlyForcedFocused) {
                dayCells.forEach((cell) => cell.classList.add("is-faded"));
            }
        } else {
            this.controller.forceOpaqueMonths.add(monthIndex);
            dayCells.forEach((cell) => cell.classList.remove("is-faded"));
        }
        this.controller.saveSettings();
    }

    private toggleMonthFocus(monthIndex: number): void {
        const dayCells = this.controller.calendarContentEl.querySelectorAll(
            `.calendar-cell[data-month-index="${monthIndex}"]`
        );
        const tbody = this.controller.calendarContentEl.querySelector("tbody");
        if (!tbody) return;

        const now = moment();
        const currentActualMonthIndex = now.month();
        const isTheCurrentMonth =
            monthIndex === currentActualMonthIndex &&
            this.controller.settings.year === now.year();
        const isCurrentlyForcedFocused = this.controller.forceFocusMonths.has(monthIndex);

        if (isCurrentlyForcedFocused) {
            this.controller.forceFocusMonths.delete(monthIndex);
            this.controller.forceOpaqueMonths.delete(monthIndex);
            dayCells.forEach((cell) => cell.classList.remove("force-focused-month"));
            if (!isTheCurrentMonth && !this.controller.forceOpaqueMonths.has(monthIndex)) {
                dayCells.forEach((cell) => cell.classList.add("is-faded"));
            }
        } else {
            this.controller.forceFocusMonths.add(monthIndex);
            if (!this.controller.forceOpaqueMonths.has(monthIndex)) {
                this.controller.forceOpaqueMonths.add(monthIndex);
            }
            dayCells.forEach((cell) => cell.classList.remove("is-faded"));
            dayCells.forEach((cell) => cell.classList.add("force-focused-month"));
        }

        this.controller.renderer.clearAllOutlines(tbody);
        this.controller.renderer.applyOutlineStyles(
            tbody,
            this.controller.settings.year,
            currentActualMonthIndex,
            this.controller.forceFocusMonths
        );
        this.controller.saveSettings();
        this.controller.renderer.updateAllMonthIcons(this.controller.forceFocusMonths, this.controller.forceOpaqueMonths);
    }

    attachControlsListeners() {
        const resetButton = this.controller.calendarContentEl.querySelector(".reset-focus-button");
        if (resetButton) {
            resetButton.addEventListener("click", () => {
                this.controller.forceFocusMonths.clear();
                this.controller.forceOpaqueMonths.clear();
                this.controller.saveSettings();
                this.controller.renderer.redrawClassesAndOutlines(this.controller.forceFocusMonths, this.controller.forceOpaqueMonths);
                this.controller.renderer.updateAllMonthIcons(this.controller.forceFocusMonths, this.controller.forceOpaqueMonths);
                new Notice("Focus states reset");
            });
        }

        const relocateButton = this.controller.calendarContentEl.querySelector(".relocate-button");
        if (relocateButton) {
            relocateButton.addEventListener("click", () => {
                const now = moment();
                const currentTbody = this.controller.calendarContentEl.querySelector("tbody");
                if (currentTbody) {
                    this.controller.renderer.scrollToDate(currentTbody, now, this.controller.settings.year);
                    new Notice("Relocated to current week.");
                } else {
                    console.error("Could not find tbody to relocate.");
                }
            });
        }

        const updateButton = this.controller.calendarContentEl.querySelector(".year-update-button") as HTMLElement;
        const yearInput = this.controller.calendarContentEl.querySelector(".year-input") as HTMLInputElement;

        if (updateButton && yearInput) {
            updateButton.addEventListener("click", async () => {
                const newYearStr = yearInput.value.trim();
                const newYear = parseInt(newYearStr);

                if (!isNaN(newYear) && newYear > 1000 && newYear < 3000) {
                    if (newYear !== this.controller.settings.year) {
                        this.controller.settings.year = newYear;
                        await this.controller.saveSettings();
                        new Notice(`Loading calendar for ${newYear}...`);
                        this.controller.refresh();
                    }
                } else {
                    new Notice("Please enter a valid year (e.g., 2024).");
                    yearInput.value = this.controller.settings.year.toString();
                }
            });

            yearInput.addEventListener("keydown", (event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    updateButton.click(); // Trigger click handler
                }
            });
        }

        const refreshButton = this.controller.calendarContentEl.querySelector(".calendar-refresh-button");
        if (refreshButton) {
            refreshButton.addEventListener("click", async () => {
                new Notice("Refreshing calendar data...");
                await this.controller.refresh();
                new Notice("Calendar refreshed!");
            });
        }
    }
}
