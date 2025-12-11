export interface Holiday {
    date: string; // YYYY-MM-DD format
    name: string;
    color?: string; // CSS color value
    countryCode?: string; // Country code for display (e.g., "US", "CO")
}

export interface CountryHolidaySource {
    type: 'country';
    countryCode: string;
    color?: string; // CSS color for this country's holidays
}

export interface CustomHolidaySource {
    type: 'custom';
    name: string;
}

export type HolidaySource = CountryHolidaySource | CustomHolidaySource;

export interface HolidayFileFrontMatter {
    holidaySourceType: 'country' | 'custom';
    countryCode?: string;
    customName?: string;
    year: number;
    holidays: Holiday[];
    lastFetched?: string; // ISO date string for country sources
}