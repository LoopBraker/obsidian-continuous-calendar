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