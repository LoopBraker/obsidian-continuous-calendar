// src/types.ts
export interface Holiday {
    date: string; // YYYY-MM-DD
    name: string;
  }
  
  // A specific type for sources that are countries
  export interface CountryHolidaySource {
    type: 'country';
    countryCode: string; // e.g., 'CO', 'US', 'DE'
  }
  
  // A placeholder for future custom sources
  export interface CustomHolidaySource {
    type: 'custom';
    name: string; // e.g., "Family Birthdays", "Project Deadlines"
  }
  
  // A union type to represent any kind of holiday source
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
    holidaySources: HolidaySource[]; // Replaces holidayCountry
  }
  
  // Updated to be more generic, preparing for custom sources
  export interface HolidayFileFrontMatter {
    holidaySourceType: 'country' | 'custom';
    countryCode?: string; // Only for country type
    customName?: string; // Only for custom type
    year: number;
    holidays: Holiday[];
    lastFetched?: string;
  }