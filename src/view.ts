// src/view.ts
import { ItemView, WorkspaceLeaf, moment } from 'obsidian';
import MyCalendarPlugin from './main'; // Import the plugin class

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
        
        this.renderCalendar(container);
    }

    async onClose() {
        // No cleanup needed yet
    }

    // New method to handle refreshing the view
    async refresh() {
        // Update the view's title
        this.leaf.updateHeader(); 
        
        // Re-render the calendar content
        const container = this.containerEl.children[1];
        container.empty();
        this.renderCalendar(container);
    }
    
    renderCalendar(container: Element) {
        const year = this.plugin.settings.year;
        const today = moment().format("YYYY-MM-DD");

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
                const cell = weekRow.createEl('td');
                
                const cellClasses = ['calendar-cell'];
                const isOddMonth = dayMoment.month() % 2 === 1;
                
                cellClasses.push(isOddMonth ? 'odd-month' : 'even-month');

                if (dayMoment.year() !== year) {
                    cellClasses.push('other-year');
                }

                if (dayMoment.format("YYYY-MM-DD") === today) {
                    cellClasses.push('today');
                }
                
                cell.addClass(...cellClasses);

                if (dayMoment.year() === year) {
                    cell.setText(dayMoment.date().toString());
                }

                currentDay.add(1, 'day');
            }
        }
    }
}