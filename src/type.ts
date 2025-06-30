// src/types.ts
export interface Holiday {
  date: string; // YYYY-MM-DD
  name: string;
}

interface TagAppearance {
  color: string; // existing
  symbol?: string; // NEW – optional
}

export interface MyCalendarPluginSettings {
  year: number;
  defaultBirthdayColor: string;
  defaultBirthdaySymbol: string;
  defaultDailyNoteSymbol: string;
  defaultDotColor: string;
  defaultBarColor: string;
  birthdayFolder: string;
  shouldConfirmBeforeCreate: boolean;
  shouldConfirmBeforeCreateRange: boolean; // Optional, for future use
  holidaySources: HolidaySource[];
  tagAppearance: Record<string, TagAppearance>;

  focusedMonths: number[];
  opaqueMonths: number[];
  collapseDuplicateTagSymbols: boolean;
}

export interface CountryHolidaySource {
  type: "country";
  countryCode: string; // e.g., 'CO', 'US', 'DE'
  color?: string;
}

export interface CustomHolidaySource {
  type: "custom";
  name: string; // e.g., "Family Birthdays", "Project Deadlines"
}

export type HolidaySource = CountryHolidaySource | CustomHolidaySource;

export interface HolidayFileFrontMatter {
  holidaySourceType: "country" | "custom";
  countryCode?: string; // Only for country type
  customName?: string; // Only for custom type
  year: number;
  holidays: Holiday[];
  lastFetched?: string; // ISO timestamp, for country files to know when updated
}
