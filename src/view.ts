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
    const container = this.containerEl.children[1];
    container.empty();
    this.calendarContentEl = container.createDiv({
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
    /* ... rendering logic is identical to previous version ... */
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
      if (hasDate) {
        pagesData.push({
          date: validDate,
          dateStart: validDateStart,
          dateEnd: validDateEnd,
          name: file.basename,
          color: fm.color,
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
            birthday: mBday.format("YYYY-MM-DD"),
            name: file.basename,
            color: fm.color,
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
    let currentDay = startDate.clone();
    while (currentDay.isBefore(endDate)) {
      const weekRow = tbody.createEl("tr");
      weekRow.createEl("td", {
        cls: "week-number",
        text: currentDay.isoWeek().toString(),
      });
      for (let i = 0; i < 7; i++) {
        const dayMoment = currentDay;
        const dateStr = dayMoment.format("YYYY-MM-DD");
        const cell = weekRow.createEl("td");
        cell.dataset.date = dateStr;
        const holidaysOnDay = holidaysByDate.get(dateStr) || [];
        const isHoliday = holidaysOnDay.length > 0;
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
        if (isHoliday) {
          cell.title = holidaysOnDay.map((h) => h.name).join("\n");
        }
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
        const matchingNotes = pagesData.filter((p) => p.date === dateStr);
        matchingNotes.forEach((note) => {
          const dot = dotAreaDiv.createSpan({ cls: "dot note-dot", text: "●" });
          dot.title = note.name;
          dot.style.color = note.color || this.plugin.settings.defaultDotColor;
        });
        const matchingBirthdays = birthdayData.filter(
          (b) =>
            moment(b.birthday).format("MM-DD") === dayMoment.format("MM-DD")
        );
        if (matchingBirthdays.length > 0) {
          const dot = dotAreaDiv.createSpan({ cls: "dot birthday-dot" });
          dot.textContent = this.plugin.settings.defaultBirthdaySymbol;
          dot.title = matchingBirthdays.map((b) => b.name).join("\n");
          dot.style.color =
            matchingBirthdays[0].color ||
            this.plugin.settings.defaultBirthdayColor;
        }
        const matchingRanges = pagesData.filter(
          (p) =>
            p.dateStart &&
            p.dateEnd &&
            dayMoment.isBetween(p.dateStart, p.dateEnd, "day", "[]")
        );
        matchingRanges.forEach((p) => {
          const bar = rangeBarAreaDiv.createDiv({
            cls: "range-bar",
            title: p.name,
          });
          bar.style.backgroundColor =
            p.color || this.plugin.settings.defaultBarColor;
          if (dayMoment.isSame(p.dateStart, "day")) bar.addClass("range-start");
          if (dayMoment.isSame(p.dateEnd, "day")) bar.addClass("range-end");
        });
        currentDay.add(1, "day");
      }
    }
  }

  handleClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const isCmdClick = event.metaKey || event.ctrlKey;
    const dayNumberEl = target.closest(".day-number");

    if (!dayNumberEl) {
      this.clearDayNumberEngagement();
      return;
    }

    const cellEl = dayNumberEl.closest("td.calendar-cell");
    if (!cellEl || !cellEl.dataset.date) {
      this.clearDayNumberEngagement();
      return;
    }

    const dateMoment = moment(cellEl.dataset.date);

    if (isCmdClick) {
      if (this.startRangeDate && this.engagedStartRangeEl) {
        const endRangeDate = dateMoment;
        // Ensure start is always before end
        const finalStartDate = this.startRangeDate.isBefore(endRangeDate)
          ? this.startRangeDate
          : endRangeDate;
        const finalEndDate = this.startRangeDate.isBefore(endRangeDate)
          ? endRangeDate
          : this.startRangeDate;

        this.createRangeNote(finalStartDate, finalEndDate);
        this.clearDayNumberEngagement();
      } else {
        new Notice("Click a start date first (without holding Cmd/Ctrl).");
      }
    } else {
      // Normal click
      if (this.engagedStartRangeEl === dayNumberEl) {
        // Second normal click on the same day: open daily note
        this.openOrCreateDailyNote(dateMoment, event);
        this.clearDayNumberEngagement();
      } else {
        // First normal click: set as potential range start
        this.clearDayNumberEngagement();
        this.startRangeDate = dateMoment;
        this.engagedStartRangeEl = dayNumberEl as HTMLElement;
        this.engagedStartRangeEl.addClass("range-start-engaged");
      }
    }
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
      const defaultFolder = ""; // Could be a setting later
      const noteContent = `---
dateStart: ${startDate.format("YYYY-MM-DD")}
dateEnd: ${endDate.format("YYYY-MM-DD")}
color: ${this.plugin.settings.defaultBarColor}
---

# New Event
`;
      try {
        // A helper function to find an available path might be needed in a real scenario
        const fileName = `Range ${startDate.format("YYMMDD")}-${endDate.format("YYMMDD")}.md`;
        const notePath = defaultFolder
          ? `${defaultFolder}/${fileName}`
          : fileName;

        const newFile = await this.app.vault.create(notePath, noteContent);
        new Notice(`Created range note: ${newFile.basename}`);

        // Open the new note
        const leaf = this.app.workspace.getLeaf("tab");
        await leaf.openFile(newFile);
      } catch (err) {
        console.error("Error creating range note file:", err);
        new Notice("Error creating the range note file.");
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
