// src/types.ts
export interface Holiday {
    date: string; // YYYY-MM-DD
    name: string;
  }
  
  export interface MyCalendarPluginSettings {
    year: number;
    defaultDotColor: string;
    defaultBarColor: string;
    shouldConfirmBeforeCreate: boolean;
    birthdayFolder: string;
    defaultBirthdaySymbol: string;
    defaultBirthdayColor:string;
    holidayCountry: string;
    holidayStorageFolder: string; // New setting
  }
  
  // New type for the holiday file's frontmatter
  export interface HolidayFileFrontMatter {
    countryCode: string;
    year: number;
    holidays: Holiday[];
    lastFetched?: string; // ISO timestamp
  }