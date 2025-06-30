# Table of Contents

1. [src/holidayService.ts](#src/holidayservice.ts)
2. [src/main.ts](#src/main.ts)
3. [src/modal.ts](#src/modal.ts)
4. [src/settings.ts](#src/settings.ts)
5. [src/type.ts](#src/type.ts)
6. [src/view.ts](#src/view.ts)
7. [styles.css](#styles.css)

---

## src/holidayService.ts
ts
// src/holidayService.ts
import { App, TFile, Notice, normalizePath, stringifyYaml, parseYaml, moment } from 'obsidian';
import MyCalendarPlugin from './main';
import { HolidaySource, Holiday, HolidayFileFrontMatter, CountryHolidaySource, CustomHolidaySource } from './types';


const HOLIDAY_FILE_PREFIX = " Holidays ";


// Define a new type for the aggregated map value
interface AggregatedHolidayInfo {
    name: string;
    color?: string; // The CSS variable string assigned to the source country
}

export class HolidayService {
    app: App;
    plugin: MyCalendarPlugin;
    // Use a cache to hold date-holidays instances keyed by country (or generic)
    private hdCache = new Map<string, any>();

    constructor(app: App, plugin: MyCalendarPlugin) {
        this.app = app;
        this.plugin = plugin;
    }

    // --- Modified to Initialize with Country Code ---
    private async getDateHolidaysInstance(countryCode?: string): Promise<any | null> {
        // Use a specific cache key if countryCode is provided; otherwise use a generic key.
        const cacheKey = countryCode ? countryCode.toUpperCase() : '__generic__';

        if (this.hdCache.has(cacheKey)) {
            return this.hdCache.get(cacheKey);
        }

        try {
            const Holidays = require('date-holidays');
            // Pass the country code to the constructor if provided
            const instance = countryCode ? new Holidays(countryCode) : new Holidays();
            console.log(`[Debug] date-holidays instance created${countryCode ? ` for ${countryCode}` : ''}.`);
            this.hdCache.set(cacheKey, instance);
            return instance;
        } catch (err) {
            console.error(`[Debug] Failed to load/init 'date-holidays' library${countryCode ? ` for ${countryCode}` : ''}.`, err);
            new Notice("Failed to load holiday library. Country features disabled.");
            return null;
        }
    }

    async getAvailableCountries(): Promise<{ code: string; name: string }[]> {
        // Get the generic instance (no country code) for listing available countries.
        const hd = await this.getDateHolidaysInstance();
        if (!hd) return [];
        try {
            const countries = hd.getCountries();
            return Object.entries(countries).map(([code, name]) => ({ code, name: name as string }));
        } catch (err) {
            console.error("Error getting country list from date-holidays:", err);
            return [];
        }
    }

    getHolidaySourceId(source: HolidaySource): string {
        if (source.type === 'country') {
            return source.countryCode.toUpperCase();
        } else {
            return source.name.replace(/[^a-zA-Z0-9_-\s]/g, '').replace(/\s+/g, '_');
        }
    }

    getHolidayFileName(year: number, sourceId: string): string {
        return `${year}${HOLIDAY_FILE_PREFIX}${sourceId}.md`;
    }

    getHolidayFilePath(year: number, source: HolidaySource): string {
        const folder = this.plugin.settings.holidayStorageFolder;
        const sourceId = this.getHolidaySourceId(source);
        const fileName = this.getHolidayFileName(year, sourceId);
        return normalizePath(`${folder}/${fileName}`);
    }

    // --- Modified fetchCountryHolidays to use the specific instance ---
    async fetchCountryHolidays(countryCode: string, year: number): Promise<Holiday[]> {
        console.log(`[Debug] fetchCountryHolidays called for: ${countryCode}, ${year}`);
        // Get the instance specifically initialized for this country
        const hd = await this.getDateHolidaysInstance(countryCode);
        if (!hd) {
            console.warn(`[Debug] Cannot fetch holidays: date-holidays instance not available for ${countryCode}.`);
            return [];
        }
        try {
            console.log(`[Debug] Attempting hd.getHolidays(${year}) for initialized instance`);
            const rawHolidays = hd.getHolidays(year);
            console.log("[Debug] Raw holidays received from library:", rawHolidays);

            if (!rawHolidays || !Array.isArray(rawHolidays)) {
                console.warn(`[Debug] Received invalid/non-array holidays for ${countryCode}, ${year}.`);
                return [];
            }

            // Map raw holiday entries to your Holiday interface
            const mappedHolidays = rawHolidays.map((h: any) => {
                if (!h || !h.date || !h.name) {
                    console.warn("[Debug] Skipping invalid holiday object received:", h);
                    return null;
                }
                const dateMoment = moment(h.date);
                if (!dateMoment.isValid()) {
                    console.warn(`[Debug] Invalid date format received for ${h.name}: ${h.date}`);
                    return null;
                }
                return {
                    date: dateMoment.format('YYYY-MM-DD'),
                    name: h.name,
                };
            });

            const filteredHolidays = mappedHolidays.filter((h): h is Holiday =>
                h !== null && h.date.startsWith(year.toString())
            );
            console.log(`[Debug] Final filtered holidays for ${countryCode}, ${year}:`, filteredHolidays);
            return filteredHolidays;
        } catch (err: any) {
            console.error(`[Debug] Error caught in fetchCountryHolidays for ${countryCode}, ${year}:`, err);
            return [];
        }
    }

    async ensureHolidayFileExists(year: number, source: HolidaySource): Promise<TFile | null> {
        const filePath = this.getHolidayFilePath(year, source);
        let file = this.app.vault.getAbstractFileByPath(filePath);

        if (file instanceof TFile) {
            return file;
        }

        // File doesn't exist, create it
        try {
            const folder = this.plugin.settings.holidayStorageFolder;
            // Ensure folder exists
            if (!await this.app.vault.adapter.exists(normalizePath(folder))) {
                await this.app.vault.createFolder(folder);
            }

            let initialFrontMatter: HolidayFileFrontMatter;
            let fileContent = "";

            if (source.type === 'country') {
                initialFrontMatter = {
                    holidaySourceType: 'country',
                    countryCode: source.countryCode.toUpperCase(),
                    year: year,
                    holidays: [], // Will be fetched separately
                    lastFetched: undefined,
                };
                fileContent = `# ${year} Holidays for ${source.countryCode.toUpperCase()}\n\nThis file is automatically managed for country holidays. Fetched data is stored in the frontmatter.\n`;
            } else { // Custom type
                initialFrontMatter = {
                    holidaySourceType: 'custom',
                    customName: source.name,
                    year: year,
                    holidays: [], // User adds these manually
                };
                fileContent = `# ${year} Custom Holidays: ${source.name}\n\nAdd your custom holidays to the 'holidays' list in the frontmatter below.\n\nExample:\n\`\`\`yaml\nholidays:\n  - date: ${year}-10-31\n    name: My Special Day\n\`\`\`\n`;
            }

            const fmString = `---\n${stringifyYaml(initialFrontMatter)}---`;
            const fullContent = `${fmString}\n\n${fileContent}`;

            file = await this.app.vault.create(filePath, fullContent);
            console.log(`Created holiday file: ${filePath}`);
            return file instanceof TFile ? file : null;
        } catch (err) {
            console.error(`Error creating holiday file ${filePath}:`, err);
            new Notice(`Failed to create file for ${this.getHolidaySourceId(source)} holidays.`);
            return null;
        }
    }

    async updateCountryHolidayFile(year: number, source: CountryHolidaySource): Promise<boolean> {
        const file = await this.ensureHolidayFileExists(year, source);
        if (!file) return false;

        console.log(`Fetching updated holidays for ${source.countryCode}, ${year}...`);
        const fetchedHolidays = await this.fetchCountryHolidays(source.countryCode, year);

        try {
            await this.app.fileManager.processFrontMatter(file, (fm) => {
                const data: HolidayFileFrontMatter = {
                    holidaySourceType: 'country',
                    countryCode: source.countryCode.toUpperCase(),
                    year: year,
                    holidays: fetchedHolidays,
                    lastFetched: new Date().toISOString(),
                    ...fm,
                };
                for (const key in fm) {
                    delete fm[key];
                }
                Object.assign(fm, data);
            });
            console.log(`Updated holiday file: ${file.path} with ${fetchedHolidays.length} holidays.`);
            if (fetchedHolidays.length > 0) {
                new Notice(`Updated ${source.countryCode} holidays for ${year}.`);
            } else {
                console.log(`Finished update process for ${source.countryCode}, ${year}. 0 holidays found or fetch error occurred.`);
            }
            return true;
        } catch (err) {
            console.error(`Error updating frontmatter for ${file.path}:`, err);
            new Notice(`Failed to save updated holidays for ${source.countryCode}.`);
            return false;
        }
    }

    async fetchAndUpdateAllCountryFilesForYear(year: number): Promise<void> {
        let updatedCount = 0;
        let failedCount = 0;
        const countrySources = this.plugin.settings.holidaySources.filter(s => s.type === 'country') as CountryHolidaySource[];

        if (countrySources.length === 0) {
            new Notice("No country holiday sources configured in settings.");
            return;
        }

        new Notice(`Starting holiday update for ${countrySources.length} country source(s) for ${year}...`);

        for (const source of countrySources) {
            const success = await this.updateCountryHolidayFile(year, source);
            if (success) {
                updatedCount++;
            } else {
                failedCount++;
            }
        }

        let summaryNotice = `Holiday update for ${year} complete. `;
        if (updatedCount > 0) summaryNotice += `Processed: ${updatedCount}. `;
        if (failedCount > 0) summaryNotice += `Failed: ${failedCount}. `;
        summaryNotice += `Check console for details.`;
        new Notice(summaryNotice);

        // Trigger refresh in main plugin AFTER all updates are done
        this.plugin.refreshCalendarView();
    }

    async getAggregatedHolidays(year: number): Promise<Map<string, Holiday[]>> {
        const aggregatedHolidays = new Map<string, Holiday[]>();
        const activeSources = this.plugin.settings.holidaySources;
        const folder = this.plugin.settings.holidayStorageFolder;

        if (!activeSources || activeSources.length === 0) {
            return aggregatedHolidays;
        }
        console.log(`Aggregating holidays for ${year} from ${activeSources.length} sources.`);

        for (const source of activeSources) {
            // *** Get the assigned color for this source (if it's a country source) ***
            const sourceColor = source.type === 'country' ? source.color : undefined;
            const sourceId = this.getHolidaySourceId(source);
            const filePath = this.getHolidayFilePath(year, source);
            const file = this.app.vault.getAbstractFileByPath(filePath);

            if (!(file instanceof TFile)) {
                console.warn(`Holiday file not found for source ${sourceId} year ${year}: ${filePath}`);
                continue;
            }

            try {
                const cache = this.app.metadataCache.getFileCache(file);
                const fm = cache?.frontmatter;

                if (fm && typeof fm === 'object' && fm.holidays && Array.isArray(fm.holidays) && fm.year === year) {
                    const holidaysFromFile = fm.holidays as any[];

                    holidaysFromFile.forEach((holiday: any) => {
                        if (holiday && typeof holiday.date === 'string' && typeof holiday.name === 'string') {
                            const dateMoment = moment(holiday.date, "YYYY-MM-DD", true);
                            if (dateMoment.isValid() && dateMoment.year() === year) {
                                const dateStr = dateMoment.format("YYYY-MM-DD");
                                if (!aggregatedHolidays.has(dateStr)) {
                                    aggregatedHolidays.set(dateStr, []);
                                }
                                if (!aggregatedHolidays.get(dateStr)?.some(h => h.name === holiday.name)) {
                                    aggregatedHolidays.get(dateStr)?.push({ date: dateStr, name: holiday.name, color: sourceColor });
                                }
                            }
                        } else {
                            console.warn(`Skipping invalid holiday structure in ${filePath}:`, holiday);
                        }
                    });
                } else if (fm && fm.year !== year) {
                    // File exists but is for a different year; skip it.
                } else if (source.type === 'country' && !fm?.holidays && !fm?.lastFetched) {
                    console.warn(`Country holiday file ${filePath} exists but seems uninitialized. Try running the update command.`);
                } else {
                    console.warn(`Invalid, missing, or mismatched frontmatter in holiday file: ${filePath}. Expected year ${year}, found: ${fm?.year}. FM content:`, fm);
                }
            } catch (err) {
                console.error(`Error reading frontmatter from ${filePath}:`, err);
            }
        }
        const totalHolidays = [...aggregatedHolidays.values()].flat().length;
        console.log(`Finished aggregation: Found ${totalHolidays} holidays across ${aggregatedHolidays.size} dates for ${year}.`);
        return aggregatedHolidays;
    }
}


## src/main.ts
ts
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



## src/modal.ts
ts
// src/modal.ts
import { App, Modal } from "obsidian";

// Interface defining the parameters for the confirmation dialog
interface IConfirmationDialogParams {
  cta: string; // Call-to-action button text (e.g., "Create")
  // Callback function to execute when the CTA button is clicked
  // It receives the original mouse event if needed and should be async
  onAccept: (e: MouseEvent) => Promise<void>;
  text: string; // The main message/question in the modal body
  title: string; // The title of the modal window
}

// The actual Modal class
export class ConfirmationModal extends Modal {
  config: IConfirmationDialogParams;

  // Store the configuration passed to the constructor
  constructor(app: App, config: IConfirmationDialogParams) {
    super(app);
    this.config = config;
  }

  // This method is called when the modal is opened
  onOpen() {
    const { contentEl } = this;
    const { cta, onAccept, text, title } = this.config; // Use stored config

    contentEl.empty(); // Clear any previous content

    contentEl.createEl("h2", { text: title }); // Set the title
    contentEl.createEl("p", { text }); // Set the body text

    // Create a container for the buttons
    contentEl.createDiv("modal-button-container", (buttonsEl) => {
      // "Cancel" button - simply closes the modal
      buttonsEl
        .createEl("button", { text: "Never mind" })
        .addEventListener("click", () => this.close());

      // "Accept" (Call-to-action) button
      buttonsEl
        .createEl("button", {
          cls: "mod-cta", // Use Obsidian's styling for primary action buttons
          text: cta,
        })
        .addEventListener("click", async (e) => {
          // When clicked, call the async onAccept function passed in the config
          await onAccept(e);
          // Close the modal automatically after the action is performed
          this.close();
        });
    });
  }

  // This method is called when the modal is closed
  onClose() {
    const { contentEl } = this;
    contentEl.empty(); // Clean up the content
  }
}

// Helper function to easily create and open the modal
export function createConfirmationDialog(
  app: App, // Pass the App instance explicitly
  config: IConfirmationDialogParams
): void {
  // Create a new instance of our modal class and open it
  new ConfirmationModal(app, config).open();
}



## src/settings.ts
ts
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



## src/type.ts
ts
// src/types.ts
export interface Holiday {
  date: string; // YYYY-MM-DD
  name: string;
}

interface TagAppearance {
  color: string; // existing
  symbol?: string; // NEW – optional
}

export interface MyCalendarPluginSettings {
  year: number;
  defaultBirthdayColor: string;
  defaultBirthdaySymbol: string;
  defaultDailyNoteSymbol: string;
  defaultDotColor: string;
  defaultBarColor: string;
  birthdayFolder: string;
  shouldConfirmBeforeCreate: boolean;
  shouldConfirmBeforeCreateRange: boolean; // Optional, for future use
  holidaySources: HolidaySource[];
  tagAppearance: Record<string, TagAppearance>;

  focusedMonths: number[];
  opaqueMonths: number[];
  collapseDuplicateTagSymbols: boolean;
}

export interface CountryHolidaySource {
  type: "country";
  countryCode: string; // e.g., 'CO', 'US', 'DE'
  color?: string;
}

export interface CustomHolidaySource {
  type: "custom";
  name: string; // e.g., "Family Birthdays", "Project Deadlines"
}

export type HolidaySource = CountryHolidaySource | CustomHolidaySource;

export interface HolidayFileFrontMatter {
  holidaySourceType: "country" | "custom";
  countryCode?: string; // Only for country type
  customName?: string; // Only for custom type
  year: number;
  holidays: Holiday[];
  lastFetched?: string; // ISO timestamp, for country files to know when updated
}



## src/view.ts
ts
// src/view.ts
import { ItemView, WorkspaceLeaf, TFile, moment, Notice, setIcon, TFolder } from 'obsidian'; 
import {
	getDailyNoteSettings,
	createDailyNote,
	getAllDailyNotes,
	getDailyNote,
	getDateFromFile
} from 'obsidian-daily-notes-interface';

import MyCalendarPlugin from './main';
import { Holiday } from './types'; // Keep Holiday type if used elsewhere
import { createConfirmationDialog } from './modal'; 
import { AggregatedHolidayInfo } from './holidayService';
import { TagAppearance } from './types'; 
export const CALENDAR_VIEW_TYPE = 'yearly-calendar-view';

const MAX_VISIBLE_RANGE_SLOTS = 4;

const BORDER_COLOR_MAP: Record<string,string> = {
  "var(--color-red-tint)":    "var(--color-red-text)",
  "var(--color-grey-tint)":   "var(--color-grey-text)",
  "var(--color-orange-tint)": "var(--color-orange-text)",
  "var(--color-yellow-tint)": "var(--color-yellow-text)",
  "var(--color-green-tint)":  "var(--color-green-text)",
  "var(--color-mint-tint)":   "var(--color-mint-text)",
  "var(--color-cyan-tint)":   "var(--color-cyan-text)",
  "var(--color-blue-tint)":   "var(--color-blue-text)",
  "var(--color-purple-tint)": "var(--color-purple-text)",
};
const DEFAULT_BORDER_COLOR = "var(--color-red-text)"; 

export class CalendarView extends ItemView {
	plugin: MyCalendarPlugin;
	calendarContentEl: HTMLElement;
	activeWeekCell: HTMLElement | null = null;
	engagedDayNumberEl: HTMLElement | null = null;
	private forceOpaqueMonths: Set<number> = new Set();
	private forceFocusMonths: Set<number> = new Set();
	private currentYearHolidays: Map<string, AggregatedHolidayInfo[]> = new Map();
	private startRangeDate: moment.Moment | null = null; 
	private engagedStartRangeEl: HTMLElement | null = null; 

	constructor(leaf: WorkspaceLeaf, plugin: MyCalendarPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return CALENDAR_VIEW_TYPE;
	}

	getDisplayText(): string {
		return `Year Calendar - ${this.plugin.settings.year}`;
	}

	getIcon(): string {
		return 'calendar-days';
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();

		this.calendarContentEl = container.createDiv({ cls: 'continuous-calendar' });

		this.forceFocusMonths = new Set(this.plugin.settings.focusedMonths || []);
		this.forceOpaqueMonths = new Set(this.plugin.settings.opaqueMonths || []);

		await this.renderCalendar();

		this.registerDomEvent(this.calendarContentEl, 'click', this.handleClick.bind(this));
	}

	async onClose() {
		this.activeWeekCell = null;
		this.forceOpaqueMonths.clear();
		this.forceFocusMonths.clear();
		this.startRangeDate = null; // Clear state on close
		this.engagedStartRangeEl = null;
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
						state: { ...state.state, title: newTitle }
					});
				} else {
					await leaf.setViewState({
						type: this.getViewType(),
						state: { title: newTitle }
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
		if (!this.plugin.holidayService) {
			console.error("Holiday service not available in CalendarView.");
			this.calendarContentEl.setText("Error: Holiday service failed to load.");
			return;
		}

		this.calendarContentEl.empty();
		this.activeWeekCell = null;

		const scrollContainer = this.calendarContentEl.createDiv({ cls: 'calendar-scroll-container' });

		const year = this.plugin.settings.year;
		const today = moment().format("YYYY-MM-DD");
		const DEFAULT_HOLIDAY_COLOR_VAR = "var(--color-red-tint)";
		const DEFAULT_DOT_COLOR = this.plugin.settings.defaultDotColor;
		const DEFAULT_BAR_COLOR = this.plugin.settings.defaultBarColor;
		const DEFAULT_BIRTHDAY_COLOR = this.plugin.settings.defaultBirthdayColor;

        const DEFAULT_DAILY_NOTE_SYMBOL = this.plugin.settings.defaultDailyNoteSymbol || ''; // Add fallback
        const tagAppearanceSettings: Record<string, TagAppearance> = this.plugin.settings.tagAppearance; // <-- Use tagAppearance

		console.log("Fetching aggregated holidays for year:", year);
		this.currentYearHolidays = await this.plugin.holidayService.getAggregatedHolidays(year);
		console.log("Fetched holidays map:", this.currentYearHolidays);

		const allDNs = getAllDailyNotes(); // Get all daily notes once for efficiency

		const allFiles = this.app.vault.getMarkdownFiles();
		let pagesData: any[] = [];
		let birthdayData: any[] = [];

		const birthdayFolder = this.plugin.settings.birthdayFolder.toLowerCase() + '/';
		const hasBirthdayFolderSetting = this.plugin.settings.birthdayFolder.trim() !== '';

		for (const file of allFiles) {
			const cache = this.app.metadataCache.getFileCache(file);
			const fm = cache?.frontmatter;
			if (!fm) continue;

			let hasDate = false;
			let validDate: string | null = null;
			let validDateStart: string | null = null;
			let validDateEnd: string | null = null;
			let validBirthday: string | null = null;
			let explicitColor: string | undefined = undefined; // 
            let defaultColorFromTag: string | undefined = undefined;
            let defaultSymbolFromTag: string | undefined = undefined;
            let noteTags: string[] = [];
			//
			// --- Get Explicit Color ---
			if (fm.color) {
				explicitColor = fm.color.toString();
			}
			if (fm.date) {
				const mDate = moment(fm.date.toString(), "YYYY-MM-DD", true);
				if (mDate.isValid()) {
					validDate = mDate.format("YYYY-MM-DD");
					hasDate = true;
				}
			}
			if (fm.dateStart && fm.dateEnd) {
				const mStart = moment(fm.dateStart.toString(), "YYYY-MM-DD", true);
				const mEnd = moment(fm.dateEnd.toString(), "YYYY-MM-DD", true);
				if (mStart.isValid() && mEnd.isValid()) {
					validDateStart = mStart.format("YYYY-MM-DD");
					validDateEnd = mEnd.format("YYYY-MM-DD");
					hasDate = true;
				}
			}
			if (fm.birthday && (!hasBirthdayFolderSetting || file.path.toLowerCase().startsWith(birthdayFolder))) {
				const mBday = moment(fm.birthday.toString(), "YYYY-MM-DD", true);
				if (mBday.isValid()) {
					validBirthday = mBday.format("YYYY-MM-DD");
					birthdayData.push({
						file: file,
						birthday: validBirthday,
						name: file.basename,
						path: file.path,
                        color: explicitColor,
                        tags: fm.tags // Pass tags for potential birthday color logic later
					});
				}
			}

			// --- Determine Default Color from Tags (if no explicit color) ---
            if (!explicitColor && fm.tags) {
                let rawTags: any[] = [];
                if (typeof fm.tags === 'string') {
                    rawTags = fm.tags.split(',').map(t => t.trim()).filter(t => t);
                } else if (Array.isArray(fm.tags)) {
                    rawTags = fm.tags.map(t => String(t).trim()).filter(t => t);
                }

                noteTags = rawTags.map(tag => (tag.startsWith('#') ? tag : `#${tag}`));

                // Find the first matching tag in the settings
                for (const tag of noteTags) {
                    const appearance = tagAppearanceSettings[tag]; // <-- Check tagAppearance
                    if (appearance) {
                        defaultColorFromTag = appearance.color;     // <-- Get color
                        if (appearance.symbol) {                    // <-- Check for symbol
                            defaultSymbolFromTag = appearance.symbol; // <-- Get symbol
                        }
                        break; // Use the first match
                    }
                }
            }

            if (hasDate) {
                pagesData.push({
                    file: file,
                    date: validDate,
                    dateStart: validDateStart,
                    dateEnd: validDateEnd,
                    color: explicitColor,
                    defaultColorFromTag: defaultColorFromTag,   // Store derived color
                    defaultSymbolFromTag: defaultSymbolFromTag, // Store derived symbol
                    name: file.basename,
                    path: file.path,
                    tags: noteTags // Store normalized tags
                });
            }
		}

		const table = scrollContainer.createEl('table', { cls: 'my-calendar-table' });
		const thead = table.createEl('thead');
		const headerRow = thead.createEl('tr');
		headerRow.createEl('th', { text: 'W' });
		const dayHeaders = "Mon Tue Wed Thu Fri Sat Sun".split(" ");
		dayHeaders.forEach(day => headerRow.createEl('th', { text: day }));
		headerRow.createEl('th', { text: 'M' });

		const tbody = table.createEl('tbody');
		const startDate = moment(`${year}-01-01`, "YYYY-MM-DD").startOf('isoWeek');
		const endDate = moment(`${year + 1}-01-31`, "YYYY-MM-DD").endOf('isoWeek');
		let currentWeek = startDate.clone();
		const now = moment();
		let lastDisplayedMonth = -1;
		const currentRealMonthIndex = now.month();

		while (currentWeek.isBefore(endDate) || currentWeek.isSame(endDate, 'day')) {
			const weekRow = tbody.createEl('tr', { cls: 'week-row' });
			const weekNumber = currentWeek.isoWeek();
			const isCurrentWeek = currentWeek.isSame(now, 'isoWeek');

			const weekNumCell = weekRow.createEl('td', {
				cls: `week-number ${isCurrentWeek ? 'current-week' : ''}`,
				attr: { 'data-isoweek': weekNumber.toString() }
			});
			weekNumCell.createSpan({ cls: 'week-number-text', text: weekNumber.toString() });

			let weekDays: moment.Moment[] = [];
			for (let i = 0; i < 7; i++) {
				weekDays.push(currentWeek.clone().add(i, 'days'));
			}
			const firstMonth = weekDays[0].month();
			const boundaryIndex = weekDays.findIndex(day => day.month() !== firstMonth);
			const hasBoundary = (boundaryIndex !== -1);

			const weeklyRanges = new Map<string, any>();
			const weeklySlotAssignments = new Map<string, number>();

			for (let d = 0; d < 7; d++) {
				const dayMoment = currentWeek.clone().add(d, 'days');
				const dayStr = dayMoment.format("YYYY-MM-DD");

				pagesData.forEach(p => {
					if (p.dateStart && p.dateEnd && !weeklyRanges.has(p.path)) {
						const mStart = moment(p.dateStart);
						const mEnd = moment(p.dateEnd);
						if (mStart.isSameOrBefore(dayMoment) && mEnd.isSameOrAfter(dayMoment)) {
							weeklyRanges.set(p.path, p);
						}
					}
				});

			}
				/***********************************************************************
				 *  BUILD DAILY SLOT ASSIGNMENTS
				 ***********************************************************************/
				interface RangeInfo {
				path:  string;
				start: moment.Moment;
				end:   moment.Moment;
				}

				const allRanges: RangeInfo[] = pagesData
				.filter(p => p.dateStart && p.dateEnd)
				.map(p => ({
					path:  p.path,
					start: moment(p.dateStart, "YYYY-MM-DD"),
					end:   moment(p.dateEnd,   "YYYY-MM-DD")
				}));

				// quick index: which ranges *start* on a given date?
				const rangesStartingByDate = new Map<string, RangeInfo[]>();
				for (const r of allRanges) {
				const key = r.start.format("YYYY-MM-DD");
				(rangesStartingByDate.get(key) ?? rangesStartingByDate.set(key, []).get(key)!)
					.push(r);
				}

				/**
				 * rangeSlotsByDate[dateStr]  →  Map<path, slotNumber>
				 * (Only dates inside the displayed year are stored.)
				 */
				const rangeSlotsByDate: Record<string, Map<string, number>> = {};

				// state that moves forward day‑by‑day
				const activeByPath = new Map<string, number>();   // path → slot
				const occupied      = new Set<number>();          // which slots 0–3 are in use?

				function nextFreeSlot(): number | undefined {
				for (let i = 0; i < MAX_VISIBLE_RANGE_SLOTS; i++) {
					if (!occupied.has(i)) return i;
				}
				}

				let cursor = moment(`${year}-01-01`);
				const last   = moment(`${year}-12-31`);

				while (cursor.isSameOrBefore(last, 'day')) {
				const todayStr = cursor.format("YYYY-MM-DD");

				/* 1 Drop ranges that ended *yesterday* */
				for (const [path, slot] of [...activeByPath.entries()]) {
					const r = allRanges.find(x => x.path === path)!;
					if (r.end.isBefore(cursor, 'day')) {          // ended before today
					activeByPath.delete(path);
					occupied.delete(slot);
					}
				}

				/* 2 Add ranges that start today */
				const starting = rangesStartingByDate.get(todayStr) ?? [];
				for (const r of starting) {
					const slot = nextFreeSlot();
					if (slot === undefined) continue;             // more than 4 overlaps → hide
					activeByPath.set(r.path, slot);
					occupied.add(slot);
				}

				/* 3 Record the snapshot for this date */
				rangeSlotsByDate[todayStr] = new Map(activeByPath);

				cursor.add(1, 'day');
				}

			let slotIndex = 0;
			for (const [path, range] of weeklyRanges.entries()) {
				if (slotIndex < MAX_VISIBLE_RANGE_SLOTS) {
					weeklySlotAssignments.set(path, slotIndex++);
				}
			}

			for (let i = 0; i < 7; i++) {
				const day = weekDays[i];
				const dateStr = day.format("YYYY-MM-DD");
				const dayNum = day.date();
				const inYear = (day.year() === year);
				const monthIndex = day.month();

				const holidaysInfo = this.currentYearHolidays.get(dateStr) || [];
				const isHoliday = holidaysInfo.length > 0;
				let holidayColorVar = DEFAULT_HOLIDAY_COLOR_VAR;

				if (isHoliday) {
					if (holidaysInfo.length === 1 && holidaysInfo[0].color) {
						holidayColorVar = holidaysInfo[0].color;
					}
				}

				const isBoundaryDay = hasBoundary && i === boundaryIndex;
				const isFirstDayOfMonth = day.date() === 1;
				const isLastDayOfMonth = day.isSame(day.clone().endOf('month'), 'day');
				const isFirstWeekOfMonth = day.isSame(day.clone().startOf('month').startOf('isoWeek'), 'isoWeek');
				const isLastWeekOfMonth = day.isSame(day.clone().endOf('month').startOf('isoWeek'), 'isoWeek');
				const isCurrentMonth = day.isSame(now, 'month') && day.isSame(now, 'year');
				const isTodayDate = dateStr === today;

				const dailyNoteFileForThisDay = getDailyNote(day, allDNs);
				const hasDailyNote = !!dailyNoteFileForThisDay;
				
				const isForcedOpaque = this.forceOpaqueMonths.has(monthIndex);
				const isForcedFocus = this.forceFocusMonths.has(monthIndex);

				const matchingNotes = pagesData.filter(p => p.date === dateStr);
				const matchingBirthdays = birthdayData.filter(b => {
					const bdayMoment = moment(b.birthday, "YYYY-MM-DD");
					return bdayMoment.month() === day.month() && bdayMoment.date() === day.date();
				});
				const matchingRanges = pagesData.filter(p =>
					p.dateStart && p.dateEnd &&
					moment(p.dateStart).isSameOrBefore(day, 'day') &&
					moment(p.dateEnd).isSameOrAfter(day, 'day')
				);

				const cell = weekRow.createEl('td');
				cell.dataset.date = dateStr;
				cell.dataset.monthIndex = monthIndex.toString();
				//
				const cellClasses = ['calendar-cell'];
				const isOddMonth = monthIndex % 2 === 1;        // Feb, Apr, …
				cellClasses.push(isOddMonth ? 'odd-month' : 'even-month');
				
				if (isHoliday) {
					cellClasses.push('holiday-colored');
					cell.style.setProperty('--holiday-background-color', holidayColorVar);
				}
				if (!inYear) cellClasses.push('other-year');
				if (hasBoundary && i >= boundaryIndex) cellClasses.push('new-month');
				if (isCurrentMonth) cellClasses.push('current-month');
				if (isBoundaryDay) cellClasses.push('month-boundary');
				if (isFirstWeekOfMonth) cellClasses.push('month-top');
				if (isLastWeekOfMonth) cellClasses.push('month-bottom');
				if (isFirstDayOfMonth) cellClasses.push('month-start');
				if (isLastDayOfMonth) cellClasses.push('month-end');

				if (isForcedFocus) {
					cellClasses.push('force-focused-month');
				}
				if (inYear && !isCurrentMonth && !isForcedFocus && !isForcedOpaque) {
					cellClasses.push('is-faded');
				}

				cell.addClass(...cellClasses);

				if (isHoliday) {
					cell.title = holidaysInfo.map(h => h.name).join('\n');
				}

				const cellContentWrapper = cell.createDiv({ cls: 'cell-content' });

				const topContentDiv = cellContentWrapper.createDiv({ cls: 'top-content' });
				const dotAreaDiv = cellContentWrapper.createDiv({ cls: 'dot-area' });
				const rangeBarAreaDiv = cellContentWrapper.createDiv({ cls: 'range-bar-area' });

				const dayNumContainerSpan = topContentDiv.createSpan({
					cls: `day-number ${isTodayDate ? 'today' : ''}`
				});

				const dayNumTextSpan = dayNumContainerSpan.createSpan({
					cls: 'day-number-text',
					text: dayNum.toString()
				});

				if (hasDailyNote && dailyNoteFileForThisDay) {
					dayNumContainerSpan.dataset.dailyNotePath = dailyNoteFileForThisDay.path;
					dayNumTextSpan.addClass('has-daily-note-linkable');
				}
	
				// Add the pencil indicator AFTER the day number/link
				const pencilIndicatorSpan = dayNumContainerSpan.createSpan({ text: '✎' });
				pencilIndicatorSpan.addClass('pencil-indicator');
				// if (hasDailyNote) {
				// 	pencilIndicatorSpan.addClass('always-visible');
				// }
				const dailyNoteRegex = /^\d{4}-\d{2}-\d{2}$/;

				const dailyNoteDots: HTMLElement[] = [];
				const birthdayDots: HTMLElement[] = [];
				const otherNoteDots: HTMLElement[] = [];

				const doc = this.containerEl.doc;

				const emittedSymbols = new Set<string>();       

				matchingNotes.forEach(p => {
					const isDailyNote = dailyNoteRegex.test(p.name);

					const dot = doc.createElement('span');
					dot.addClass('dot', 'note-dot');
					if (isDailyNote) dot.addClass('daily-note-indicator');

					// decide which glyph this note gets
					let dotSymbol = isDailyNote
						? DEFAULT_DAILY_NOTE_SYMBOL
						: (p.defaultSymbolFromTag ?? '●');

						const cameFromTag = !!p.defaultSymbolFromTag;   // ← true only when
																		//    the symbol was
																		//    assigned by a tag

						if (
							this.plugin.settings.collapseDuplicateTagSymbols &&
							!isDailyNote &&
							cameFromTag &&                              // ← added line
							emittedSymbols.has(dotSymbol)
						) return;                                       // skip duplicate
						emittedSymbols.add(dotSymbol);


					dot.textContent = dotSymbol;
					dot.title       = p.name;
					dot.style.color = p.color || p.defaultColorFromTag || DEFAULT_DOT_COLOR;

					/* bucket it */
					(isDailyNote ? dailyNoteDots : otherNoteDots).push(dot);
				});

				if (matchingBirthdays.length > 0) {
					const dot = doc.createElement('span');
					dot.addClass('dot', 'birthday-dot');
					const birthdaySymbol = this.plugin.settings.defaultBirthdaySymbol || '🎂';
					dot.textContent = birthdaySymbol;
					dot.title = `${matchingBirthdays.length} birthday${matchingBirthdays.length > 1 ? 's' : ''}`;
					dot.style.color = matchingBirthdays[0].color || matchingBirthdays[0].defaultColorFromTag || DEFAULT_BIRTHDAY_COLOR; // Priority: Explicit > Tag > Global
					birthdayDots.push(dot);
				}

				// dailyNoteDots.forEach(dot => dotAreaDiv.appendChild(dot));
				birthdayDots.forEach(dot => dotAreaDiv.appendChild(dot)); 
				otherNoteDots.forEach(dot => dotAreaDiv.appendChild(dot));

				if (matchingRanges.length > 0) {
					const rangeBarArea = cellContentWrapper.createDiv({ cls: 'range-bar-area' });

					for (let slot = 0; slot < MAX_VISIBLE_RANGE_SLOTS; slot++) {
						rangeBarArea.createDiv({ cls: `range-slot slot-${slot}` });
					}

					matchingRanges.forEach(p => {
					const dateSlots = rangeSlotsByDate[dateStr];
					const slotIndex = dateSlots?.get(p.path);
					if (slotIndex === undefined) return;

					const slot = rangeBarArea.querySelector(`.slot-${slotIndex}`);
					if (!slot) return;

					// ----‑ create the bar
					const bar = slot.createDiv({ cls: 'range-bar', title: p.name });

					// background colour
					const bgVar = p.color || p.defaultColorFromTag || DEFAULT_BAR_COLOR;
					bar.style.backgroundColor = bgVar;

					// text‑variant for borders
					const borderVar = BORDER_COLOR_MAP[bgVar] || DEFAULT_BORDER_COLOR;

					const isStart = moment(p.dateStart).isSame(day, 'day');
					const isEnd   = moment(p.dateEnd)  .isSame(day, 'day');

					// Tag & style per‑bar, not per‑cell
					if (isStart) {
						bar.addClass('range-start');
						bar.style.borderLeft = `2px solid ${borderVar}`;
					}
					if (isEnd) {
						bar.addClass('range-end');
						bar.style.borderRight = `2px solid ${borderVar}`;
					}
					});
				}

				let expandedHTML = `<div class="expanded-content">`;
				expandedHTML += `<button class="close-button" aria-label="Close">×</button>`;

				const normalizedNow = now.startOf('day');
				const normalizedDay = day.startOf('day');

				const daysFromToday = normalizedDay.diff(normalizedNow, 'days');

				let dayFromTodayText = `${daysFromToday} days from today`;
				if (daysFromToday === 0) {
					dayFromTodayText = 'Today';
				} else if (daysFromToday === 1) {
					dayFromTodayText = 'Tomorrow';
				} else if (daysFromToday === -1) {
					dayFromTodayText = 'Yesterday';
				}

				const dayLabel = day.format("dddd, MMMM DD, YYYY");

				expandedHTML += `<strong>${dayLabel}</strong><br>`;
				expandedHTML += `<em>${dayFromTodayText}</em>`;
				expandedHTML += `<br>`;
				expandedHTML += `<br>`;

				if (isHoliday) {
					expandedHTML += `<strong>Holidays:</strong><ul class="expanded-holidays">`;
					expandedHTML += holidaysInfo
						.map(h => `<li>${h.name}</li>`)
						.join("");
					expandedHTML += `</ul>`;
				}

				if (matchingBirthdays.length > 0) {
					expandedHTML += `<strong>Birthdays:</strong><ul class="expanded-birthdays">`;
					expandedHTML += matchingBirthdays
						.map(b => {
							// --- APPLY COLOR LOGIC ---
							const birthdayColor = b.color || b.defaultColorFromTag || DEFAULT_BIRTHDAY_COLOR;
							const linkStyleColor = (birthdayColor === 'currentColor') ? 'inherit' : birthdayColor; // Handle currentColor case if needed
							return `<li><a class="internal-link birthday-link" data-href="${b.path}" href="${b.path}" style="color: ${linkStyleColor};">${b.name}</a></li>`;
						})
						.join("");
					expandedHTML += `</ul>`;
				}
                // Events/Notes List
                if (matchingNotes.length > 0) {
                    expandedHTML += `<strong>Events/Notes:</strong><ul class="expanded-notes">`;
                    expandedHTML += matchingNotes.map(p => {
                        // --- Determine Link Color (Priority: Explicit > Tag > Global Default) ---
                        const noteColor = p.color || p.defaultColorFromTag || DEFAULT_DOT_COLOR; // Use derived tag color
                        const linkStyleColor = (noteColor === 'currentColor') ? 'inherit' : noteColor;
                        return `<li><a class="internal-link" data-href="${p.path}" href="${p.path}" style="color: ${linkStyleColor};">${p.name}</a></li>`;
                    }).join("");
                    expandedHTML += `</ul>`;
                }
				if (matchingRanges.length > 0) {
					expandedHTML += `<strong>Ongoing Events:</strong><ul class="expanded-events">`;
					expandedHTML += matchingRanges
						.map(p => {
							// --- APPLY COLOR LOGIC ---
							const barColor = p.color || p.defaultColorFromTag || DEFAULT_BAR_COLOR;
							const linkStyleColor = (barColor === 'currentColor') ? 'inherit' : barColor; // Handle currentColor case if needed
							return `<li><a class="internal-link" data-href="${p.path}" href="${p.path}" style="color: ${linkStyleColor};">${p.name}</a></li>`;
						})
						.join("");
					expandedHTML += `</ul>`;
				}
				if (!isHoliday && matchingBirthdays.length === 0 && matchingNotes.length === 0 && matchingRanges.length === 0) {
					expandedHTML += `<p>No events or holidays for this day.</p>`;
				}
				expandedHTML += `</div>`;
				cell.dataset.cellContent = expandedHTML;
			}

			const monthCell = weekRow.createEl('td', { cls: 'month-column' });
			const earliestMonthIndex = weekDays[0].month();
			const boundaryMonthIndex = hasBoundary ? weekDays[boundaryIndex].month() : earliestMonthIndex;
			const thisRowMonth = boundaryMonthIndex;

			if (thisRowMonth !== lastDisplayedMonth && weekDays[0].year() === year) {
				const monthMoment = hasBoundary ? weekDays[boundaryIndex] : weekDays[0];
				const monthName = monthMoment.format("MMM");
				const monthIndex = monthMoment.month();
				lastDisplayedMonth = thisRowMonth;
				const isCurrentDisplayMonth = monthMoment.isSame(now, "month") && monthMoment.isSame(now, "year");

				const wrapper = monthCell.createDiv({ cls: 'month-cell-wrapper' });

				const labelSpan = wrapper.createSpan({
					cls: `month-label-text ${isCurrentDisplayMonth ? 'current-month-label' : 'other-month-label'}`,
					text: monthName
				});
				labelSpan.addClass('clickable-month-label');

				if (monthIndex !== currentRealMonthIndex) {
					const opacityCell = wrapper.createDiv({ cls: 'month-action-cell' });
					const opacityIcon = opacityCell.createSpan({
						cls: 'month-action-icon month-toggle-opacity',
						attr: { 'aria-label': this.forceOpaqueMonths.has(monthIndex) ? 'Make month visible' : 'Make month faded' }
					});
					opacityIcon.dataset.monthIndex = monthIndex.toString();
					setIcon(opacityIcon, (this.forceOpaqueMonths.has(monthIndex) || this.forceFocusMonths.has(monthIndex)) ? 'eye' : 'eye-off');

					const focusCell = wrapper.createDiv({ cls: 'month-action-cell' });
					const focusIcon = focusCell.createSpan({
						cls: 'month-action-icon month-toggle-focus',
						attr: { 'aria-label': this.forceFocusMonths.has(monthIndex) ? 'Remove focus' : 'Focus month' }
					});
					focusIcon.dataset.monthIndex = monthIndex.toString();
					setIcon(focusIcon, this.forceFocusMonths.has(monthIndex) ? 'minus-circle' : 'plus-circle');
				}

				monthCell.dataset.monthYear = monthMoment.year().toString();
				monthCell.dataset.monthIndex = monthIndex.toString();
				if (!isCurrentDisplayMonth) {
					monthCell.addClass('other-month');
				}
			}

			currentWeek.add(7, 'days');
		}

		const controlsBottomContainer = this.calendarContentEl.createDiv({ cls: 'calendar-controls-bottom' });

		const focusControlsGroup = controlsBottomContainer.createDiv({ cls: 'focus-controls' });

		const resetButton = focusControlsGroup.createEl('button', {
			text: 'Reset Focus',
			cls: 'reset-focus-button'
		});
		resetButton.addEventListener('click', () => {
			this.forceFocusMonths.clear();
			this.forceOpaqueMonths.clear();
			this.saveFocusStates();
			this.redrawClassesAndOutlines();
			this.updateAllMonthIcons();
			new Notice("Focus states reset");
		});

		const relocateButton = focusControlsGroup.createEl('button', {
			cls: 'relocate-button',
			attr: {
				'aria-label': 'Relocate to current week'
			}
		});
		setIcon(relocateButton, 'compass');
		relocateButton.addEventListener('click', () => {
			const now = moment();
			const currentTbody = scrollContainer.querySelector('tbody');
			if (currentTbody) {
				this.scrollToCurrent(currentTbody, now, this.plugin.settings.year);
				new Notice("Relocated to current week.");
			} else {
				console.error("Could not find tbody to relocate.");
			}
		});


		this.addYearSelectorControls(controlsBottomContainer, year);

		const currentMonthIndex = now.month();
		this.applyOutlineStyles(tbody, year, currentMonthIndex);
		this.scrollToCurrent(tbody, now, year);

	}

	private saveFocusStates() {
		this.plugin.settings.focusedMonths = Array.from(this.forceFocusMonths);
		this.plugin.settings.opaqueMonths = Array.from(this.forceOpaqueMonths);
		this.plugin.saveSettings();
	}

	private addYearSelectorControls(controlsContainer: HTMLElement, currentYear: number): void {
		const yearControlsContainer = controlsContainer.createDiv({ cls: 'year-update-controls' });

		const yearInput = yearControlsContainer.createEl('input', {
			type: 'text',
			cls: 'year-input'
		});
		yearInput.maxLength = 4;
		yearInput.placeholder = "YYYY";
		yearInput.value = currentYear.toString();

		const updateButton = yearControlsContainer.createEl('button', {
			text: 'Load',
			cls: 'year-update-button'
		});

		// Add refresh button before the year input controls
		const refreshButton = controlsContainer.createEl('button', {
			cls: 'calendar-refresh-button',
			attr: {
				'aria-label': 'Refresh calendar data'
			}
		});
		setIcon(refreshButton, 'refresh-cw');
		refreshButton.addEventListener('click', async () => {
			new Notice('Refreshing calendar data...');
			await this.refresh();
			new Notice('Calendar refreshed!');
		});

		updateButton.addEventListener('click', async () => {
			const newYearStr = yearInput.value.trim();
			const newYear = parseInt(newYearStr);

			if (!isNaN(newYear) && newYear > 1000 && newYear < 3000) {
				if (newYear !== this.plugin.settings.year) {
					this.plugin.settings.year = newYear;
					await this.plugin.saveSettings();
					new Notice(`Loading calendar for ${newYear}...`);
					this.refresh();
				}
			} else {
				new Notice("Please enter a valid year (e.g., 2024).");
				yearInput.value = this.plugin.settings.year.toString();
			}
		});

		yearInput.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				updateButton.click();
			}
		});
	}

	scrollToCurrent(tbody: HTMLTableSectionElement, now: moment.Moment, displayYear: number) {
		if (now.year() !== displayYear) return;
		const currentWeekStartStr = now.clone().startOf('isoWeek').format('YYYY-MM-DD');
		const targetCell = tbody.querySelector(`td.calendar-cell[data-date="${currentWeekStartStr}"]`);
		if (targetCell) {
			const scrollContainer = this.calendarContentEl.querySelector('.calendar-scroll-container');
			if (scrollContainer) {
				targetCell.scrollIntoView({ behavior: 'auto', block: 'center' });
			}
		}
	}

	private clearAllOutlines(tbody: HTMLTableSectionElement): void {
		tbody.querySelectorAll('.border-outline-top, .border-outline-bottom, .border-outline-left, .border-outline-right, .corner-top-left, .corner-top-right, .corner-bottom-left, .corner-bottom-right')
			.forEach(cell => cell.classList.remove(
				'border-outline-top', 'border-outline-bottom', 'border-outline-left', 'border-outline-right',
				'corner-top-left', 'corner-top-right', 'corner-bottom-left', 'corner-bottom-right'
			));
	}

	private redrawClassesAndOutlines(): void {
		const year = this.plugin.settings.year;
		const now = moment();
		const currentActualMonthIndex = now.month();
		const tbody = this.calendarContentEl.querySelector('tbody');
		if (!tbody) return;

		tbody.querySelectorAll('td.calendar-cell[data-month-index]').forEach(cellNode => {
			if (!(cellNode instanceof HTMLElement)) return;
			const cell = cellNode;
			const monthIndexStr = cell.dataset.monthIndex;
			if (!monthIndexStr) return;
			const monthIndex = parseInt(monthIndexStr, 10);

			const isCurrentMonth = monthIndex === currentActualMonthIndex && year === now.year();
			const isForcedOpaque = this.forceOpaqueMonths.has(monthIndex);
			const isForcedFocus = this.forceFocusMonths.has(monthIndex);

			cell.classList.remove('is-faded', 'force-focused-month');

			if (isForcedFocus) {
				cell.classList.add('force-focused-month');
			} else if (isCurrentMonth) {
			} else if (!isForcedOpaque) {
				cell.classList.add('is-faded');
			}
		});

		this.clearAllOutlines(tbody);
		this.applyOutlineStyles(tbody, year, currentActualMonthIndex);
	}

	private updateAllMonthIcons(): void {
		const monthCells = this.calendarContentEl.querySelectorAll('td.month-column[data-month-index]');
		monthCells.forEach(cellNode => {
			if (!(cellNode instanceof HTMLElement)) return;
			const monthIndexStr = cellNode.dataset.monthIndex;
			if (!monthIndexStr) return;
			const monthIndex = parseInt(monthIndexStr, 10);

			const eyeIcon = cellNode.querySelector<HTMLElement>('.month-toggle-opacity');
			const focusIcon = cellNode.querySelector<HTMLElement>('.month-toggle-focus');

			if (eyeIcon) {
				const isEffectivelyOpaque = this.forceOpaqueMonths.has(monthIndex) || this.forceFocusMonths.has(monthIndex);
				setIcon(eyeIcon, isEffectivelyOpaque ? 'eye' : 'eye-off');
				eyeIcon.setAttribute('aria-label', isEffectivelyOpaque ? 'Make month faded' : 'Make month visible');
			}
			if (focusIcon) {
				const isFocused = this.forceFocusMonths.has(monthIndex);
				setIcon(focusIcon, isFocused ? 'minus-circle' : 'plus-circle');
				focusIcon.setAttribute('aria-label', isFocused ? 'Remove month focus' : 'Focus this month');
			}
		});
	}

	private toggleMonthOpacity(monthIndex: number): void {
		const dayCells = this.calendarContentEl.querySelectorAll(`.calendar-cell[data-month-index="${monthIndex}"]`);
		const isCurrentlyForcedOpaque = this.forceOpaqueMonths.has(monthIndex);
		const isCurrentlyForcedFocused = this.forceFocusMonths.has(monthIndex);
		const now = moment();
		const currentActualMonthIndex = now.month();
		const isTheCurrentMonth = monthIndex === currentActualMonthIndex && this.plugin.settings.year === now.year();

		if (isCurrentlyForcedOpaque) {
			this.forceOpaqueMonths.delete(monthIndex);
			if (!isTheCurrentMonth && !isCurrentlyForcedFocused) {
				dayCells.forEach(cell => cell.classList.add('is-faded'));
			}
		} else {
			this.forceOpaqueMonths.add(monthIndex);
			dayCells.forEach(cell => cell.classList.remove('is-faded'));
		}
		this.saveFocusStates();
	}

	private toggleMonthFocus(monthIndex: number): void {
		const dayCells = this.calendarContentEl.querySelectorAll(`.calendar-cell[data-month-index="${monthIndex}"]`);
		const tbody = this.calendarContentEl.querySelector('tbody');
		if (!tbody) return;

		const now = moment();
		const currentActualMonthIndex = now.month();
		const isTheCurrentMonth = monthIndex === currentActualMonthIndex && this.plugin.settings.year === now.year();
		const isCurrentlyForcedFocused = this.forceFocusMonths.has(monthIndex);

		if (isCurrentlyForcedFocused) {
			this.forceFocusMonths.delete(monthIndex);
			this.forceOpaqueMonths.delete(monthIndex);
			dayCells.forEach(cell => cell.classList.remove('force-focused-month'));
			if (!isTheCurrentMonth && !this.forceOpaqueMonths.has(monthIndex)) {
				dayCells.forEach(cell => cell.classList.add('is-faded'));
			}
		} else {
			this.forceFocusMonths.add(monthIndex);
			if (!this.forceOpaqueMonths.has(monthIndex)) {
				this.forceOpaqueMonths.add(monthIndex);
			}
			dayCells.forEach(cell => cell.classList.remove('is-faded'));
			dayCells.forEach(cell => cell.classList.add('force-focused-month'));
		}

		this.clearAllOutlines(tbody);
		this.applyOutlineStyles(tbody, this.plugin.settings.year, currentActualMonthIndex);
		this.saveFocusStates();
		this.updateAllMonthIcons();
	}

	handleClick(event: MouseEvent) {
		const target = event.target as HTMLElement;
		const isCmdClick = event.metaKey || event.ctrlKey; // Check for Cmd (Mac) or Ctrl (Win/Linux)

		const clickedCloseButton = target.closest('button.close-button');
		const clickedInternalLink = target.closest('a.internal-link');
		const clickedMonthLabelText = target.closest('.month-label-text.clickable-month-label');
		const clickedWeekNumber = target.closest('td.week-number');
		const clickedDayCell = target.closest('td.calendar-cell:not(.month-column)');
		const clickedOpacityToggle = target.closest('.month-toggle-opacity');
		const clickedFocusToggle = target.closest('.month-toggle-focus');
		const clickedDayNumber = target.closest('.day-number');

		if (clickedCloseButton || clickedInternalLink || clickedMonthLabelText || clickedWeekNumber || clickedOpacityToggle || clickedFocusToggle || (clickedDayCell && !clickedDayNumber && !target.closest('.expanded-row'))) {
			this.clearDayNumberEngagement();
			if (clickedCloseButton) {
				const expandedRow = clickedCloseButton.closest('tr.expanded-row');
				if (expandedRow) {
					const tbody = expandedRow.parentElement;
					expandedRow.removeClass('show');
					setTimeout(() => {
						expandedRow.remove();
						tbody?.querySelectorAll('td.calendar-cell.expanded').forEach(cell => {
							cell.classList.remove('expanded');
						});
					}, 300);
				}
			} else if (clickedInternalLink) {
				event.preventDefault();
				const path = clickedInternalLink.dataset.href || clickedInternalLink.getAttribute('href');
				if (path) {
					const openInNewPane = event.ctrlKey || event.metaKey;
					this.app.workspace.openLinkText(path, '', openInNewPane);
				} else {
					console.warn("Continuous Calendar: Clicked internal link missing path", clickedInternalLink);
				}
			} else if (clickedMonthLabelText) {
				const parentCell = clickedMonthLabelText.closest('td.month-column');
				if (parentCell && parentCell.dataset.monthYear && parentCell.dataset.monthIndex) {
					event.preventDefault();
					const year = parseInt(parentCell.dataset.monthYear, 10);
					const monthIndex = parseInt(parentCell.dataset.monthIndex, 10);
					if (!isNaN(year) && !isNaN(monthIndex)) {
						const monthMoment = moment({ year: year, month: monthIndex, day: 1 });
						this.openOrCreateMonthlyNote(monthMoment, event);
					} else {
						console.error("Could not parse year/month data from month label parent:", parentCell.dataset);
					}
				}
			} else if (clickedWeekNumber) {
				if (this.activeWeekCell === clickedWeekNumber) {
					this.revertWeekNumbers(this.calendarContentEl);
					this.activeWeekCell = null;
				} else {
					if (this.activeWeekCell) {
						this.revertWeekNumbers(this.calendarContentEl);
					}
					this.activeWeekCell = clickedWeekNumber as HTMLElement;
					const isoWeekAttr = clickedWeekNumber.getAttribute('data-isoweek');
					const clickedWeekIso = isoWeekAttr ? parseInt(isoWeekAttr, 10) : NaN;
					if (!isNaN(clickedWeekIso)) {
						this.renumberWeeks(this.calendarContentEl, clickedWeekIso);
					} else {
						console.error("Could not parse data-isoweek from clicked cell:", clickedWeekNumber);
						this.revertWeekNumbers(this.calendarContentEl);
						this.activeWeekCell = null;
					}
				}
			} else if (clickedOpacityToggle) {
				event.stopPropagation();
				const monthIndexStr = clickedOpacityToggle.dataset.monthIndex;
				if (monthIndexStr) {
					const monthIndex = parseInt(monthIndexStr, 10);
					if (!isNaN(monthIndex)) {
						this.toggleMonthOpacity(monthIndex);
						const isEffectivelyOpaque = this.forceOpaqueMonths.has(monthIndex) || this.forceFocusMonths.has(monthIndex);
						setIcon(clickedOpacityToggle, isEffectivelyOpaque ? 'eye' : 'eye-off');
						clickedOpacityToggle.setAttribute('aria-label', isEffectivelyOpaque ? 'Make month faded' : 'Make month visible');
					}
				}
			} else if (clickedFocusToggle) {
				event.stopPropagation();
				const monthIndexStr = clickedFocusToggle.dataset.monthIndex;
				if (monthIndexStr) {
					const monthIndex = parseInt(monthIndexStr, 10);
					if (!isNaN(monthIndex)) {
						this.toggleMonthFocus(monthIndex);
						const isFocused = this.forceFocusMonths.has(monthIndex);
						const isEffectivelyOpaque = this.forceOpaqueMonths.has(monthIndex) || isFocused;
						setIcon(clickedFocusToggle, isFocused ? 'minus-circle' : 'plus-circle');
						clickedFocusToggle.setAttribute('aria-label', isFocused ? 'Remove month focus' : 'Focus this month');
						const parentWrapper = clickedFocusToggle.closest('.month-cell-wrapper');
						const eyeIcon = parentWrapper?.querySelector<HTMLElement>('.month-toggle-opacity');
						if (eyeIcon) {
							setIcon(eyeIcon, isEffectivelyOpaque ? 'eye' : 'eye-off');
							eyeIcon.setAttribute('aria-label', isEffectivelyOpaque ? 'Make month faded' : 'Make month visible');
						}
					}
				}
			} else if (clickedDayCell && !target.closest('.expanded-row')) {
				const currentRow = clickedDayCell.parentElement as HTMLTableRowElement;
				if (!currentRow) return;
				const tbody = currentRow.parentElement as HTMLTableSectionElement;
				if (!tbody) return;
				const existingExpanded = tbody.querySelector("tr.expanded-row");
				let clickedCellWasExpanded = clickedDayCell.classList.contains("expanded");
				if (existingExpanded) {
					existingExpanded.remove();
					tbody.querySelectorAll("td.calendar-cell.expanded").forEach(expandedCell => {
						expandedCell.classList.remove("expanded");
					});
				}
				if (!clickedCellWasExpanded) {
					const contentHtml = clickedDayCell.dataset.cellContent;
					if (!contentHtml) return;
					clickedDayCell.classList.add("expanded");
					const expandedRow = document.createElement("tr");
					expandedRow.classList.add("expanded-row");
					const colspan = 9;
					const expandedCell = document.createElement("td");
					expandedCell.setAttribute("colspan", colspan.toString());
					expandedCell.innerHTML = contentHtml;
					expandedRow.appendChild(expandedCell);
					currentRow.after(expandedRow);
					setTimeout(() => expandedRow.classList.add("show"), 10);
				}
			}
			return;
		}

		if (clickedDayNumber && !clickedDayNumber.closest('.expanded-row')) {
			event.preventDefault();
			const cell = clickedDayNumber.closest('td.calendar-cell');
			if (!cell || !cell.dataset.date) {
				console.warn("Could not find parent cell/date for day number click");
				this.clearDayNumberEngagement();
				return;
			}

			const dateStr = cell.dataset.date;
			const dateMoment = moment(dateStr, "YYYY-MM-DD");
			if (!dateMoment.isValid()) {
				console.warn("Invalid date on cell for day number click:", dateStr);
				this.clearDayNumberEngagement();
				return;
			}

			if (isCmdClick) {
				if (this.startRangeDate && this.engagedStartRangeEl) {
					const endRangeDate = dateMoment;

					let finalStartDate = this.startRangeDate;
					let finalEndDate = endRangeDate;
					if (endRangeDate.isBefore(finalStartDate)) {
						console.log("End date is before start date, swapping.");
						finalStartDate = endRangeDate;
						finalEndDate = this.startRangeDate;
					}

					console.log(`Cmd+Click: Range selected from ${finalStartDate.format("YYYY-MM-DD")} to ${finalEndDate.format("YYYY-MM-DD")}`);

					this.createRangeNote(finalStartDate, finalEndDate);

					this.clearDayNumberEngagement();
				} else {
					new Notice("Please click a start date first (without Cmd/Ctrl).");
					this.clearDayNumberEngagement();
				}
			} else {
				if (this.engagedStartRangeEl === clickedDayNumber) {
					console.log("Second normal click on same day number:", dateStr);
					this.openOrCreateDailyNote(dateMoment, event);
					this.clearDayNumberEngagement();
				} else {
					console.log("Normal click, setting as potential range start:", dateStr);
					this.clearDayNumberEngagement();

					this.startRangeDate = dateMoment;
					this.engagedStartRangeEl = clickedDayNumber;
					this.engagedStartRangeEl.classList.add('range-start-engaged');

					this.engagedDayNumberEl = clickedDayNumber;
					this.engagedDayNumberEl.classList.add('engaged');
				}
			}
			return;
		}

		if (target.closest('.continuous-calendar') && !clickedCloseButton && !clickedInternalLink && !clickedDayNumber && !clickedWeekNumber && !clickedDayCell && !clickedMonthLabelText && !clickedOpacityToggle && !clickedFocusToggle) {
			this.clearDayNumberEngagement();
			console.log("Clicked empty space, clearing engagement.");
		}
	}

	revertWeekNumbers(container: HTMLElement) {
		container.querySelectorAll("td.week-number").forEach(cell => {
			const isoWeekVal = cell.getAttribute("data-isoweek");
			const labelSpan = cell.querySelector(".week-number-text");
			if (labelSpan && isoWeekVal) {
				labelSpan.textContent = isoWeekVal;
			}
			cell.classList.remove('relative-week-mode');
		});
	}

	renumberWeeks(container: HTMLElement, clickedWeekIso: number) {
		container.querySelectorAll("td.week-number").forEach(cell => {
			const isoWeekVal = parseInt(cell.getAttribute("data-isoweek") || '0', 10);
			const offset = isoWeekVal - clickedWeekIso;
			const labelSpan = cell.querySelector(".week-number-text");
			if (labelSpan) {
				labelSpan.textContent = isNaN(offset) ? '?' : offset.toString();
			}
			cell.classList.add('relative-week-mode');
		});
	}

	applyOutlineStyles(tbody: HTMLTableSectionElement, targetYear: number, currentActualMonthIndex: number): void {
		this.clearAllOutlines(tbody);

		const cellsMap = new Map<string, HTMLElement>();
		tbody.querySelectorAll('td.calendar-cell[data-date][data-month-index]').forEach(cellNode => {
			if (cellNode instanceof HTMLElement && cellNode.dataset.date) {
				cellsMap.set(cellNode.dataset.date, cellNode);
			}
		});

		const monthsToOutline = new Set<number>([currentActualMonthIndex, ...this.forceFocusMonths]);

		tbody.querySelectorAll('td.calendar-cell[data-month-index]').forEach(cellNode => {
			if (!(cellNode instanceof HTMLElement && cellNode.dataset.date && cellNode.dataset.monthIndex)) return;

			const cellMonthIndex = parseInt(cellNode.dataset.monthIndex, 10);
			if (!monthsToOutline.has(cellMonthIndex)) return;

			const cell = cellNode;
			const cellMoment = moment(cell.dataset.date, "YYYY-MM-DD");

			if (!cellMoment.isValid() || cellMoment.year() !== targetYear) return;

			const isTargetNeighbor = (neighborCell: HTMLElement | undefined): boolean => {
				if (!neighborCell || !neighborCell.dataset.date || !neighborCell.dataset.monthIndex) return false;
				const neighborMoment = moment(neighborCell.dataset.date, "YYYY-MM-DD");
				if (!neighborMoment.isValid() || neighborMoment.year() !== targetYear) return false;
				const neighborMonth = parseInt(neighborCell.dataset.monthIndex, 10);
				return monthsToOutline.has(neighborMonth);
			};

			const dateAbove = cellMoment.clone().subtract(7, 'days').format("YYYY-MM-DD");
			const dateBelow = cellMoment.clone().add(7, 'days').format("YYYY-MM-DD");
			const dateLeft = cellMoment.clone().subtract(1, 'day').format("YYYY-MM-DD");
			const dateRight = cellMoment.clone().add(1, 'day').format("YYYY-MM-DD");

			const cellAbove = cellsMap.get(dateAbove);
			const cellBelow = cellsMap.get(dateBelow);
			const cellLeft = cellsMap.get(dateLeft);
			const cellRight = cellsMap.get(dateRight);

			const needsTopBorder = !isTargetNeighbor(cellAbove);
			const needsBottomBorder = !isTargetNeighbor(cellBelow);
			const isoDayOfWeek = cellMoment.isoWeekday();
			const needsLeftBorder = (isoDayOfWeek === 1 || !isTargetNeighbor(cellLeft));
			const needsRightBorder = (isoDayOfWeek === 7 || !isTargetNeighbor(cellRight));

			if (needsTopBorder) cell.classList.add('border-outline-top');
			if (needsBottomBorder) cell.classList.add('border-outline-bottom');
			if (needsLeftBorder) cell.classList.add('border-outline-left');
			if (needsRightBorder) cell.classList.add('border-outline-right');
			if (needsTopBorder && needsLeftBorder) cell.classList.add('corner-top-left');
			if (needsTopBorder && needsRightBorder) cell.classList.add('corner-top-right');
			if (needsBottomBorder && needsLeftBorder) cell.classList.add('corner-bottom-left');
			if (needsBottomBorder && needsRightBorder) cell.classList.add('corner-bottom-right');
		});
	}

	async openOrCreateDailyNote(date: moment.Moment, event: MouseEvent): Promise<void> {
		const { workspace } = this.app;
		const allDailyNotes = getAllDailyNotes();
		const existingFile = getDailyNote(date, allDailyNotes);
		const openInNewPane = event.ctrlKey || event.metaKey;

		const performCreateAndOpen = async () => {
			try {
				console.log(`Creating daily note for: ${date.format("YYYY-MM-DD")}`);
				const newFile = await createDailyNote(date);
				console.log(`Created daily note: ${newFile.path}`);
				await workspace.openLinkText(newFile.path, '', openInNewPane);
			} catch (err) {
				console.error(`Failed to create daily note for ${date.format("YYYY-MM-DD")}:`, err);
			}
		};

		if (existingFile) {
			console.log(`Opening existing daily note: ${existingFile.path}`);
			await workspace.openLinkText(existingFile.path, '', openInNewPane);
		} else {
			if (this.plugin.settings.shouldConfirmBeforeCreate) {
				createConfirmationDialog(this.app, {
					title: "Create Daily Note?",
					text: `Daily note for ${date.format("YYYY-MM-DD")} does not exist. Create it now?`,
					cta: "Create",
					onAccept: performCreateAndOpen
				});
			} else {
				await performCreateAndOpen();
			}
		}
	}

	clearDayNumberEngagement() {
		if (this.engagedDayNumberEl) {
			this.engagedDayNumberEl.classList.remove('engaged');
			this.engagedDayNumberEl = null;
		}
		if (this.engagedStartRangeEl) {
			this.engagedStartRangeEl.classList.remove('range-start-engaged');
			this.engagedStartRangeEl = null;
		}
		this.startRangeDate = null;
	}


	async openOrCreateMonthlyNote(monthMoment: moment.Moment, event: MouseEvent): Promise<void> {
		console.log("Attempting to open/create monthly note for:", monthMoment.format("YYYY-MM"));
		const { workspace, vault } = this.app;
		const openInNewPane = event.ctrlKey || event.metaKey;
		const periodicNotes = (this.app as any).plugins.plugins['periodic-notes'];

		if (!periodicNotes) {
			console.warn("Periodic Notes plugin not found. Cannot create monthly note.");
			return;
		}

		if (!periodicNotes.settings?.monthly?.enabled) {
			console.warn("Monthly notes are not enabled in Periodic Notes settings.");
			return;
		}

		const { folder, format, template } = periodicNotes.settings.monthly;
		const fileName = monthMoment.format(format || "YYYY-MM") + '.md';
		const folderPath = folder?.trim() || '';
		const fullPath = folderPath ? `${folderPath}/${fileName}` : fileName;

		console.log(`Using Periodic Notes. Full path: ${fullPath}`);

		try {
			let file = vault.getAbstractFileByPath(fullPath);
			if (file instanceof TFile) {
				// Open existing monthly note
				await workspace.getLeaf(openInNewPane).openFile(file, { active: true });
			} else {
				// Create new monthly note with template
				let content = '';
				if (template) {
					const templateFile = vault.getAbstractFileByPath(template);
					if (templateFile instanceof TFile) {
						content = await vault.read(templateFile);
					}
				}
				const createdFile = await vault.create(fullPath, content);
				await workspace.getLeaf(openInNewPane).openFile(createdFile, { active: true });
			}
		} catch (err) {
			console.error("Error handling monthly note:", err);
		}
	}



	async createRangeNote(startDate: moment.Moment, endDate: moment.Moment): Promise<void> {
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
				const templateFullContent = await this.app.vault.cachedRead(templateFile);
				const templateParts = templateFullContent.split('---');
				if (templateParts.length >= 3) {
					const templateBody = templateParts.slice(2).join('---').trim();
					if (templateBody) {
						noteContent += "\n" + templateBody;
					}
				} else {
					noteContent += "\n" + templateFullContent.trim();
				}
			} else {
				console.warn(`Template file not found or is a folder: ${templatePath}`);
				new Notice(`Template file not found at ${templatePath}`, 3000);
			}
		} catch (err) {
			console.error("Error reading template file:", err);
			new Notice("Error reading template file.", 3000);
		}

		let notePath: string;
		try {
			const baseName = `Untitled Range Note ${startDate.format("YYMMDD")}-${endDate.format("YYMMDD")}`;
			const parentPath = defaultFolder ? defaultFolder + '/' : '';
			notePath = await (this.app as any).fileManager.getAvailablePathForAttachment(baseName, 'md', this.app.vault.getAbstractFileByPath(parentPath));

			if (!notePath || !notePath.endsWith('.md')) {
				console.warn("getAvailablePathForAttachment did not return a valid path, constructing manually.");
				let counter = 0;
				notePath = defaultFolder ? `${defaultFolder}/${baseName}.md` : `${baseName}.md`;
				while (await this.app.vault.adapter.exists(notePath) && counter < 100) {
					counter++;
					notePath = defaultFolder ? `${defaultFolder}/${baseName} ${counter}.md` : `${baseName} ${counter}.md`;
				}
				if (counter >= 100) throw new Error("Could not find unique filename.");
			}
		} catch (error) {
			console.error("Error generating file path:", error);
			new Notice("Could not determine a path for the new note.");
			return;
		}

		try {
			const newFile = await this.app.vault.create(notePath, noteContent);
			new Notice(`Created range note: ${newFile.basename}`);

			const leaf = this.app.workspace.getLeaf('tab');
			await leaf.openFile(newFile);
		} catch (err) {
			console.error("Error creating range note file:", err);
			new Notice("Error creating the range note file. Check console.");
		}
	};

	if (this.plugin.settings.shouldConfirmBeforeCreateRange) {
		createConfirmationDialog(this.app, {
			title: "Create Range Note?",
			text: `Create a new note for the range ${startDate.format("YYYY-MM-DD")} to ${endDate.format("YYYY-MM-DD")}?`,
			cta: "Create",
			onAccept: performCreateAndOpen
		});
	} else {
		await performCreateAndOpen();
	}
}
}


## styles.css
css
/* src/styles.css */
/* =========================================== */
/*         CONTINUOUS CALENDAR PLUGIN          */
/* =========================================== */

/* --- Main Container & Scroll --- */
.continuous-calendar {
  position: relative; /* Needed for absolute positioning of controls if used, but flex is better */
  height: 100%; /* Make continuous-calendar fill its container */
  display: flex; /* Use flexbox */
  flex-direction: column; /* Stack scroll area and controls */
}

.continuous-calendar .calendar-scroll-container {
  flex-grow: 1; /* Allow scroll container to take up available space */
  overflow-y: auto;
  overflow-x: hidden;
}
/* --- End Main Container & Scroll --- */

/* Base Table & Cell Styling */
.continuous-calendar .my-calendar-table {
  width: 100%;
  border-collapse: separate !important; /* Changed from collapse */
  border-spacing: 0;
  table-layout: fixed; /* Use fixed layout algorithm for equal column resizing */
}

.continuous-calendar .my-calendar-table th,
.continuous-calendar .my-calendar-table td {
  position: relative;
  text-align: center;
  vertical-align: top;
  border: 0.5px dotted var(--background-modifier-border);
  /* border: none; */
  padding: 2px;
  font-size: var(--font-adaptive-small);
  line-height: 1.2;
  overflow: hidden;
  overflow-wrap: break-word;
  word-wrap: break-word;
  /* background-color: var(--background-primary); */
}

/* -------------------------------------------
 Continuous‑Calendar – alternate month colours
 (put this as the *last* rule in the file)
 ------------------------------------------- */

.continuous-calendar td.calendar-cell.even-month {
  background-color: var(--background-primary);
}

.continuous-calendar td.calendar-cell.odd-month {
  background-color: color-mix(in srgb, var(--background-primary), black 1.2%);
  /* border: 0.5px dotted var(--background-primary); */
}

/* keep the same hover tint */
.continuous-calendar td.calendar-cell.even-month:hover {
  background-color: var(--bg2);
}

.continuous-calendar td.calendar-cell.odd-month:hover {
  background-color: var(--background-primary);
  transition: all 0.1s ease-in-out;
}

.continuous-calendar td.calendar-cell {
  min-height: 60px;
}

/* General Cell Hover */
.continuous-calendar .calendar-cell,
.continuous-calendar .week-number {
  cursor: pointer;
}

.continuous-calendar .week-number:hover {
  transform: scale(1.3);
  transition: all 0.1s ease-in-out;
  opacity: 1;
}

.continuous-calendar .calendar-cell:hover {
  background-color: var(--background-modifier-hover);
  border-color: var(--background-modifier-border-hover);
  border-radius: 6px;
  /* cell get a little bit bigger than cell around it */
  transform: scale(1.05);
  transition: all 0.1s ease-in-out;
  z-index: 1; /* Bring hovered cell to the front */
  box-shadow: 0 0 3px var(--background-modifier-border-hover);
}

/* --- Cell Content Structure --- */
.continuous-calendar .cell-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  min-height: 60px;
  padding-bottom: 16px;
}

