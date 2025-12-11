// services/index/NoteManager.ts
import { format } from 'date-fns';
import { DateMetadata, NoteData } from './IndexTypes';

export class NoteManager {
    // Map date string "YYYY-MM-DD" to its metadata
    public data: Map<string, DateMetadata> = new Map();
    // Notes with date property
    public notesByDate: Map<string, NoteData[]> = new Map();
    // Track which dates a file contributes to for efficient cleanup
    public fileToDates: Map<string, Set<string>> = new Map();

    public clear() {
        this.data.clear();
        this.notesByDate.clear();
        this.fileToDates.clear();
    }

    public getDateStatus(dateStr: string): DateMetadata {
        return this.data.get(dateStr) || { hasProperty: false, isDailyNote: false, tags: [] };
    }

    public getNotesForDate(dateStr: string): NoteData[] {
        return this.notesByDate.get(dateStr) || [];
    }

    public addNote(dateStr: string, note: NoteData) {
        // Update Metadata
        this.updateDateMetadata(dateStr, { hasProperty: true, tags: note.tags });

        // Track file association
        if (!this.fileToDates.has(note.path)) {
            this.fileToDates.set(note.path, new Set());
        }
        this.fileToDates.get(note.path)!.add(dateStr);

        // Add to registry
        if (!this.notesByDate.has(dateStr)) {
            this.notesByDate.set(dateStr, []);
        }
        this.notesByDate.get(dateStr)!.push(note);
    }

    public cleanupFile(path: string): string[] {
        const affectedDates: Set<string> = new Set();

        if (this.fileToDates.has(path)) {
            const dates = this.fileToDates.get(path)!;
            dates.forEach(date => {
                affectedDates.add(date);
                if (this.notesByDate.has(date)) {
                    const notes = this.notesByDate.get(date)!;
                    const filtered = notes.filter(n => n.path !== path);
                    if (filtered.length === 0) {
                        this.notesByDate.delete(date);
                    } else {
                        this.notesByDate.set(date, filtered);
                    }
                }
                this.recalculateDateMetadata(date);
            });
            this.fileToDates.delete(path);
        }
        return Array.from(affectedDates);
    }

    public updateDateMetadata(date: string, update: Partial<DateMetadata>) {
        const existing = this.data.get(date) || { hasProperty: false, isDailyNote: false, tags: [] };
        const mergedTags = Array.from(new Set([...(existing.tags || []), ...(update.tags || [])]));
        this.data.set(date, { ...existing, ...update, tags: mergedTags });
    }

    private recalculateDateMetadata(date: string) {
        const currentMeta = this.data.get(date);
        if (!currentMeta) return;

        const notesForDate = this.notesByDate.get(date) || [];
        const hasProperty = notesForDate.length > 0;
        const allTags = new Set<string>();
        notesForDate.forEach(n => n.tags.forEach(t => allTags.add(t)));

        this.data.set(date, {
            hasProperty: hasProperty,
            isDailyNote: currentMeta.isDailyNote,
            tags: Array.from(allTags)
        });

        if (!hasProperty && !currentMeta.isDailyNote) {
            this.data.delete(date);
        }
    }
}