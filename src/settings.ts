// src/settings.ts
import {
  App,
  PluginSettingTab,
  Setting,
  Notice,
  AbstractInputSuggest,
  TFolder,
} from "obsidian";
import MyCalendarPlugin from "./main";
import { HolidaySource, CountryHolidaySource } from "./types";

// --- Suggester Classes and Helpers ---

function getAllFolderPaths(app: App): string[] {
  const folders: string[] = ["/"]; // Add root folder explicitly
  app.vault.getAllLoadedFiles().forEach((file) => {
    if (file instanceof TFolder && file.path !== "/") {
      folders.push(file.path);
    }
  });
  return folders.sort();
}

class FolderSuggest extends AbstractInputSuggest<string> {
  private allFolders: string[];
  constructor(
    app: App,
    private inputEl: HTMLInputElement
  ) {
    super(app, inputEl);
    this.allFolders = getAllFolderPaths(app);
  }
  getSuggestions(query: string): string[] {
    const lowerCaseQuery = query.toLowerCase();
    return this.allFolders.filter((folder) =>
      folder.toLowerCase().includes(lowerCaseQuery)
    );
  }
  renderSuggestion(folder: string, el: HTMLElement): void {
    el.setText(folder);
  }
  selectSuggestion(folder: string): void {
    this.inputEl.value = folder;
    this.inputEl.dispatchEvent(new Event("input"));
    this.close();
  }
}

class TagSuggest extends AbstractInputSuggest<string> {
  private allTags: string[];
  constructor(
    app: App,
    private inputEl: HTMLInputElement
  ) {
    super(app, inputEl);
    this.allTags = Object.keys(app.metadataCache.getTags() || {});
  }
  getSuggestions(query: string): string[] {
    return this.allTags.filter((tag) =>
      tag.toLowerCase().includes(query.toLowerCase())
    );
  }
  renderSuggestion(tag: string, el: HTMLElement): void {
    el.setText(tag);
  }
  selectSuggestion(tag: string): void {
    this.inputEl.value = tag;
    this.inputEl.dispatchEvent(new Event("input"));
    this.close();
  }
}