/* 1. Top Content (Day Number) */
.continuous-calendar .top-content {
  flex-shrink:;
  padding-bottom: 2px;
  text-align: center;
}

.continuous-calendar .day-number {
  display: inline-block;
  font-weight: normal;
  vertical-align: middle;
  position: relative;
  padding: 1px 2px;
  margin: 0;
  border-radius: 3px;
  cursor: pointer;
  outline: 1px solid transparent;
  outline-offset: 1px;
  transition:
    outline-color 0.1s ease-in-out,
    background-color 0.1s ease-in-out;
}

.continuous-calendar .day-number.today {
  color: var(--background-primary);
  font-size: var(--font-adaptive-small);
  font-weight: bold !important;
  display: block;
  width: 100%;
  background-color: var(--text-normal);
  border-radius: 2px;
  margin-left: auto; /* Center the block */
  margin-right: auto; /* Center the block */
  padding: 1px 4px !important; /* Adjust padding */
}

/* 2. Dot Area */
.continuous-calendar .dot-area {
  flex-shrink: 0;
  max-height: 1.3em;
  overflow: hidden;
  line-height: 1.1;
  text-align: center;
  margin: 0 auto; /* Center the dots */
  /* margin-bottom: 2px; */
}

.continuous-calendar .dot {
  display: inline-block;
  margin: 0 1px;
  vertical-align: middle;
  white-space: normal;
}

