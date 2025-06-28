// src/main.ts
import { Plugin, ItemView, WorkspaceLeaf } from 'obsidian';
import { CalendarView, CALENDAR_VIEW_TYPE } from './view';

export default class MyCalendarPlugin extends Plugin {
    
    async onload() {
        console.log('Loading Continuous Calendar Plugin');

        // Register the View
        this.registerView(
            CALENDAR_VIEW_TYPE,
            (leaf) => new CalendarView(leaf)
        );

        // Add Ribbon Icon to Open View
        this.addRibbonIcon('calendar-days', 'Open Continuous Calendar', (evt: MouseEvent) => {
            this.activateView();
        });
    }

    onunload() {
        console.log('Unloading Continuous Calendar Plugin');
    }

    // Function to activate/open the view
    async activateView() {
        // Detach existing leaves first to ensure only one instance runs
        this.app.workspace.getLeavesOfType(CALENDAR_VIEW_TYPE).forEach((leaf) => {
            leaf.detach();
        });

        // Add to the right sidebar
        await this.app.workspace.getRightLeaf(false)?.setViewState({
            type: CALENDAR_VIEW_TYPE,
            active: true,
        });

        // Reveal the view
        this.app.workspace.revealLeaf(
            this.app.workspace.getLeavesOfType(CALENDAR_VIEW_TYPE)[0]
        );
    }
}