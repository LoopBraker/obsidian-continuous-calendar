// src/main.ts
import { Plugin, WorkspaceLeaf, Notice } from "obsidian";
import { CalendarView, CALENDAR_VIEW_TYPE } from "./view";
import { CalendarSettingTab } from "./settings";
import { MyCalendarPluginSettings } from "./types";
import { HolidayService } from "./holidayService";

const DEFAULT_SETTINGS: MyCalendarPluginSettings = {
  year: new Date().getFullYear(),
  defaultDotColor: "currentColor",
  defaultBarColor: "var(--interactive-accent)",
  shouldConfirmBeforeCreate: true,
  shouldConfirmBeforeCreateRange: true,
  birthdayFolder: "",
  defaultBirthdaySymbol: "🎂",
  defaultBirthdayColor: "var(--color-red-tint)",
  holidayStorageFolder: "Calendar/Holidays",
  holidaySources: [],
  tagAppearance: {}, // New setting default
};

export default class MyCalendarPlugin extends Plugin {
  settings: MyCalendarPluginSettings;
  calendarView: CalendarView | null = null;
  holidayService: HolidayService;

  async onload() {
    console.log("Loading Continuous Calendar Plugin");
    await this.loadSettings();

    // Safety check for the new setting
    if (
      typeof this.settings.tagAppearance !== "object" ||
      this.settings.tagAppearance === null
    ) {
      this.settings.tagAppearance = DEFAULT_SETTINGS.tagAppearance;
    }

    this.holidayService = new HolidayService(this.app, this);
    this.registerView(CALENDAR_VIEW_TYPE, (leaf) => {
      this.calendarView = new CalendarView(leaf, this);
      return this.calendarView;
    });
    this.addRibbonIcon("calendar-days", "Open Continuous Calendar", () => {
      this.activateView();
    });
    this.addCommand({
      id: "update-country-holidays",
      name: "Update Country Holidays for Displayed Year",
      callback: async () => {
        await this.holidayService.fetchAndUpdateAllCountryFilesForYear(
          this.settings.year
        );
      },
    });
    this.addSettingTab(new CalendarSettingTab(this.app, this));
  }

  onunload() {
    this.calendarView = null;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!Array.isArray(this.settings.holidaySources)) {
      this.settings.holidaySources = [];
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async activateView() {
    this.app.workspace.getLeavesOfType(CALENDAR_VIEW_TYPE).forEach((leaf) => {
      leaf.detach();
    });
    await this.app.workspace
      .getRightLeaf(false)
      ?.setViewState({ type: CALENDAR_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(
      this.app.workspace.getLeavesOfType(CALENDAR_VIEW_TYPE)[0]
    );
  }

  refreshCalendarView() {
    if (this.calendarView) {
      this.calendarView.refresh();
    }
  }
}
