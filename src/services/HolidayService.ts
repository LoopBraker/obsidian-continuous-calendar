import { App, TFile, Notice } from 'obsidian';
import type ContinuousCalendarPlugin from '../main';
import { Holiday, HolidaySource, CountryHolidaySource } from './holiday/HolidayTypes';
import { HolidayFetcher } from './holiday/HolidayFetcher';
import { HolidayStorage } from './holiday/HolidayStorage';

export class HolidayService {
    app: App;
    plugin: ContinuousCalendarPlugin;

    // Sub-Services
    private fetcher: HolidayFetcher;
    private storage: HolidayStorage;

    constructor(app: App, plugin: ContinuousCalendarPlugin) {
        this.app = app;
        this.plugin = plugin;

        // Initialize Composition
        this.fetcher = new HolidayFetcher();
        this.storage = new HolidayStorage(app, plugin);
    }

    // =================================================================================
    // PUBLIC API (Facade Methods)
    // =================================================================================

    async getAvailableCountries(): Promise<{ code: string; name: string }[]> {
        return this.fetcher.getAvailableCountries();
    }

    // Used by Settings Tab to generate IDs for logic
    getHolidaySourceId(source: HolidaySource): string {
        return this.storage.getHolidaySourceId(source);
    }

    // Used by Settings Tab to show where files will be
    getHolidayFilePath(year: number, source: HolidaySource): string {
        return this.storage.getHolidayFilePath(year, source);
    }

    // Direct fetch (mostly used internally or for debug)
    async fetchCountryHolidays(countryCode: string, year: number): Promise<Holiday[]> {
        return this.fetcher.fetchCountryHolidays(countryCode, year);
    }

    // Ensures file exists (used when adding a new source in settings)
    async ensureHolidayFileExists(year: number, source: HolidaySource): Promise<TFile | null> {
        return this.storage.ensureHolidayFileExists(year, source);
    }

    // Reads all holidays to display on the calendar
    async getAggregatedHolidays(year: number): Promise<Map<string, Holiday[]>> {
        return this.storage.getAggregatedHolidays(year);
    }

    // =================================================================================
    // ORCHESTRATION (Logic connecting Fetcher and Storage)
    // =================================================================================

    async updateCountryHolidayFile(year: number, source: CountryHolidaySource): Promise<boolean> {
        console.log(`[HolidayService] Updating holidays for ${source.countryCode}, ${year}...`);

        // 1. Fetch data
        const fetchedHolidays = await this.fetcher.fetchCountryHolidays(source.countryCode, year);

        // 2. Save data
        const success = await this.storage.writeHolidaysToFile(year, source, fetchedHolidays);

        if (success) {
            console.log(`[HolidayService] Updated holidays for ${source.countryCode}`);
            if (fetchedHolidays.length > 0) {
                new Notice(`Updated ${source.countryCode} holidays for ${year}`);
            }
        } else {
            new Notice(`Failed to save updated holidays for ${source.countryCode}`);
        }

        return success;
    }

    async fetchAndUpdateAllCountryFilesForYear(year: number): Promise<void> {
        const countrySources = this.plugin.settings.holidaySources.filter(s => s.type === 'country') as CountryHolidaySource[];

        if (countrySources.length === 0) {
            new Notice("No country holiday sources configured in settings");
            return;
        }

        new Notice(`Starting holiday update for ${countrySources.length} source(s) for ${year}...`);

        let updatedCount = 0;
        let failedCount = 0;

        for (const source of countrySources) {
            const success = await this.updateCountryHolidayFile(year, source);
            if (success) updatedCount++;
            else failedCount++;
        }

        let summaryNotice = `Holiday update for ${year} complete. `;
        if (updatedCount > 0) summaryNotice += `Processed: ${updatedCount}. `;
        if (failedCount > 0) summaryNotice += `Failed: ${failedCount}. `;
        new Notice(summaryNotice);

        // Trigger calendar refresh
        this.refreshCalendar();
    }

    private refreshCalendar() {
        const leaves = this.app.workspace.getLeavesOfType('infinite-calendar-view');
        if (leaves.length > 0) {
            // Force re-index and re-render
            this.plugin.calendarIndex.indexVault();
        }
    }
}