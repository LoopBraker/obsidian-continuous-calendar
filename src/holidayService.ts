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
} from "./types";

const HOLIDAY_FILE_PREFIX = " Holidays ";

interface AggregatedHolidayInfo {
  name: string;
  color?: string;
}

export class HolidayService {
  app: App;
  plugin: MyCalendarPlugin;
  // Use a cache to hold date-holidays instances keyed by country code
  private hdCache = new Map<string, any>();

  constructor(app: App, plugin: MyCalendarPlugin) {
    this.app = app;
    this.plugin = plugin;
  }

  private async getDateHolidaysInstance(
    countryCode?: string
  ): Promise<any | null> {
    // Use a specific cache key if countryCode is provided; otherwise use a generic key for listing all countries.
    const cacheKey = countryCode ? countryCode.toUpperCase() : "__generic__";

    if (this.hdCache.has(cacheKey)) {
      return this.hdCache.get(cacheKey);
    }

    try {
      const Holidays = require("date-holidays");
      // Pass the country code to the constructor if provided
      const instance = countryCode ? new Holidays(countryCode) : new Holidays();
      this.hdCache.set(cacheKey, instance);
      return instance;
    } catch (err) {
      console.error(
        `Failed to load/init 'date-holidays' library for ${cacheKey}.`,
        err
      );
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
      return Object.entries(countries).map(([code, name]) => ({
        code,
        name: name as string,
      }));
    } catch (err) {
      console.error("Error getting country list from date-holidays:", err);
      return [];
    }
  }

  getHolidaySourceId(source: HolidaySource): string {
    if (source.type === "country") {
      return source.countryCode.toUpperCase();
    } else {
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
    // Get the instance specifically initialized for this country
    const hd = await this.getDateHolidaysInstance(countryCode);
    if (!hd) return [];

    try {
      const rawHolidays = hd.getHolidays(year);
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
      let initialFrontMatter: HolidayFileFrontMatter,
        fileContent = "";
      if (source.type === "country") {
        initialFrontMatter = {
          holidaySourceType: "country",
          countryCode: source.countryCode.toUpperCase(),
          year: year,
          holidays: [],
          lastFetched: undefined,
        };
        fileContent = `# ${year} Holidays for ${source.countryCode.toUpperCase()}`;
      } else {
        initialFrontMatter = {
          holidaySourceType: "custom",
          customName: source.name,
          year: year,
          holidays: [],
        };
        fileContent = `# ${year} Custom Holidays: ${source.name}\n\nAdd holidays in frontmatter.`;
      }
      const fmString = `---\n${stringifyYaml(initialFrontMatter)}---`;
      const fullContent = `${fmString}\n\n${fileContent}`;
      file = await this.app.vault.create(filePath, fullContent);
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
      new Notice("No country sources configured.");
      return;
    }
    new Notice(`Starting update for ${countrySources.length} sources...`);
    for (const source of countrySources) {
      const success = await this.updateCountryHolidayFile(year, source);
      if (success) updatedCount++;
    }
    new Notice(`Update complete. Processed ${updatedCount} sources.`);
    this.plugin.refreshCalendarView();
  }

  async getAggregatedHolidays(
    year: number
  ): Promise<Map<string, AggregatedHolidayInfo[]>> {
    const aggregatedHolidays = new Map<string, AggregatedHolidayInfo[]>();
    for (const source of this.plugin.settings.holidaySources) {
      const sourceColor = source.type === "country" ? source.color : undefined;
      const filePath = this.getHolidayFilePath(year, source);
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) continue;
      try {
        const cache = this.app.metadataCache.getFileCache(file);
        if (
          cache?.frontmatter?.holidays &&
          Array.isArray(cache.frontmatter.holidays) &&
          cache.frontmatter.year === year
        ) {
          (cache.frontmatter.holidays as Holiday[]).forEach(
            (holiday: Holiday) => {
              const dateStr = holiday.date;
              if (!aggregatedHolidays.has(dateStr))
                aggregatedHolidays.set(dateStr, []);
              if (
                !aggregatedHolidays
                  .get(dateStr)
                  ?.some((h) => h.name === holiday.name)
              ) {
                aggregatedHolidays
                  .get(dateStr)
                  ?.push({ name: holiday.name, color: sourceColor });
              }
            }
          );
        }
      } catch (err) {
        console.error(`Error reading frontmatter from ${filePath}:`, err);
      }
    }
    return aggregatedHolidays;
  }
}
