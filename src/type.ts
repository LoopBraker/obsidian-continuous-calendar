// src/types.ts
export interface Holiday {
  date: string; // YYYY-MM-DD
  name: string;
  color?: string; // Add color to the base holiday type for aggregation
}

export interface CountryHolidaySource {
  type: "country";
  countryCode: string;
  color?: string; // New optional property for color
}

export interface CustomHolidaySource {
  type: "custom";
  name: string;
}

export type HolidaySource = CountryHolidaySource | CustomHolidaySource;

export interface MyCalendarPluginSettings {
  year: number;
  defaultDotColor: string;
  defaultBarColor: string;
  shouldConfirmBeforeCreate: boolean;
  birthdayFolder: string;
  defaultBirthdaySymbol: string;
  defaultBirthdayColor: string;
  holidayStorageFolder: string;
  holidaySources: HolidaySource[];
}

export interface HolidayFileFrontMatter {
  holidaySourceType: "country" | "custom";
  countryCode?: string;
  customName?: string;
  year: number;
  holidays: Holiday[]; // The file itself won't store the color
  lastFetched?: string;
}
