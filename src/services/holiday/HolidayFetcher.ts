import { Notice } from 'obsidian';
import { Holiday } from './HolidayTypes';

export class HolidayFetcher {
    // Cache to hold date-holidays instances keyed by country (or generic)
    private hdCache = new Map<string, any>();

    constructor() { }

    /**
     * Lazy loads the date-holidays library and specific country instances
     */
    private async getDateHolidaysInstance(countryCode?: string): Promise<any | null> {
        const cacheKey = countryCode ? countryCode.toUpperCase() : '__generic__';

        if (this.hdCache.has(cacheKey)) {
            return this.hdCache.get(cacheKey);
        }

        try {
            // Dynamic require to prevent load issues if library is missing
            const Holidays = require('date-holidays');
            const instance = countryCode ? new Holidays(countryCode) : new Holidays();
            console.log(`[HolidayFetcher] date-holidays instance created${countryCode ? ` for ${countryCode}` : ''}`);
            this.hdCache.set(cacheKey, instance);
            return instance;
        } catch (err) {
            console.error(`[HolidayFetcher] Failed to load 'date-holidays' library${countryCode ? ` for ${countryCode}` : ''}`, err);
            new Notice("Failed to load holiday library. Holiday features disabled.");
            return null;
        }
    }

    async getAvailableCountries(): Promise<{ code: string; name: string }[]> {
        const hd = await this.getDateHolidaysInstance();
        if (!hd) return [];
        try {
            const countries = hd.getCountries();
            return Object.entries(countries).map(([code, name]) => ({ code, name: name as string }));
        } catch (err) {
            console.error("[HolidayFetcher] Error getting country list:", err);
            return [];
        }
    }

    async fetchCountryHolidays(countryCode: string, year: number): Promise<Holiday[]> {
        console.log(`[HolidayFetcher] Fetching holidays for ${countryCode}, ${year}`);
        const hd = await this.getDateHolidaysInstance(countryCode);
        if (!hd) {
            console.warn(`[HolidayFetcher] Cannot fetch holidays: instance not available for ${countryCode}`);
            return [];
        }

        try {
            const rawHolidays = hd.getHolidays(year);
            // console.log(`[HolidayFetcher] Raw holidays received:`, rawHolidays);

            if (!rawHolidays || !Array.isArray(rawHolidays)) {
                console.warn(`[HolidayFetcher] Invalid holidays data for ${countryCode}, ${year}`);
                return [];
            }

            const mappedHolidays = rawHolidays.map((h: any) => {
                if (!h || !h.date || !h.name) {
                    console.warn("[HolidayFetcher] Skipping invalid holiday:", h);
                    return null;
                }
                const dateMoment = window.moment(h.date);
                if (!dateMoment.isValid()) {
                    console.warn(`[HolidayFetcher] Invalid date for ${h.name}: ${h.date}`);
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
            return filteredHolidays;
        } catch (err: any) {
            console.error(`[HolidayFetcher] Error fetching holidays for ${countryCode}, ${year}:`, err);
            return [];
        }
    }
}