import { App, TFile } from 'obsidian';
import { format } from 'date-fns';
import { Holiday } from './holiday/HolidayTypes';
import { CalendarPluginSettings } from '../settings/settings';
import { DateMetadata, RangeNote, NoteData } from './index/IndexTypes';
import { NoteManager } from './index/NoteManager';
import { RangeManager } from './index/RangeManager';
import { RecurrenceManager } from './index/RecurrenceManager';
import { TaskManager } from './index/TaskManager';
import { TaskNote } from './index/IndexTypes';

// Re-export types so external consumers don't break if they imported from here
export type { DateMetadata, RangeNote, TaskNote };

export class IndexService {
    app: App;
    settings: CalendarPluginSettings;

    // Sub-Managers
    private noteManager: NoteManager;
    private rangeManager: RangeManager;
    private recurrenceManager: RecurrenceManager;
    private taskManager: TaskManager;

    // Holiday tracking (Year -> Date -> Holiday[])
    holidays: Map<number, Map<string, Holiday[]>> = new Map();

    // Observer pattern
    listeners: Array<(changedDates: string[] | null) => void> = [];

    constructor(app: App) {
        this.app = app;
        this.noteManager = new NoteManager();
        this.rangeManager = new RangeManager();
        this.recurrenceManager = new RecurrenceManager();
        this.taskManager = new TaskManager();
    }

    // =================================================================================
    // PUBLIC ACCESSORS (BACKWARD COMPATIBILITY)
    // =================================================================================

    // External code accessing `indexService.data` will now get the data from NoteManager
    get data() { return this.noteManager.data; }
    get notesByDate() { return this.noteManager.notesByDate; }
    get fileToDates() { return this.noteManager.fileToDates; }

    get allRanges() { return this.rangeManager.allRanges; }
    set allRanges(val: RangeNote[]) { this.rangeManager.allRanges = val; }
    get rangesByDate() { return this.rangeManager.rangesByDate; }
    get rangeSlotsByDate() { return this.rangeManager.rangeSlotsByDate; }
    get rangeEmergenceByPath() { return this.rangeManager.rangeEmergenceByPath; }

    get recurringNotes() { return this.recurrenceManager.recurringNotes; }
    get fileToRecurringDates() { return this.recurrenceManager.fileToRecurringDates; }
    get fileToRRule() { return this.recurrenceManager.fileToRRule; }
    get recurringEventsCache() { return this.recurrenceManager.recurringEventsCache; }
    get cachedYears() { return this.recurrenceManager.cachedYears; }
    get fileToGeneratedDates() { return this.recurrenceManager.fileToGeneratedDates; }

    // =================================================================================
    // PUBLIC API
    // =================================================================================

    setSettings(settings: CalendarPluginSettings) {
        this.settings = settings;
    }

    subscribe(callback: (changedDates: string[] | null) => void) {
        this.listeners.push(callback);
        return () => {
            this.listeners = this.listeners.filter(l => l !== callback);
        };
    }

    // =================================================================================
    // DATA ACCESS
    // =================================================================================

    getDateStatus(dateStr: string): DateMetadata {
        const meta = this.noteManager.getDateStatus(dateStr);

        // Check recurring in RecurrenceManager
        const recurringNotes = this.recurrenceManager.getNotesForDate(dateStr);
        if (recurringNotes.length > 0) {
            return { ...meta, hasProperty: true };
        }

        return meta;
    }

    getRangesForDate(dateStr: string): RangeNote[] {
        return this.rangesByDate.get(dateStr) || [];
    }

    getRangeSlots(dateStr: string): Map<string, number> {
        return this.rangeSlotsByDate.get(dateStr) || new Map();
    }

    isRangeEmergence(rangePath: string, dateStr: string): boolean {
        return this.rangeEmergenceByPath.get(rangePath) === dateStr;
    }