const ALL_COLOR_OPTIONS: Record<string, string> = {
  "Default (Red Tint)": "var(--color-red-tint)",
  "Orange Tint": "var(--color-orange-tint)",
  "Yellow Tint": "var(--color-yellow-tint)",
  "Green Tint": "var(--color-green-tint)",
  "Cyan Tint": "var(--color-cyan-tint)",
  "Blue Tint": "var(--color-blue-tint)",
  "Purple Tint": "var(--color-purple-tint)",
  "Theme Default": "currentColor",
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
    new Setting(containerEl).setName("Year").addText((t) =>
      t.setValue(this.plugin.settings.year.toString()).onChange(async (v) => {
        const y = parseInt(v);
        if (!isNaN(y)) {
          this.plugin.settings.year = y;
          await this.plugin.saveSettings();
          this.plugin.refreshCalendarView();
        }
      })
    );
    containerEl.createEl("h3", { text: "Event Display" });
    new Setting(containerEl)
      .setName("Default Event Dot Color")
      .addDropdown((d) => {
        Object.keys(ALL_COLOR_OPTIONS).forEach((n) =>
          d.addOption(ALL_COLOR_OPTIONS[n], n)
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
        Object.keys(ALL_COLOR_OPTIONS).forEach((n) =>
          d.addOption(ALL_COLOR_OPTIONS[n], n)
        );
        d.setValue(this.plugin.settings.defaultBarColor);
        d.onChange(async (v) => {
          this.plugin.settings.defaultBarColor = v;
          await this.plugin.saveSettings();
          this.plugin.refreshCalendarView();
        });
      });
    this.renderTagAppearanceSettings(containerEl);

    containerEl.createEl("h3", { text: "Data Sources" });
    new Setting(containerEl)
      .setName("Birthdays Folder")
      .setDesc("Path to folder. Type to search.")
      .addText((t) => {
        t.setPlaceholder("e.g. People")
          .setValue(this.plugin.settings.birthdayFolder)
          .onChange(async (v) => {
            this.plugin.settings.birthdayFolder = v.trim();
            await this.plugin.saveSettings();
            this.plugin.refreshCalendarView();
          });
        new FolderSuggest(this.app, t.inputEl);
      });
    new Setting(containerEl).setName("Birthday Symbol").addText((t) => {
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
        Object.keys(ALL_COLOR_OPTIONS).forEach((n) =>
          d.addOption(ALL_COLOR_OPTIONS[n], n)
        );
        d.setValue(this.plugin.settings.defaultBirthdayColor);
        d.onChange(async (v) => {
          this.plugin.settings.defaultBirthdayColor = v;
          await this.plugin.saveSettings();
          this.plugin.refreshCalendarView();
        });
      });
    new Setting(containerEl)
      .setName("Holiday Storage Folder")
      .setDesc("Path to folder. Type to search.")
      .addText((t) => {
        t.setValue(this.plugin.settings.holidayStorageFolder).onChange(
          async (v) => {
            this.plugin.settings.holidayStorageFolder = v.trim();
            await this.plugin.saveSettings();
            this.plugin.refreshCalendarView();
          }
        );
        new FolderSuggest(this.app, t.inputEl);
      });
    containerEl.createEl("h4", { text: "Holiday Sources" });
    const sourcesListEl = containerEl.createDiv();
    if (this.plugin.settings.holidaySources.length === 0) {
      sourcesListEl.createEl("p", { text: "No sources." });
    } else {
      this.renderHolidaySources(sourcesListEl);
    }
    if (this.availableCountries.length === 0) {
      await this.fetchAvailableCountries();
    }
    this.renderAddHolidaySourceControls(containerEl);

    containerEl.createEl("h3", { text: "Interaction" });
    new Setting(containerEl).setName("Confirm Daily Note").addToggle((t) =>
      t
        .setValue(this.plugin.settings.shouldConfirmBeforeCreate)
        .onChange(async (v) => {
          this.plugin.settings.shouldConfirmBeforeCreate = v;
          await this.plugin.saveSettings();
        })
    );
    new Setting(containerEl).setName("Confirm Range Note").addToggle((t) =>
      t
        .setValue(this.plugin.settings.shouldConfirmBeforeCreateRange)
        .onChange(async (v) => {
          this.plugin.settings.shouldConfirmBeforeCreateRange = v;
          await this.plugin.saveSettings();
        })
    );
  }
  private renderTagAppearanceSettings(containerEl: HTMLElement): void {
    containerEl.createEl("h4", { text: "Tag-Based Appearance" });
    Object.keys(this.plugin.settings.tagAppearance)
      .sort()
      .forEach((tag) => {
        const setting = new Setting(containerEl).setName(tag);
        const appearance = this.plugin.settings.tagAppearance[tag];
        setting.addDropdown((dd) => {
          Object.keys(ALL_COLOR_OPTIONS).forEach((key) =>
            dd.addOption(ALL_COLOR_OPTIONS[key], key)
          );
          dd.setValue(appearance.color).onChange(async (newVar) => {
            appearance.color = newVar;
            await this.plugin.saveSettings();
            this.plugin.refreshCalendarView();
          });
        });
        setting.addText((text) => {
          text
            .setPlaceholder("●")
            .setValue(appearance.symbol || "")
            .onChange(async (val) => {
              appearance.symbol = val.trim() || undefined;
              await this.plugin.saveSettings();
              this.plugin.refreshCalendarView();
            });
        });
        setting.addButton((btn) =>
          btn
            .setIcon("trash")
            .setWarning()
            .onClick(async () => {
              delete this.plugin.settings.tagAppearance[tag];
              await this.plugin.saveSettings();
              this.display();
              this.plugin.refreshCalendarView();
            })
        );
      });
    const newMappingSetting = new Setting(containerEl).setName(
      "New Tag Mapping"
    );
    let newTag = "",
      newSymbol = "●",
      newColor = ALL_COLOR_OPTIONS["Theme Default"];
    newMappingSetting.addText((text) => {
      text.setPlaceholder("#your/tag").onChange((val) => (newTag = val));
      new TagSuggest(this.app, text.inputEl);
    });
    newMappingSetting.addText((text) => {
      text
        .setPlaceholder("●")
        .onChange((val) => (newSymbol = val.trim() || "●"));
    });
    newMappingSetting.addDropdown((dd) => {
      Object.keys(ALL_COLOR_OPTIONS).forEach((key) =>
        dd.addOption(ALL_COLOR_OPTIONS[key], key)
      );
      dd.setValue(newColor).onChange((val) => (newColor = val));
    });
    newMappingSetting.addButton((btn) =>
      btn
        .setButtonText("Add")
        .setCta()
        .onClick(async () => {
          if (!newTag || !newTag.startsWith("#")) {
            new Notice("Tag must start with '#'");
            return;
          }
          if (this.plugin.settings.tagAppearance[newTag]) {
            new Notice(`Mapping for "${newTag}" already exists`);
            return;
          }
          this.plugin.settings.tagAppearance[newTag] = {
            color: newColor,
            symbol: newSymbol,
          };
          await this.plugin.saveSettings();
          this.display();
          this.plugin.refreshCalendarView();
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
          Object.keys(ALL_COLOR_OPTIONS).forEach((k) =>
            d.addOption(ALL_COLOR_OPTIONS[k], k)
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
          type = v as any;
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
        Object.keys(ALL_COLOR_OPTIONS).forEach((k) =>
          d.addOption(ALL_COLOR_OPTIONS[k], k)
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
              new Notice("Select country");
              return;
            }
            if (
              this.plugin.settings.holidaySources.some(
                (s) =>
                  s.type === "country" &&
                  s.countryCode.toUpperCase() === code.toUpperCase()
              )
            ) {
              new Notice("Source exists");
              return;
            }
            newSource = { type: "country", countryCode: code, color: color };
          } else {
            if (!name) {
              new Notice("Enter name");
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
              new Notice(`Source exists`);
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
