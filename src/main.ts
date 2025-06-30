// src/main.ts
import { Plugin, WorkspaceLeaf, Notice } from 'obsidian';
import { CalendarView, CALENDAR_VIEW_TYPE } from './view';
import { CalendarSettingTab } from './settings';
import { MyCalendarPluginSettings } from './types';
import { HolidayService } from './holidayService'; 

const DEFAULT_SETTINGS: MyCalendarPluginSettings = {
    year: new Date().getFullYear(),
    defaultDotColor: 'currentColor',
    defaultBarColor: 'var(--interactive-accent)',
    shouldConfirmBeforeCreate: true,
    birthdayFolder: '',
    defaultBirthdaySymbol: '🎂',
    defaultBirthdayColor: 'var(--color-red-tint)',
    holidayCountry: '',
    holidayStorageFolder: 'Calendar/Holidays', // A sensible default
};

export default class MyCalendarPlugin extends Plugin {
    settings: MyCalendarPluginSettings;
    calendarView: CalendarView | null = null;
    holidayService: HolidayService;
    
    async onload() {
        console.log('Loading Continuous Calendar Plugin');

        await this.loadSettings();
        
        // Pass the plugin instance to the service
        this.holidayService = new HolidayService(this.app, this);

        this.registerView(
            CALENDAR_VIEW_TYPE,
            (leaf) => {
                 this.calendarView = new CalendarView(leaf, this);
                 return this.calendarView;
            }
        );

        this.addRibbonIcon('calendar-days', 'Open Continuous Calendar', (evt: MouseEvent) => {
            this.activateView();
        });

        // Add Command to Fetch/Update Holidays
        this.addCommand({
            id: 'update-country-holidays',
            name: 'Update Country Holidays for Displayed Year',
            callback: async () => {
                if (!this.settings.holidayCountry) {
                    new Notice("Please set a country code in Calendar settings first.");
                    return;
                }
                new Notice(`Updating holidays for ${this.settings.holidayCountry}...`);
                await this.holidayService.updateCountryHolidayFile(this.settings.year, this.settings.holidayCountry);
                this.refreshCalendarView(); // Refresh after updating
            },
        });

        this.addSettingTab(new CalendarSettingTab(this.app, this));
    }

    onunload() {
        console.log('Unloading Continuous Calendar Plugin');
        this.calendarView = null;
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async activateView() {
        this.app.workspace.getLeavesOfType(CALENDAR_VIEW_TYPE).forEach((leaf) => { leaf.detach(); });
        await this.app.workspace.getRightLeaf(false)?.setViewState({ type: CALENDAR_VIEW_TYPE, active: true, });
        this.app.workspace.revealLeaf( this.app.workspace.getLeavesOfType(CALENDAR_VIEW_TYPE)[0] );
    }

    refreshCalendarView() {
        if (this.calendarView) {
            this.calendarView.refresh();
             console.log("Calendar view refreshed.");
        }
    }
}