.continuous-calendar .dot.note-dot {
  font-size: 0.6em;
  line-height: 1;
}

/* Style the specific daily note indicator */
.continuous-calendar .dot.daily-note-indicator {
  font-size: 0.8em; /* Make pin slightly larger? Adjust as needed */
  /* Override color if you want it different from the note's color */
  /* color: var(--text-accent); */
  /* Adjust vertical alignment if needed */
  vertical-align: middle; /* or baseline, text-bottom etc. */
  font-weight: bold;
  /* Ensure it doesn't get margin from the base .dot rule if needed */
  /* margin: 0; */
}

.continuous-calendar .dot.birthday-dot {
  font-size: 0.8em;
  font-weight: bold;
  vertical-align: middle;
}

/* 3. Range Bar Area & Slots */
.continuous-calendar .range-bar-area {
  position: absolute;
  bottom: 2px;
  left: 0;
  right: 0;
  height: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0 0;
  margin: 0 auto; /* Center the range bar */
}

.continuous-calendar .range-slot {
  height: 4px;
  width: 100%;
}

.continuous-calendar .range-bar {
  width: 100%;
  height: 100%;
  display: block;
  border-radius: 0;
}

/* Range Bar Start/End Styles */
/* left corner when this individual bar starts here */
.range-bar.range-start {
  border-top-left-radius: 2px;
  border-bottom-left-radius: 2px;
}

