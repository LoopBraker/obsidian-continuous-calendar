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
import { Holiday, HolidayFileFrontMatter } from "./types";

const HOLIDAY_FILE_PREFIX = "Holidays ";

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

  private async fetchHolidaysFromLibrary(
    countryCode: string,
    year: number
  ): Promise<Holiday[]> {
    if (!this.hd || !countryCode) return [];
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

  getHolidayFileName(year: number, countryCode: string): string {
    return `${year} ${HOLIDAY_FILE_PREFIX}${countryCode.toUpperCase()}.md`;
  }

  getHolidayFilePath(year: number, countryCode: string): string {
    const folder = this.plugin.settings.holidayStorageFolder;
    const fileName = this.getHolidayFileName(year, countryCode);
    return normalizePath(`${folder}/${fileName}`);
  }

  async ensureHolidayFileExists(
    year: number,
    countryCode: string
  ): Promise<TFile | null> {
    const filePath = this.getHolidayFilePath(year, countryCode);
    let file = this.app.vault.getAbstractFileByPath(filePath);

    if (file instanceof TFile) return file;

    try {
      const folder = this.plugin.settings.holidayStorageFolder;
      if (!(await this.app.vault.adapter.exists(normalizePath(folder)))) {
        await this.app.vault.createFolder(folder);
      }

      const initialFrontMatter: HolidayFileFrontMatter = {
        countryCode: countryCode.toUpperCase(),
        year: year,
        holidays: [],
      };
      const fmString = `---\n${stringifyYaml(initialFrontMatter)}---\n\n# ${year} Holidays for ${countryCode.toUpperCase()}`;
      file = await this.app.vault.create(filePath, fmString);
      return file instanceof TFile ? file : null;
    } catch (err) {
      console.error(`Error creating holiday file ${filePath}:`, err);
      new Notice(`Failed to create file for ${countryCode} holidays.`);
      return null;
    }
  }

  async updateCountryHolidayFile(
    year: number,
    countryCode: string
  ): Promise<boolean> {
    const file = await this.ensureHolidayFileExists(year, countryCode);
    if (!file) return false;

    const fetchedHolidays = await this.fetchHolidaysFromLibrary(
      countryCode,
      year
    );

    try {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        fm.holidays = fetchedHolidays;
        fm.lastFetched = new Date().toISOString();
      });
      new Notice(
        `Updated ${countryCode} holidays for ${year} with ${fetchedHolidays.length} events.`
      );
      return true;
    } catch (err) {
      console.error(`Error updating frontmatter for ${file.path}:`, err);
      new Notice(`Failed to save updated holidays for ${countryCode}.`);
      return false;
    }
  }
}
