import { App, TFile, moment } from "obsidian";
import MyCalendarPlugin from "./main";
import { TagAppearance } from "./type";

export type IndexedCalendarData = {
    notesByDate: Map<string, any[]>;
    recurringEventsByDate: Map<string, any[]>; // Replaces birthdaysByDate
    allRanges: any[];
};

export class CalendarDataService {
    app: App;
    plugin: MyCalendarPlugin;

    constructor(app: App, plugin: MyCalendarPlugin) {
        this.app = app;
        this.plugin = plugin;
    }

    /**
     * Scans the vault once and indexes all relevant notes by date for fast lookups.
     * This is the primary performance optimization.
     */
    private currentData: IndexedCalendarData = {
        notesByDate: new Map(),
        recurringEventsByDate: new Map(),
        allRanges: [],
    };

    /**
     * Scans the vault once and indexes all relevant notes by date for fast lookups.
     * This is the primary performance optimization.
     */
    async collectAndIndexCalendarData(): Promise<IndexedCalendarData> {
        console.time("CalendarDataService:collectAndIndexCalendarData");
        // Reset data
        this.currentData = {
            notesByDate: new Map(),
            recurringEventsByDate: new Map(),
            allRanges: [],
        };

        const allFiles = this.app.vault.getMarkdownFiles();

        // Index all files
        for (const file of allFiles) {
            this.indexFile(file, this.currentData);
        }

        console.timeEnd("CalendarDataService:collectAndIndexCalendarData");
        return this.currentData;
    }

    /**
     * Updates the index for a single file.
     * Removes old entries for this file and adds new ones if relevant.
     */
    async updateFile(file: TFile): Promise<IndexedCalendarData> {
        // Remove existing entries for this file
        this.removeFileFromIndex(file, this.currentData);

        // Re-index the file
        this.indexFile(file, this.currentData);

        return this.currentData;
    }

    private removeFileFromIndex(file: TFile, data: IndexedCalendarData) {
        const filePath = file.path;

        // Remove from notesByDate
        for (const [date, notes] of data.notesByDate.entries()) {
            const filteredNotes = notes.filter((n) => n.path !== filePath);
            if (filteredNotes.length !== notes.length) {
                if (filteredNotes.length === 0) {
                    data.notesByDate.delete(date);
                } else {
                    data.notesByDate.set(date, filteredNotes);
                }
            }
        }

        // Remove from recurringEventsByDate
        for (const [date, events] of data.recurringEventsByDate.entries()) {
            const filteredEvents = events.filter((b) => b.path !== filePath);
            if (filteredEvents.length !== events.length) {
                if (filteredEvents.length === 0) {
                    data.recurringEventsByDate.delete(date);
                } else {
                    data.recurringEventsByDate.set(date, filteredEvents);
                }
            }
        }

        // Remove from allRanges
        const originalLength = data.allRanges.length;
        data.allRanges = data.allRanges.filter((r) => r.path !== filePath);
    }

    /**
     * Checks if the file's relevant data has changed compared to the current index.
     * Returns true if an update is required, false otherwise.
     */
    checkIfUpdateRequired(file: TFile): boolean {
        const cache = this.app.metadataCache.getFileCache(file);
        // If no cache, but we have data for it, we need to update (to remove it).
        // If no cache and no data, no update needed.
        // But usually cache is null only if file is deleted, which is handled by 'delete' event.
        // If cache exists but no frontmatter, it might have lost its metadata.

        const newEntries = this.generateFileEntries(file, cache);
        const oldEntries = this.getEntriesForFile(file, this.currentData);

        return !this.areEntriesEqual(newEntries, oldEntries);
    }

    private getEntriesForFile(file: TFile, data: IndexedCalendarData) {
        const filePath = file.path;
        const notes: any[] = [];
        const recurringEvents: any[] = [];
        const ranges: any[] = [];

        // Find in notesByDate
        for (const [date, noteList] of data.notesByDate.entries()) {
            const found = noteList.find((n) => n.path === filePath);
            if (found) notes.push(found);
        }

        // Find in recurringEventsByDate
        for (const [date, eventList] of data.recurringEventsByDate.entries()) {
            const found = eventList.find((n) => n.path === filePath);
            if (found) recurringEvents.push(found);
        }

        // Find in allRanges
        const foundRanges = data.allRanges.filter((r) => r.path === filePath);
        ranges.push(...foundRanges);

        return { notes, recurringEvents, ranges };
    }

    private areEntriesEqual(a: any, b: any): boolean {
        // Helper to strip 'file' property which contains circular references (TFile)
        const stripFile = (obj: any): any => {
            if (Array.isArray(obj)) {
                return obj.map(stripFile);
            } else if (obj && typeof obj === 'object') {
                const { file, ...rest } = obj;
                // Recursively strip properties of the remaining object
                const newObj: any = {};
                for (const key in rest) {
                    newObj[key] = stripFile(rest[key]);
                }
                return newObj;
            }
            return obj;
        };

        // Compare the stripped objects
        return JSON.stringify(stripFile(a)) === JSON.stringify(stripFile(b));
    }