/* right corner when this bar ends here */
.range-bar.range-end {
  border-top-right-radius: 2px;
  border-bottom-right-radius: 2px;
}

/* both start & end on the same day */
.range-bar.range-start.range-end {
  border-radius: 3px !important; /* square */
}

/* Holiday Cells */
/* .continuous-calendar .calendar-cell.holiday {
background-color: color-mix(in srgb, var(--color-red-tint), transparent 85%);
color: var(--color-red-text) !important;
}
.continuous-calendar .calendar-cell.holiday:hover {
background-color: color-mix(in srgb, var(--color-red-tint), transparent 60%);

} */

/* Weekends (Saturday 7th col, Sunday 8th col) */
.continuous-calendar .my-calendar-table td:nth-child(7),
.continuous-calendar .my-calendar-table td:nth-child(8) {
  /* background-color: color-mix(in srgb, var(--color-red-tint), transparent 85%);} */
  background-color: color-mix(in srgb, var(--bg2), black 0%);
}
.continuous-calendar .my-calendar-table td:nth-child(7):hover,
.continuous-calendar .my-calendar-table td:nth-child(8):hover {
  background-color: color-mix(
    in srgb,
    var(--background-modifier-hover),
    transparent 0%
  );
  /* background-color: var(--background-primary); */
}

