// src/view.ts
import { ItemView, WorkspaceLeaf, moment } from 'obsidian';
import MyCalendarPlugin from './main'; 

export const CALENDAR_VIEW_TYPE = 'yearly-calendar-view';

export class CalendarView extends ItemView {
    plugin: MyCalendarPlugin;

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
        
        await this.renderCalendar(container);
    }

    async onClose() {
        // No cleanup needed yet
    }

    async refresh() {
        this.leaf.updateHeader(); 
        
        const container = this.containerEl.children[1];
        container.empty();
        await this.renderCalendar(container);
    }
    
    async renderCalendar(container: Element) {
        const year = this.plugin.settings.year;
        const today = moment().format("YYYY-MM-DD");

        // --- Data Fetching ---
        const allFiles = this.app.vault.getMarkdownFiles();
        let pagesData: any[] = [];

        for (const file of allFiles) {
            const cache = this.app.metadataCache.getFileCache(file);
            const fm = cache?.frontmatter;
            if (!fm) continue;

            let hasDate = false;
            let validDate: string | null = null;
            let validDateStart: string | null = null;
            let validDateEnd: string | null = null;
            
            // Check for single date
            if (fm.date) {
                const mDate = moment(fm.date.toString(), "YYYY-MM-DD", true);
                if (mDate.isValid()) {
                    validDate = mDate.format("YYYY-MM-DD");
                    hasDate = true;
                }
            }

            // Check for date range
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
                pagesData.push({
                    date: validDate,
                    dateStart: validDateStart,
                    dateEnd: validDateEnd,
                    name: file.basename,
                    color: fm.color
                });
            }
        }
        // --- End Data Fetching ---

        const table = container.createEl('table', { cls: 'my-calendar-table' });
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
                
                const cellClasses = ['calendar-cell'];
                const isOddMonth = dayMoment.month() % 2 === 1;
                
                cellClasses.push(isOddMonth ? 'odd-month' : 'even-month');

                if (dayMoment.year() !== year) {
                    cellClasses.push('other-year');
                }

                if (dateStr === today) {
                    cellClasses.push('today');
                }
                
                cell.addClass(...cellClasses);

                // --- Updated Cell Structure ---
                const cellContentWrapper = cell.createDiv({ cls: 'cell-content' });
                const topContentDiv = cellContentWrapper.createDiv({ cls: 'top-content' });
                const dotAreaDiv = cellContentWrapper.createDiv({ cls: 'dot-area' });
                const rangeBarAreaDiv = cellContentWrapper.createDiv({ cls: 'range-bar-area' }); // New area

                if (dayMoment.year() === year) {
                    topContentDiv.setText(dayMoment.date().toString());
                }

                // Render single-day event dots
                const matchingNotes = pagesData.filter(p => p.date === dateStr);
                matchingNotes.forEach(note => {
                    const dot = dotAreaDiv.createSpan({ cls: 'dot', text: '●' });
                    dot.title = note.name;
                    dot.style.color = note.color || this.plugin.settings.defaultDotColor;
                });

                // Render range bars
                const matchingRanges = pagesData.filter(p => 
                    p.dateStart && p.dateEnd &&
                    dayMoment.isBetween(p.dateStart, p.dateEnd, 'day', '[]') // '[]' includes start and end
                );
                
                matchingRanges.forEach(p => {
                    const bar = rangeBarAreaDiv.createDiv({ cls: 'range-bar', title: p.name });
                    bar.style.backgroundColor = p.color || this.plugin.settings.defaultBarColor;

                    if (dayMoment.isSame(p.dateStart, 'day')) {
                        bar.addClass('range-start');
                    }
                    if (dayMoment.isSame(p.dateEnd, 'day')) {
                        bar.addClass('range-end');
                    }
                });
                // --- End Updated Cell Structure ---

                currentDay.add(1, 'day');
            }
        }
    }
}