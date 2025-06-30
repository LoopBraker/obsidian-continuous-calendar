// src/view.ts
import { ItemView, WorkspaceLeaf, moment, TFile, Notice } from "obsidian";
import {
  createDailyNote,
  getAllDailyNotes,
  getDailyNote,
} from "obsidian-daily-notes-interface";
import MyCalendarPlugin from "./main";
import { createConfirmationDialog } from "./modal";
import { AggregatedHolidayInfo } from "./holidayService";

export const CALENDAR_VIEW_TYPE = "yearly-calendar-view";
const MAX_VISIBLE_RANGE_SLOTS = 4;
const BORDER_COLOR_MAP: Record<string, string> = {
  "var(--color-red-tint)": "var(--color-red-text)",
  "var(--color-orange-tint)": "var(--color-orange-text)",
  "var(--color-yellow-tint)": "var(--color-yellow-text)",
  "var(--color-green-tint)": "var(--color-green-text)",
  "var(--color-cyan-tint)": "var(--color-cyan-text)",
  "var(--color-blue-tint)": "var(--color-blue-text)",
  "var(--color-purple-tint)": "var(--color-purple-text)",
};
const DEFAULT_BORDER_COLOR = "var(--color-red-text)";

export class CalendarView extends ItemView {
  plugin: MyCalendarPlugin;
  calendarContentEl: HTMLElement;
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
    const c = this.containerEl.children[1];
    c.empty();
    this.calendarContentEl = c.createDiv({
      cls: "continuous-calendar-content",
    });
    await this.renderCalendar();
    this.registerDomEvent(
      this.calendarContentEl,
      "click",
      this.handleClick.bind(this)
    );
  }
  async onClose() {
    this.clearDayNumberEngagement();
  }
  async refresh() {
    this.leaf.updateHeader();
    await this.renderCalendar();
  }

  async renderCalendar() {
    this.calendarContentEl.empty();
    const year = this.plugin.settings.year;
    const today = moment().format("YYYY-MM-DD");
    const allDNs = getAllDailyNotes();
    const holidaysByDate =
      await this.plugin.holidayService.getAggregatedHolidays(year);
    const allFiles = this.app.vault.getMarkdownFiles();
    let pagesData: any[] = [];
    let birthdayData: any[] = [];
    const birthdayFolder = this.plugin.settings.birthdayFolder.toLowerCase();
    const hasBirthdayFolderSetting =
      this.plugin.settings.birthdayFolder.trim() !== "";
    for (const file of allFiles) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (!fm) continue;
      let hasDate = false,
        validDate: string | null = null,
        validDateStart: string | null = null,
        validDateEnd: string | null = null;
      let explicitColor: string | undefined = fm.color?.toString();
      let defaultColorFromTag: string | undefined;
      let defaultSymbolFromTag: string | undefined;
      if (fm.date) {
        const mDate = moment(fm.date.toString(), "YYYY-MM-DD", true);
        if (mDate.isValid()) {
          validDate = mDate.format("YYYY-MM-DD");
          hasDate = true;
        }
      }
      if (fm.dateStart && fm.dateEnd) {
        const mStart = moment(fm.dateStart.toString(), "YYYY-MM-DD", true);
        const mEnd = moment(fm.dateEnd.toString(), "YYYY-MM-DD", true);
        if (mStart.isValid() && mEnd.isValid()) {
          validDateStart = mStart.format("YYYY-MM-DD");
          validDateEnd = mEnd.format("YYYY-MM-DD");
          hasDate = true;
        }
      }
      if (!explicitColor && fm.tags) {
        let rawTags: any[] = Array.isArray(fm.tags)
          ? fm.tags
          : String(fm.tags)
              .split(",")
              .map((t) => t.trim());
        const noteTags = rawTags
          .map((tag) => String(tag).trim())
          .filter((t) => t)
          .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`));
        for (const tag of noteTags) {
          const appearance = this.plugin.settings.tagAppearance[tag];
          if (appearance) {
            if (!defaultColorFromTag) {
              defaultColorFromTag = appearance.color;
            }
            if (!defaultSymbolFromTag && appearance.symbol) {
              defaultSymbolFromTag = appearance.symbol;
            }
            if (defaultColorFromTag && defaultSymbolFromTag) break;
          }
        }
      }
      if (hasDate) {
        pagesData.push({
          path: file.path,
          date: validDate,
          dateStart: validDateStart,
          dateEnd: validDateEnd,
          name: file.basename,
          color: explicitColor,
          defaultColorFromTag: defaultColorFromTag,
          defaultSymbolFromTag: defaultSymbolFromTag,
        });
      }
      if (
        fm.birthday &&
        (!hasBirthdayFolderSetting ||
          file.path.toLowerCase().startsWith(birthdayFolder))
      ) {
        const mBday = moment(fm.birthday.toString(), "YYYY-MM-DD", true);
        if (mBday.isValid()) {
          birthdayData.push({
            path: file.path,
            birthday: mBday.format("YYYY-MM-DD"),
            name: file.basename,
            color: explicitColor,
            defaultColorFromTag: defaultColorFromTag,
          });
        }
      }
    }
    const table = this.calendarContentEl.createEl("table", {
      cls: "my-calendar-table",
    });
    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");
    headerRow.createEl("th", { text: "W" });
    "Mon Tue Wed Thu Fri Sat Sun"
      .split(" ")
      .forEach((day) => headerRow.createEl("th", { text: day }));
    const tbody = table.createEl("tbody");
    const startDate = moment(`${year}-01-01`).startOf("isoWeek");
    const endDate = moment(`${year}-12-31`).endOf("isoWeek");
    let currentWeek = startDate.clone();
    while (currentWeek.isBefore(endDate)) {
      const weekRow = tbody.createEl("tr");
      weekRow.createEl("td", {
        cls: "week-number",
        text: currentWeek.isoWeek().toString(),
      });
      const weeklyRanges = new Map<string, any>();
      const weeklySlotAssignments = new Map<string, number>();
      for (let d = 0; d < 7; d++) {
        const dayMoment = currentWeek.clone().add(d, "days");
        pagesData.forEach((p) => {
          if (p.dateStart && p.dateEnd && !weeklyRanges.has(p.path)) {
            const mStart = moment(p.dateStart);
            const mEnd = moment(p.dateEnd);
            if (dayMoment.isBetween(mStart, mEnd, "day", "[]")) {
              weeklyRanges.set(p.path, p);
            }
          }
        });
      }
      let slotIndex = 0;
      for (const path of weeklyRanges.keys()) {
        if (slotIndex < MAX_VISIBLE_RANGE_SLOTS) {
          weeklySlotAssignments.set(path, slotIndex++);
        }
      }
      for (let i = 0; i < 7; i++) {
        const dayMoment = currentWeek.clone().add(i, "days");
        const dateStr = dayMoment.format("YYYY-MM-DD");
        const cell = weekRow.createEl("td");
        cell.dataset.date = dateStr;
        const holidaysOnDay = holidaysByDate.get(dateStr) || [];
        const isHoliday = holidaysOnDay.length > 0;
        const matchingNotes = pagesData.filter((p) => p.date === dateStr);
        const matchingRanges = pagesData.filter(
          (p) =>
            p.dateStart &&
            p.dateEnd &&
            dayMoment.isBetween(p.dateStart, p.dateEnd, "day", "[]")
        );
        const matchingBirthdays = birthdayData.filter(
          (b) =>
            moment(b.birthday).format("MM-DD") === dayMoment.format("MM-DD")
        );
        const cellClasses = ["calendar-cell"];
        cellClasses.push(
          dayMoment.month() % 2 === 1 ? "odd-month" : "even-month"
        );
        if (dayMoment.year() !== year) cellClasses.push("other-year");
        if (dateStr === today) cellClasses.push("today");
        if (isHoliday) {
          cellClasses.push("holiday-colored");
          const holidayColorVar =
            holidaysOnDay[0].color || "var(--color-red-tint)";
          cell.style.setProperty("--holiday-background-color", holidayColorVar);
        }
        cell.addClass(...cellClasses);
        const cellContentWrapper = cell.createDiv({ cls: "cell-content" });
        const topContentDiv = cellContentWrapper.createDiv({
          cls: "top-content",
        });
        const dotAreaDiv = cellContentWrapper.createDiv({ cls: "dot-area" });
        const rangeBarAreaDiv = cellContentWrapper.createDiv({
          cls: "range-bar-area",
        });
        const dayNumSpan = topContentDiv.createSpan({ cls: "day-number" });
        if (dayMoment.year() === year) {
          dayNumSpan.setText(dayMoment.date().toString());
          if (getDailyNote(dayMoment, allDNs)) {
            dayNumSpan.addClass("has-daily-note");
          }
        }

        // --- New De-duplication Logic ---
        const emittedSymbols = new Set<string>();
        matchingNotes.forEach((note) => {
          const symbol = note.defaultSymbolFromTag || "●";
          const fromTag = !!note.defaultSymbolFromTag;
          if (
            this.plugin.settings.collapseDuplicateTagSymbols &&
            fromTag &&
            emittedSymbols.has(symbol)
          ) {
            return; // Skip duplicate symbol
          }
          const dot = dotAreaDiv.createSpan({
            cls: "dot note-dot",
            text: symbol,
          });
          dot.title = note.name;
          dot.style.color =
            note.color ||
            note.defaultColorFromTag ||
            this.plugin.settings.defaultDotColor;
          if (fromTag) {
            emittedSymbols.add(symbol);
          }
        });

        if (matchingBirthdays.length > 0) {
          const dot = dotAreaDiv.createSpan({ cls: "dot birthday-dot" });
          dot.textContent = this.plugin.settings.defaultBirthdaySymbol;
          dot.title = matchingBirthdays.map((b) => b.name).join("\n");
          dot.style.color =
            matchingBirthdays[0].color ||
            matchingBirthdays[0].defaultColorFromTag ||
            this.plugin.settings.defaultBirthdayColor;
        }
        for (let s = 0; s < MAX_VISIBLE_RANGE_SLOTS; s++) {
          rangeBarAreaDiv.createDiv({ cls: `range-slot slot-${s}` });
        }
        matchingRanges.forEach((p) => {
          const slot = weeklySlotAssignments.get(p.path);
          if (slot !== undefined) {
            const slotEl = rangeBarAreaDiv.querySelector(`.slot-${slot}`);
            if (slotEl) {
              const bar = slotEl.createDiv({ cls: "range-bar", title: p.name });
              const bgVar =
                p.color ||
                p.defaultColorFromTag ||
                this.plugin.settings.defaultBarColor;
              bar.style.backgroundColor = bgVar;
              const borderVar = BORDER_COLOR_MAP[bgVar] || DEFAULT_BORDER_COLOR;
              const isStart = dayMoment.isSame(p.dateStart, "day");
              const isEnd = dayMoment.isSame(p.dateEnd, "day");
              if (isStart) bar.style.borderLeft = `2px solid ${borderVar}`;
              if (isEnd) bar.style.borderRight = `2px solid ${borderVar}`;
              if (isStart) bar.addClass("range-start");
              if (isEnd) bar.addClass("range-end");
            }
          }
        });

        let expandedHTML = `<div class="expanded-content"><button class="close-button">×</button><strong>${dayMoment.format("dddd, MMMM Do")}</strong>`; /* ... expandedHTML same as before ... */
        if (isHoliday) {
          expandedHTML += `<ul>${holidaysOnDay.map((h) => `<li>${h.name}</li>`).join("")}</ul>`;
        }
        if (matchingBirthdays.length > 0) {
          expandedHTML += `<ul>${matchingBirthdays.map((b) => `<li><a class="internal-link" data-href="${b.path}" href="${b.path}">${b.name}</a></li>`).join("")}</ul>`;
        }
        if (matchingNotes.length > 0) {
          expandedHTML += `<ul>${matchingNotes.map((p) => `<li><a class="internal-link" data-href="${p.path}" href="${p.path}">${p.name}</a></li>`).join("")}</ul>`;
        }
        if (matchingRanges.length > 0) {
          expandedHTML += `<ul>${matchingRanges.map((p) => `<li><a class="internal-link" data-href="${p.path}" href="${p.path}">${p.name}</a></li>`).join("")}</ul>`;
        }
        if (
          !isHoliday &&
          !matchingBirthdays.length &&
          !matchingNotes.length &&
          !matchingRanges.length
        ) {
          expandedHTML += `<p>No events.</p>`;
        }
        expandedHTML += `</div>`;
        cell.dataset.cellContent = expandedHTML;
      }
      currentWeek.add(7, "days");
    }
  }
  handleClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const dayNumberEl = target.closest(".day-number");
    if (dayNumberEl) {
      this.handleDayNumberClick(event, dayNumberEl);
      return;
    }
    const closeButton = target.closest(".close-button");
    if (closeButton) {
      const expandedRow = closeButton.closest("tr.expanded-row");
      if (expandedRow) {
        this.closeExpandedRow(expandedRow);
      }
      return;
    }
    const internalLink = target.closest("a.internal-link");
    if (internalLink) {
      event.preventDefault();
      const path = internalLink.dataset.href;
      if (path) {
        this.app.workspace.openLinkText(
          path,
          "",
          event.ctrlKey || event.metaKey
        );
      }
      return;
    }
    const cellEl = target.closest("td.calendar-cell");
    if (cellEl) {
      this.handleCellClick(cellEl);
    }
  }
  handleDayNumberClick(event: MouseEvent, dayNumberEl: Element) {
    const isCmdClick = event.metaKey || event.ctrlKey;
    const cellEl = dayNumberEl.closest("td.calendar-cell");
    if (!cellEl || !cellEl.dataset.date) {
      this.clearDayNumberEngagement();
      return;
    }
    const dateMoment = moment(cellEl.dataset.date);
    if (isCmdClick) {
      if (this.startRangeDate) {
        const endRangeDate = dateMoment;
        const finalStartDate = this.startRangeDate.isBefore(endRangeDate)
          ? this.startRangeDate
          : endRangeDate;
        const finalEndDate = this.startRangeDate.isBefore(endRangeDate)
          ? endRangeDate
          : this.startRangeDate;
        this.createRangeNote(finalStartDate, finalEndDate);
        this.clearDayNumberEngagement();
      } else {
        new Notice("Click a start date first.");
      }
    } else {
      if (this.engagedStartRangeEl === dayNumberEl) {
        this.openOrCreateDailyNote(dateMoment, event);
        this.clearDayNumberEngagement();
      } else {
        this.clearDayNumberEngagement();
        this.startRangeDate = dateMoment;
        this.engagedStartRangeEl = dayNumberEl as HTMLElement;
        this.engagedStartRangeEl.addClass("range-start-engaged");
      }
    }
  }
  handleCellClick(cellEl: HTMLElement) {
    const currentRow = cellEl.parentElement as HTMLTableRowElement;
    if (!currentRow) return;
    const tbody = currentRow.parentElement as HTMLTableSectionElement;
    const existingExpanded = tbody.querySelector("tr.expanded-row");
    const wasThisCellExpanded = cellEl.classList.contains("expanded");
    if (existingExpanded) {
      const previouslyExpandedCell = tbody.querySelector(
        "td.calendar-cell.expanded"
      );
      previouslyExpandedCell?.removeClass("expanded");
      existingExpanded.remove();
    }
    if (!wasThisCellExpanded) {
      const contentHtml = cellEl.dataset.cellContent;
      if (!contentHtml) return;
      cellEl.addClass("expanded");
      const expandedRow = document.createElement("tr");
      expandedRow.className = "expanded-row";
      const expandedCell = expandedRow.createEl("td", {
        attr: { colspan: "8" },
      });
      expandedCell.innerHTML = contentHtml;
      currentRow.after(expandedRow);
    }
  }
  closeExpandedRow(expandedRow: Element) {
    const tbody = expandedRow.parentElement;
    tbody?.querySelector("td.calendar-cell.expanded")?.removeClass("expanded");
    expandedRow.remove();
  }
  clearDayNumberEngagement() {
    if (this.engagedStartRangeEl) {
      this.engagedStartRangeEl.removeClass("range-start-engaged");
      this.engagedStartRangeEl = null;
    }
    this.startRangeDate = null;
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
        const newFile = await createDailyNote(date);
        await workspace.openLinkText(newFile.path, "", openInNewPane);
      } catch (err) {
        console.error(`Failed to create daily note`, err);
      }
    };
    if (existingFile) {
      await workspace.openLinkText(existingFile.path, "", openInNewPane);
    } else {
      if (this.plugin.settings.shouldConfirmBeforeCreate) {
        createConfirmationDialog(this.app, {
          title: "Create Daily Note?",
          text: `Daily note for ${date.format("YYYY-MM-DD")} does not exist. Create it?`,
          cta: "Create",
          onAccept: performCreateAndOpen,
        });
      } else {
        await performCreateAndOpen();
      }
    }
  }
  async createRangeNote(
    startDate: moment.Moment,
    endDate: moment.Moment
  ): Promise<void> {
    const performCreateAndOpen = async () => {
      const noteContent = `---\ndateStart: ${startDate.format("YYYY-MM-DD")}\ndateEnd: ${endDate.format("YYYY-MM-DD")}\ncolor: ${this.plugin.settings.defaultBarColor}\n---\n\n# New Event\n`;
      try {
        const fileName = `Range ${startDate.format("YYMMDD")}-${endDate.format("YYMMDD")}.md`;
        const newFile = await this.app.vault.create(fileName, noteContent);
        new Notice(`Created: ${newFile.basename}`);
        await this.app.workspace.getLeaf("tab").openFile(newFile);
      } catch (err) {
        console.error("Error creating range note:", err);
        new Notice("Error creating file.");
      }
    };
    if (this.plugin.settings.shouldConfirmBeforeCreateRange) {
      createConfirmationDialog(this.app, {
        title: "Create Range Note?",
        text: `Create note for ${startDate.format("YYYY-MM-DD")} to ${endDate.format("YYYY-MM-DD")}?`,
        cta: "Create",
        onAccept: performCreateAndOpen,
      });
    } else {
      await performCreateAndOpen();
    }
  }
}