/* Outside Year */
.continuous-calendar .calendar-cell.other-year {
  opacity: 0.2;
}

/* Non-Current Month Fading - Original rule modified by JS logic adding 'is-faded' */
.continuous-calendar .calendar-cell:not(.current-month) {
  color: var(--text-muted);
  font-size: var(--font-adaptive-smaller) !important;
}

/* Current Month Cells */
.continuous-calendar .calendar-cell.current-month {
  opacity: 1;
  color: var(--text-normal);
  font-weight: 500;
  font-size: var(--font-adaptive-small) !important;
}

/* Week Number Styling */
.continuous-calendar .week-number {
  text-align: center;
  border-right: 1px dashed var(--text-muted) !important;
  /* line-height: 3; */
  font-weight: normal;
  vertical-align: middle !important;
  padding: 4px 2px !important;
  font-size: var(--font-adaptive-smaller) !important;
  border: none !important;
  opacity: 0.5;
}

.continuous-calendar :not(.week-number.current-week) .week-number-text {
  /* opacity: 0.5; */
  color: var(--text-muted);
  display: inline-block;
}

.continuous-calendar .week-number.current-week {
  opacity: 1 !important; /* Ensure it stays visible */
}

.continuous-calendar .week-number.current-week .week-number-text {
  font-size: var(--font-adaptive-small) !important;
  font-weight: bold !important;
  border-radius: 2px !important;
  padding: 2px 6px !important;
  display: inline-block;
}

