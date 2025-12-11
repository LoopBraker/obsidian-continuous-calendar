// Settings interface
import { HolidaySource } from '../services/holiday/HolidayTypes';

export interface TagAppearance {
    color?: string;
    symbol?: string;
}

export interface DateProperty {
    name: string;
    color?: string;
    symbol?: string;
    isRecurring?: boolean;
}

export interface CalendarPluginSettings {
    defaultDotColor: string;
    defaultBarColor: string;
    shouldConfirmBeforeCreate: boolean;
    shouldConfirmBeforeCreateRange: boolean;
    tagAppearance: Record<string, TagAppearance>;
    collapseDuplicateTagSymbols: boolean;
    // Dots-only mode for calendar view
    useDotsOnlyForTags: boolean;
    useDotsOnlyForProperties: boolean;
    // Custom Date Properties
    customDateProperties: DateProperty[];
    // Holiday settings
    holidayStorageFolder: string;
    holidaySources: HolidaySource[];
    // Task properties visuals
    taskSettings: {
        scheduled: { symbol?: string; color?: string; };
        due: { symbol?: string; color?: string; };
        completed: { symbol?: string; color?: string; };
    };
}

export const DEFAULT_SETTINGS: CalendarPluginSettings = {
    defaultDotColor: 'var(--color-red-text)',
    defaultBarColor: 'var(--color-blue-text)',
    shouldConfirmBeforeCreate: false,
    shouldConfirmBeforeCreateRange: true,
    tagAppearance: {},
    collapseDuplicateTagSymbols: true,
    // Dots-only mode defaults (false to preserve icons)
    useDotsOnlyForTags: false,
    useDotsOnlyForProperties: false,
    // Custom Date Properties
    customDateProperties: [],
    // Holiday defaults
    holidayStorageFolder: 'Holidays',
    holidaySources: [],
    // Task Defaults
    taskSettings: {
        scheduled: { symbol: '⏳', color: 'var(--color-orange-text)' },
        due: { symbol: '📅', color: 'var(--color-red-text)' },
        completed: { symbol: '✅', color: 'var(--color-green-text)' }
    }
};

