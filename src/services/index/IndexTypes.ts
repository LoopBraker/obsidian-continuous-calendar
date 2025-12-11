import { Holiday } from '../holiday/HolidayTypes';

export interface DateMetadata {
    hasProperty: boolean; // Has "date" in frontmatter (The Dot)
    isDailyNote: boolean; // Filename is YYYY-MM-DD (The Underline)
    tags: string[];
}

export interface RangeNote {
    path: string;
    name: string;
    dateStart: string; // YYYY-MM-DD
    dateEnd: string;   // YYYY-MM-DD
    color?: string;
    tags: string[];
    // to add compatabilty with taskNotes plugin
    scheduled?: string;
    timeEstimate?: string;
}

export interface TaskNote {
    path: string;
    name: string;
    color?: string;
    tags: string[];
    status: string;
    priority: string;
    scheduled?: string;
    projects?: string[];
    timeEstimate?: string;
    due?: string;
    complete_instances?: string[];
    completedDate?: string;
    isRecurring?: boolean;
}

// This is a new interface to standardize how we pass note data 
// between the Managers and the IndexService
export interface NoteData {
    path: string;
    name: string;
    color?: string;
    tags: string[];
    symbol?: string;
    isRecurring?: boolean;
}


// Re-export Holiday so it can be used easily if needed
export type { Holiday };