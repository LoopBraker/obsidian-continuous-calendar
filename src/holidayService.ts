// src/holidayService.ts
import { Notice, moment } from 'obsidian';
import { Holiday } from './types';

export class HolidayService {
    private hd: any = null; // To hold the date-holidays library instance

    constructor() {
        this.initialize();
    }

    private async initialize() {
        try {
            // This is how we dynamically import an external library in Obsidian plugins
            this.hd = require('date-holidays');
        } catch (err) {
            console.error("Failed to load 'date-holidays' library. Holiday feature will be disabled.", err);
            new Notice("Holiday library not found. Please install it or check for errors.");
            this.hd = null;
        }
    }

    async fetchHolidaysForCountry(countryCode: string, year: number): Promise<Holiday[]> {
        if (!this.hd || !countryCode) {
            return []; // Return empty if library isn't loaded or no country is set
        }

        try {
            const holidaysInstance = new this.hd(countryCode);
            const rawHolidays = holidaysInstance.getHolidays(year);

            if (!rawHolidays || !Array.isArray(rawHolidays)) {
                return [];
            }
            
            // Map the library's format to our internal Holiday type
            const mappedHolidays = rawHolidays.map((h: any): Holiday | null => {
                if (!h || !h.date || !h.name) return null;

                const dateMoment = moment(h.date);
                if (!dateMoment.isValid()) return null;

                return {
                    date: dateMoment.format('YYYY-MM-DD'),
                    name: h.name,
                };
            }).filter((h): h is Holiday => h !== null);

            return mappedHolidays;

        } catch (err: any) {
            console.error(`Error fetching holidays for ${countryCode}:`, err);
            // new Notice(`Could not fetch holidays for country: ${countryCode}. Is the code valid?`);
            return [];
        }
    }
}