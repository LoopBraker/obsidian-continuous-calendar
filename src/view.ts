// src/view.ts
import { ItemView, WorkspaceLeaf, moment } from 'obsidian';

export const CALENDAR_VIEW_TYPE = 'yearly-calendar-view';

export class CalendarView extends ItemView {

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
    }

    getViewType(): string {
        return CALENDAR_VIEW_TYPE;
    }

    getDisplayText(): string {
        // Hardcoded for now
        return `Year Calendar - 2024`; 
    }

    getIcon(): string {
        return 'calendar-days';
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        container.createEl('h2', { text: 'Continuous Calendar' });
        
        this.renderCalendar(container);
    }

    async onClose() {
        // No cleanup needed yet
    }
    
    renderCalendar(container: Element) {
        const year = 2024; // Hardcoded year

        const table = container.createEl('table', { cls: 'my-calendar-table' });
        const thead = table.createEl('thead');
        const headerRow = thead.createEl('tr');
        
        // Add day headers
        headerRow.createEl('th', { text: 'W' }); // For week number
        "Mon Tue Wed Thu Fri Sat Sun".split(" ").forEach(day => headerRow.createEl('th', { text: day }));

        const tbody = table.createEl('tbody');
        const startDate = moment(`${year}-01-01`).startOf('isoWeek');
        const endDate = moment(`${year}-12-31`).endOf('isoWeek');
        
        let currentDay = startDate.clone();
        
        while (currentDay.isBefore(endDate)) {
            const weekRow = tbody.createEl('tr');
            
            // Add week number cell
            weekRow.createEl('td', { text: currentDay.isoWeek().toString() });
            
            for (let i = 0; i < 7; i++) {
                const cell = weekRow.createEl('td');
                // Only display day number if it's within the target year
                if (currentDay.year() === year) {
                    cell.setText(currentDay.date().toString());
                }
                currentDay.add(1, 'day');
            }
        }
    }
}