/* --- Month Column & Icons (Vertical Stack) --- */
.continuous-calendar .month-column {
  text-align: center;
  border-left: 0.5px dotted var(--background-modifier-border);
  vertical-align: middle; /* Center content vertically */
  border: none !important; /* Remove default border */
}

.continuous-calendar .month-cell-wrapper {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center; /* Center items vertically */
  height: 100%;
  padding: 2px 0px; /* Reduced padding */
  gap: 1px; /* Reduced gap between label and icon cells */
  width: 100%; /* Ensure wrapper takes full width */
}

.continuous-calendar .month-label-text {
  /* Styles for the text itself, e.g., current-month-label, other-month-label */
  display: block; /* Ensure it takes space */
  line-height: 1.2; /* Adjust line height */
  margin-bottom: 0; /* Remove bottom margin if using gap */
  padding: 2px 3px; /* Adjust padding */
  border-radius: 2px;
  width: max-content; /* Prevent stretching */
  font-size: var(--font-adaptive-smaller);
}

/* Make the label text clickable */
.continuous-calendar .month-label-text.clickable-month-label {
  cursor: pointer;
}

.continuous-calendar .month-label-text.clickable-month-label:hover {
  background-color: var(--text-accent);
  color: var(--background-primary);
  transform: scale(1.05);
  transition: all 0.1s ease-in-out;
  z-index: 1; /* Bring hovered cell to the front */
}

