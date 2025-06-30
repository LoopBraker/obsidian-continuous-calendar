// src/holidayService.ts
import {
  App,
  TFile,
  Notice,
  normalizePath,
  stringifyYaml,
  moment,
} from "obsidian";
import MyCalendarPlugin from "./main";
import {
  HolidaySource,
  Holiday,
  HolidayFileFrontMatter,
  CountryHolidaySource,
  CustomHolidaySource,
} from "./types";

const HOLIDAY_FILE_PREFIX = " Holidays ";

export class HolidayService {
  app: App;
  plugin: MyCalendarPlugin;
  private hd: any = null;

  constructor(app: App, plugin: MyCalendarPlugin) {
    this.app = app;
    this.plugin = plugin;
    this.initialize();
  }

  private async initialize() {
    try {
      this.hd = require("date-holidays");
    } catch (err) {
      console.error("Failed to load 'date-holidays' library.", err);
      this.hd = null;
    }
  }

  // New method to provide country list for settings UI
  async getAvailableCountries(): Promise<{ code: string; name: string }[]> {
    if (!this.hd) return [];
    try {
      const holidaysInstance = new this.hd();
      const countries = holidaysInstance.getCountries();
      return Object.entries(countries).map(([code, name]) => ({
        code,
        name: name as string,
      }));
    } catch (err) {
      console.error("Error getting country list from date-holidays:", err);
      return [];
    }
  }

  // Helper to generate a consistent ID for any source type
  getHolidaySourceId(source: HolidaySource): string {
    if (source.type === "country") {
      return source.countryCode.toUpperCase();
    } else {
      // A simple way to create a file-safe name from a custom source name
      return source.name.replace(/[^a-zA-Z0-9_-\s]/g, "").replace(/\s+/g, "_");
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

  private async fetchCountryHolidays(
    countryCode: string,
    year: number
  ): Promise<Holiday[]> {
    if (!this.hd) return [];
    try {
      const holidaysInstance = new this.hd(countryCode);
      const rawHolidays = holidaysInstance.getHolidays(year);
      if (!rawHolidays || !Array.isArray(rawHolidays)) return [];

      return rawHolidays
        .map((h: any): Holiday | null => {
          if (!h || !h.date || !h.name) return null;
          const dateMoment = moment(h.date);
          if (!dateMoment.isValid()) return null;
          return { date: dateMoment.format("YYYY-MM-DD"), name: h.name };
        })
        .filter((h): h is Holiday => h !== null);
    } catch (err: any) {
      console.error(`Error fetching holidays for ${countryCode}:`, err);
      return [];
    }
  }

  async ensureHolidayFileExists(
    year: number,
    source: HolidaySource
  ): Promise<TFile | null> {
    const filePath = this.getHolidayFilePath(year, source);
    let file = this.app.vault.getAbstractFileByPath(filePath);
    if (file instanceof TFile) return file;

    try {
      const folder = this.plugin.settings.holidayStorageFolder;
      if (!(await this.app.vault.adapter.exists(normalizePath(folder)))) {
        await this.app.vault.createFolder(folder);
      }

      let initialFrontMatter: HolidayFileFrontMatter;
      let fileContent = "";

      if (source.type === "country") {
        initialFrontMatter = {
          holidaySourceType: "country",
          countryCode: source.countryCode.toUpperCase(),
          year: year,
          holidays: [],
        };
        fileContent = `# ${year} Holidays for ${source.countryCode.toUpperCase()}`;
      } else {
        // Custom type
        initialFrontMatter = {
          holidaySourceType: "custom",
          customName: source.name,
          year: year,
          holidays: [],
        };
        fileContent = `# ${year} Custom Holidays: ${source.name}`;
      }

      const fmString = `---\n${stringifyYaml(initialFrontMatter)}---`;
      file = await this.app.vault.create(
        filePath,
        `${fmString}\n\n${fileContent}`
      );
      return file instanceof TFile ? file : null;
    } catch (err) {
      console.error(`Error creating holiday file ${filePath}:`, err);
      new Notice(
        `Failed to create file for ${this.getHolidaySourceId(source)} holidays.`
      );
      return null;
    }
  }

  async updateCountryHolidayFile(
    year: number,
    source: CountryHolidaySource
  ): Promise<boolean> {
    const file = await this.ensureHolidayFileExists(year, source);
    if (!file) return false;

    const fetchedHolidays = await this.fetchCountryHolidays(
      source.countryCode,
      year
    );
    try {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        fm.holidays = fetchedHolidays;
        fm.lastFetched = new Date().toISOString();
      });
      console.log(
        `Updated holiday file: ${file.path} with ${fetchedHolidays.length} holidays.`
      );
      return true;
    } catch (err) {
      console.error(`Error updating frontmatter for ${file.path}:`, err);
      return false;
    }
  }

  async fetchAndUpdateAllCountryFilesForYear(year: number): Promise<void> {
    let updatedCount = 0;
    const countrySources = this.plugin.settings.holidaySources.filter(
      (s) => s.type === "country"
    ) as CountryHolidaySource[];
    if (countrySources.length === 0) {
      new Notice("No country holiday sources configured.");
      return;
    }

    new Notice(
      `Starting update for ${countrySources.length} country source(s)...`
    );
    for (const source of countrySources) {
      const success = await this.updateCountryHolidayFile(year, source);
      if (success) updatedCount++;
    }
    new Notice(`Holiday update complete. Processed ${updatedCount} source(s).`);
    this.plugin.refreshCalendarView();
  }

  // New method for the view to consume all holiday data at once
  async getAggregatedHolidays(year: number): Promise<Map<string, Holiday[]>> {
    const aggregatedHolidays = new Map<string, Holiday[]>();
    const activeSources = this.plugin.settings.holidaySources;

    for (const source of activeSources) {
      const filePath = this.getHolidayFilePath(year, source);
      const file = this.app.vault.getAbstractFileByPath(filePath);

      if (!(file instanceof TFile)) {
        // Silently fail if file doesn't exist, as user might not have run the update command yet
        continue;
      }

      try {
        const cache = this.app.metadataCache.getFileCache(file);
        if (
          cache?.frontmatter?.holidays &&
          Array.isArray(cache.frontmatter.holidays) &&
          cache.frontmatter.year === year
        ) {
          const holidaysFromFile = cache.frontmatter.holidays as Holiday[];
          holidaysFromFile.forEach((h) => {
            if (!aggregatedHolidays.has(h.date)) {
              aggregatedHolidays.set(h.date, []);
            }
            // Avoid duplicates if multiple sources have the same holiday (e.g., New Year's Day)
            if (
              !aggregatedHolidays
                .get(h.date)
                ?.some((existing) => existing.name === h.name)
            ) {
              aggregatedHolidays.get(h.date)?.push(h);
            }
          });
        }
      } catch (err) {
        console.error(`Error reading frontmatter from ${filePath}:`, err);
      }
    }
    return aggregatedHolidays;
  }
}
