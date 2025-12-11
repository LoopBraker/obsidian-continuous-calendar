import { Plugin, ItemView, WorkspaceLeaf, TFile } from 'obsidian';
import * as React from "react";
import { createRoot, Root } from "react-dom/client";
import ContinuousCalendar from "./ContinuousCalendar";
import ContinuousCalendarPlugin from "./main";
import { IndexService } from "./services/IndexService";
import { createRangeNote } from './createRangeNote';
import { createConfirmationDialog } from './modals/ConfirmationModal';

// Import Daily Note utilities
import {
    getAllDailyNotes,
    getDailyNote,
    createDailyNote
} from 'obsidian-daily-notes-interface';
import moment from 'moment';


export const VIEW_TYPE_CALENDAR = "Continuous-calendar-view";

export class CalendarView extends ItemView {
    root: Root | null = null;
    calendarIndex: IndexService;
    plugin: ContinuousCalendarPlugin;

    constructor(leaf: WorkspaceLeaf, index: IndexService, plugin: ContinuousCalendarPlugin) {
        super(leaf);
        this.calendarIndex = index;
        this.plugin = plugin;
    }

    getViewType() {
        return VIEW_TYPE_CALENDAR;
    }

    getDisplayText() {
        return "Continuous Calendar";
    }

    getIcon() {
        return "calendar-days";
    }

    async onOpen() {
        const container = this.containerEl;
        container.empty();

        // Create a wrapper div for React
        const reactRoot = container.createDiv({ cls: "Continuous-calendar-plugin" });
        reactRoot.style.height = "100%";
        reactRoot.style.width = "100%";

        // --- THE OPEN/CREATE LOGIC ---
        const handleOpenNote = async (date: Date) => {
            const { workspace } = this.app;
            const momentDate = moment(date);
            const dateStr = momentDate.format('YYYY-MM-DD');

            const allDailyNotes = getAllDailyNotes();
            const existingNote = getDailyNote(momentDate, allDailyNotes);

            // A: If note exists, just open it
            if (existingNote) {
                await workspace.getLeaf(false).openFile(existingNote);
                return;
            }

            // Define the creation logic as a reusable function
            const performCreate = async () => {
                try {
                    const newNote = await createDailyNote(momentDate);
                    await workspace.getLeaf(false).openFile(newNote);
                } catch (err) {
                    console.error(`Failed to create daily note for ${dateStr}`, err);
                }
            };

            // B: If note does NOT exist, check settings
            // (Assuming your settings interface has 'shouldConfirmBeforeCreate')
            if (this.plugin.settings.shouldConfirmBeforeCreate) {
                // Show Confirmation Modal
                createConfirmationDialog(this.app, {
                    title: 'Create Daily Note?',
                    text: `Daily note for ${dateStr} does not exist. Create it now?`,
                    cta: 'Create',
                    onAccept: async () => {
                        await performCreate();
                    }
                });
            } else {
                // Create immediately if setting is off
                await performCreate();
            }
        };

        // Create Range Note Handler
        const handleCreateRange = async (startDate: Date, endDate: Date) => {
            const moment = (window as any).moment;
            const startStr = moment(startDate).format('YYYY-MM-DD');
            const endStr = moment(endDate).format('YYYY-MM-DD');

            const performCreate = async () => {
                await createRangeNote(this.app, startStr, endStr);
            };

            // Check settings for confirmation (assuming you have this setting)
            if (this.plugin.settings.shouldConfirmBeforeCreateRange) {
                createConfirmationDialog(this.app, {
                    title: 'Create Range Note?',
                    text: `Create a range note from ${startStr} to ${endStr}?`,
                    cta: 'Create',
                    onAccept: async () => {
                        await performCreate();
                    }
                });
            } else {
                await performCreate();
            }
        };

        this.root = createRoot(reactRoot);
        this.root.render(
            <React.StrictMode>
                <ContinuousCalendar
                    index={this.calendarIndex}
                    onOpenNote={handleOpenNote}
                    onCreateRange={handleCreateRange}
                />
            </React.StrictMode>
        );
    }

    async onClose() {
        this.root?.unmount();
    }
}