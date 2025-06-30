// src/settings.ts
import {
  App,
  PluginSettingTab,
  Setting,
  DropdownComponent,
  TextComponent,
  Notice,
  AbstractInputSuggest,
  prepareFuzzySearch,
  fussySearch,
  TFolder,
} from "obsidian";
import MyCalendarPlugin from "./main";
import {
  HolidaySource,
  CountryHolidaySource,
  CustomHolidaySource,
} from "./types";

export function getAllFolderPaths(app: App): string[] {
  const folders: string[] = [];
  // Ensure root exists and is a TFolder before starting
  const root = app.vault.getRoot();
  if (!(root instanceof TFolder)) {
    console.error("Calendar Plugin: Vault root is not a TFolder.");
    return []; // Return empty array if root isn't as expected
  }

  function traverse(folder: TFolder) {
    // Push the path (root is '', others are relative paths)
    folders.push(folder.path);
    // Recurse through children that are folders
    for (const child of folder.children) {
      if (child instanceof TFolder) {
        traverse(child);
      }
    }
  }

  traverse(root);
  // Optional: Sort alphabetically? Might be nice for display if not filtering
  // folders.sort((a, b) => a.localeCompare(b));
  return folders;
}
// Define the available color options Map<UserFriendlyName, CSSVariableString>
const AVAILABLE_COLOR_OPTIONS: Record<string, string> = {
  "Default (Red pale)": "var(--color-red-tint)", // Provide a clear default option
  "Grey pale": "var(--color-grey-tint)",
  "Orange pale": "var(--color-orange-tint)",
  "Yellow pale": "var(--color-yellow-tint)",
  "Green pale": "var(--color-green-tint)",
  "Mint pale": "var(--color-mint-tint)",
  "Cyan pale": "var(--color-cyan-tint)",
  "Blue pale": "var(--color-blue-tint)",
  "Purple pale": "var(--color-purple-tint)",
  "Red vivid": "var(--color-red-text)",
  "Grey vivid": "var(--color-grey-text)",
  "Orange vivid": "var(--color-orange-text)",
  "Yellow vivid": "var(--color-yellow-text)",
  "Green vivid": "var(--color-green-text)",
  "Mint vivid": "var(--color-mint-text)",
  "Cyan vivid": "var(--color-cyan-text)",
  "Blue vivid": "var(--color-blue-text)",
  "Purple vivid": "var(--color-purple-text)",
};

// Use AVAILABLE_COLOR_OPTIONS for holidays as well for consistency
const HOLIDAY_COLOR_OPTIONS = AVAILABLE_COLOR_OPTIONS; // Use the same map

// Helper to get the variable name from the map, falling back to default
function getColorVar(colorName: string | undefined): string {
  return colorName && AVAILABLE_COLOR_OPTIONS[colorName]
    ? AVAILABLE_COLOR_OPTIONS[colorName]
    : AVAILABLE_COLOR_OPTIONS["Default (Red Tint)"]; // Fallback
}

// Helper to find the key (UserFriendlyName) from the value (CSSVariableString)
function findColorNameByVar(variable: string | undefined): string | undefined {
  if (!variable) return undefined;
  return Object.keys(AVAILABLE_COLOR_OPTIONS).find(
    (key) => AVAILABLE_COLOR_OPTIONS[key] === variable
  );
}

class FolderSuggest extends AbstractInputSuggest<string> {
  private allFolders: string[];

  constructor(
    app: App,
    private inputEl: HTMLInputElement
  ) {
    // No plugin needed here
    super(app, inputEl);
    this.allFolders = getAllFolderPaths(app);

    // Listen for input/focus to show/update suggestions
    this.inputEl.addEventListener("input", this.onInputOrFocus.bind(this));
    this.inputEl.addEventListener("focus", this.onInputOrFocus.bind(this));
  }

