// src/main.ts
import { Plugin, WorkspaceLeaf } from 'obsidian';
import { CalendarView, CALENDAR_VIEW_TYPE } from './view';
import { CalendarSettingTab } from './settings';
import { MyCalendarPluginSettings } from './types';

const DEFAULT_SETTINGS: MyCalendarPluginSettings = {
    year: new Date().getFullYear(),
    defaultDotColor: 'currentColor',
    defaultBarColor: 'var(--interactive-accent)', // A good default for a prominent bar
};

export default class MyCalendarPlugin extends Plugin {
    settings: MyCalendarPluginSettings;
    calendarView: CalendarView | null = null;
    
    async onload() {
        console.log('Loading Continuous Calendar Plugin');

        await this.loadSettings();

        // Register the View
        this.registerView(
            CALENDAR_VIEW_TYPE,
            (leaf) => {
                 this.calendarView = new CalendarView(leaf, this);
                 return this.calendarView;
            }
        );

        // Add Ribbon Icon to Open View
        this.addRibbonIcon('calendar-days', 'Open Continuous Calendar', (evt: MouseEvent) => {
            this.activateView();
        });

        // Add Settings Tab
        this.addSettingTab(new CalendarSettingTab(this.app, this));
    }

    onunload() {
        console.log('Unloading Continuous Calendar Plugin');
        this.calendarView = null; // Clear reference
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async activateView() {
        this.app.workspace.getLeavesOfType(CALENDAR_VIEW_TYPE).forEach((leaf) => {
            leaf.detach();
        });

        await this.app.workspace.getRightLeaf(false)?.setViewState({
            type: CALENDAR_VIEW_TYPE,
            active: true,
        });

        this.app.workspace.revealLeaf(
            this.app.workspace.getLeavesOfType(CALENDAR_VIEW_TYPE)[0]
        );
    }

    refreshCalendarView() {
        if (this.calendarView) {
            this.calendarView.refresh();
             console.log("Calendar view refreshed.");
        }
    }
}