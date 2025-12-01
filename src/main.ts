// src/main.ts
import { Plugin, WorkspaceLeaf, TFile, debounce, Notice } from "obsidian";
import { CalendarView, CALENDAR_VIEW_TYPE } from "./view";
import { CalendarSettingTab } from "./settings";
import { HolidaySource, TagAppearance, CustomDateSource } from "./type";
import { HolidayService } from "./holidayService";
// Settings Interface and Defaults
interface MyCalendarSettings {
  year: number;
  defaultDailyNoteSymbol: string;
  defaultDotColor: string;
  defaultBarColor: string;
  shouldConfirmBeforeCreate: boolean;
  shouldConfirmBeforeCreateRange: boolean; // Optional, for future use
  holidayStorageFolder: string;
  holidaySources: HolidaySource[];
  tagAppearance: Record<string, TagAppearance>;
  customDateSources: CustomDateSource[];
  focusedMonths: number[];
  opaqueMonths: number[];
  collapseDuplicateTagSymbols: boolean; // New setting for collapsing duplicate tag symbols
}

const DEFAULT_SETTINGS: MyCalendarSettings = {
  year: new Date().getFullYear(),
  defaultDailyNoteSymbol: "📍",
  defaultDotColor: "currentColor",
  defaultBarColor: "var(--interactive-accent)",
  shouldConfirmBeforeCreate: true,
  shouldConfirmBeforeCreateRange: true, // Optional, for future use
  holidayStorageFolder: "02-Calendar/Holidays",
  holidaySources: [],
  tagAppearance: {},
  customDateSources: [],
  focusedMonths: [],
  opaqueMonths: [],
  collapseDuplicateTagSymbols: false,
};

export default class MyCalendarPlugin extends Plugin {
  settings: MyCalendarSettings;
  calendarView: CalendarView | null = null;
  holidayService!: HolidayService;
  // We don't need to store dataService here as it's instantiated in CalendarView,
  // BUT to use isFileRelevant we might need access to it or instantiate it here too.
  // Actually, CalendarView instantiates it. We can access it via calendarView.
  // Or better, instantiate it here and pass it to CalendarView.
  // Let's check view.ts again. view.ts instantiates it in onOpen.
  // So we can't rely on it being there if view is not open.
  // But if view is not open, we don't need to refresh.
  // So accessing via calendarView is fine.

  // Wait, I need to define the property if I want to access it type-safely?
  // CalendarView has it public.


