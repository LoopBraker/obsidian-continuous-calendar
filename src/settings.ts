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
    new Setting(containerEl).setName("Year to Display").addText((t) =>
      t
        .setPlaceholder("e.g., 2024")
        .setValue(this.plugin.settings.year.toString())
        .onChange(async (v) => {
          const y = parseInt(v);
          if (!isNaN(y)) {
            this.plugin.settings.year = y;
            await this.plugin.saveSettings();
            this.plugin.refreshCalendarView();
          }
        })
    );
    containerEl.createEl("h3", { text: "Holidays" });
    new Setting(containerEl).setName("Holiday Definition Folder").addText((t) =>
      t
        .setPlaceholder("e.g. Calendar/Holidays")
        .setValue(this.plugin.settings.holidayStorageFolder)
        .onChange(async (v) => {
          this.plugin.settings.holidayStorageFolder = v.trim();
          await this.plugin.saveSettings();
          this.plugin.refreshCalendarView();
        })
    );
    containerEl.createEl("h4", { text: "Active Holiday Sources" });
    const sourcesListEl = containerEl.createDiv();
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
    const o = {
      "Theme Default": "currentColor",
      ...AVAILABLE_COLOR_OPTIONS,
      "Accent Color": "var(--interactive-accent)",
    };
    new Setting(containerEl)
      .setName("Default Event Dot Color")
      .addDropdown((d) => {
        Object.keys(o).forEach((n) => d.addOption(o[n], n));
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
        Object.keys(o).forEach((n) => d.addOption(o[n], n));
        d.setValue(this.plugin.settings.defaultBarColor);
        d.onChange(async (v) => {
          this.plugin.settings.defaultBarColor = v;
          await this.plugin.saveSettings();
          this.plugin.refreshCalendarView();
        });
      });

    containerEl.createEl("h3", { text: "Birthdays" });
    new Setting(containerEl).setName("Birthdays Folder Path").addText((t) => {
      t.setPlaceholder("e.g. People")
        .setValue(this.plugin.settings.birthdayFolder)
        .onChange(async (v) => {
          this.plugin.settings.birthdayFolder = v.trim();
          await this.plugin.saveSettings();
          this.plugin.refreshCalendarView();
        });
    });
    new Setting(containerEl).setName("Birthday symbol / emoji").addText((t) => {
      t.setPlaceholder("🎂")
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
        Object.keys(o).forEach((n) => d.addOption(o[n], n));
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
    new Setting(containerEl)
      .setName("Confirm before creating range notes")
      .setDesc("Show a confirmation dialog for new date range notes.")
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.shouldConfirmBeforeCreateRange)
          .onChange(async (v) => {
            this.plugin.settings.shouldConfirmBeforeCreateRange = v;
            await this.plugin.saveSettings();
          })
      );
  }
  private getCountryName(c: string) {
    return (
      this.availableCountries.find(
        (x) => x.code.toUpperCase() === c.toUpperCase()
      )?.name || c
    );
  }
  private renderHolidaySources(el: HTMLElement) {
    this.plugin.settings.holidaySources.forEach((s, i) => {
      const item = new Setting(el).setName(
        s.type === "country"
          ? `Country: ${this.getCountryName(s.countryCode)} (${s.countryCode})`
          : `Custom: ${s.name}`
      );
      if (s.type === "country") {
        item.addDropdown((d) => {
          Object.keys(AVAILABLE_COLOR_OPTIONS).forEach((k) =>
            d.addOption(AVAILABLE_COLOR_OPTIONS[k], k)
          );
          d.setValue(s.color || "var(--color-red-tint)");
          d.onChange(async (v) => {
            (
              this.plugin.settings.holidaySources[i] as CountryHolidaySource
            ).color = v;
            await this.plugin.saveSettings();
            this.plugin.refreshCalendarView();
          });
        });
      }
      item.addButton((b) =>
        b.setIcon("trash").onClick(async () => {
          this.plugin.settings.holidaySources.splice(i, 1);
          await this.plugin.saveSettings();
          this.display();
          this.plugin.refreshCalendarView();
        })
      );
    });
  }
  private async fetchAvailableCountries() {
    try {
      this.availableCountries =
        await this.plugin.holidayService.getAvailableCountries();
      this.availableCountries.sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      console.error("Error fetching countries:", e);
      this.availableCountries = [];
    }
  }
  private renderAddHolidaySourceControls(el: HTMLElement) {
    let type: "country" | "custom" = "country",
      code: string = "",
      color: string = "var(--color-red-tint)",
      name: string = "";
    const addControls = el.createDiv();
    new Setting(addControls).setName("Source Type").addDropdown((d) => {
      d.addOption("country", "Country")
        .addOption("custom", "Custom")
        .setValue(type)
        .onChange((v) => {
          type = v as "country" | "custom";
          this.display();
        });
    });
    if (type === "country") {
      new Setting(addControls).setName("Country").addDropdown((d) => {
        d.addOption("", "Select...");
        this.availableCountries.forEach((c) =>
          d.addOption(c.code, `${c.name} (${c.code})`)
        );
        d.onChange((v) => {
          code = v;
        });
      });
      new Setting(addControls).setName("Color").addDropdown((d) => {
        Object.keys(AVAILABLE_COLOR_OPTIONS).forEach((k) =>
          d.addOption(AVAILABLE_COLOR_OPTIONS[k], k)
        );
        d.setValue(color).onChange((v) => {
          color = v;
        });
      });
    } else {
      new Setting(addControls).setName("Custom Set Name").addText((t) =>
        t.setPlaceholder("Enter name").onChange((v) => {
          name = v.trim();
        })
      );
    }
    new Setting(addControls).addButton((b) =>
      b
        .setButtonText("Add Source")
        .setCta()
        .onClick(async () => {
          let newSource: HolidaySource | null = null;
          if (type === "country") {
            if (!code) {
              new Notice("Select a country.");
              return;
            }
            if (
              this.plugin.settings.holidaySources.some(
                (s) =>
                  s.type === "country" &&
                  s.countryCode.toUpperCase() === code.toUpperCase()
              )
            ) {
              new Notice("Country source exists.");
              return;
            }
            newSource = { type: "country", countryCode: code, color: color };
          } else {
            if (!name) {
              new Notice("Enter a name.");
              return;
            }
            const id = this.plugin.holidayService.getHolidaySourceId({
              type: "custom",
              name: name,
            });
            if (
              this.plugin.settings.holidaySources.some(
                (s) =>
                  s.type === "custom" &&
                  this.plugin.holidayService.getHolidaySourceId(s) === id
              )
            ) {
              new Notice(`Custom source '${id}' exists.`);
              return;
            }
            newSource = { type: "custom", name: name };
          }
          if (newSource) {
            this.plugin.settings.holidaySources.push(newSource);
            await this.plugin.saveSettings();
            await this.plugin.holidayService.ensureHolidayFileExists(
              this.plugin.settings.year,
              newSource
            );
            new Notice(`Added source.`);
            this.display();
            this.plugin.refreshCalendarView();
          }
        })
    );
  }
}
