// src/types.ts
export interface Holiday {
  date: string;
  name: string;
  color?: string;
}
interface TagAppearance {
  color: string;
  symbol?: string;
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
  tagAppearance: Record<string, TagAppearance>;
  collapseDuplicateTagSymbols: boolean; // New setting
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
