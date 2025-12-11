import { Plugin, ItemView, WorkspaceLeaf, TFile } from 'obsidian';
import { CalendarView, VIEW_TYPE_CALENDAR } from "./CalendarView";
import { IndexService } from "./services/IndexService";
import { DEFAULT_SETTINGS, type CalendarPluginSettings } from "./settings/settings";
import { CalendarSettingTab } from "./settings/SettingsTab";
import { HolidayService } from './services/HolidayService';
import { CalendarBasesView, CALENDAR_BASES_VIEW_TYPE } from './CalendarBasesView';

export default class ContinuousCalendarPlugin extends Plugin {
    settings: CalendarPluginSettings;
    calendarIndex: IndexService;
    holidayService: HolidayService;
    displayedYear: number;


    async onload() {

        // Load settings
        await this.loadSettings();

        //Add settings tab
        this.addSettingTab(new CalendarSettingTab(this.app, this));

        //Initialize index service
        this.calendarIndex = new IndexService(this.app);
        this.calendarIndex.setSettings(this.settings);


        //Initialize holiday service
        this.holidayService = new HolidayService(this.app, this);

        this.displayedYear = new Date().getFullYear();

        // 1. Wait for layout to be ready to index
        this.app.workspace.onLayoutReady(async () => {
            this.calendarIndex.indexVault();
            await this.loadHolidaysForYear(new Date().getFullYear());
        });

        // 2. Register the Standard View
        this.registerView(
            VIEW_TYPE_CALENDAR,
            (leaf) => new CalendarView(leaf, this.calendarIndex, this)
        );

        // 3. Add Ribbon Icon
        this.addRibbonIcon("calendar-days", "Open Calendar", () => {
            this.activateView();
        });

        // 4. Add Command
        this.addCommand({
            id: "open-calendar-view",
            name: "Open Continuous Calendar",
            callback: () => {
                this.activateView();
            },
        });

        // 5. REGISTER BASES VIEW (This is the missing piece)
        // We use @ts-ignore because 'registerBasesView' is likely added dynamically by the Bases plugin
        // @ts-ignore
        if (this.registerBasesView) {
            // @ts-ignore
            this.registerBasesView(CALENDAR_BASES_VIEW_TYPE, {
                name: 'Calendar',
                icon: 'calendar-with-checkmark',
                factory: (controller: any, containerEl: HTMLElement) => {
                    return new CalendarBasesView(controller, containerEl, this);
                },
            });
        }

        this.app.workspace.onLayoutReady(async () => {
            this.calendarIndex.indexVault();
            // This triggers the async fetch, which calls index.setHolidaysForYear, 
            // which calls notifyListeners, which updates dataVersion in React
            await this.loadHolidaysForYear(new Date().getFullYear());
        });
    }


    async loadHolidaysForYear(year: number) {
        // Load holidays for the requested year, plus previous and next year to handle scrolling
        const yearsToLoad = [year - 1, year, year + 1];

        // We can load them in parallel
        await Promise.all(yearsToLoad.map(async (y) => {
            const holidayMap = await this.holidayService.getAggregatedHolidays(y);
            this.calendarIndex.setHolidaysForYear(y, holidayMap);
        }));
    }
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async activateView() {
        const { workspace } = this.app;

        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_CALENDAR);

        if (leaves.length > 0) {
            // A leaf already exists, use it
            leaf = leaves[0];
        } else {
            // Create a new leaf in the RIGHT sidebar
            leaf = workspace.getRightLeaf(false);

            // FIX 1: Check if leaf exists before using it
            if (leaf) {
                await leaf.setViewState({ type: VIEW_TYPE_CALENDAR, active: true });
            }
        }

        // FIX 2: Check if leaf exists before revealing
        if (leaf) {
            workspace.revealLeaf(leaf);
        }
    }
}