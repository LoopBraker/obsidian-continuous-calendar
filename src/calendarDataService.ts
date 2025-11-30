import { App, TFile, moment } from "obsidian";
import MyCalendarPlugin from "./main";
import { TagAppearance } from "./type";

export type IndexedCalendarData = {
    notesByDate: Map<string, any[]>;
    birthdaysByDate: Map<string, any[]>;
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
        birthdaysByDate: new Map(),
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
            birthdaysByDate: new Map(),
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

        // Remove from birthdaysByDate
        for (const [date, birthdays] of data.birthdaysByDate.entries()) {
            const filteredBirthdays = birthdays.filter((b) => b.path !== filePath);
            if (filteredBirthdays.length !== birthdays.length) {
                if (filteredBirthdays.length === 0) {
                    data.birthdaysByDate.delete(date);
                } else {
                    data.birthdaysByDate.set(date, filteredBirthdays);
                }
            }
        }

        // Remove from allRanges
        const originalLength = data.allRanges.length;
        data.allRanges = data.allRanges.filter((r) => r.path !== filePath);
    }

    private indexFile(file: TFile, data: IndexedCalendarData) {
        const cache = this.app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter;
        if (!fm) return;

        const birthdayFolder =
            this.plugin.settings.birthdayFolder.toLowerCase() + "/";
        const hasBirthdayFolderSetting =
            this.plugin.settings.birthdayFolder.trim() !== "";
        const tagAppearanceSettings: Record<string, TagAppearance> =
            this.plugin.settings.tagAppearance;

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
                if (!data.notesByDate.has(dateStr)) {
                    data.notesByDate.set(dateStr, []);
                }
                data.notesByDate.get(dateStr)?.push({ ...baseNoteData, date: dateStr });
            }
        }

        // --- Index Date-Range Notes ---
        if (fm.dateStart && fm.dateEnd) {
            const mStart = moment(fm.dateStart.toString(), "YYYY-MM-DD", true);
            const mEnd = moment(fm.dateEnd.toString(), "YYYY-MM-DD", true);
            if (mStart.isValid() && mEnd.isValid()) {
                data.allRanges.push({
                    ...baseNoteData,
                    dateStart: mStart.format("YYYY-MM-DD"),
                    dateEnd: mEnd.format("YYYY-MM-DD"),
                });
            }
        }

        // --- Index Birthdays ---
        if (
            fm.birthday &&
            (!hasBirthdayFolderSetting ||
                file.path.toLowerCase().startsWith(birthdayFolder))
        ) {
            const mBday = moment(fm.birthday.toString(), "YYYY-MM-DD", true);
            if (mBday.isValid()) {
                const monthDayStr = mBday.format("MM-DD");
                if (!data.birthdaysByDate.has(monthDayStr)) {
                    data.birthdaysByDate.set(monthDayStr, []);
                }
                data.birthdaysByDate
                    .get(monthDayStr)
                    ?.push({ ...baseNoteData, birthday: mBday.format("YYYY-MM-DD") });
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
        if (fm.date || fm.dateStart || fm.dateEnd || fm.birthday) {
            return true;
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
