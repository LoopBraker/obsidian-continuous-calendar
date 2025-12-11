// services/index/RecurrenceManager.ts
import { RRule } from 'rrule';
import { format } from 'date-fns';
import { TFile } from 'obsidian';
import { NoteData } from './IndexTypes';
import { CalendarPluginSettings } from '../../settings/settings';

export class RecurrenceManager {
    // Legacy Recurring notes (Key: "MM-DD")
    public recurringNotes: Map<string, NoteData[]> = new Map();
    public fileToRecurringDates: Map<string, Set<string>> = new Map();

    // RRule System
    public fileToRRule: Map<string, string> = new Map();
    public recurringEventsCache: Map<string, NoteData[]> = new Map();
    public cachedYears: Set<number> = new Set();
    public fileToGeneratedDates: Map<string, Set<string>> = new Map();

    public clear() {
        this.recurringNotes.clear();
        this.fileToRecurringDates.clear();
        this.fileToRRule.clear();
        this.recurringEventsCache.clear();
        this.fileToGeneratedDates.clear();
        // Don't clear cachedYears to avoid re-calculating unless explicitly requested
    }

    public cleanupFile(path: string): boolean {
        let changed = false;

        // Cleanup Legacy
        if (this.fileToRecurringDates.has(path)) {
            const recurringDates = this.fileToRecurringDates.get(path)!;
            recurringDates.forEach(mmdd => {
                if (this.recurringNotes.has(mmdd)) {
                    const notes = this.recurringNotes.get(mmdd)!;
                    const filtered = notes.filter(n => n.path !== path);
                    if (filtered.length === 0) {
                        this.recurringNotes.delete(mmdd);
                    } else {
                        this.recurringNotes.set(mmdd, filtered);
                    }
                }
            });
            this.fileToRecurringDates.delete(path);
            changed = true;
        }

        // Cleanup RRule
        if (this.fileToRRule.has(path)) {
            this.fileToRRule.delete(path);
        }

        if (this.fileToGeneratedDates.has(path)) {
            const dates = this.fileToGeneratedDates.get(path)!;
            dates.forEach(date => {
                if (this.recurringEventsCache.has(date)) {
                    const events = this.recurringEventsCache.get(date)!;
                    const filtered = events.filter(e => e.path !== path);
                    if (filtered.length === 0) {
                        this.recurringEventsCache.delete(date);
                    } else {
                        this.recurringEventsCache.set(date, filtered);
                    }
                }
            });
            this.fileToGeneratedDates.delete(path);
            changed = true;
        }

        return changed;
    }

    public addLegacyRecurrence(dateStr: string, note: NoteData) {
        // expect dateStr YYYY-MM-DD
        const parts = dateStr.split('-');
        if (parts.length === 3) {
            const mmdd = `${parts[1]}-${parts[2]}`;
            if (!this.recurringNotes.has(mmdd)) {
                this.recurringNotes.set(mmdd, []);
            }
            this.recurringNotes.get(mmdd)!.push(note);

            if (!this.fileToRecurringDates.has(note.path)) {
                this.fileToRecurringDates.set(note.path, new Set());
            }
            this.fileToRecurringDates.get(note.path)!.add(mmdd);
        }
    }

    public addRRule(file: TFile, rruleStr: string, settings: CalendarPluginSettings, frontmatter: any, tags: string[]) {

        // *************************************************************************************************
        // To be compatible with noteTask plugin recurrence format. This strip DTSTART prefix if present
        if (rruleStr.startsWith('DTSTART')) {
            const firstSemicolon = rruleStr.indexOf(';');
            if (firstSemicolon > -1) {
                rruleStr = rruleStr.substring(firstSemicolon + 1);
            }
        }
        // *************************************************************************************************

        this.fileToRRule.set(file.path, rruleStr);

        let primaryDateProp = frontmatter?.['date'];
        let primarySymbol = undefined;
        let primaryColor = undefined;

        if (!primaryDateProp && settings && settings.customDateProperties) {
            for (const prop of settings.customDateProperties) {
                const customVal = frontmatter?.[prop.name];
                if (customVal) {
                    primaryDateProp = customVal;
                    primarySymbol = prop.symbol;
                    primaryColor = prop.color;
                    break;
                }
            }
        }

        if (this.cachedYears.size > 0) {
            const finalColor = frontmatter?.['color'] || primaryColor;
            this.generateEventsForFile(file, rruleStr, tags, finalColor, primaryDateProp, undefined, primarySymbol);
        }
    }