  onInputOrFocus() {
    // Don't show suggester if input is empty unless focused? Maybe only open on input > 0 chars
    // Let's open if focused or has input value
    if (!this.inputEl.value && document.activeElement !== this.inputEl) {
      this.close();
      return;
    }
    this.open();
    this.updateSuggestions();
  }

  getSuggestions(query: string): string[] {
    const lowerCaseQuery = query.toLowerCase();

    // Using Fuzzy Search with fallback
    try {
      // Show all/limited if query is empty? Only when focused?
      if (!query) {
        // Avoid overwhelming list, maybe return first N or based on recent?
        // Returning all for now, consider limiting (e.g., .slice(0, 100))
        return this.allFolders;
      }
      const preparedQuery = prepareFuzzySearch(query);
      // Handle root path '' correctly if needed during search?
      // fuzzySearch might handle '' okay, but test.
      const searchableItems = this.allFolders.map((path) => ({ text: path }));
      const matches = fuzzySearch(preparedQuery, searchableItems);
      return matches.map((match) => match.item.text);
    } catch (e) {
      console.warn(
        "Calendar Plugin: Folder fuzzy search failed. Falling back to simple filter.",
        e
      );
      // Fallback
      return this.allFolders.filter((folderPath) =>
        folderPath.toLowerCase().includes(lowerCaseQuery)
      );
    }
  }

  renderSuggestion(folderPath: string, el: HTMLElement): void {
    // Display root ('') as '/'
    const displayPath = folderPath === "" ? "/" : folderPath;
    el.setText(displayPath);
  }

  selectSuggestion(folderPath: string, evt: MouseEvent | KeyboardEvent): void {
    // Set input value based on display preference (using '/')
    this.inputEl.value = folderPath === "" ? "/" : folderPath;
    // Trigger input event for onChange handlers
    this.inputEl.dispatchEvent(new Event("input"));
    this.close();
  }
}

// --- Tag Suggester Class ---
class TagSuggest extends AbstractInputSuggest<string> {
  private allTags: string[]; // Cache all tags locally

  constructor(
    app: App,
    private inputEl: HTMLInputElement,
    plugin: MyCalendarPlugin
  ) {
    super(app, inputEl);
    // Get all tags from the vault immediately
    this.allTags = Object.keys(app.metadataCache.getTags() || {}); // Use || {} for safety
    // Optional: Listen for metadata changes to update tags dynamically?
    // Could be complex, might be simpler to re-fetch when settings open or on demand.
    this.inputEl.addEventListener("input", this.onInput.bind(this));
    this.inputEl.addEventListener("focus", this.onInput.bind(this)); // Also open on focus
  }
  // Handle input changes
  onInput() {
    if (!this.inputEl.value) {
      this.close(); // Close if input is empty
      return;
    }
    // Open and update suggestions
    this.open();
    this.updateSuggestions(); // Should internally call getSuggestions
  }
  // Builds the suggestion list based on the input query
  getSuggestions(query: string): string[] {
    const lowerCaseQuery = query.toLowerCase();

    // --- Option 1: Simple Substring Filter (Safer Fallback) ---
    // const filteredTags = this.allTags.filter(tag =>
    // 	tag.toLowerCase().includes(lowerCaseQuery)
    // );
    // return filteredTags;

    // --- Option 2: Obsidian's Fuzzy Search ---
    try {
      if (!query) {
        // If query is empty, maybe return all or recent?
        return this.allTags.slice(0, 50); // Limit if showing all
      }
      const preparedQuery = prepareFuzzySearch(query);
      const searchableItems = this.allTags.map((tag) => ({ text: tag }));
      const matches = fuzzySearch(preparedQuery, searchableItems);
      return matches.map((match) => match.item.text);
    } catch (e) {
      console.warn(
        "Calendar Plugin: Obsidian's internal fuzzy search not available or failed. Falling back to simple filter.",
        e
      );
      // Fallback to simple filter if fuzzy search fails
      return this.allTags.filter((tag) =>
        tag.toLowerCase().includes(lowerCaseQuery)
      );
    }
  }

