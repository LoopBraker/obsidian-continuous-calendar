import { App, TFile, Notice, normalizePath, stringifyYaml } from 'obsidian';
import type ContinuousCalendarPlugin from '../../main'; // Adjust path to main.ts
import { HolidaySource, Holiday, HolidayFileFrontMatter, CountryHolidaySource } from './HolidayTypes';

const HOLIDAY_FILE_PREFIX = " Holidays ";

export class HolidayStorage {
    app: App;
    plugin: ContinuousCalendarPlugin;

    constructor(app: App, plugin: ContinuousCalendarPlugin) {
        this.app = app;
        this.plugin = plugin;
    }

    // --- Helpers ---

    getHolidaySourceId(source: HolidaySource): string {
        if (source.type === 'country') {
            return source.countryCode.toUpperCase();
        } else {
            return source.name.replace(/[^a-zA-Z0-9_-\s]/g, '').replace(/\s+/g, '_');
        }
    }

    private getHolidayFileName(year: number, sourceId: string): string {
        return `${year}${HOLIDAY_FILE_PREFIX}${sourceId}.md`;
    }

    getHolidayFilePath(year: number, source: HolidaySource): string {
        const folder = this.plugin.settings.holidayStorageFolder;
        const sourceId = this.getHolidaySourceId(source);
        const fileName = this.getHolidayFileName(year, sourceId);
        return normalizePath(`${folder}/${fileName}`);
    }

    // --- Write Operations ---

    async ensureHolidayFileExists(year: number, source: HolidaySource): Promise<TFile | null> {
        const filePath = this.getHolidayFilePath(year, source);
        let file = this.app.vault.getAbstractFileByPath(filePath);

        if (file instanceof TFile) {
            return file;
        }

        // File doesn't exist, create it
        try {
            const folder = this.plugin.settings.holidayStorageFolder;
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
                    holidays: [],
                    lastFetched: undefined,
                };
                fileContent = `# ${year} Holidays for ${source.countryCode.toUpperCase()}\n\nThis file is automatically managed for country holidays. Fetched data is stored in the frontmatter.\n`;
            } else {
                initialFrontMatter = {
                    holidaySourceType: 'custom',
                    customName: source.name,
                    year: year,
                    holidays: [],
                };
                fileContent = `# ${year} Custom Holidays: ${source.name}\n\nAdd your custom holidays to the 'holidays' list in the frontmatter.\n\nExample:\n\`\`\`yaml\nholidays:\n  - date: ${year}-10-31\n    name: My Special Day\n\`\`\`\n`;
            }

            const fmString = `---\n${stringifyYaml(initialFrontMatter)}---`;
            const fullContent = `${fmString}\n\n${fileContent}`;

            file = await this.app.vault.create(filePath, fullContent);
            console.log(`[HolidayStorage] Created holiday file: ${filePath}`);
            return file instanceof TFile ? file : null;
        } catch (err) {
            console.error(`[HolidayStorage] Error creating file ${filePath}:`, err);
            new Notice(`Failed to create holiday file for ${this.getHolidaySourceId(source)}`);
            return null;
        }
    }

    async writeHolidaysToFile(year: number, source: CountryHolidaySource, holidays: Holiday[]): Promise<boolean> {
        const file = await this.ensureHolidayFileExists(year, source);
        if (!file) return false;

        try {
            await this.app.fileManager.processFrontMatter(file, (fm) => {
                const data: HolidayFileFrontMatter = {
                    ...fm,
                    holidaySourceType: 'country',
                    countryCode: source.countryCode.toUpperCase(),
                    year: year,
                    holidays: holidays,
                    lastFetched: new Date().toISOString(),
                };
                // Clear old keys and assign new data
                for (const key in fm) { delete fm[key]; }
                Object.assign(fm, data);
            });
            return true;
        } catch (err) {
            console.error(`[HolidayStorage] Error updating frontmatter for ${file.path}:`, err);
            return false;
        }
    }

    // --- Read Operations ---

    async getAggregatedHolidays(year: number): Promise<Map<string, Holiday[]>> {
        const aggregatedHolidays = new Map<string, Holiday[]>();
        const activeSources = this.plugin.settings.holidaySources;

        if (!activeSources || activeSources.length === 0) {
            return aggregatedHolidays;
        }

        console.log(`[HolidayStorage] Aggregating holidays for ${year} from ${activeSources.length} sources`);

        for (const source of activeSources) {
            const sourceColor = source.type === 'country' ? source.color : undefined;
            const sourceCountryCode = source.type === 'country' ? source.countryCode.toUpperCase() : undefined;
            const filePath = this.getHolidayFilePath(year, source);
            const file = this.app.vault.getAbstractFileByPath(filePath);

            if (!(file instanceof TFile)) {
                // Not found implies it hasn't been generated or was deleted
                continue;
            }

            try {
                const cache = this.app.metadataCache.getFileCache(file);
                const fm = cache?.frontmatter;

                if (fm && typeof fm === 'object' && fm.holidays && Array.isArray(fm.holidays) && fm.year === year) {
                    const holidaysFromFile = fm.holidays as any[];

                    holidaysFromFile.forEach((holiday: any) => {
                        if (holiday && typeof holiday.date === 'string' && typeof holiday.name === 'string') {
                            const dateMoment = window.moment(holiday.date, "YYYY-MM-DD", true);
                            if (dateMoment.isValid() && dateMoment.year() === year) {
                                const dateStr = dateMoment.format("YYYY-MM-DD");
                                if (!aggregatedHolidays.has(dateStr)) {
                                    aggregatedHolidays.set(dateStr, []);
                                }
                                // Avoid duplicates for the same source
                                if (!aggregatedHolidays.get(dateStr)?.some(h => h.name === holiday.name && h.countryCode === sourceCountryCode)) {
                                    aggregatedHolidays.get(dateStr)?.push({
                                        date: dateStr,
                                        name: holiday.name,
                                        color: sourceColor,
                                        countryCode: sourceCountryCode
                                    });
                                }
                            }
                        }
                    });
                }
            } catch (err) {
                console.error(`[HolidayStorage] Error reading frontmatter from ${filePath}:`, err);
            }
        }
        return aggregatedHolidays;
    }
}