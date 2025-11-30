import {
  ItemView,
  WorkspaceLeaf,
  TFile,
  moment,
  Notice,
  setIcon,
} from "obsidian";
import {
  getDailyNoteSettings,
  createDailyNote,
  getAllDailyNotes,
  getDailyNote,
} from "obsidian-daily-notes-interface";

import MyCalendarPlugin from "./main";
import { createConfirmationDialog } from "./modal";
import { Holiday } from "./type";
import { CalendarDataService } from "./calendarDataService";
import { CalendarRenderer } from "./calendarRenderer";
import { CalendarEventHandler, CalendarController } from "./calendarEventHandler";

export const CALENDAR_VIEW_TYPE = "yearly-calendar-view";

export class CalendarView extends ItemView implements CalendarController {
  plugin: MyCalendarPlugin;
  calendarContentEl: HTMLElement;

  // Components
  dataService: CalendarDataService;
  renderer: CalendarRenderer;
  eventHandler: CalendarEventHandler;

  // State
  forceOpaqueMonths: Set<number> = new Set();
  forceFocusMonths: Set<number> = new Set();
  private currentYearHolidays: Map<string, Holiday[]> = new Map();

  constructor(leaf: WorkspaceLeaf, plugin: MyCalendarPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  get settings() {
    return this.plugin.settings;
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

    // Initialize components
    this.dataService = new CalendarDataService(this.app, this.plugin);
    this.renderer = new CalendarRenderer(this.plugin, this.calendarContentEl);
    this.eventHandler = new CalendarEventHandler(this);

    await this.renderCalendar();

    this.registerDomEvent(
      this.calendarContentEl,
      "click",
      (e) => this.eventHandler.handleClick(e)
    );
  }

  async onClose() {
    this.forceOpaqueMonths.clear();
    this.forceFocusMonths.clear();
    // Clear event handler state if needed, though it's recreated on open
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

  async renderCalendar() {
    console.time("CalendarView:renderCalendar");
    if (!this.plugin.holidayService) {
      console.error("Holiday service not available in CalendarView.");
      this.calendarContentEl.setText("Error: Holiday service failed to load.");
      console.timeEnd("CalendarView:renderCalendar");
      return;
    }

    const year = this.plugin.settings.year;

    // --- Perform the expensive data collection and indexing ONCE ---
    console.time("CalendarDataService:collectAndIndex");
    const data = await this.dataService.collectAndIndexCalendarData();
    console.timeEnd("CalendarDataService:collectAndIndex");

    console.log("Fetching aggregated holidays for year:", year);
    this.currentYearHolidays =
      await this.plugin.holidayService.getAggregatedHolidays(year);
    console.log("Fetched holidays map:", this.currentYearHolidays);

    console.time("CalendarRenderer:render");
    await this.renderer.render(
      data,
      this.currentYearHolidays,
      this.forceFocusMonths,
      this.forceOpaqueMonths
    );
    console.timeEnd("CalendarRenderer:render");

    // Attach listeners for controls that were created by renderer
    this.eventHandler.attachControlsListeners();
    console.timeEnd("CalendarView:renderCalendar");
  }

  async saveSettings() {
    this.plugin.settings.focusedMonths = Array.from(this.forceFocusMonths);
    this.plugin.settings.opaqueMonths = Array.from(this.forceOpaqueMonths);
    await this.plugin.saveSettings();
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
        text: `Create a new range note from ${startDate.format("YYYY-MM-DD")} to ${endDate.format("YYYY-MM-DD")}?`,
        cta: "Create",
        onAccept: performCreateAndOpen,
      });
    } else {
      await performCreateAndOpen();
    }
  }
}
