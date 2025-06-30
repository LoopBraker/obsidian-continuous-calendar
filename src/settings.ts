// src/settings.ts
import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import MyCalendarPlugin from "./main";
import { HolidaySource, CountryHolidaySource } from "./types";

const AVAILABLE_COLOR_OPTIONS: Record<string, string> = {
  "Default (Red Tint)": "var(--color-red-tint)",
  "Orange Tint": "var(--color-orange-tint)",
  "Yellow Tint": "var(--color-yellow-tint)",
  "Green Tint": "var(--color-green-tint)",
  "Cyan Tint": "var(--color-cyan-tint)",
  "Blue Tint": "var(--color-blue-tint)",
  "Purple Tint": "var(--color-purple-tint)",
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

    containerEl.createEl("h4", { text: "Active Holiday Sources" });
    const sourcesListEl = containerEl.createDiv("holiday-sources-list");
    if (this.plugin.settings.holidaySources.length === 0) {
      sourcesListEl.createEl("p", { text: "No holiday sources configured." });
    } else {
      this.renderHolidaySources(sourcesListEl);
    }

    containerEl.createEl("h4", { text: "Add New Holiday Source" });
    if (this.availableCountries.length === 0) {
      await this.fetchAvailableCountries();
    }
    this.renderAddHolidaySourceControls(containerEl);

    containerEl.createEl("h3", { text: "Event Display" });
    const otherColorOptions = {
      "Theme Default": "currentColor",
      ...AVAILABLE_COLOR_OPTIONS,
      "Accent Color": "var(--interactive-accent)",
    };
    new Setting(containerEl)
      .setName("Default Event Dot Color")
      .addDropdown((d) => {
        Object.keys(otherColorOptions).forEach((n) =>
          d.addOption(otherColorOptions[n], n)
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
      .addDropdown((d) => {
        Object.keys(otherColorOptions).forEach((n) =>
          d.addOption(otherColorOptions[n], n)
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
      .addDropdown((d) => {
        Object.keys(otherColorOptions).forEach((n) =>
          d.addOption(otherColorOptions[n], n)
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
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.shouldConfirmBeforeCreate)
          .onChange(async (v) => {
            this.plugin.settings.shouldConfirmBeforeCreate = v;
            await this.plugin.saveSettings();
          })
      );
  }

  private getCountryName(code: string): string {
    const country = this.availableCountries.find(
      (c) => c.code.toUpperCase() === code.toUpperCase()
    );
    return country ? country.name : code;
  }

  private renderHolidaySources(containerEl: HTMLElement): void {
    this.plugin.settings.holidaySources.forEach((source, index) => {
      const settingItem = new Setting(containerEl).setName(
        source.type === "country"
          ? `Country: ${this.getCountryName(source.countryCode)} (${source.countryCode})`
          : `Custom: ${source.name}`
      );
      if (source.type === "country") {
        settingItem.addDropdown((dropdown) => {
          Object.keys(AVAILABLE_COLOR_OPTIONS).forEach((key) =>
            dropdown.addOption(AVAILABLE_COLOR_OPTIONS[key], key)
          );
          dropdown.setValue(source.color || "var(--color-red-tint)");
          dropdown.onChange(async (value) => {
            (
              this.plugin.settings.holidaySources[index] as CountryHolidaySource
            ).color = value;
            await this.plugin.saveSettings();
            this.plugin.refreshCalendarView();
          });
        });
      }
      settingItem.addButton((button) =>
        button.setIcon("trash").onClick(async () => {
          this.plugin.settings.holidaySources.splice(index, 1);
          await this.plugin.saveSettings();
          this.display();
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
      console.error("Error fetching countries:", error);
      this.availableCountries = [];
    }
  }

  private renderAddHolidaySourceControls(containerEl: HTMLElement): void {
    let selectedType: "country" | "custom" = "country";
    let selectedCountryCode: string = "";
    let selectedColorVar: string = "var(--color-red-tint)";
    let customName: string = "";

    const addControlsContainer = containerEl.createDiv(
      "add-holiday-source-controls"
    );
    new Setting(addControlsContainer)
      .setName("Source Type")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("country", "Country")
          .addOption("custom", "Custom")
          .setValue(selectedType)
          .onChange((value) => {
            this.display();
          }); // Simple refresh to show/hide controls
      });

    if (selectedType === "country") {
      new Setting(addControlsContainer)
        .setName("Country")
        .addDropdown((dropdown) => {
          dropdown.addOption("", "Select a country...");
          this.availableCountries.forEach((c) =>
            dropdown.addOption(c.code, `${c.name} (${c.code})`)
          );
          dropdown.onChange((value) => {
            selectedCountryCode = value;
          });
        });
      new Setting(addControlsContainer)
        .setName("Assign Color")
        .addDropdown((d) => {
          Object.keys(AVAILABLE_COLOR_OPTIONS).forEach((k) =>
            d.addOption(AVAILABLE_COLOR_OPTIONS[k], k)
          );
          d.setValue(selectedColorVar).onChange((v) => {
            selectedColorVar = v;
          });
        });
    } else {
      // custom
      new Setting(addControlsContainer)
        .setName("Custom Set Name")
        .setDesc('A short name (e.g., "Family", "ProjectX").')
        .addText((text) =>
          text.setPlaceholder("Enter custom name").onChange((value) => {
            customName = value.trim();
          })
        );
    }

    new Setting(addControlsContainer).addButton((button) =>
      button
        .setButtonText("Add Source")
        .setCta()
        .onClick(async () => {
          let newSource: HolidaySource | null = null;
          if (selectedType === "country") {
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
              new Notice("Country source already exists.");
              return;
            }
            newSource = {
              type: "country",
              countryCode: selectedCountryCode,
              color: selectedColorVar,
            };
          } else {
            // custom
            if (!customName) {
              new Notice("Please enter a name for the custom set.");
              return;
            }
            const sourceId = this.plugin.holidayService.getHolidaySourceId({
              type: "custom",
              name: customName,
            });
            if (
              this.plugin.settings.holidaySources.some(
                (s) =>
                  s.type === "custom" &&
                  this.plugin.holidayService.getHolidaySourceId(s) === sourceId
              )
            ) {
              new Notice(`Custom source '${sourceId}' already exists.`);
              return;
            }
            newSource = { type: "custom", name: customName };
          }
          if (newSource) {
            this.plugin.settings.holidaySources.push(newSource);
            await this.plugin.saveSettings();
            await this.plugin.holidayService.ensureHolidayFileExists(
              this.plugin.settings.year,
              newSource
            );
            new Notice(`Added holiday source.`);
            this.display();
            this.plugin.refreshCalendarView();
          }
        })
    );
  }
}