    getNotesForDate(dateStr: string): Array<NoteData> {
        const specificNotes = this.noteManager.getNotesForDate(dateStr);
        const recurringNotes = this.recurrenceManager.getNotesForDate(dateStr);

        // Filter rrule events if they overlap with specific notes (same path)
        const uniqueRecurring = recurringNotes.filter(r => !specificNotes.some(s => s.path === r.path));

        let results = [...specificNotes, ...uniqueRecurring];

        // --- Task Properties Dots ---
        if (this.settings && this.settings.taskSettings) {
            const taskSettings = this.settings.taskSettings;
            const tasks = this.taskManager.getTasksForDate(dateStr);
            // console.log(`DEBUG: Retrieving tasks for ${dateStr}. Found: ${tasks.length}`, tasks);

            tasks.forEach(task => {
                const isOpen = task.status === 'open' || task.status === 'todo';

                // 1. Scheduled (Open only)
                if (isOpen && task.scheduled === dateStr && taskSettings.scheduled) {
                    // console.log(`DEBUG: Adding Scheduled Dot for ${task.name} on ${dateStr}`, taskSettings.scheduled);
                    results.push({
                        path: task.path,
                        name: task.name,
                        color: taskSettings.scheduled.color,
                        symbol: taskSettings.scheduled.symbol,
                        tags: [] // Force empty to avoid tag-based icon override
                    });
                }

                // 2. Due (Open only)
                if (isOpen && task.due === dateStr && taskSettings.due) {
                    results.push({
                        path: task.path,
                        name: task.name,
                        color: taskSettings.due.color,
                        symbol: taskSettings.due.symbol,
                        tags: [] // Force empty to avoid tag-based icon override
                    });
                }

                // 3. Completed (Always)
                let isCompletedToday = false;
                if (task.completedDate === dateStr) isCompletedToday = true;
                if (!isCompletedToday && task.complete_instances && Array.isArray(task.complete_instances)) {
                    if (task.complete_instances.includes(dateStr)) isCompletedToday = true;
                }

                if (isCompletedToday && taskSettings.completed) {
                    // console.log(`DEBUG: Adding Completed Dot for ${task.name} on ${dateStr}`, taskSettings.completed);
                    results.push({
                        path: task.path,
                        name: task.name,
                        color: taskSettings.completed.color,
                        symbol: taskSettings.completed.symbol,
                        tags: [] // Force empty to avoid tag-based icon override
                    });
                }
            });
        } else {
            console.warn('DEBUG: taskSettings is missing in settings!', this.settings);
        }

        return results;
    }

    getTasksForDate(dateStr: string): TaskNote[] {
        return this.taskManager.getTasksForDate(dateStr);
    }

    getHolidaysForDate(dateStr: string): Holiday[] {
        const parts = dateStr.split('-'); // YYYY-MM-DD
        if (parts.length !== 3) return [];
        const year = parseInt(parts[0], 10);

        const yearHolidays = this.holidays.get(year);
        if (!yearHolidays) return [];

        return yearHolidays.get(dateStr) || [];
    }

    getDisplaySymbols(dateStr: string, tagSettings: any, defaultDotColor: string, collapseDuplicates: boolean = false, maxCount: number = 5, useDotsOnlyForTags: boolean = false, useDotsOnlyForProperties: boolean = false): Array<{ symbol?: string, color?: string }> {
        // Presentation logic remains here as it acts as a View Model
        const notes = this.getNotesForDate(dateStr);

        interface NoteDisplay {
            symbol?: string;
            color?: string;
            hasSymbol: boolean;
        }

        let noteDisplays: NoteDisplay[] = notes.map(note => {
            let symbol: string | undefined;
            let color: string | undefined;
            let isTagSymbol = false;
            let isPropertySymbol = false;

            if (note.tags && note.tags.length > 0 && tagSettings) {
                for (const tag of note.tags) {
                    if (tagSettings[tag] && tagSettings[tag].symbol) {
                        symbol = tagSettings[tag].symbol;
                        color = note.color || tagSettings[tag].color || 'var(--text-muted)';
                        isTagSymbol = true;
                        break;
                    }
                }
            }

            if (!symbol && note.symbol) {
                symbol = note.symbol;
                isPropertySymbol = true;
            }

            // Only use property symbol if NO tag symbol was found
            // if (!isTagSymbol && note.symbol) {
            //     symbol = note.symbol;
            //     isPropertySymbol = true;
            // }

            if (isTagSymbol && useDotsOnlyForTags) {
                symbol = undefined;
            }
            if (isPropertySymbol && useDotsOnlyForProperties) {
                symbol = undefined;
            }

            return {
                symbol: symbol,
                color: color || note.color || defaultDotColor,
                hasSymbol: !!symbol
            };
        });

        if (collapseDuplicates) {
            const seenSymbols = new Set<string>();
            noteDisplays = noteDisplays.filter(d => {
                if (!d.hasSymbol) return true;
                if (d.symbol && seenSymbols.has(d.symbol)) return false;
                if (d.symbol) seenSymbols.add(d.symbol);
                return true;
            });
        }

        noteDisplays.sort((a, b) => {
            if (a.hasSymbol && !b.hasSymbol) return -1;
            if (!a.hasSymbol && b.hasSymbol) return 1;
            return 0;
        });

        return noteDisplays.slice(0, maxCount).map(({ symbol, color }) => ({ symbol, color }));
    }