  // Renders how each suggestion looks in the dropdown
  renderSuggestion(tag: string, el: HTMLElement): void {
    el.setText(tag);
    // Optional: Add highlighting if using fuzzy search results
    // This part can be complex if `renderResults` isn't directly usable.
    // You might need to manually parse `fuzzySearch` match results
    // and wrap matched characters in spans with a specific class.
    // For simplicity, we'll just set the text for now.
  }

  // Called when the user selects a suggestion (mouse or keyboard)
  selectSuggestion(tag: string, evt: MouseEvent | KeyboardEvent): void {
    this.inputEl.value = tag; // Update the input field value
    // --- Use dispatchEvent ---
    this.inputEl.dispatchEvent(new Event("input"));
    this.close(); // Close the suggestion dropdown
  }
}

export class CalendarSettingTab extends PluginSettingTab {
  plugin: MyCalendarPlugin;
  private availableCountries: { code: string; name: string }[] = []; // Cache for country list

  constructor(app: App, plugin: MyCalendarPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty(); // Clear old settings

    containerEl.createEl("h1", { text: "Continuous Calendar Settings" });

    // --- Basic Settings ---
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
              this.plugin.refreshCalendarView(); // Refresh needed
            }
          })
      );

    new Setting(containerEl)
      .setName("Birthdays Folder Path")
      .setDesc(
        'Path to folder with birthday notes. Type to search. "/" for root.'
      )
      .addText((text) => {
        const displayValue =
          this.plugin.settings.birthdayFolder === ""
            ? "/"
            : this.plugin.settings.birthdayFolder;
        text
          .setPlaceholder("/")
          .setValue(displayValue)
          .onChange(async (value) => {
            // Convert '/' back to '' for storage, trim others
            const storageValue = value.trim() === "/" ? "" : value.trim();
            this.plugin.settings.birthdayFolder = storageValue;
            await this.plugin.saveSettings();
            this.plugin.refreshCalendarView(); // Refresh if path change affects view
          });

        // Attach the suggester
        new FolderSuggest(this.app, text.inputEl);
      });

    //
    new Setting(containerEl)
      .setName("Birthday symbol / emoji")
      .setDesc("Single character shown for birthdays (e.g. 🎂, ✱, ★).")
      .addText((text) => {
        text
          .setPlaceholder("🎂")
          .setValue(this.plugin.settings.defaultBirthdaySymbol)
          .onChange(async (value) => {
            this.plugin.settings.defaultBirthdaySymbol = value.trim() || "🎂";
            await this.plugin.saveSettings();
            this.plugin.refreshCalendarView();
          });
      });
    new Setting(containerEl)
      .setName("Default Birthday text Color")
      .setDesc("Fallback color if no `color` frontmatter is specified.")
      .addDropdown((dropdown) => {
        let colorPreview: HTMLDivElement; // Define reference to store preview element

        Object.keys(AVAILABLE_COLOR_OPTIONS).forEach((friendlyName) => {
          const cssVar = AVAILABLE_COLOR_OPTIONS[friendlyName];
          dropdown.addOption(cssVar, friendlyName);
        });

        dropdown.setValue(this.plugin.settings.defaultBirthdayColor);

        dropdown.onChange(async (value: string) => {
          this.plugin.settings.defaultBirthdayColor = value;
          await this.plugin.saveSettings();
          this.plugin.refreshCalendarView();
          if (colorPreview) {
            // Update preview immediately
            colorPreview.style.backgroundColor = value;
          }
        });

        // Create preview dot after dropdown setup
        colorPreview = dropdown.selectEl.parentElement?.createEl("div", {
          attr: {
            style:
              "display: inline-block; width: 15px; height: 15px; border-radius: 50%; margin-left: 8px; vertical-align: middle; background-color: " +
              this.plugin.settings.defaultBirthdayColor,
          },
        });
      });

    new Setting(containerEl)
      .setName("Default Event Dot Color")
      .setDesc("Fallback color if no `color` frontmatter is specified.")
      .addDropdown((dropdown) => {
        let colorPreview: HTMLDivElement;

        Object.keys(AVAILABLE_COLOR_OPTIONS).forEach((friendlyName) => {
          const cssVar = AVAILABLE_COLOR_OPTIONS[friendlyName];
          dropdown.addOption(cssVar, friendlyName);
        });

        dropdown.setValue(this.plugin.settings.defaultDotColor);

        dropdown.onChange(async (value: string) => {
          this.plugin.settings.defaultDotColor = value;
          await this.plugin.saveSettings();
          this.plugin.refreshCalendarView();
          if (colorPreview) {
            colorPreview.style.backgroundColor = value;
          }
        });

        colorPreview = dropdown.selectEl.parentElement?.createEl("div", {
          attr: {
            style:
              "display: inline-block; width: 15px; height: 15px; border-radius: 50%; margin-left: 8px; vertical-align: middle; background-color: " +
              this.plugin.settings.defaultDotColor,
          },
        });
      });

    new Setting(containerEl)
      .setName("Default Range Bar Color")
      .setDesc(
        "Fallback color for range bars if note has no `color` frontmatter."
      )
      .addDropdown((dropdown) => {
        let colorPreview: HTMLDivElement;

        Object.keys(AVAILABLE_COLOR_OPTIONS).forEach((friendlyName) => {
          const cssVar = AVAILABLE_COLOR_OPTIONS[friendlyName];
          dropdown.addOption(cssVar, friendlyName);
        });

        dropdown.setValue(this.plugin.settings.defaultBarColor);

        dropdown.onChange(async (value: string) => {
          this.plugin.settings.defaultBarColor = value;
          await this.plugin.saveSettings();
          this.plugin.refreshCalendarView();
          if (colorPreview) {
            colorPreview.style.backgroundColor = value;
          }
        });

        colorPreview = dropdown.selectEl.parentElement?.createEl("div", {
          attr: {
            style:
              "display: inline-block; width: 15px; height: 15px; border-radius: 50%; margin-left: 8px; vertical-align: middle; background-color: " +
              this.plugin.settings.defaultBarColor,
          },
        });
      });

    new Setting(containerEl)
      .setName("Confirm before creating daily notes")
      // ... (Confirm toggle remains the same) ...
      .setDesc(
        "Show a confirmation dialog asking if you want to create a missing daily note."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.shouldConfirmBeforeCreate)
          .onChange(async (value) => {
            this.plugin.settings.shouldConfirmBeforeCreate = value;
            await this.plugin.saveSettings();
            // No view refresh needed
          })
      );

    new Setting(containerEl)
      .setName("Confirm before creating range notes")
      .setDesc(
        "Show a confirmation dialog asking if you want to create a note for the selected date range."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.shouldConfirmBeforeCreateRange)
          .onChange(async (value) => {
            this.plugin.settings.shouldConfirmBeforeCreateRange = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Holiday Definition Folder")
      .setDesc(
        'Folder for holiday definition files. Type to search. "/" for root.'
      )
      .addText((text) => {
        const displayValue =
          this.plugin.settings.holidayStorageFolder === ""
            ? "/"
            : this.plugin.settings.holidayStorageFolder;
        text
          .setPlaceholder("Example: 02-Calendar/Holidays")
          .setValue(displayValue)
          .onChange(async (value) => {
            // Convert '/' back to '' for storage, trim others
            const storageValue = value.trim() === "/" ? "" : value.trim();
            this.plugin.settings.holidayStorageFolder = storageValue;
            await this.plugin.saveSettings();
            this.plugin.refreshCalendarView(); // Refresh needed
          });

        // Attach the suggester
        new FolderSuggest(this.app, text.inputEl);
      });

    // --- Display Current Holiday Sources (with Color Picker) ---
    containerEl.createEl("h3", { text: "Active Holiday Sources" });
    const sourcesListEl = containerEl.createDiv("holiday-sources-list");
    if (
      !this.plugin.settings.holidaySources ||
      this.plugin.settings.holidaySources.length === 0
    ) {
      sourcesListEl.createEl("p", { text: "No holiday sources configured." });
    } else {
      this.renderHolidaySourcesWithColor(sourcesListEl);
    }

    // --- Add New Holiday Source Controls (with Color Picker) ---
    containerEl.createEl("h3", { text: "Add New Holiday Source" });
    if (this.availableCountries.length === 0) {
      await this.fetchAvailableCountries();
    }
    this.renderAddHolidaySourceControlsWithColor(containerEl);

    // --- Manual Update Button ---
    new Setting(containerEl)
      .setName("Update Country Holidays Now")
      .setDesc(
        `Manually fetch and update holiday data for configured country sources for the currently displayed year (${this.plugin.settings.year}).`
      )
      .addButton((button) =>
        button
          .setButtonText("Fetch & Update")
          .setCta()
          .onClick(async () => {
            if (!this.plugin.holidayService) {
              new Notice("Holiday service is not ready.");
              return;
            }
            button.setDisabled(true).setButtonText("Updating...");
            await this.plugin.holidayService.fetchAndUpdateAllCountryFilesForYear(
              this.plugin.settings.year
            );
            button.setDisabled(false).setButtonText("Fetch & Update");
            // Optionally, re-render settings if needed
          })
      );
    // --- Tag-Based Default Color Settings Section ---
    this.renderTagColorSettings(containerEl);

    this.addDonatingSetting(containerEl);
  }

  private renderTagColorSettings(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Tag-Based Default Colors" });
    containerEl.createEl("p", {
      text: "Define default colors for notes based on their tags. This color will be used if a note has a matching tag but does *not* have an explicit `color` property defined in its frontmatter. If a note has multiple matching tags, the first match found in this list will be used.",
      cls: "setting-item-description",
    });

    // --- Display Current Tag Mappings ---
    const mappingsListEl = containerEl.createDiv("tag-color-mappings-list");
    if (Object.keys(this.plugin.settings.tagAppearance).length === 0) {
      mappingsListEl.createEl("p", {
        text: "No tag-color mappings defined.",
        cls: "setting-item-description",
      });
    } else {
      this.renderTagMappings(mappingsListEl);
    }

    // --- Add New Tag Mapping Controls ---
    containerEl.createEl("h4", { text: "Add New Tag-Color Mapping" });
    this.renderAddTagMappingControls(containerEl);

    new Setting(containerEl)
      .setName("Collapse duplicate tag icons")
      .setDesc(
        "Show just one icon per tag per day, even if several notes share that tag."
      )
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.collapseDuplicateTagSymbols)
          .onChange(async (v) => {
            this.plugin.settings.collapseDuplicateTagSymbols = v;
            await this.plugin.saveSettings();
            this.plugin.refreshCalendarView(); // instant feedback
          })
      );
  }

  /**
   * Renders the list of existing tag-color mappings with controls.
   */
  private renderTagMappings(containerEl: HTMLElement): void {
    const mappings = this.plugin.settings.tagAppearance;
    // Sort tags alphabetically for consistent display
    const sortedTags = Object.keys(mappings).sort();

    sortedTags.forEach((tag) => {
      const currentAppearance = mappings[tag];
      const currentColorVar = currentAppearance.color;

      const settingItem = new Setting(containerEl).setName(tag);

      // Color Dropdown
      settingItem.addDropdown((dd) => {
        Object.keys(AVAILABLE_COLOR_OPTIONS).forEach((key) => {
          dd.addOption(AVAILABLE_COLOR_OPTIONS[key], key);
        });
        dd.setValue(currentAppearance.color);

        dd.onChange(async (newVar) => {
          currentAppearance.color = newVar;
          colorPreview.style.backgroundColor = newVar; // ← live preview
          await this.plugin.saveSettings();
          this.plugin.refreshCalendarView();
        });
      });

      // — symbol textbox —
      settingItem.addText((text) => {
        text
          .setPlaceholder("●")
          .setValue(currentAppearance.symbol ?? "")
          .onChange(async (val) => {
            const appearance = this.plugin.settings.tagAppearance[tag];
            appearance.symbol = val.trim() || undefined;
            await this.plugin.saveSettings();
            this.plugin.refreshCalendarView();
          });
      });

      // Color Preview Dot
      const colorPreview = settingItem.controlEl.createEl("div");
      colorPreview.style.display = "inline-block";
      colorPreview.style.width = "15px";
      colorPreview.style.height = "15px";
      colorPreview.style.borderRadius = "50%"; // Make it a dot
      colorPreview.style.marginLeft = "10px";
      colorPreview.style.verticalAlign = "middle";
      colorPreview.style.backgroundColor = currentColorVar; // Use the actual CSS variable

      // Remove Button
      settingItem.addButton((button) =>
        button
          .setIcon("trash")
          .setTooltip(`Remove mapping for ${tag}`)
          .setWarning() // Optional: make it red
          .onClick(async () => {
            delete this.plugin.settings.tagAppearance[tag];
            await this.plugin.saveSettings();
            new Notice(`Removed color mapping for tag: ${tag}`);
            this.display(); // Re-render the settings tab
            this.plugin.refreshCalendarView();
          })
      );
    });
  }

  /**
   * Renders the controls for adding a new tag-color mapping.
   */
  private renderAddTagMappingControls(containerEl: HTMLElement): void {
    // ── local state ────────────────────────────────────────────────
    let newSymbol = "●"; // default glyph / emoji
    let selectedColorVar = AVAILABLE_COLOR_OPTIONS["Default (Red Tint)"];

    // wrapper
    const wrapper = containerEl.createDiv("add-tag-mapping-controls");

    // one Setting row that will hold all three controls + button
    const row = new Setting(wrapper).setName("New Tag Mapping");

    // 1️⃣  tag textbox  ─────────────────────────────────────────────
    let tagInputComponent: TextComponent | null = null;

    row.addText((text) => {
      tagInputComponent = text;
      text.setPlaceholder("#your/tag").onChange(() => {
        /* nothing; we read the value later */
      });

      new TagSuggest(this.app, text.inputEl, this.plugin); // suggester
    });

    // 2️⃣  symbol textbox  (NEW)  ──────────────────────────────────
    row.addText((text) => {
      text
        .setPlaceholder("● / 😎 / * …")
        .onChange((v) => (newSymbol = v.trim() || "●"));
    });

    // 3️⃣  colour dropdown  ────────────────────────────────────────
    row.addDropdown((dd) => {
      for (const key of Object.keys(AVAILABLE_COLOR_OPTIONS)) {
        dd.addOption(AVAILABLE_COLOR_OPTIONS[key], key);
      }
      dd.setValue(selectedColorVar);
      dd.onChange((v) => (selectedColorVar = v));
    });

    // 4️⃣  “Add mapping” button  ───────────────────────────────────
    row.addButton((btn) =>
      btn
        .setButtonText("Add Mapping")
        .setCta()
        .onClick(async () => {
          const tag = tagInputComponent?.getValue().trim() ?? "";
          if (!tag) {
            new Notice("Enter a tag first");
            return;
          }
          if (!tag.startsWith("#")) {
            new Notice("Tag must start with '#'");
            return;
          }
          if (this.plugin.settings.tagAppearance?.[tag]) {
            new Notice(`Mapping for "${tag}" already exists`);
            return;
          }

          // ⬇️ store both colour & symbol
          this.plugin.settings.tagAppearance[tag] = {
            color: selectedColorVar,
            symbol: newSymbol,
          };

          await this.plugin.saveSettings();
          this.display(); // refresh settings UI
          this.plugin.refreshCalendarView();

          // reset quick‑entry fields
          tagInputComponent?.setValue("");
          newSymbol = "●";
          selectedColorVar = AVAILABLE_COLOR_OPTIONS["Default (Red Tint)"];
        })
    );
  }
  /**
   * At the very end, define the donation-setting method.
   */
  private addDonatingSetting(containerEl: HTMLElement): void {
    const s = new Setting(containerEl)
      .setName("Donate")
      .setDesc(
        "If you like this Plugin, consider donating to support continued development."
      );

    const a1 = document.createElement("a");
    a1.setAttribute(
      "href",
      "https://www.paypal.com/donate/?hosted_button_id=R24VP67KCPC88"
    );
    a1.addClass("continuous_calendar_donating");
    const img2 = document.createElement("img");
    img2.src =
      "https://img.shields.io/badge/paypal-LoopBreaker-yellow?style=social&logo=paypal";
    a1.appendChild(img2);

    s.settingEl.appendChild(a1);
  }

  /**
   * MODIFIED: Renders the list of currently configured holiday sources
   * with remove buttons AND color pickers for country sources.
   */
  private renderHolidaySourcesWithColor(containerEl: HTMLElement): void {
    this.plugin.settings.holidaySources.forEach((source, index) => {
      const settingItem = new Setting(containerEl).setName(
        source.type === "country"
          ? `Country: ${source.countryCode.toUpperCase()}`
          : `Custom: ${source.name}`
      );

      // Add description remains unchanged
      settingItem.setDesc(
        source.type === "country"
          ? `Using date-holidays library for ${this.getCountryName(source.countryCode)}`
          : `Using custom file: "${this.plugin.settings.year} Holidays ${this.plugin.holidayService.getHolidaySourceId(source)}.md"`
      );

      // Add Color Dropdown ONLY for country sources
      if (source.type === "country") {
        const colorPreview = settingItem.controlEl.createEl("div");
        colorPreview.style.display = "inline-block";
        colorPreview.style.width = "15px";
        colorPreview.style.height = "15px";
        colorPreview.style.borderRadius = "3px";
        colorPreview.style.marginLeft = "10px";
        colorPreview.style.verticalAlign = "middle";
        // Set initial color
        colorPreview.style.backgroundColor =
          source.color || AVAILABLE_COLOR_OPTIONS["Default (Red Tint)"];
        // Now add the dropdown:
        settingItem.addDropdown((dropdown) => {
          Object.keys(AVAILABLE_COLOR_OPTIONS).forEach((key) => {
            dropdown.addOption(AVAILABLE_COLOR_OPTIONS[key], key);
          });
          // Set the dropdown to the note's currently saved color
          dropdown.setValue(
            source.color ?? AVAILABLE_COLOR_OPTIONS["Default (Red Tint)"]
          );

          // Update both the note’s saved color *and* the preview whenever user picks a new color
          dropdown.onChange(async (value) => {
            // Update the plugin’s holiday source color setting
            const sourceToUpdate = this.plugin.settings.holidaySources[index];
            if (sourceToUpdate?.type === "country") {
              sourceToUpdate.color = value;
            }
            await this.plugin.saveSettings();
            this.plugin.refreshCalendarView();

            // **HERE** we also update the preview
            colorPreview.style.backgroundColor = value;
          });
        });
      }

      // Add Remove Button
      settingItem.addButton((button) =>
        button
          .setIcon("trash")
          .setTooltip("Remove this source")
          .onClick(async () => {
            this.plugin.settings.holidaySources.splice(index, 1);
            await this.plugin.saveSettings();
            this.display();
            new Notice(`Removed holiday source.`);
            this.plugin.refreshCalendarView();
          })
      );
    });
  }

  /**
   * Fetches the list of countries from the service and caches it.
   */
  private async fetchAvailableCountries(): Promise<void> {
    if (!this.plugin.holidayService) {
      console.error("Cannot fetch countries: Holiday service not available.");
      return;
    }
    try {
      this.availableCountries =
        await this.plugin.holidayService.getAvailableCountries();
      this.availableCountries.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      console.error("Error fetching available countries:", error);
      new Notice("Could not load list of countries for holiday settings.");
      this.availableCountries = [];
    }
  }

  /**
   * Gets the display name for a country code from the cached list.
   */
  private getCountryName(code: string): string {
    const country = this.availableCountries.find(
      (c) => c.code.toUpperCase() === code.toUpperCase()
    );
    return country ? country.name : code;
  }

  /**
   * MODIFIED: Renders the controls for adding a new source,
   * including a color picker for country sources.
   */
  private renderAddHolidaySourceControlsWithColor(
    containerEl: HTMLElement
  ): void {
    let selectedType: "country" | "custom" = "country";
    let selectedCountryCode: string =
      this.availableCountries.length > 0 ? this.availableCountries[0].code : "";
    let selectedColorVar: string =
      AVAILABLE_COLOR_OPTIONS["Default (Red Tint)"];
    let customName: string = "";

    const addControlsContainer = containerEl.createDiv(
      "add-holiday-source-controls"
    );

    new Setting(addControlsContainer)
      .setName("Source Type")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("country", "Country (uses library)")
          .addOption("custom", "Custom (manual file)")
          .setValue(selectedType)
          .onChange((value) => {
            selectedType = value as "country" | "custom";
            this.display(); // Refresh to show/hide the proper controls
          });
      });

    if (selectedType === "country") {
      if (this.availableCountries.length > 0) {
        new Setting(addControlsContainer)
          .setName("Select Country")
          .addDropdown((dropdown) => {
            // 1) Add a placeholder option:
            dropdown.addOption("", "Select a country...");

            // 2) Add all real countries
            this.availableCountries.forEach((country) => {
              dropdown.addOption(
                country.code,
                `${country.name} (${country.code.toUpperCase()})`
              );
            });

            // 3) Start the dropdown on the placeholder
            dropdown.setValue(""); // Ensure the placeholder is selected by default

            dropdown.onChange((value) => {
              selectedCountryCode = value;
            });
          });

        // ADD Color Picker for Country
        new Setting(addControlsContainer)
          .setName("Assign Color")
          .addDropdown((dropdown) => {
            Object.keys(AVAILABLE_COLOR_OPTIONS).forEach((key) => {
              dropdown.addOption(AVAILABLE_COLOR_OPTIONS[key], key);
            });
            dropdown.setValue(selectedColorVar);
            dropdown.onChange((value) => {
              selectedColorVar = value;
            });
          });
      } else {
        addControlsContainer.createEl("p", {
          text: "Could not load country list. Check console or try reloading.",
          cls: "setting-item-description",
        });
      }
    } else {
      // custom type
      new Setting(addControlsContainer)
        .setName("Custom Set Name")
        .setDesc(
          'A short name for this custom set (e.g., "Family", "ProjectX"). Used in the filename.'
        )
        .addText((text) => {
          text
            .setPlaceholder("Enter custom name")
            .setValue(customName)
            .onChange((value) => {
              customName = value.trim();
            });
        });
    }

    // Add Button to add the new source.
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
              new Notice(
                `Country source '${selectedCountryCode.toUpperCase()}' already exists.`
              );
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
              new Notice(
                `A custom source that generates the ID '${sourceId}' already exists.`
              );
              return;
            }
            newSource = { type: "custom", name: customName };
          }

          if (newSource) {
            this.plugin.settings.holidaySources.push(newSource);
            await this.plugin.saveSettings();
            if (this.plugin.holidayService) {
              await this.plugin.holidayService.ensureHolidayFileExists(
                this.plugin.settings.year,
                newSource
              );
            }
            new Notice(`Added holiday source.`);
            this.display(); // Re-render the settings tab
            this.plugin.refreshCalendarView();
          }
        })
    );
  }
}