  async onload() {
    console.log("Loading Continuous Calendar Plugin");

    await this.loadSettings();

    // --- Migration: Convert old birthday settings to new CustomDateSource ---
    const loadedData = await this.loadData();
    if (loadedData) {
      const hasOldBirthdaySettings = loadedData.defaultBirthdaySymbol || loadedData.defaultBirthdayColor;
      const hasNoCustomSources = !this.settings.customDateSources || this.settings.customDateSources.length === 0;

      if (hasOldBirthdaySettings && hasNoCustomSources) {
        console.log("Migrating old birthday settings to Custom Date Sources...");
        this.settings.customDateSources = [
          {
            key: "birthday",
            symbol: loadedData.defaultBirthdaySymbol || "🎂",
            color: loadedData.defaultBirthdayColor || "var(--color-red-tint)",
            isRecurring: true
          }
        ];
        // We don't delete the old keys from disk immediately to be safe, 
        // but they are removed from the interface so they won't be used.
        await this.saveSettings();
      }
    }

    // Make sure tagAppearance is an object after loading
    if (
      typeof this.settings.tagAppearance !== "object" ||
      this.settings.tagAppearance === null
    ) {
      console.warn(
        "Loaded settings 'tagAppearance' was not an object. Resetting to default empty object."
      );
      this.settings.tagAppearance = DEFAULT_SETTINGS.tagAppearance;
    }
    // Ensure tagAppearance entries have the correct structure (simple check)
    for (const tag in this.settings.tagAppearance) {
      if (
        typeof this.settings.tagAppearance[tag] !== "object" ||
        !this.settings.tagAppearance[tag].color
      ) {
        console.warn(
          `Invalid structure for tagAppearance[${tag}]. Resetting entry.`
        );
        // Option 1: Delete invalid entry
        delete this.settings.tagAppearance[tag];
        // Option 2: Reset to a default (might be less desirable)
        // this.settings.tagAppearance[tag] = { color: DEFAULT_SETTINGS.defaultDotColor };
      }
    }

    // Make sure focused/opaque months are arrays
    if (!Array.isArray(this.settings.focusedMonths)) {
      this.settings.focusedMonths = DEFAULT_SETTINGS.focusedMonths;
    }
    if (!Array.isArray(this.settings.opaqueMonths)) {
      this.settings.opaqueMonths = DEFAULT_SETTINGS.opaqueMonths;
    }

    // *** Instantiate the REAL HolidayService ***
    this.holidayService = new HolidayService(this.app, this);

    // Register the View
    this.registerView(CALENDAR_VIEW_TYPE, (leaf) => {
      this.calendarView = new CalendarView(leaf, this); // Pass plugin instance
      return this.calendarView;
    });

    // Add Ribbon Icon to Open View
    this.addRibbonIcon(
      "calendar-days",
      "Open Continuous Calendar",
      (evt: MouseEvent) => {
        this.activateView();
      }
    );

    // Add Command to Open View
    this.addCommand({
      id: "open-continuous-calendar",
      name: "Open Continuous Calendar",
      callback: () => {
        this.activateView();
      },
    });

    // Add Command to Refresh View (useful for debugging or manual refresh)
    this.addCommand({
      id: "refresh-continuous-calendar",
      name: "Refresh Continuous Calendar",
      callback: () => {
        this.refreshCalendarView();
      },
    });

    // *** Add Command to Fetch/Update Holidays (using the service) ***
    this.addCommand({
      id: "update-country-holidays",
      name: "Update Country Holidays for Displayed Year",
      callback: async () => {
        if (!this.holidayService) {
          new Notice("Holiday service is not ready.");
          console.error(
            "Holiday service not initialized when trying to update holidays."
          );
          return;
        }
        new Notice(`Starting holiday update for ${this.settings.year}...`);
        // Call the actual service method
        await this.holidayService.fetchAndUpdateAllCountryFilesForYear(
          this.settings.year
        );
        // The service method itself should call refreshCalendarView after completion
        // or provide feedback via Notices.
      },
    });

    // Add Settings Tab
    this.addSettingTab(new CalendarSettingTab(this.app, this));

    // --- Automatic Updates ---
    // Debounce the refresh to avoid excessive updates during rapid changes
    this.debouncedRefresh = debounce(
      (file: TFile) => {
        if (this.calendarView && this.calendarView.dataService) {
          // Use smart update check: only update if calendar data actually changed
          if (this.calendarView.dataService.checkIfUpdateRequired(file)) {
            console.log(
              `Relevant data changed in: ${file.path}. Refreshing calendar...`
            );
            this.refreshCalendarView(file);
          } else {
            // console.log(`Ignored content-only change: ${file.path}`);
          }
        }
      },
      2000, // 2 seconds delay
      true // Run on trailing edge
    );

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        this.debouncedRefresh(file);
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) {
          // For delete, we might not be able to check content easily if it's gone,
          // but we can just refresh to be safe, or check if it WAS relevant (harder).
          // Simpler to just refresh for deletes as they are less frequent than edits.
          console.log(`File deleted: ${file.path}. Refreshing calendar...`);
          this.refreshCalendarView();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) {
          console.log(`File renamed: ${file.path}. Refreshing calendar...`);
          this.refreshCalendarView();
        }
      })
    );
  }

  debouncedRefresh: (file: TFile) => void;

  onunload() {
    console.log("Unloading Continuous Calendar Plugin");
    // Clean up: Detach all leaves with the calendar view
    this.app.workspace.getLeavesOfType(CALENDAR_VIEW_TYPE).forEach((leaf) => {
      leaf.detach();
    });
    this.calendarView = null; // Clear reference
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!Array.isArray(this.settings.holidaySources)) {
      console.warn(
        "Loaded settings 'holidaySources' was not an array. Resetting to default empty array."
      );
      this.settings.holidaySources = DEFAULT_SETTINGS.holidaySources;
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Refresh view maybe needed if holiday settings changed
    // this.refreshCalendarView();
  }

  // Function to activate/open the view in the right sidebar
  async activateView() {
    // Detach existing leaves first to ensure only one instance runs, if desired
    this.app.workspace.getLeavesOfType(CALENDAR_VIEW_TYPE).forEach((leaf) => {
      leaf.detach();
    });

    // Add to the right sidebar
    await this.app.workspace.getRightLeaf(false)?.setViewState({
      type: CALENDAR_VIEW_TYPE,
      active: true,
    });

    // Reveal the view
    this.app.workspace.revealLeaf(
      this.app.workspace.getLeavesOfType(CALENDAR_VIEW_TYPE)[0]
    );
  }

  // Helper function to refresh the calendar view if it's open
  refreshCalendarView(file?: TFile) {
    const leaf = this.app.workspace.getLeavesOfType(CALENDAR_VIEW_TYPE)[0];
    if (leaf && leaf.view instanceof CalendarView) {
      (leaf.view as CalendarView).refresh(file);
      console.log("Calendar view refreshed.");
    } else {
      console.log("Calendar view not found or not a CalendarView instance.");
    }
  }
}