    // =================================================================================
    // INDEXING
    // =================================================================================

    indexVault() {
        this.clear();
        const files = this.app.vault.getMarkdownFiles();
        files.forEach((file) => this.indexFile(file));
        this.assignRangeSlots();
        this.notifyListeners(null);
    }

    indexFile(file: TFile) {
        const wasRecurring = this.fileToRecurringDates.has(file.path);
        const affectedDates = this.cleanupFile(file.path);

        const isDailyNote = /^\d{4}-\d{2}-\d{2}$/.test(file.basename);
        let dateFromFilename = isDailyNote ? file.basename : null;

        if (isDailyNote && dateFromFilename) {
            this.noteManager.updateDateMetadata(dateFromFilename, { isDailyNote: true });
        }

        const metadata = this.app.metadataCache.getFileCache(file);
        const frontmatter = metadata?.frontmatter;

        const dateProp = frontmatter?.['date'];
        const recurrenceProp = frontmatter?.['recurrence'];
        const dateStartProp = frontmatter?.['dateStart'];
        const dateEndProp = frontmatter?.['dateEnd'];
        const scheduledProp = frontmatter?.['scheduled'];
        const timeEstimateProp = frontmatter?.['timeEstimate'];
        const tags = this.extractTags(frontmatter);

        // Process Date Properties (Delegate to NoteManager or RecurrenceManager)
        if (dateProp) {
            this.processDateProperty(file, dateProp, tags, frontmatter?.['color'], undefined, false);
        }

        let recurringChanged = false;
        if (this.settings && this.settings.customDateProperties) {
            for (const prop of this.settings.customDateProperties) {
                const customVal = frontmatter?.[prop.name];
                if (customVal) {
                    const isRec = prop.isRecurring;
                    this.processDateProperty(file, customVal, tags, frontmatter?.['color'] || prop.color, prop.symbol, isRec);
                    if (isRec) recurringChanged = true;
                }
            }
        }

        // Process Recurrence (Delegate to RecurrenceManager)
        if (recurrenceProp && typeof recurrenceProp === 'string') {
            this.recurrenceManager.addRRule(file, recurrenceProp, this.settings, frontmatter, tags);
            recurringChanged = true;
        }

        // Process Ranges (Delegate to RangeManager)
        // Check for explicit start/end or schedule/timeEstimate
        // Process Ranges (Delegate to RangeManager)
        // Check for explicit start/end or schedule/timeEstimate
        const hasRangeDates = dateStartProp && dateEndProp;
        const isDone = frontmatter?.['status'] === 'done';
        const hasScheduled = scheduledProp && timeEstimateProp && !isDone;

        if (hasRangeDates || hasScheduled) {
            const rangeNote: RangeNote = {
                path: file.path,
                name: file.basename,
                dateStart: hasRangeDates ? this.normalizeDate(dateStartProp) : '', // Will be calculated if empty
                dateEnd: hasRangeDates ? this.normalizeDate(dateEndProp) : '',   // Will be calculated if empty
                color: frontmatter?.['color'],
                tags: tags,
                scheduled: hasScheduled ? this.normalizeDate(scheduledProp) : undefined,
                timeEstimate: hasScheduled ? timeEstimateProp : undefined
            };
            this.rangeManager.addRange(rangeNote);
        }

        // Process Tasks (Delegate to TaskManager)
        if (tags.some(t => t.toLowerCase() === '#task')) {
            const taskNote: TaskNote = {
                path: file.path,
                name: file.basename,
                color: frontmatter?.['color'],
                tags: tags,
                status: frontmatter?.['status'] || 'todo',
                priority: frontmatter?.['priority'],
                scheduled: scheduledProp ? this.normalizeDate(scheduledProp) : undefined,
                due: frontmatter?.['due'] ? this.normalizeDate(frontmatter['due']) : undefined,
                timeEstimate: timeEstimateProp,
                projects: (frontmatter && Array.isArray(frontmatter['projects'])) ? frontmatter['projects'] : [],
                complete_instances: frontmatter?.['complete_instances'],
                completedDate: frontmatter?.['completedDate'],
                isRecurring: !!recurrenceProp
            };
            this.taskManager.addTask(taskNote);
        }

        // Collect changed dates for notification
        const changedDates = Array.from(new Set([...affectedDates]));
        if (dateFromFilename) changedDates.push(dateFromFilename);

        // Note: we can't easily get exactly which dates were just added to noteManager inside this method without changing signature,
        // so we rely on invalidating listeners either fully or with what we know.
        // For strict "don't change logic", we might need to peek into noteManager, but usually listeners handle re-render.

        if ((hasRangeDates || hasScheduled) || recurringChanged || wasRecurring) {
            if (hasRangeDates || hasScheduled) this.assignRangeSlots();
            this.notifyListeners(null);
        } else if (changedDates.length > 0) {
            // Append currently known dates for this file
            if (this.noteManager.fileToDates.has(file.path)) {
                this.noteManager.fileToDates.get(file.path)!.forEach(d => changedDates.push(d));
            }
            this.notifyListeners(changedDates);
        }
    }

