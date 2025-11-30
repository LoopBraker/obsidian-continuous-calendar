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
    async collectAndIndexCalendarData(): Promise<IndexedCalendarData> {
        const notesByDate = new Map<string, any[]>();
        const birthdaysByDate = new Map<string, any[]>();
        const allRanges: any[] = [];

        const allFiles = this.app.vault.getMarkdownFiles();
        const birthdayFolder =
            this.plugin.settings.birthdayFolder.toLowerCase() + "/";
        const hasBirthdayFolderSetting =
            this.plugin.settings.birthdayFolder.trim() !== "";
        const tagAppearanceSettings: Record<string, TagAppearance> =
            this.plugin.settings.tagAppearance;

        for (const file of allFiles) {
            const cache = this.app.metadataCache.getFileCache(file);
            const fm = cache?.frontmatter;
            if (!fm) continue;

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
                    if (!notesByDate.has(dateStr)) {
                        notesByDate.set(dateStr, []);
                    }
                    notesByDate.get(dateStr)?.push({ ...baseNoteData, date: dateStr });
                }
            }

            // --- Index Date-Range Notes ---
            if (fm.dateStart && fm.dateEnd) {
                const mStart = moment(fm.dateStart.toString(), "YYYY-MM-DD", true);
                const mEnd = moment(fm.dateEnd.toString(), "YYYY-MM-DD", true);
                if (mStart.isValid() && mEnd.isValid()) {
                    allRanges.push({
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
                    if (!birthdaysByDate.has(monthDayStr)) {
                        birthdaysByDate.set(monthDayStr, []);
                    }
                    birthdaysByDate
                        .get(monthDayStr)
                        ?.push({ ...baseNoteData, birthday: mBday.format("YYYY-MM-DD") });
                }
            }
        }

        return { notesByDate, birthdaysByDate, allRanges };
    }
}