.continuous-calendar .month-action-cell {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%; /* Take full width */
  line-height: 1; /* Prevent extra height */
  /* height: 18px; */ /* Optional: Fixed height */
}

.continuous-calendar .month-action-icon {
  cursor: pointer;
  padding: 1px; /* Reduced padding */
  border-radius: 3px;
  opacity: 0.6; /* Slightly more visible default */
  transition: all 0.2s ease;
  display: flex; /* Needed for setIcon */
  align-items: center; /* Needed for setIcon */
  justify-content: center; /* Needed for setIcon */
  pointer-events: auto !important; /* Ensure clickable */
  color: var(--text-muted);
  width: 18px; /* Slightly smaller */
  height: 18px;
}

.continuous-calendar .month-action-icon > svg {
  /* Target the SVG set by setIcon */
  width: 12px; /* Smaller icon */
  height: 12px;
}

.continuous-calendar .month-action-icon:hover {
  opacity: 1;
  color: var(--background-primary);
  transform: scale(1.05);
  background-color: var(--text-accent);
  transition: all 0.1s ease-in-out;
}

/* --- END Month Column --- */

/* Month Boundaries (vertical & horizontal) */
.calendar-cell.month-start {
  border-left: 0.5px dashed var(--text-muted) !important;
}

.calendar-cell.month-end {
  border-right: 0.5px dashed var(--text-muted) !important;
}

.calendar-cell.month-top {
  border-top: 1px dashed var(--text-muted) !important;
}
.calendar-cell.month-bottom {
  border-bottom: 1px dashed var(--text-muted) !important;
}

/* For month-boundary as an extra separate class if needed */
.calendar-cell.month-boundary {
  border-left: 1px dashed var(--text-muted) !important;
}

