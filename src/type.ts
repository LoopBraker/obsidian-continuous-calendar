// src/types.ts
export interface Holiday {
  date: string; // YYYY-MM-DD
  name: string;
  color?: string;
}

// New type for defining tag-based appearance
interface TagAppearance {
  color: string;
}

export interface MyCalendarPluginSettings {
  year: number;
  defaultDotColor: string;
  defaultBarColor: string;
  shouldConfirmBeforeCreate: boolean;
  shouldConfirmBeforeCreateRange: boolean;
  birthdayFolder: string;
  defaultBirthdaySymbol: string;
  defaultBirthdayColor: string;
  holidayStorageFolder: string;
  holidaySources: HolidaySource[];
  tagAppearance: Record<string, TagAppearance>; // New setting
}

export interface CountryHolidaySource {
  type: "country";
  countryCode: string;
  color?: string;
}

export interface CustomHolidaySource {
  type: "custom";
  name: string;
}

export type HolidaySource = CountryHolidaySource | CustomHolidaySource;

export interface HolidayFileFrontMatter {
  holidaySourceType: "country" | "custom";
  countryCode?: string;
  customName?: string;
  year: number;
  holidays: Holiday[];
  lastFetched?: string;
}
