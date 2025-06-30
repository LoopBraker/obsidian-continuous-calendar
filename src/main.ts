// src/main.ts
import { Plugin, WorkspaceLeaf, TFile } from "obsidian";
import { CalendarView, CALENDAR_VIEW_TYPE } from "./view";
import { CalendarSettingTab } from "./settings";
import { HolidaySource } from "./types";
import { HolidayService } from "./holidayService";
// Settings Interface and Defaults
interface MyCalendarSettings {
  year: number;
  birthdayFolder: string;
  defaultBirthdaySymbol: string;
  defaultDailyNoteSymbol: string;
  defaultDotColor: string;
  defaultBarColor: string;
  shouldConfirmBeforeCreate: boolean;
  shouldConfirmBeforeCreateRange: boolean; // Optional, for future use
  holidayStorageFolder: string;
  holidaySources: HolidaySource[];
  tagAppearance: Record<string, TagAppearance>;
  focusedMonths: number[];
  opaqueMonths: number[];
  defaultBirthdayColor: string;
  collapseDuplicateTagSymbols: boolean; // New setting for collapsing duplicate tag symbols
}

const DEFAULT_SETTINGS: MyCalendarSettings = {
  year: new Date().getFullYear(),
  birthdayFolder: "05-People",
  defaultBirthdaySymbol: "🎂",
  defaultBirthdayColor: "var(--color-red-tint)",
  defaultDotColor: "currentColor",
  defaultBarColor: "var(--interactive-accent)",
  shouldConfirmBeforeCreate: true,
  shouldConfirmBeforeCreateRange: true, // Optional, for future use
  holidayStorageFolder: "02-Calendar/Holidays",
  holidaySources: [],
  tagAppearance: {},
  focusedMonths: [],
  opaqueMonths: [],
  collapseDuplicateTagSymbols: false,
};

export default class MyCalendarPlugin extends Plugin {
  settings: MyCalendarSettings;
  calendarView: CalendarView | null = null;
  holidayService!: HolidayService;

  async onload() {
    console.log("Loading Continuous Calendar Plugin");

    await this.loadSettings();

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

    // TODO: Add event listeners for vault changes to auto-refresh
    // Example (can be performance intensive, refine later):
    /*
         this.registerEvent(this.app.metadataCache.on('changed', (file, data, cache) => {
             // Crude check: if any file changes, refresh the calendar
             // More refined: check if the changed file *could* affect the calendar
             console.log("Metadata changed, refreshing calendar (potentially)");
             this.refreshCalendarView();
         }));
         this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
             console.log("File renamed, refreshing calendar");
             this.refreshCalendarView();
         }));
          this.registerEvent(this.app.vault.on('delete', (file) => {
             console.log("File deleted, refreshing calendar");
             this.refreshCalendarView();
         }));
        */
  }

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
  refreshCalendarView() {
    const leaf = this.app.workspace.getLeavesOfType(CALENDAR_VIEW_TYPE)[0];
    if (leaf && leaf.view instanceof CalendarView) {
      (leaf.view as CalendarView).refresh();
      console.log("Calendar view refreshed.");
    } else {
      console.log("Calendar view not found or not a CalendarView instance.");
    }
  }
}
