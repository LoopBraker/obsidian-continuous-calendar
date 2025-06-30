// src/view.ts
import {
  ItemView,
  WorkspaceLeaf,
  TFile,
  moment,
  Notice,
  setIcon,
  TFolder,
} from "obsidian";
import {
  getDailyNoteSettings,
  createDailyNote,
  getAllDailyNotes,
  getDailyNote,
  getDateFromFile,
} from "obsidian-daily-notes-interface";

import MyCalendarPlugin from "./main";
import { Holiday } from "./types"; // Keep Holiday type if used elsewhere
import { createConfirmationDialog } from "./modal";
import { AggregatedHolidayInfo } from "./holidayService";
import { TagAppearance } from "./types";
export const CALENDAR_VIEW_TYPE = "yearly-calendar-view";

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

// Define a type for our indexed calendar data for clarity
type IndexedCalendarData = {
  notesByDate: Map<string, any[]>;
  birthdaysByDate: Map<string, any[]>;
  allRanges: any[];
};

export class CalendarView extends ItemView {
  plugin: MyCalendarPlugin;
  calendarContentEl: HTMLElement;
  activeWeekCell: HTMLElement | null = null;
  engagedDayNumberEl: HTMLElement | null = null;
  private forceOpaqueMonths: Set<number> = new Set();
  private forceFocusMonths: Set<number> = new Set();
  private currentYearHolidays: Map<string, AggregatedHolidayInfo[]> = new Map();
  private startRangeDate: moment.Moment | null = null;
  private engagedStartRangeEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: MyCalendarPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return CALENDAR_VIEW_TYPE;
  }

  getDisplayText(): string {
    return `Year Calendar - ${this.plugin.settings.year}`;
  }

  getIcon(): string {
    return "calendar-days";
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();

    this.calendarContentEl = container.createDiv({
      cls: "continuous-calendar",
    });

    this.forceFocusMonths = new Set(this.plugin.settings.focusedMonths || []);
    this.forceOpaqueMonths = new Set(this.plugin.settings.opaqueMonths || []);

    await this.renderCalendar();

    this.registerDomEvent(
      this.calendarContentEl,
      "click",
      this.handleClick.bind(this)
    );
  }

  async onClose() {
    this.activeWeekCell = null;
    this.forceOpaqueMonths.clear();
    this.forceFocusMonths.clear();
    this.startRangeDate = null; // Clear state on close
    this.engagedStartRangeEl = null;
  }

  async refresh() {
    this.updateTitle();
    await this.renderCalendar();
  }

  async updateTitle() {
    const newTitle = `Year Calendar - ${this.plugin.settings.year}`;
    const leaf = this.leaf;
    if (leaf && leaf.view === this) {
      try {
        const state = leaf.getViewState();
        if (state && state.state) {
          await leaf.setViewState({
            ...state,
            state: { ...state.state, title: newTitle },
          });
        } else {
          await leaf.setViewState({
            type: this.getViewType(),
            state: { title: newTitle },
          });
        }
        this.leaf.updateHeader();
      } catch (e) {
        console.error("Error trying to update view state for title:", e);
        this.leaf.updateHeader();
      }
    } else {
      this.leaf?.updateHeader();
    }
  }

  /**
   * Scans the vault once and indexes all relevant notes by date for fast lookups.
   * This is the primary performance optimization.
   */
  private async collectAndIndexCalendarData(): Promise<IndexedCalendarData> {
    const notesByDate = new Map<string, any[]>();
    const birthdaysByDate = new Map<string, any[]>();
    const allRanges: any[] = [];

    const allFiles = this.app.vault.getMarkdownFiles();
    const birthdayFolder =
      this.plugin.settings.birthdayFolder.toLowerCase() + "/";
    const hasBirthdayFolderSetting =
      this.plugin.settings.birthdayFolder.trim() !== "";
    const tagAppearanceSettings: Record<string, TagAppearance> =
      this.plugin.settings.tagAppearance;

    for (const file of allFiles) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (!fm) continue;

      // --- Collect Base Information ---
      const explicitColor = fm.color ? fm.color.toString() : undefined;
      const explicitSymbol = fm.symbol ? fm.symbol.toString() : undefined;
      let defaultColorFromTag: string | undefined = undefined;
      let defaultSymbolFromTag: string | undefined = undefined;
      let noteTags: string[] = [];

      // --- Process Tags to find defaults (if no explicit color/symbol) ---
      if ((!explicitColor || !explicitSymbol) && fm.tags) {
        let rawTags: any[] = [];
        if (typeof fm.tags === "string") {
          rawTags = fm.tags
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t);
        } else if (Array.isArray(fm.tags)) {
          rawTags = fm.tags.map((t) => String(t).trim()).filter((t) => t);
        }
        noteTags = rawTags.map((tag) =>
          tag.startsWith("#") ? tag : `#${tag}`
        );

        for (const tag of noteTags) {
          const appearance = tagAppearanceSettings[tag];
          if (appearance) {
            if (!defaultColorFromTag) defaultColorFromTag = appearance.color;
            if (!defaultSymbolFromTag && appearance.symbol)
              defaultSymbolFromTag = appearance.symbol;
            if (defaultColorFromTag && defaultSymbolFromTag) break; // Optimization: stop if both found
          }
        }
      }

      const baseNoteData = {
        file: file,
        name: file.basename,
        path: file.path,
        color: explicitColor,
        symbol: explicitSymbol,
        defaultColorFromTag: defaultColorFromTag,
        defaultSymbolFromTag: defaultSymbolFromTag,
        tags: noteTags,
      };

      // --- Index Single-Date Notes ---
      if (fm.date) {
        const mDate = moment(fm.date.toString(), "YYYY-MM-DD", true);
        if (mDate.isValid()) {
          const dateStr = mDate.format("YYYY-MM-DD");
          if (!notesByDate.has(dateStr)) {
            notesByDate.set(dateStr, []);
          }
          notesByDate.get(dateStr)?.push({ ...baseNoteData, date: dateStr });
        }
      }

      // --- Index Date-Range Notes ---
      if (fm.dateStart && fm.dateEnd) {
        const mStart = moment(fm.dateStart.toString(), "YYYY-MM-DD", true);
        const mEnd = moment(fm.dateEnd.toString(), "YYYY-MM-DD", true);
        if (mStart.isValid() && mEnd.isValid()) {
          allRanges.push({
            ...baseNoteData,
            dateStart: mStart.format("YYYY-MM-DD"),
            dateEnd: mEnd.format("YYYY-MM-DD"),
          });
        }
      }

      // --- Index Birthdays ---
      if (
        fm.birthday &&
        (!hasBirthdayFolderSetting ||
          file.path.toLowerCase().startsWith(birthdayFolder))
      ) {
        const mBday = moment(fm.birthday.toString(), "YYYY-MM-DD", true);
        if (mBday.isValid()) {
          const monthDayStr = mBday.format("MM-DD");
          if (!birthdaysByDate.has(monthDayStr)) {
            birthdaysByDate.set(monthDayStr, []);
          }
          birthdaysByDate
            .get(monthDayStr)
            ?.push({ ...baseNoteData, birthday: mBday.format("YYYY-MM-DD") });
        }
      }
    }

    return { notesByDate, birthdaysByDate, allRanges };
  }

  async renderCalendar() {
    if (!this.plugin.holidayService) {
      console.error("Holiday service not available in CalendarView.");
      this.calendarContentEl.setText("Error: Holiday service failed to load.");
      return;
    }

    this.calendarContentEl.empty();
    this.activeWeekCell = null;

    const scrollContainer = this.calendarContentEl.createDiv({
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

    // --- Perform the expensive data collection and indexing ONCE ---
    const { notesByDate, birthdaysByDate, allRanges } =
      await this.collectAndIndexCalendarData();

    console.log("Fetching aggregated holidays for year:", year);
    this.currentYearHolidays =
      await this.plugin.holidayService.getAggregatedHolidays(year);
    console.log("Fetched holidays map:", this.currentYearHolidays);

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

      /***********************************************************************
       *  BUILD DAILY SLOT ASSIGNMENTS for RANGES
       ***********************************************************************/
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

        const holidaysInfo = this.currentYearHolidays.get(dateStr) || [];
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

        const isForcedOpaque = this.forceOpaqueMonths.has(monthIndex);
        const isForcedFocus = this.forceFocusMonths.has(monthIndex);

        // --- Perform FAST lookups instead of slow filters ---
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

        // Expanded Content HTML generation (no change in logic)
        let expandedHTML = `<div class="expanded-content">`;
        expandedHTML += `<button class="close-button" aria-label="Close">×</button>`;
        const normalizedNow = now.startOf("day");
        const normalizedDay = day.startOf("day");
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
              return `<li><a class="internal-link" data-href="${p.path}" href="${p.path}" style="color: ${linkStyleColor};">${p.name}</a></li>`;
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
              "aria-label": this.forceOpaqueMonths.has(monthIndex)
                ? "Make month visible"
                : "Make month faded",
            },
          });
          opacityIcon.dataset.monthIndex = monthIndex.toString();
          setIcon(
            opacityIcon,
            this.forceOpaqueMonths.has(monthIndex) ||
              this.forceFocusMonths.has(monthIndex)
              ? "eye"
              : "eye-off"
          );

          const focusCell = wrapper.createDiv({ cls: "month-action-cell" });
          const focusIcon = focusCell.createSpan({
            cls: "month-action-icon month-toggle-focus",
            attr: {
              "aria-label": this.forceFocusMonths.has(monthIndex)
                ? "Remove focus"
                : "Focus month",
            },
          });
          focusIcon.dataset.monthIndex = monthIndex.toString();
          setIcon(
            focusIcon,
            this.forceFocusMonths.has(monthIndex)
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

    const controlsBottomContainer = this.calendarContentEl.createDiv({
      cls: "calendar-controls-bottom",
    });

    const focusControlsGroup = controlsBottomContainer.createDiv({
      cls: "focus-controls",
    });

    const resetButton = focusControlsGroup.createEl("button", {
      text: "Reset Focus",
      cls: "reset-focus-button",
    });
    resetButton.addEventListener("click", () => {
      this.forceFocusMonths.clear();
      this.forceOpaqueMonths.clear();
      this.saveFocusStates();
      this.redrawClassesAndOutlines();
      this.updateAllMonthIcons();
      new Notice("Focus states reset");
    });

    const relocateButton = focusControlsGroup.createEl("button", {
      cls: "relocate-button",
      attr: {
        "aria-label": "Relocate to current week",
      },
    });
    setIcon(relocateButton, "compass");
    relocateButton.addEventListener("click", () => {
      const now = moment();
      const currentTbody = scrollContainer.querySelector("tbody");
      if (currentTbody) {
        this.scrollToCurrent(currentTbody, now, this.plugin.settings.year);
        new Notice("Relocated to current week.");
      } else {
        console.error("Could not find tbody to relocate.");
      }
    });

    this.addYearSelectorControls(controlsBottomContainer, year);

    const currentMonthIndex = now.month();
    this.applyOutlineStyles(tbody, year, currentMonthIndex);
    this.scrollToCurrent(tbody, now, year);
  }

  private saveFocusStates() {
    this.plugin.settings.focusedMonths = Array.from(this.forceFocusMonths);
    this.plugin.settings.opaqueMonths = Array.from(this.forceOpaqueMonths);
    this.plugin.saveSettings();
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
    refreshButton.addEventListener("click", async () => {
      new Notice("Refreshing calendar data...");
      await this.refresh();
      new Notice("Calendar refreshed!");
    });

    updateButton.addEventListener("click", async () => {
      const newYearStr = yearInput.value.trim();
      const newYear = parseInt(newYearStr);

      if (!isNaN(newYear) && newYear > 1000 && newYear < 3000) {
        if (newYear !== this.plugin.settings.year) {
          this.plugin.settings.year = newYear;
          await this.plugin.saveSettings();
          new Notice(`Loading calendar for ${newYear}...`);
          this.refresh();
        }
      } else {
        new Notice("Please enter a valid year (e.g., 2024).");
        yearInput.value = this.plugin.settings.year.toString();
      }
    });

    yearInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        updateButton.click();
      }
    });
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
      const scrollContainer = this.calendarContentEl.querySelector(
        ".calendar-scroll-container"
      );
      if (scrollContainer) {
        targetCell.scrollIntoView({ behavior: "auto", block: "center" });
      }
    }
  }

  private clearAllOutlines(tbody: HTMLTableSectionElement): void {
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

  private redrawClassesAndOutlines(): void {
    const year = this.plugin.settings.year;
    const now = moment();
    const currentActualMonthIndex = now.month();
    const tbody = this.calendarContentEl.querySelector("tbody");
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
        const isForcedOpaque = this.forceOpaqueMonths.has(monthIndex);
        const isForcedFocus = this.forceFocusMonths.has(monthIndex);

        cell.classList.remove("is-faded", "force-focused-month");

        if (isForcedFocus) {
          cell.classList.add("force-focused-month");
        } else if (isCurrentMonth) {
        } else if (!isForcedOpaque) {
          cell.classList.add("is-faded");
        }
      });

    this.clearAllOutlines(tbody);
    this.applyOutlineStyles(tbody, year, currentActualMonthIndex);
  }

  private updateAllMonthIcons(): void {
    const monthCells = this.calendarContentEl.querySelectorAll(
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
          this.forceOpaqueMonths.has(monthIndex) ||
          this.forceFocusMonths.has(monthIndex);
        setIcon(eyeIcon, isEffectivelyOpaque ? "eye" : "eye-off");
        eyeIcon.setAttribute(
          "aria-label",
          isEffectivelyOpaque ? "Make month faded" : "Make month visible"
        );
      }
      if (focusIcon) {
        const isFocused = this.forceFocusMonths.has(monthIndex);
        setIcon(focusIcon, isFocused ? "minus-circle" : "plus-circle");
        focusIcon.setAttribute(
          "aria-label",
          isFocused ? "Remove month focus" : "Focus this month"
        );
      }
    });
  }

  private toggleMonthOpacity(monthIndex: number): void {
    const dayCells = this.calendarContentEl.querySelectorAll(
      `.calendar-cell[data-month-index="${monthIndex}"]`
    );
    const isCurrentlyForcedOpaque = this.forceOpaqueMonths.has(monthIndex);
    const isCurrentlyForcedFocused = this.forceFocusMonths.has(monthIndex);
    const now = moment();
    const currentActualMonthIndex = now.month();
    const isTheCurrentMonth =
      monthIndex === currentActualMonthIndex &&
      this.plugin.settings.year === now.year();

    if (isCurrentlyForcedOpaque) {
      this.forceOpaqueMonths.delete(monthIndex);
      if (!isTheCurrentMonth && !isCurrentlyForcedFocused) {
        dayCells.forEach((cell) => cell.classList.add("is-faded"));
      }
    } else {
      this.forceOpaqueMonths.add(monthIndex);
      dayCells.forEach((cell) => cell.classList.remove("is-faded"));
    }
    this.saveFocusStates();
  }

  private toggleMonthFocus(monthIndex: number): void {
    const dayCells = this.calendarContentEl.querySelectorAll(
      `.calendar-cell[data-month-index="${monthIndex}"]`
    );
    const tbody = this.calendarContentEl.querySelector("tbody");
    if (!tbody) return;

    const now = moment();
    const currentActualMonthIndex = now.month();
    const isTheCurrentMonth =
      monthIndex === currentActualMonthIndex &&
      this.plugin.settings.year === now.year();
    const isCurrentlyForcedFocused = this.forceFocusMonths.has(monthIndex);

    if (isCurrentlyForcedFocused) {
      this.forceFocusMonths.delete(monthIndex);
      this.forceOpaqueMonths.delete(monthIndex);
      dayCells.forEach((cell) => cell.classList.remove("force-focused-month"));
      if (!isTheCurrentMonth && !this.forceOpaqueMonths.has(monthIndex)) {
        dayCells.forEach((cell) => cell.classList.add("is-faded"));
      }
    } else {
      this.forceFocusMonths.add(monthIndex);
      if (!this.forceOpaqueMonths.has(monthIndex)) {
        this.forceOpaqueMonths.add(monthIndex);
      }
      dayCells.forEach((cell) => cell.classList.remove("is-faded"));
      dayCells.forEach((cell) => cell.classList.add("force-focused-month"));
    }

    this.clearAllOutlines(tbody);
    this.applyOutlineStyles(
      tbody,
      this.plugin.settings.year,
      currentActualMonthIndex
    );
    this.saveFocusStates();
    this.updateAllMonthIcons();
  }

  handleClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const isCmdClick = event.metaKey || event.ctrlKey; // Check for Cmd (Mac) or Ctrl (Win/Linux)

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
        const expandedRow = clickedCloseButton.closest("tr.expanded-row");
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
      } else if (clickedInternalLink) {
        event.preventDefault();
        const path =
          clickedInternalLink.dataset.href ||
          clickedInternalLink.getAttribute("href");
        if (path) {
          const openInNewPane = event.ctrlKey || event.metaKey;
          this.app.workspace.openLinkText(path, "", openInNewPane);
        } else {
          console.warn(
            "Continuous Calendar: Clicked internal link missing path",
            clickedInternalLink
          );
        }
      } else if (clickedMonthLabelText) {
        const parentCell = clickedMonthLabelText.closest("td.month-column");
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
            this.openOrCreateMonthlyNote(monthMoment, event);
          } else {
            console.error(
              "Could not parse year/month data from month label parent:",
              parentCell.dataset
            );
          }
        }
      } else if (clickedWeekNumber) {
        if (this.activeWeekCell === clickedWeekNumber) {
          this.revertWeekNumbers(this.calendarContentEl);
          this.activeWeekCell = null;
        } else {
          if (this.activeWeekCell) {
            this.revertWeekNumbers(this.calendarContentEl);
          }
          this.activeWeekCell = clickedWeekNumber as HTMLElement;
          const isoWeekAttr = clickedWeekNumber.getAttribute("data-isoweek");
          const clickedWeekIso = isoWeekAttr ? parseInt(isoWeekAttr, 10) : NaN;
          if (!isNaN(clickedWeekIso)) {
            this.renumberWeeks(this.calendarContentEl, clickedWeekIso);
          } else {
            console.error(
              "Could not parse data-isoweek from clicked cell:",
              clickedWeekNumber
            );
            this.revertWeekNumbers(this.calendarContentEl);
            this.activeWeekCell = null;
          }
        }
      } else if (clickedOpacityToggle) {
        event.stopPropagation();
        const monthIndexStr = clickedOpacityToggle.dataset.monthIndex;
        if (monthIndexStr) {
          const monthIndex = parseInt(monthIndexStr, 10);
          if (!isNaN(monthIndex)) {
            this.toggleMonthOpacity(monthIndex);
            const isEffectivelyOpaque =
              this.forceOpaqueMonths.has(monthIndex) ||
              this.forceFocusMonths.has(monthIndex);
            setIcon(
              clickedOpacityToggle,
              isEffectivelyOpaque ? "eye" : "eye-off"
            );
            clickedOpacityToggle.setAttribute(
              "aria-label",
              isEffectivelyOpaque ? "Make month faded" : "Make month visible"
            );
          }
        }
      } else if (clickedFocusToggle) {
        event.stopPropagation();
        const monthIndexStr = clickedFocusToggle.dataset.monthIndex;
        if (monthIndexStr) {
          const monthIndex = parseInt(monthIndexStr, 10);
          if (!isNaN(monthIndex)) {
            this.toggleMonthFocus(monthIndex);
            const isFocused = this.forceFocusMonths.has(monthIndex);
            const isEffectivelyOpaque =
              this.forceOpaqueMonths.has(monthIndex) || isFocused;
            setIcon(
              clickedFocusToggle,
              isFocused ? "minus-circle" : "plus-circle"
            );
            clickedFocusToggle.setAttribute(
              "aria-label",
              isFocused ? "Remove month focus" : "Focus this month"
            );
            const parentWrapper = clickedFocusToggle.closest(
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
      } else if (clickedDayCell && !target.closest(".expanded-row")) {
        const currentRow = clickedDayCell.parentElement as HTMLTableRowElement;
        if (!currentRow) return;
        const tbody = currentRow.parentElement as HTMLTableSectionElement;
        if (!tbody) return;
        const existingExpanded = tbody.querySelector("tr.expanded-row");
        let clickedCellWasExpanded =
          clickedDayCell.classList.contains("expanded");
        if (existingExpanded) {
          existingExpanded.remove();
          tbody
            .querySelectorAll("td.calendar-cell.expanded")
            .forEach((expandedCell) => {
              expandedCell.classList.remove("expanded");
            });
        }
        if (!clickedCellWasExpanded) {
          const contentHtml = clickedDayCell.dataset.cellContent;
          if (!contentHtml) return;
          clickedDayCell.classList.add("expanded");
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
      return;
    }

    if (clickedDayNumber && !clickedDayNumber.closest(".expanded-row")) {
      event.preventDefault();
      const cell = clickedDayNumber.closest("td.calendar-cell");
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

          this.createRangeNote(finalStartDate, finalEndDate);

          this.clearDayNumberEngagement();
        } else {
          new Notice("Please click a start date first (without Cmd/Ctrl).");
          this.clearDayNumberEngagement();
        }
      } else {
        if (this.engagedStartRangeEl === clickedDayNumber) {
          console.log("Second normal click on same day number:", dateStr);
          this.openOrCreateDailyNote(dateMoment, event);
          this.clearDayNumberEngagement();
        } else {
          console.log(
            "Normal click, setting as potential range start:",
            dateStr
          );
          this.clearDayNumberEngagement();

          this.startRangeDate = dateMoment;
          this.engagedStartRangeEl = clickedDayNumber;
          this.engagedStartRangeEl.classList.add("range-start-engaged");

          this.engagedDayNumberEl = clickedDayNumber;
          this.engagedDayNumberEl.classList.add("engaged");
        }
      }
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

  applyOutlineStyles(
    tbody: HTMLTableSectionElement,
    targetYear: number,
    currentActualMonthIndex: number
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
      ...this.forceFocusMonths,
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

  async openOrCreateDailyNote(
    date: moment.Moment,
    event: MouseEvent
  ): Promise<void> {
    const { workspace } = this.app;
    const allDailyNotes = getAllDailyNotes();
    const existingFile = getDailyNote(date, allDailyNotes);
    const openInNewPane = event.ctrlKey || event.metaKey;

    const performCreateAndOpen = async () => {
      try {
        console.log(`Creating daily note for: ${date.format("YYYY-MM-DD")}`);
        const newFile = await createDailyNote(date);
        console.log(`Created daily note: ${newFile.path}`);
        await workspace.openLinkText(newFile.path, "", openInNewPane);
      } catch (err) {
        console.error(
          `Failed to create daily note for ${date.format("YYYY-MM-DD")}:`,
          err
        );
      }
    };

    if (existingFile) {
      console.log(`Opening existing daily note: ${existingFile.path}`);
      await workspace.openLinkText(existingFile.path, "", openInNewPane);
    } else {
      if (this.plugin.settings.shouldConfirmBeforeCreate) {
        createConfirmationDialog(this.app, {
          title: "Create Daily Note?",
          text: `Daily note for ${date.format("YYYY-MM-DD")} does not exist. Create it now?`,
          cta: "Create",
          onAccept: performCreateAndOpen,
        });
      } else {
        await performCreateAndOpen();
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

  async openOrCreateMonthlyNote(
    monthMoment: moment.Moment,
    event: MouseEvent
  ): Promise<void> {
    console.log(
      "Attempting to open/create monthly note for:",
      monthMoment.format("YYYY-MM")
    );
    const { workspace, vault } = this.app;
    const openInNewPane = event.ctrlKey || event.metaKey;
    const periodicNotes = (this.app as any).plugins.plugins["periodic-notes"];

    if (!periodicNotes) {
      console.warn(
        "Periodic Notes plugin not found. Cannot create monthly note."
      );
      return;
    }

    if (!periodicNotes.settings?.monthly?.enabled) {
      console.warn("Monthly notes are not enabled in Periodic Notes settings.");
      return;
    }

    const { folder, format, template } = periodicNotes.settings.monthly;
    const fileName = monthMoment.format(format || "YYYY-MM") + ".md";
    const folderPath = folder?.trim() || "";
    const fullPath = folderPath ? `${folderPath}/${fileName}` : fileName;

    console.log(`Using Periodic Notes. Full path: ${fullPath}`);

    try {
      let file = vault.getAbstractFileByPath(fullPath);
      if (file instanceof TFile) {
        // Open existing monthly note
        await workspace.getLeaf(openInNewPane).openFile(file, { active: true });
      } else {
        // Create new monthly note with template
        let content = "";
        if (template) {
          const templateFile = vault.getAbstractFileByPath(template);
          if (templateFile instanceof TFile) {
            content = await vault.read(templateFile);
          }
        }
        const createdFile = await vault.create(fullPath, content);
        await workspace
          .getLeaf(openInNewPane)
          .openFile(createdFile, { active: true });
      }
    } catch (err) {
      console.error("Error handling monthly note:", err);
    }
  }

  async createRangeNote(
    startDate: moment.Moment,
    endDate: moment.Moment
  ): Promise<void> {
    const performCreateAndOpen = async () => {
      const templatePath = "Utilities/Templates/rangeNoteTemplate.md"; // Make this a setting later!
      const defaultFolder = ""; // Root folder - make this a setting later!
      const defaultColor = "var(--color-purple-tint)"; // Or leave empty, or make a setting

      let noteContent = `---
dateStart: ${startDate.format("YYYY-MM-DD")}
dateEnd: ${endDate.format("YYYY-MM-DD")}
tags:
  - goals🎖️
  - note/fleetingNote🗒️
color: ${defaultColor}
showCal: true
---

`;

      try {
        const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
        if (templateFile instanceof TFile) {
          const templateFullContent =
            await this.app.vault.cachedRead(templateFile);
          const templateParts = templateFullContent.split("---");
          if (templateParts.length >= 3) {
            const templateBody = templateParts.slice(2).join("---").trim();
            if (templateBody) {
              noteContent += "\n" + templateBody;
            }
          } else {
            noteContent += "\n" + templateFullContent.trim();
          }
        } else {
          console.warn(
            `Template file not found or is a folder: ${templatePath}`
          );
          new Notice(`Template file not found at ${templatePath}`, 3000);
        }
      } catch (err) {
        console.error("Error reading template file:", err);
        new Notice("Error reading template file.", 3000);
      }

      let notePath: string;
      try {
        const baseName = `Untitled Range Note ${startDate.format("YYMMDD")}-${endDate.format("YYMMDD")}`;
        const parentPath = defaultFolder ? defaultFolder + "/" : "";
        notePath = await (
          this.app as any
        ).fileManager.getAvailablePathForAttachment(
          baseName,
          "md",
          this.app.vault.getAbstractFileByPath(parentPath)
        );

        if (!notePath || !notePath.endsWith(".md")) {
          console.warn(
            "getAvailablePathForAttachment did not return a valid path, constructing manually."
          );
          let counter = 0;
          notePath = defaultFolder
            ? `${defaultFolder}/${baseName}.md`
            : `${baseName}.md`;
          while (
            (await this.app.vault.adapter.exists(notePath)) &&
            counter < 100
          ) {
            counter++;
            notePath = defaultFolder
              ? `${defaultFolder}/${baseName} ${counter}.md`
              : `${baseName} ${counter}.md`;
          }
          if (counter >= 100)
            throw new Error("Could not find unique filename.");
        }
      } catch (error) {
        console.error("Error generating file path:", error);
        new Notice("Could not determine a path for the new note.");
        return;
      }

      try {
        const newFile = await this.app.vault.create(notePath, noteContent);
        new Notice(`Created range note: ${newFile.basename}`);

        const leaf = this.app.workspace.getLeaf("tab");
        await leaf.openFile(newFile);
      } catch (err) {
        console.error("Error creating range note file:", err);
        new Notice("Error creating the range note file. Check console.");
      }
    };

    if (this.plugin.settings.shouldConfirmBeforeCreateRange) {
      createConfirmationDialog(this.app, {
        title: "Create Range Note?",
        text: `Create a new note for the range ${startDate.format("YYYY-MM-DD")} to ${endDate.format("YYYY-MM-DD")}?`,
        cta: "Create",
        onAccept: performCreateAndOpen,
      });
    } else {
      await performCreateAndOpen();
    }
  }
}
