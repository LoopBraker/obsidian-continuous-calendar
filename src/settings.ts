// src/settings.ts
import { App, PluginSettingTab, Setting } from "obsidian";
import MyCalendarPlugin from "./main";

const AVAILABLE_COLOR_OPTIONS: Record<string, string> = {
  "Default (Theme-based)": "currentColor",
  Red: "var(--color-red-tint)",
  Orange: "var(--color-orange-tint)",
  Yellow: "var(--color-yellow-tint)",
  Green: "var(--color-green-tint)",
  Cyan: "var(--color-cyan-tint)",
  Blue: "var(--color-blue-tint)",
  Purple: "var(--color-purple-tint)",
  "Accent Color": "var(--interactive-accent)",
};

export class CalendarSettingTab extends PluginSettingTab {
  plugin: MyCalendarPlugin;
  constructor(app: App, plugin: MyCalendarPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Continuous Calendar Settings" });
    new Setting(containerEl)
      .setName("Year to Display")
      .setDesc("Which year the calendar should show.")
      .addText((text) =>
        text
          .setPlaceholder("e.g., 2024")
          .setValue(this.plugin.settings.year.toString())
          .onChange(async (value) => {
            const year = parseInt(value);
            if (!isNaN(year)) {
              this.plugin.settings.year = year;
              await this.plugin.saveSettings();
              this.plugin.refreshCalendarView();
            }
          })
      );

    containerEl.createEl("h3", { text: "Holidays" });
    new Setting(containerEl)
      .setName("Country Code for Holidays")
      .setDesc("Two-letter country code (e.g., US, GB, DE).")
      .addText((text) =>
        text
          .setPlaceholder("e.g., US")
          .setValue(this.plugin.settings.holidayCountry)
          .onChange(async (value) => {
            this.plugin.settings.holidayCountry = value.trim().toUpperCase();
            await this.plugin.saveSettings();
            this.plugin.refreshCalendarView();
          })
      );

    new Setting(containerEl)
      .setName("Holiday Definition Folder")
      .setDesc("Folder where holiday definition files will be stored.")
      .addText((text) =>
        text
          .setPlaceholder("e.g. Calendar/Holidays")
          .setValue(this.plugin.settings.holidayStorageFolder)
          .onChange(async (value) => {
            this.plugin.settings.holidayStorageFolder = value.trim();
            await this.plugin.saveSettings();
            this.plugin.refreshCalendarView();
          })
      );

    containerEl.createEl("h3", { text: "Event Display" });
    new Setting(containerEl)
      .setName("Default Event Dot Color")
      .setDesc("Fallback color for notes with a date.")
      .addDropdown((d) => {
        Object.keys(AVAILABLE_COLOR_OPTIONS).forEach((n) =>
          d.addOption(AVAILABLE_COLOR_OPTIONS[n], n)
        );
        d.setValue(this.plugin.settings.defaultDotColor);
        d.onChange(async (v) => {
          this.plugin.settings.defaultDotColor = v;
          await this.plugin.saveSettings();
          this.plugin.refreshCalendarView();
        });
      });
    new Setting(containerEl)
      .setName("Default Range Bar Color")
      .setDesc("Fallback color for range bars.")
      .addDropdown((d) => {
        Object.keys(AVAILABLE_COLOR_OPTIONS).forEach((n) =>
          d.addOption(AVAILABLE_COLOR_OPTIONS[n], n)
        );
        d.setValue(this.plugin.settings.defaultBarColor);
        d.onChange(async (v) => {
          this.plugin.settings.defaultBarColor = v;
          await this.plugin.saveSettings();
          this.plugin.refreshCalendarView();
        });
      });

    containerEl.createEl("h3", { text: "Birthdays" });
    new Setting(containerEl)
      .setName("Birthdays Folder Path")
      .setDesc("Path to folder with birthday notes.")
      .addText((text) => {
        text
          .setPlaceholder("e.g. People")
          .setValue(this.plugin.settings.birthdayFolder)
          .onChange(async (value) => {
            this.plugin.settings.birthdayFolder = value.trim();
            await this.plugin.saveSettings();
            this.plugin.refreshCalendarView();
          });
      });
    new Setting(containerEl)
      .setName("Birthday symbol / emoji")
      .setDesc("Single character for birthdays.")
      .addText((text) => {
        text
          .setPlaceholder("🎂")
          .setValue(this.plugin.settings.defaultBirthdaySymbol)
          .onChange(async (v) => {
            this.plugin.settings.defaultBirthdaySymbol = v.trim() || "🎂";
            await this.plugin.saveSettings();
            this.plugin.refreshCalendarView();
          });
      });
    new Setting(containerEl)
      .setName("Default Birthday Color")
      .setDesc("Fallback color for birthday notes.")
      .addDropdown((d) => {
        Object.keys(AVAILABLE_COLOR_OPTIONS).forEach((n) =>
          d.addOption(AVAILABLE_COLOR_OPTIONS[n], n)
        );
        d.setValue(this.plugin.settings.defaultBirthdayColor);
        d.onChange(async (v) => {
          this.plugin.settings.defaultBirthdayColor = v;
          await this.plugin.saveSettings();
          this.plugin.refreshCalendarView();
        });
      });

    containerEl.createEl("h3", { text: "Interaction" });
    new Setting(containerEl)
      .setName("Confirm before creating daily notes")
      .setDesc("Show a confirmation dialog.")
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.shouldConfirmBeforeCreate)
          .onChange(async (v) => {
            this.plugin.settings.shouldConfirmBeforeCreate = v;
            await this.plugin.saveSettings();
          })
      );
  }
}
