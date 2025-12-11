import { BasesView, QueryController, TFile } from 'obsidian';
import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { IndexService } from './services/IndexService';
import { ContinuousCalendar } from './ContinuousCalendar';
import ContinuousCalendarPlugin from './main';
import moment from 'moment';

// Import Daily Note Utils
import {
    getAllDailyNotes,
    getDailyNote,
    createDailyNote
} from 'obsidian-daily-notes-interface';

// Import Dialogs
import { createConfirmationDialog } from './modals/ConfirmationModal';
import { createRangeNote } from './createRangeNote';

export const CALENDAR_BASES_VIEW_TYPE = 'calendar-bases-view';

export class CalendarBasesView extends BasesView {
    readonly type = CALENDAR_BASES_VIEW_TYPE;
    private containerEl: HTMLElement;
    private root: Root | null = null;
    private calendarIndex: IndexService;
    private plugin: ContinuousCalendarPlugin;

    constructor(controller: QueryController, parentEl: HTMLElement, plugin: ContinuousCalendarPlugin) {
        super(controller);
        // Fallback to plugin.app if this.app isn't available in BasesView context
        const app = this.app || plugin.app;

        this.containerEl = parentEl.createDiv('calendar-bases-view-container');
        this.plugin = plugin;

        // 1. Initialize Service
        this.calendarIndex = new IndexService(app);
        this.calendarIndex.setSettings(plugin.settings);

        // 2. Setup Container Styles
        this.containerEl.style.height = "100%";
        this.containerEl.style.width = "100%";
        this.containerEl.style.display = "flex";
        this.containerEl.style.flexDirection = "column";
        this.containerEl.style.overflow = "hidden";

        // 3. RENDER IMMEDIATELY
        this.mountReact();
    }

    private mountReact() {
        // --- FIX IS HERE: Use the correct class name for CSS ---
        const reactRoot = this.containerEl.createDiv({ cls: "Continuous-calendar-plugin" });
        // -----------------------------------------------------

        reactRoot.style.height = "100%";
        reactRoot.style.width = "100%";

        this.root = createRoot(reactRoot);

        this.root.render(
            <ContinuousCalendar
                index={this.calendarIndex}
                app={this.app || this.plugin.app}
                // --- HANDLERS ---
                onOpenNote={async (date: Date) => {
                    const mDate = moment(date);
                    const dateStr = mDate.format('YYYY-MM-DD');
                    const allDailyNotes = getAllDailyNotes();
                    const existingFile = getDailyNote(mDate, allDailyNotes);

                    if (existingFile) {
                        await this.plugin.app.workspace.openLinkText(existingFile.path, '', false);
                    } else {
                        if (this.plugin.settings.shouldConfirmBeforeCreate) {
                            createConfirmationDialog(this.plugin.app, {
                                title: 'Create Daily Note?',
                                text: `Daily note for ${dateStr} does not exist. Create it now?`,
                                cta: 'Create',
                                onAccept: async () => {
                                    const newFile = await createDailyNote(mDate);
                                    await this.plugin.app.workspace.openLinkText(newFile.path, '', false);
                                }
                            });
                        } else {
                            const newFile = await createDailyNote(mDate);
                            await this.plugin.app.workspace.openLinkText(newFile.path, '', false);
                        }
                    }
                }}

                onCreateRange={async (startDate: Date, endDate: Date) => {
                    const startStr = moment(startDate).format('YYYY-MM-DD');
                    const endStr = moment(endDate).format('YYYY-MM-DD');

                    if (this.plugin.settings.shouldConfirmBeforeCreateRange) {
                        createConfirmationDialog(this.plugin.app, {
                            title: 'Create Range Note?',
                            text: `Create a range from ${startStr} to ${endStr}?`,
                            cta: 'Create',
                            onAccept: async () => {
                                await createRangeNote(this.plugin.app, startStr, endStr);
                            }
                        });
                    } else {
                        await createRangeNote(this.plugin.app, startStr, endStr);
                    }
                }}

                onYearChange={async (year: number) => {
                    if (this.plugin.holidayService) {
                        const yearsToLoad = [year - 1, year, year + 1];
                        await Promise.all(yearsToLoad.map(async (y) => {
                            const holidays = await this.plugin.holidayService.getAggregatedHolidays(y);
                            this.calendarIndex.setHolidaysForYear(y, holidays);
                        }));
                    }
                }}
            />
        );
    }

    public onDataUpdated(): void {
        this.calendarIndex.clearIndexedFiles();

        if (this.data && this.data.groupedData) {
            for (const group of this.data.groupedData) {
                for (const entry of group.entries) {
                    if (entry.file instanceof TFile) {
                        this.calendarIndex.indexFile(entry.file);
                    }
                }
            }
        }

        this.calendarIndex.assignRangeSlots();
        this.calendarIndex.notifyListeners(null);
    }

    public onClose() {
        if (this.root) this.root.unmount();
    }
}