/* Current Month Outline Styles */
:root {
  /* Or .continuous-calendar */
  --current-month-corner-radius: 8px; /* Make sure value is valid */
}

/* Border Outline Classes */
.continuous-calendar .border-outline-top {
  border-top: 2px solid var(--text-muted) !important;
  /* box-shadow: 0px -7px 0px 0px color-mix(in srgb, var(--text-faint), transparent 60%) !important; */
  z-index: 1;
}

.continuous-calendar .border-outline-left {
  border-left: 2px solid var(--text-muted) !important;
  z-index: 1;
}

.continuous-calendar .border-outline-right {
  border-right: 2px solid var(--text-muted) !important;
  z-index: 1;
}
.continuous-calendar .border-outline-bottom {
  border-bottom: 2px solid var(--text-muted) !important;
  /* box-shadow: 0px 7px 0px 0px color-mix(in srgb, var(--text-faint), transparent 60%) !important; */
  z-index: 1;
}

/* Rounded Corner Classes */
.continuous-calendar .corner-top-left {
  border-top-left-radius: var(--current-month-corner-radius);
  overflow: hidden;
}

.continuous-calendar .corner-top-right {
  border-top-right-radius: var(--current-month-corner-radius);
  overflow: hidden;
}

.continuous-calendar .corner-bottom-left {
  border-bottom-left-radius: var(--current-month-corner-radius);
  overflow: hidden;
}

.continuous-calendar .corner-bottom-right {
  border-bottom-right-radius: var(--current-month-corner-radius);
  overflow: hidden;
}

/* Style the cell that contains a clickable label */
.continuous-calendar td.month-column.clickable-month-label {
  cursor: pointer;
}

/* Style the text itself on hover (targets spans inside the cell) */
/* This hover might need adjustment if it interferes with icon clicks */
.continuous-calendar
  td.month-column.clickable-month-label:hover
  .month-label-text {
  background-color: var(--text-accent); /* Use theme accent color */
  text-decoration: underline !important;
  color: var(--background-primary);
  padding: 3px;
  border-radius: 2px;
  opacity: 1 !important; /* ensure it stays visible */
  transition:
    outline-color 0.1s ease-in-out,
    background-color 0.1s ease-in-out;
}

/* Ensure the specific label spans inherit pointer */
.continuous-calendar .current-month-label,
.continuous-calendar .other-month-label {
  /* Add class for other months if needed */
}

.continuous-calendar .current-month-label {
  /* background-color: var(--text-normal); */
  /* color: var(--background-primary); */
  padding: 3px;
  /* line-height: 3 !important; */
  border-radius: 2px;
  opacity: 1 !important; /* ensure it stays visible */
  font-weight: bold !important;
  font-size: var(--font-adaptive-small) !important;
}

/* Expanded (Click-to-Open) Rows */
.continuous-calendar .calendar-cell.expanded,
.continuous-calendar .calendar-cell.expanded:hover {
  border: 2px solid var(--text-normal) !important; /* Use theme accent color */
  border-radius: 4px !important;
  background-color: var(
    --background-secondary-alt
  ); /* Slightly different bg when expanded */
}

.continuous-calendar .expanded-row td {
  padding: 10px;
  border: 1px solid var(--text-muted);
  border-radius: 4px;
  text-align: left !important;
  opacity: 0;
  max-height: 0;
  overflow: hidden;
  /* transition: all 0.3s ease-in-out; */
  transition:
    opacity 0.3s ease-in-out,
    max-height 0.3s ease-in-out,
    padding 0.3s ease-in-out; /* Smooth transition */
}

.continuous-calendar .expanded-row.show td {
  max-height: 1000px;
  opacity: 1;
}

/* Expanded Content */
.continuous-calendar .expanded-content {
  font-size: var(--font-adaptive-normal) !important;
  position: relative; /* for close button positioning */
}

.continuous-calendar .expanded-content h3,
.continuous-calendar .expanded-content h4 {
  line-height: 0.8;
}

.continuous-calendar .expanded-content p {
  margin-bottom: 8px;
}

.continuous-calendar .expanded-content a:hover {
  text-decoration: underline;
}

/* Close Button */
.continuous-calendar .close-button {
  position: absolute;
  top: 5px;
  right: 5px;
  background: transparent;
  border: none;
  font-size: 20px;
  font-weight: bold;
  color: #888;
  line-height: 1;
  cursor: pointer;
}

.continuous-calendar .close-button:hover {
  color: #000;
}

/* Tooltip */
.continuous-calendar .close-button::after {
  content: "Close";
  position: absolute;
  top: -25px;
  right: 0;
  background-color: #333;
  color: #fff;
  padding: 3px 6px;
  border-radius: 4px;
  font-size: 10px;
  white-space: nowrap;
  opacity: 0;
  transition: opacity 0.3s;
  pointer-events: none;
}

.continuous-calendar .close-button:hover::after {
  opacity: 1;
}

/* Notes & Range Bars */
.continuous-calendar .notes-container {
  font-size: 12px;
}

.continuous-calendar .note-link,
.continuous-calendar .range-bar-link {
  text-decoration: none;
  margin-right: 2px;
}

.force-focused-month {
  opacity: 1 !important; /* Ensure it's fully visible */
  font-size: var(--font-adaptive-small);
  color: var(--text-normal) !important;
}

.is-faded {
  opacity: 0.4 !important; /* Use important to override other opacity rules if needed */
}

/* Responsive Layout */
@media (max-width: 768px) {
  .continuous-calendar .my-calendar-table th,
  .continuous-calendar .my-calendar-table td {
    font-size: 10px;
    padding: 2px;
  }
  .continuous-calendar .expanded-content {
    font-size: 14px;
  }
  .continuous-calendar .close-button {
    font-size: 18px;
  }
}

/* --- Controls Container Styling --- */
.calendar-controls-bottom {
  flex-shrink: 0; /* Prevent controls from shrinking */
  padding: 5px 10px; /* Add some padding */
  display: flex;
  justify-content: flex-end; /* Align items to the right */
  align-items: center;
  gap: 15px; /* Increased space between control groups */
  background-color: var(--background-secondary); /* Match theme */
  border-top: 1px solid var(--background-modifier-border);
}

/* Group for Reset/Relocate buttons */
.calendar-controls-bottom .focus-controls {
  display: flex;
  gap: 8px; /* Space within the focus group */
}

/* Year Selector */
.year-update-controls {
  display: flex;
  align-items: center;
  gap: 5px;
}

.year-input {
  width: 55px;
  padding: 3px 5px;
  text-align: center;
  border: 1px solid var(--background-modifier-border);
  background-color: var(--background-primary);
  color: var(--text-normal);
  border-radius: 4px;
}

.year-update-button {
  padding: 3px 10px;
  font-size: var(--font-adaptive-smaller);
  cursor: pointer;
  border: none;
  background-color: var(--interactive-accent);
  color: var(--text-on-accent);
  border-radius: 4px;
  transition: background-color 0.1s ease-in-out;
}

.year-update-button:hover {
  background-color: var(--interactive-accent-hover);
}

/* Reset/Relocate Button Styling */
.reset-focus-button,
.relocate-button {
  padding: 3px 10px;
  font-size: var(--font-adaptive-smaller);
  cursor: pointer;
  border: 1px solid var(--background-modifier-border);
  background-color: var(--background-primary);
  color: var(--text-muted); /* Make less prominent than year load */
  border-radius: 4px;
  transition: all 0.1s ease-in-out;
}

.reset-focus-button:hover,
.relocate-button:hover {
  background-color: var(--background-modifier-hover);
  color: var(--text-normal);
  border-color: var(--background-modifier-border-hover);
}

/* Calendar Refresh Button */
.calendar-refresh-button {
  padding: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--background-primary);
  color: var(--text-muted);
  border: 1px solid var(--background-modifier-border);
  border-radius: 4px;
  cursor: pointer;
  height: 30px;
  width: 30px;
  transition: all 0.1s ease-in-out;
}

.calendar-refresh-button:hover {
  background-color: var(--background-modifier-hover);
  color: var(--text-normal);
  border-color: var(--background-modifier-border-hover);
}

.calendar-refresh-button svg {
  height: 16px;
  width: 16px;
}

/* --- END Controls --- */

/* Misc. Classes */
.birthday-link {
  color: hotpink;
}
.birthday-link:hover {
  color: deeppink;
}
.month-abbr-column {
  text-align: center;
  line-height: 3 !important;
  font-size: 4em;
  font-family: monospace;
  color: var(--background-modifier-border) !important;
  background-color: #000 !important;
}

/* Sticky header: <thead> or specifically <thead> th. */
.continuous-calendar .my-calendar-table thead th {
  position: sticky;
  font-weight: normal;
  font-size: var(--font-adaptive-smaller);
  top: -5px;
  z-index: 2; /* So it stays above the scrolling cells */
  background-color: var(--background-primary);
  padding: 4px 2px;
  box-shadow: 0 2px 2px -1px var(--background-modifier-border);
}

/* --- Styling for Days --- */
.continuous-calendar .day-number:hover {
  outline-color: var(--text-faint); /* Use a faint theme color */
}

.continuous-calendar .day-number.engaged {
  outline-color: var(
    --text-normal
  ); /* Use theme's normal text color for outline */
}

/* Style for the first clicked day number when selecting a range */
.continuous-calendar .day-number.range-start-engaged {
  outline: 2px solid var(--interactive-accent) !important; /* Example: Blue outline, use !important if needed */
  background-color: color-mix(
    in srgb,
    var(--interactive-accent),
    transparent 80%
  ); /* Example: Light blue background */
  border-radius: 3px;
}

/* Ensure engaged style doesn't fully override range-start if both are applied briefly */
.continuous-calendar .day-number.range-start-engaged.engaged {
  outline-width: 2px; /* Keep the thicker outline */
}

.continuous-calendar .day-number .day-number-text.has-daily-note-linkable {
  text-decoration: underline;
  cursor: pointer; /* Optional: makes it visually clear it's interactive */
  /* color: var(--text-accent); */
}

.continuous-calendar .pencil-indicator {
  display: none; /* Hidden by default */
  margin-left: 4px; /* Space between number and pencil */
  font-size: 0.9em; /* Slightly smaller */
  color: var(--text-muted); /* Use a muted theme color */
  vertical-align: middle; /* Align with number text */
}

.continuous-calendar .pencil-indicator.always-visible {
  display: inline; /* Show if daily note exists, regardless of engagement */
}

.continuous-calendar .day-number.engaged .pencil-indicator {
  display: inline; /* Show the pencil */
}

.continuous-calendar .day-number.today:hover {
  background-color: var(--text-accent);
  outline-color: var(--text-faint);
}

.continuous-calendar .day-number.today.engaged {
  outline-color: var(--text-normal);
}

.continuous-calendar .day-number.today .pencil-indicator,
.continuous-calendar .day-number.today .pencil-indicator.always-visible {
  /* Ensure 'today' styling applies to always-visible pencil */
  color: var(--background-primary); /* Pencil color on 'today' background */
  margin-left: 2px;
  font-size: 0.7em; /* Smaller pencil on 'today' */
}

/* Styling for Expanded Holiday List */
.continuous-calendar .expanded-holidays {
  list-style: none; /* Remove default bullets */
  padding-left: 0;
  margin-top: 5px;
  margin-bottom: 10px;
}

.continuous-calendar .expanded-holidays li {
  padding: 2px 0;
  color: var(--text-muted); /* Style holiday names distinctively */
}

.continuous-calendar .expanded-content .expanded-holidays li {
  color: var(--color-red-text);
}

.continuous-calendar .calendar-cell.holiday-colored {
  background-color: color-mix(
    in srgb,
    var(--holiday-background-color, var(--color-red-tint)),
    transparent 85%
  ) !important;
  color: var(--text-normal);
  font-weight: 500;
}

.continuous-calendar .calendar-cell.holiday-colored:hover {
  background-color: color-mix(
    in srgb,
    var(--holiday-background-color, var(--color-red-tint)),
    transparent 60%
  ) !important;
}

/* Year Selector Controls */
.continuous-calendar {
  height: 100%;
  display: flex;
  flex-direction: column;
}