    public ensureYearCached(year: number, app: any, settings: CalendarPluginSettings) {
        const yearsNeeded = [year - 1, year, year + 1];
        let changed = false;

        yearsNeeded.forEach(y => {
            if (!this.cachedYears.has(y)) {
                this.generateRecurringEventsForYear(y, app, settings);
                this.cachedYears.add(y);
                changed = true;
            }
        });
        return changed;
    }

    private generateRecurringEventsForYear(year: number, app: any, settings: CalendarPluginSettings) {
        this.fileToRRule.forEach((rruleStr, path) => {
            const file = app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
                const metadata = app.metadataCache.getFileCache(file);
                const frontmatter = metadata?.frontmatter;
                const tags = this.extractTags(frontmatter);
                const color = frontmatter?.['color'];

                let dateProp = frontmatter?.['date'];
                let symbol = undefined;
                let propColor = undefined;

                if (!dateProp && settings && settings.customDateProperties) {
                    for (const prop of settings.customDateProperties) {
                        const customVal = frontmatter?.[prop.name];
                        if (customVal) {
                            dateProp = customVal;
                            symbol = prop.symbol;
                            propColor = prop.color;
                            break;
                        }
                    }
                }

                const finalColor = color || propColor;
                this.generateEventsForFile(file, rruleStr, tags, finalColor, dateProp, year, symbol);
            }
        });
    }

    private extractTags(frontmatter: any): string[] {
        // Logic duplicated here for self-containment or passed in. 
        // For simplicity in refactor, we assume tags are passed correctly or use a shared helper.
        if (!frontmatter) return [];
        let tags: string[] = [];
        if (Array.isArray(frontmatter.tags)) tags = frontmatter.tags.map((t: any) => String(t));
        else if (typeof frontmatter.tags === 'string') tags = frontmatter.tags.split(',').map((t: string) => t.trim());
        else if (Array.isArray(frontmatter.tag)) tags = frontmatter.tag.map((t: any) => String(t));
        else if (typeof frontmatter.tag === 'string') tags = frontmatter.tag.split(',').map((t: string) => t.trim());
        return tags.filter(t => t).map(t => t.startsWith('#') ? t : `#${t}`);
    }

    private generateEventsForFile(file: TFile, rruleStr: string, tags: string[], color?: string, dateProp?: any, specificYear?: number, symbol?: string) {
        try {
            let rule: RRule;
            if (rruleStr.includes('DTSTART')) {
                rule = RRule.fromString(rruleStr);
            } else {
                let dtStart: Date;
                if (dateProp) {
                    if (dateProp instanceof Date) dtStart = dateProp;
                    else if (typeof dateProp === 'string') {
                        const parts = dateProp.split('T')[0].split('-');
                        if (parts.length === 3) dtStart = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
                        else return;
                    } else return;
                } else return;
                dtStart.setHours(0, 0, 0, 0);
                const options = RRule.parseString(rruleStr);
                options.dtstart = dtStart;
                rule = new RRule(options);
            }

            const yearsToGenerate = specificYear ? [specificYear] : Array.from(this.cachedYears);
            yearsToGenerate.forEach(year => {
                const startOfYear = new Date(year, 0, 1);
                const endOfYear = new Date(year, 11, 31, 23, 59, 59);
                const dates = rule.between(startOfYear, endOfYear, true);
                dates.forEach(date => {
                    const dateStr = format(date, 'yyyy-MM-dd');
                    if (!this.recurringEventsCache.has(dateStr)) {
                        this.recurringEventsCache.set(dateStr, []);
                    }
                    const events = this.recurringEventsCache.get(dateStr)!;
                    if (!events.some(e => e.path === file.path)) {
                        events.push({
                            path: file.path,
                            name: file.basename,
                            color: color,
                            tags: tags,
                            symbol: symbol,
                            isRecurring: true
                        });
                    }
                    if (!this.fileToGeneratedDates.has(file.path)) {
                        this.fileToGeneratedDates.set(file.path, new Set());
                    }
                    this.fileToGeneratedDates.get(file.path)!.add(dateStr);
                });
            });
        } catch (e) {
            console.error(`[RecurrenceManager] Error generating recurrence for ${file.path}:`, e);
        }
    }

    public getNotesForDate(dateStr: string): NoteData[] {
        // Simple Recurrence
        const parts = dateStr.split('-');
        let simple: NoteData[] = [];
        if (parts.length === 3) {
            const mmdd = `${parts[1]}-${parts[2]}`;
            simple = this.recurringNotes.get(mmdd) || [];
        }

        // RRule Recurrence
        const complex = this.recurringEventsCache.get(dateStr) || [];

        return [...simple, ...complex];
    }
}