// src/settings.ts
import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import MyCalendarPlugin from "./main";
import { HolidaySource } from "./types";

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
  private availableCountries: { code: string; name: string }[] = [];

  constructor(app: App, plugin: MyCalendarPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display(): Promise<void> {
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

    // --- New Holiday Source Management UI ---
    containerEl.createEl("h4", { text: "Active Holiday Sources" });
    const sourcesListEl = containerEl.createDiv("holiday-sources-list");
    if (this.plugin.settings.holidaySources.length === 0) {
      sourcesListEl.createEl("p", { text: "No holiday sources configured." });
    } else {
      this.renderHolidaySources(sourcesListEl);
    }

    containerEl.createEl("h4", { text: "Add New Holiday Source" });
    // Fetch country list on demand
    if (this.availableCountries.length === 0) {
      await this.fetchAvailableCountries();
    }
    this.renderAddHolidaySourceControls(containerEl);
    // --- End New UI ---

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

  private renderHolidaySources(containerEl: HTMLElement): void {
    this.plugin.settings.holidaySources.forEach((source, index) => {
      new Setting(containerEl)
        .setName(
          source.type === "country"
            ? `Country: ${source.countryCode.toUpperCase()}`
            : `Custom: ${source.name}`
        )
        .addButton((button) =>
          button
            .setIcon("trash")
            .setTooltip("Remove this source")
            .onClick(async () => {
              this.plugin.settings.holidaySources.splice(index, 1);
              await this.plugin.saveSettings();
              this.display(); // Re-render the settings tab
              this.plugin.refreshCalendarView();
            })
        );
    });
  }

  private async fetchAvailableCountries(): Promise<void> {
    try {
      this.availableCountries =
        await this.plugin.holidayService.getAvailableCountries();
      this.availableCountries.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      console.error("Error fetching available countries:", error);
      this.availableCountries = [];
    }
  }

  private renderAddHolidaySourceControls(containerEl: HTMLElement): void {
    let selectedCountryCode: string =
      this.availableCountries.length > 0 ? this.availableCountries[0].code : "";

    const countrySetting = new Setting(containerEl)
      .setName("Select Country")
      .addDropdown((dropdown) => {
        this.availableCountries.forEach((country) => {
          dropdown.addOption(
            country.code,
            `${country.name} (${country.code.toUpperCase()})`
          );
        });
        dropdown.onChange((value) => {
          selectedCountryCode = value;
        });
      });

    countrySetting.addButton((button) =>
      button
        .setButtonText("Add Country Source")
        .setCta()
        .onClick(async () => {
          if (!selectedCountryCode) {
            new Notice("Please select a country.");
            return;
          }
          if (
            this.plugin.settings.holidaySources.some(
              (s) =>
                s.type === "country" &&
                s.countryCode.toUpperCase() ===
                  selectedCountryCode.toUpperCase()
            )
          ) {
            new Notice(
              `Country source '${selectedCountryCode.toUpperCase()}' already exists.`
            );
            return;
          }
          const newSource: HolidaySource = {
            type: "country",
            countryCode: selectedCountryCode,
          };
          this.plugin.settings.holidaySources.push(newSource);
          await this.plugin.saveSettings();
          await this.plugin.holidayService.ensureHolidayFileExists(
            this.plugin.settings.year,
            newSource
          );
          new Notice(`Added holiday source.`);
          this.display();
          this.plugin.refreshCalendarView();
        })
    );
  }
}
