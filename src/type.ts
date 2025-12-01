// src/types.ts
export interface Holiday {
  date: string; // YYYY-MM-DD
  name: string;
  color?: string;
}

export interface TagAppearance {
  color: string; // existing
  symbol?: string; // NEW – optional
}

export interface CustomDateSource {
  key: string; // YAML property name
  symbol: string;
  color: string;
  isRecurring: boolean; // true for MM-DD, false for YYYY-MM-DD
}

export interface MyCalendarPluginSettings {
  year: number;
  defaultDailyNoteSymbol: string;
  defaultDotColor: string;
  defaultBarColor: string;
  shouldConfirmBeforeCreate: boolean;
  shouldConfirmBeforeCreateRange: boolean; // Optional, for future use
  holidaySources: HolidaySource[];
  tagAppearance: Record<string, TagAppearance>;
  customDateSources: CustomDateSource[]; // NEW

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
