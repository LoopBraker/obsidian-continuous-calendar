// src/view.ts
import { ItemView, WorkspaceLeaf, moment } from 'obsidian';
import {
	createDailyNote,
	getAllDailyNotes,
	getDailyNote,
} from 'obsidian-daily-notes-interface';

import MyCalendarPlugin from './main';
import { createConfirmationDialog } from './modal';

export const CALENDAR_VIEW_TYPE = 'yearly-calendar-view';

export class CalendarView extends ItemView {
    plugin: MyCalendarPlugin;
    calendarContentEl: HTMLElement; // To register DOM events on

    constructor(leaf: WorkspaceLeaf, plugin: MyCalendarPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return CALENDAR_VIEW_TYPE;
    }

    getDisplayText(): string {
        return `Year Calendar - ${this.plugin.settings.year}`;
    }

    getIcon(): string {
        return 'calendar-days';
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        
        // Create a dedicated content element to attach listeners to
        this.calendarContentEl = container.createDiv({ cls: 'continuous-calendar-content' });
        
        await this.renderCalendar();

        // Register the main click handler
        this.registerDomEvent(this.calendarContentEl, 'click', this.handleClick.bind(this));
    }

    async onClose() {
        // Future cleanup
    }

    async refresh() {
        this.leaf.updateHeader();
        await this.renderCalendar();
    }
    
    async renderCalendar() {
        this.calendarContentEl.empty(); // Clear previous render

        const year = this.plugin.settings.year;
        const today = moment().format("YYYY-MM-DD");

        const allDNs = getAllDailyNotes(); // Get all daily notes once for efficiency

        const allFiles = this.app.vault.getMarkdownFiles();
        let pagesData: any[] = [];
        for (const file of allFiles) {
            const cache = this.app.metadataCache.getFileCache(file);
            const fm = cache?.frontmatter;
            if (!fm) continue;
            // ... (data fetching logic remains the same for now)
            let hasDate = false;
            let validDate: string | null = null;
            let validDateStart: string | null = null;
            let validDateEnd: string | null = null;
            if (fm.date) {
                const mDate = moment(fm.date.toString(), "YYYY-MM-DD", true);
                if (mDate.isValid()) {
                    validDate = mDate.format("YYYY-MM-DD");
                    hasDate = true;
                }
            }
            if (fm.dateStart && fm.dateEnd) {
                const mStart = moment(fm.dateStart.toString(), "YYYY-MM-DD", true);
                const mEnd = moment(fm.dateEnd.toString(), "YYYY-MM-DD", true);
                if (mStart.isValid() && mEnd.isValid()) {
                    validDateStart = mStart.format("YYYY-MM-DD");
                    validDateEnd = mEnd.format("YYYY-MM-DD");
                    hasDate = true;
                }
            }
            if (hasDate) {
                pagesData.push({ date: validDate, dateStart: validDateStart, dateEnd: validDateEnd, name: file.basename, color: fm.color });
            }
        }

        const table = this.calendarContentEl.createEl('table', { cls: 'my-calendar-table' });
        const thead = table.createEl('thead');
        const headerRow = thead.createEl('tr');
        headerRow.createEl('th', { text: 'W' });
        "Mon Tue Wed Thu Fri Sat Sun".split(" ").forEach(day => headerRow.createEl('th', { text: day }));

        const tbody = table.createEl('tbody');
        const startDate = moment(`${year}-01-01`).startOf('isoWeek');
        const endDate = moment(`${year}-12-31`).endOf('isoWeek');
        
        let currentDay = startDate.clone();
        
        while (currentDay.isBefore(endDate)) {
            const weekRow = tbody.createEl('tr');
            weekRow.createEl('td', { cls: 'week-number', text: currentDay.isoWeek().toString() });
            
            for (let i = 0; i < 7; i++) {
                const dayMoment = currentDay;
                const dateStr = dayMoment.format("YYYY-MM-DD");
                const cell = weekRow.createEl('td');
                cell.dataset.date = dateStr; // Add data-date for the click handler
                
                const cellClasses = ['calendar-cell'];
                // ... (styling logic is the same)
                const isOddMonth = dayMoment.month() % 2 === 1;
                cellClasses.push(isOddMonth ? 'odd-month' : 'even-month');
                if (dayMoment.year() !== year) cellClasses.push('other-year');
                if (dateStr === today) cellClasses.push('today');
                cell.addClass(...cellClasses);

                const cellContentWrapper = cell.createDiv({ cls: 'cell-content' });
                const topContentDiv = cellContentWrapper.createDiv({ cls: 'top-content' });
                const dotAreaDiv = cellContentWrapper.createDiv({ cls: 'dot-area' });
                const rangeBarAreaDiv = cellContentWrapper.createDiv({ cls: 'range-bar-area' });

                const dayNumSpan = topContentDiv.createSpan({ cls: 'day-number' });

                if (dayMoment.year() === year) {
                    dayNumSpan.setText(dayMoment.date().toString());
                    const dailyNoteFile = getDailyNote(dayMoment, allDNs);
                    if (dailyNoteFile) {
                        dayNumSpan.addClass('has-daily-note'); // Add class for styling
                    }
                }

                const matchingNotes = pagesData.filter(p => p.date === dateStr);
                matchingNotes.forEach(note => {
                    const dot = dotAreaDiv.createSpan({ cls: 'dot', text: '●' });
                    dot.title = note.name;
                    dot.style.color = note.color || this.plugin.settings.defaultDotColor;
                });

                const matchingRanges = pagesData.filter(p => p.dateStart && p.dateEnd && dayMoment.isBetween(p.dateStart, p.dateEnd, 'day', '[]'));
                matchingRanges.forEach(p => {
                    const bar = rangeBarAreaDiv.createDiv({ cls: 'range-bar', title: p.name });
                    bar.style.backgroundColor = p.color || this.plugin.settings.defaultBarColor;
                    if (dayMoment.isSame(p.dateStart, 'day')) bar.addClass('range-start');
                    if (dayMoment.isSame(p.dateEnd, 'day')) bar.addClass('range-end');
                });

                currentDay.add(1, 'day');
            }
        }
    }

    handleClick(event: MouseEvent) {
		const target = event.target as HTMLElement;

		// Check if a day number was clicked
		const dayNumberEl = target.closest('.day-number');
		if (dayNumberEl) {
			const cellEl = target.closest('td.calendar-cell');
			if (cellEl && cellEl.dataset.date) {
				const date = moment(cellEl.dataset.date);
				this.openOrCreateDailyNote(date, event);
			}
		}
	}

    async openOrCreateDailyNote(date: moment.Moment, event: MouseEvent): Promise<void> {
		const { workspace } = this.app;
		const allDailyNotes = getAllDailyNotes();
		const existingFile = getDailyNote(date, allDailyNotes);
		const openInNewPane = event.ctrlKey || event.metaKey;

		const performCreateAndOpen = async () => {
			try {
				const newFile = await createDailyNote(date);
				await workspace.openLinkText(newFile.path, '', openInNewPane);
			} catch (err) {
				console.error(`Failed to create daily note for ${date.format("YYYY-MM-DD")}:`, err);
			}
		};

		if (existingFile) {
			await workspace.openLinkText(existingFile.path, '', openInNewPane);
		} else {
			if (this.plugin.settings.shouldConfirmBeforeCreate) {
				createConfirmationDialog(this.app, {
					title: "Create Daily Note?",
					text: `Daily note for ${date.format("YYYY-MM-DD")} does not exist. Create it now?`,
					cta: "Create",
					onAccept: performCreateAndOpen
				});
			} else {
				await performCreateAndOpen();
			}
		}
	}
}