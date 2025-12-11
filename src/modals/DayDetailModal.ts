import { App, Modal } from 'obsidian';
import { format, differenceInDays } from 'date-fns';
import { type RangeNote, IndexService } from '../services/IndexService';
import { type Holiday } from '../services/holiday/HolidayTypes';

interface DayInfo {
    dateKey: string;
    notes: Array<{ path: string; name: string; color?: string }>;
    ranges: RangeNote[];
    holidays: Holiday[];
}

export class DayDetailModal extends Modal {
    dateKey: string;
    index: IndexService;
    unsubscribe: (() => void) | null = null;

    constructor(app: App, dateKey: string, index: IndexService) {
        super(app);
        this.dateKey = dateKey;
        this.index = index;
    }

    onOpen() {
        this.display();

        // Subscribe to changes
        this.unsubscribe = this.index.subscribe((changedDates: string[] | null) => {
            if (changedDates === null || changedDates.includes(this.dateKey)) {
                this.display();
            }
        });
    }

    display() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('day-detail-modal');

        // Fetch latest data from index
        const notes = this.index.getNotesForDate(this.dateKey);
        const ranges = this.index.getRangesForDate(this.dateKey);
        const holidays = this.index.getHolidaysForDate(this.dateKey);

        // Parse date and calculate relative time
        const [year, month, day] = this.dateKey.split('-').map(Number);
        const targetDate = new Date(year, month - 1, day); // month is 0-indexed

        const today = new Date();
        const todayNormalized = new Date(today.getFullYear(), today.getMonth(), today.getDate());

        const daysFromToday = Math.round((targetDate.getTime() - todayNormalized.getTime()) / (1000 * 60 * 60 * 24));

        let relativeText = `${daysFromToday} days from today`;
        if (daysFromToday === 0) relativeText = 'Today';
        else if (daysFromToday === 1) relativeText = 'Tomorrow';
        else if (daysFromToday === -1) relativeText = 'Yesterday';

        // Header
        const header = contentEl.createDiv({ cls: 'day-detail-header' });
        header.createEl('h2', { text: format(targetDate, 'EEEE, MMMM dd, yyyy') });
        header.createEl('p', { text: relativeText, cls: 'day-detail-relative' });

        // Notes section
        if (notes.length > 0) {
            const notesSection = contentEl.createDiv({ cls: 'day-detail-section' });
            notesSection.createEl('h3', { text: 'Events/Notes' });
            const notesList = notesSection.createEl('ul', { cls: 'day-detail-list' });

            notes.forEach((note: { path: string; name: string; color?: string }) => {
                const li = notesList.createEl('li');
                const link = li.createEl('a', {
                    text: note.name,
                    cls: 'internal-link',
                    attr: { href: note.path }
                });

                if (note.color) {
                    link.style.color = note.color;
                }

                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.app.workspace.openLinkText(note.path, '', false);
                    this.close();
                });
            });
        }

        // Range notes section
        if (ranges.length > 0) {
            const rangesSection = contentEl.createDiv({ cls: 'day-detail-section' });
            rangesSection.createEl('h3', { text: 'Ongoing Events' });
            const rangesList = rangesSection.createEl('ul', { cls: 'day-detail-list' });

            ranges.forEach((range: RangeNote) => {
                const li = rangesList.createEl('li');
                const link = li.createEl('a', {
                    text: `${range.name} (${range.dateStart} → ${range.dateEnd})`,
                    cls: 'internal-link',
                    attr: { href: range.path }
                });

                if (range.color) {
                    link.style.color = range.color;
                }

                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.app.workspace.openLinkText(range.path, '', false);
                    this.close();
                });
            });
        }

        // Holidays section
        if (holidays.length > 0) {
            const holidaysSection = contentEl.createDiv({ cls: 'day-detail-section' });
            holidaysSection.createEl('h3', { text: 'Holidays' });
            const holidaysList = holidaysSection.createEl('ul', { cls: 'day-detail-list' });

            holidays.forEach((holiday: Holiday) => {
                const li = holidaysList.createEl('li');
                const text = holiday.countryCode
                    ? `${holiday.name} (${holiday.countryCode})`
                    : holiday.name;
                li.createEl('span', { text: text });

                if (holiday.color) {
                    li.style.color = holiday.color;
                }
            });
        }

        // Empty state
        if (notes.length === 0 && ranges.length === 0 && holidays.length === 0) {
            contentEl.createEl('p', {
                text: 'No events, notes, or holidays for this day.',
                cls: 'day-detail-empty'
            });
        }
    }

    onClose() {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
        const { contentEl } = this;
        contentEl.empty();
    }
}