    removeFile(path: string) {
        const wasRecurring = this.fileToRecurringDates.has(path);
        const affectedDates = this.cleanupFile(path);

        if (wasRecurring) {
            this.notifyListeners(null);
        } else if (affectedDates.length > 0) {
            this.notifyListeners(affectedDates);
        }
    }

    renameFile(file: TFile, oldPath: string) {
        this.removeFile(oldPath);
        this.indexFile(file);
        setTimeout(() => this.indexFile(file), 200);
    }

    // =================================================================================
    // CLEANUP
    // =================================================================================

    clearIndexedFiles() {
        this.noteManager.clear();
        this.rangeManager.clear();
        this.recurrenceManager.clear();
        this.taskManager.clear();
    }

    clear() {
        this.noteManager.clear();
        this.rangeManager.clear();
        this.recurrenceManager.clear();
        this.taskManager.clear();
        this.holidays.clear();
    }

    private cleanupFile(path: string): string[] {
        // Cleanup Note Manager
        const affectedDates = this.noteManager.cleanupFile(path);

        // Cleanup Recurrence Manager
        const recChanged = this.recurrenceManager.cleanupFile(path);

        // Cleanup Range Manager
        const rangeChanged = this.rangeManager.removeRange(path);

        // Cleanup Task Manager
        this.taskManager.removeTasksForFile(path);

        if (rangeChanged) {
            this.assignRangeSlots();
            this.notifyListeners(null); // Range changes affect layout globally usually
        }

        return affectedDates;
    }

    // =================================================================================
    // RECURRENCE
    // =================================================================================

    ensureYearCached(year: number) {
        const changed = this.recurrenceManager.ensureYearCached(year, this.app, this.settings);
        if (changed) {
            this.notifyListeners(null);
        }
    }

    // =================================================================================
    // RANGES
    // =================================================================================

    public assignRangeSlots() {
        this.rangeManager.assignRangeSlots();
    }

    // =================================================================================
    // HOLIDAYS
    // =================================================================================

    setHolidaysForYear(year: number, holidayMap: Map<string, Holiday[]>) {
        this.holidays.set(year, holidayMap);
        this.notifyListeners(null);
    }

    // =================================================================================
    // HELPERS
    // =================================================================================

    notifyListeners(changedDates: string[] | null) {
        this.listeners.forEach(l => l(changedDates));
    }

    private normalizeDate(dateValue: any): string {
        if (dateValue instanceof Date) {
            return format(dateValue, 'yyyy-MM-dd');
        } else if (typeof dateValue === 'string') {
            return dateValue.split('T')[0];
        }
        return '';
    }

    private extractTags(frontmatter: any): string[] {
        if (!frontmatter) return [];
        let tags: string[] = [];
        if (Array.isArray(frontmatter.tags)) {
            tags = frontmatter.tags.map((t: any) => String(t));
        } else if (typeof frontmatter.tags === 'string') {
            tags = frontmatter.tags.split(',').map((t: string) => t.trim());
        } else if (Array.isArray(frontmatter.tag)) {
            tags = frontmatter.tag.map((t: any) => String(t));
        } else if (typeof frontmatter.tag === 'string') {
            tags = frontmatter.tag.split(',').map((t: string) => t.trim());
        }
        return tags.filter(t => t).map(t => t.startsWith('#') ? t : `#${t}`);
    }

    private processDateProperty(file: TFile, dateVal: any, tags: string[], color: string | undefined, symbol: string | undefined, isRecurring: boolean = false) {
        let dateStr = null;
        if (dateVal instanceof Date) {
            dateStr = format(dateVal, 'yyyy-MM-dd');
        } else if (typeof dateVal === 'string') {
            dateStr = dateVal.split('T')[0];
        }

        if (dateStr) {
            const noteData: NoteData = {
                path: file.path,
                name: file.basename,
                color: color,
                tags: tags,
                symbol: symbol
            };

            if (isRecurring) {
                this.recurrenceManager.addLegacyRecurrence(dateStr, noteData);
            } else {
                this.noteManager.addNote(dateStr, noteData);
            }
        }
    }
}