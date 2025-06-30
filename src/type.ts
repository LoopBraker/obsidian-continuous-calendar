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
    defaultBirthdayColor: string;
    holidayCountry: string; // e.g., 'US', 'DE', 'GB'
  }