    private generateFileEntries(file: TFile, cache: any) {
        const notes: any[] = [];
        const recurringEvents: any[] = [];
        const ranges: any[] = [];

        const fm = cache?.frontmatter;
        if (!fm) return { notes, recurringEvents, ranges };

        const tagAppearanceSettings: Record<string, TagAppearance> =
            this.plugin.settings.tagAppearance;
        const customDateSources = this.plugin.settings.customDateSources || [];

        // --- Collect Base Information ---
        const explicitColor = fm.color ? fm.color.toString() : undefined;
        const explicitSymbol = fm.symbol ? fm.symbol.toString() : undefined;
        let defaultColorFromTag: string | undefined = undefined;
        let defaultSymbolFromTag: string | undefined = undefined;
        let noteTags: string[] = [];

        // --- Process Tags to find defaults (if no explicit color/symbol) ---
        if ((!explicitColor || !explicitSymbol) && fm.tags) {
            let rawTags: any[] = [];
            if (typeof fm.tags === "string") {
                rawTags = fm.tags
                    .split(",")
                    .map((t: string) => t.trim())
                    .filter((t: string) => t);
            } else if (Array.isArray(fm.tags)) {
                rawTags = fm.tags.map((t: any) => String(t).trim()).filter((t: any) => t);
            }
            noteTags = rawTags.map((tag: string) =>
                tag.startsWith("#") ? tag : `#${tag}`
            );

            for (const tag of noteTags) {
                const appearance = tagAppearanceSettings[tag];
                if (appearance) {
                    if (!defaultColorFromTag) defaultColorFromTag = appearance.color;
                    if (!defaultSymbolFromTag && appearance.symbol)
                        defaultSymbolFromTag = appearance.symbol;
                    if (defaultColorFromTag && defaultSymbolFromTag) break; // Optimization: stop if both found
                }
            }
        }

        const baseNoteData = {
            file: file,
            name: file.basename,
            path: file.path,
            color: explicitColor,
            symbol: explicitSymbol,
            defaultColorFromTag: defaultColorFromTag,
            defaultSymbolFromTag: defaultSymbolFromTag,
            tags: noteTags,
        };

        // --- Index Single-Date Notes ---
        if (fm.date) {
            const mDate = moment(fm.date.toString(), "YYYY-MM-DD", true);
            if (mDate.isValid()) {
                const dateStr = mDate.format("YYYY-MM-DD");
                notes.push({ ...baseNoteData, date: dateStr });
            }
        }

        // --- Index Date-Range Notes ---
        if (fm.dateStart && fm.dateEnd) {
            const mStart = moment(fm.dateStart.toString(), "YYYY-MM-DD", true);
            const mEnd = moment(fm.dateEnd.toString(), "YYYY-MM-DD", true);
            if (mStart.isValid() && mEnd.isValid()) {
                ranges.push({
                    ...baseNoteData,
                    dateStart: mStart.format("YYYY-MM-DD"),
                    dateEnd: mEnd.format("YYYY-MM-DD"),
                });
            }
        }

        // --- Index Custom Date Sources ---
        for (const source of customDateSources) {
            if (fm[source.key]) {
                const dateVal = fm[source.key];
                const mDate = moment(dateVal.toString(), "YYYY-MM-DD", true);

                if (mDate.isValid()) {
                    const eventData = {
                        ...baseNoteData,
                        date: mDate.format("YYYY-MM-DD"),
                        sourceLabel: source.key,
                        symbol: source.symbol,
                        color: source.color
                    };

                    if (source.isRecurring) {
                        // For recurring events, we store the full date but index by MM-DD later
                        recurringEvents.push(eventData);
                    } else {
                        // Treat as a regular note event with specific styling
                        // We override the default symbol/color with the source's settings
                        notes.push({
                            ...eventData,
                            symbol: source.symbol, // Override
                            color: source.color    // Override
                        });
                    }
                }
            }
        }

        return { notes, recurringEvents, ranges };
    }

    private indexFile(file: TFile, data: IndexedCalendarData) {
        const cache = this.app.metadataCache.getFileCache(file);
        const { notes, recurringEvents, ranges } = this.generateFileEntries(file, cache);

        // Add to notesByDate
        for (const note of notes) {
            if (!data.notesByDate.has(note.date)) {
                data.notesByDate.set(note.date, []);
            }
            data.notesByDate.get(note.date)?.push(note);
        }

        // Add to allRanges
        data.allRanges.push(...ranges);

        // Add to recurringEventsByDate
        for (const event of recurringEvents) {
            // Extract month-day from the full date string we stored
            const mDate = moment(event.date, "YYYY-MM-DD", true);
            if (mDate.isValid()) {
                const monthDayStr = mDate.format("MM-DD");
                if (!data.recurringEventsByDate.has(monthDayStr)) {
                    data.recurringEventsByDate.set(monthDayStr, []);
                }
                data.recurringEventsByDate.get(monthDayStr)?.push(event);
            }
        }
    }

    /**
     * Checks if a file is relevant to the calendar (has dates, birthdays, or specific tags).
     * Used to filter updates.
     */
    isFileRelevant(file: TFile): boolean {
        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache) return false;

        const fm = cache.frontmatter;
        if (!fm) return false;

        // Check for direct date properties
        if (fm.date || fm.dateStart || fm.dateEnd) {
            return true;
        }

        // Check for custom date sources
        const customDateSources = this.plugin.settings.customDateSources || [];
        for (const source of customDateSources) {
            if (fm[source.key]) return true;
        }

        // Check for tags that have appearance settings
        if (fm.tags) {
            let rawTags: string[] = [];
            if (typeof fm.tags === "string") {
                rawTags = fm.tags
                    .split(",")
                    .map((t: string) => t.trim())
                    .filter((t: string) => t);
            } else if (Array.isArray(fm.tags)) {
                rawTags = fm.tags.map((t: any) => String(t).trim()).filter((t: any) => t);
            }

            const tagAppearanceSettings = this.plugin.settings.tagAppearance;
            for (const tag of rawTags) {
                const normalizedTag = tag.startsWith("#") ? tag : `#${tag}`;
                if (tagAppearanceSettings[normalizedTag]) {
                    return true;
                }
            }
        }

        return false;
    }
}
