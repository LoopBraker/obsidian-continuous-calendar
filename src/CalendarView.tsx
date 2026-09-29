import { ItemView, WorkspaceLeaf, Notice, Platform } from 'obsidian';
import * as React from "react";
import { createRoot, Root } from "react-dom/client";
import { ContinuousCalendar } from "./ContinuousCalendar";
import ContinuousCalendarPlugin from "./main";
import { IndexService } from "./services/IndexService";
import { createRangeNote } from './createRangeNote';
import { createConfirmationDialog } from './modals/ConfirmationModal';
import { openSyncEventModal } from './modals/SyncEventModal';
import { sanitizeSyncUiError, type SyncEventActions } from './components/SyncUi';

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
        container.style.overflowX = "hidden";

        // Create a wrapper div for React
        const reactRoot = container.createDiv({ cls: "Continuous-calendar-plugin" });
        reactRoot.style.height = "100%";
        reactRoot.style.width = "100%";
        reactRoot.style.overflowX = "hidden";

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

        const canWriteCalendarEvents = () => {
            const sync = this.plugin.settings.sync;
            return Platform.isDesktopApp && sync.syncMode === 'bidirectional'
                && Boolean(sync.providerId && sync.accountId && sync.calendarId);
        };
        const rejectUnavailableEventWrite = () => {
            new Notice('Enable a connected bidirectional calendar before creating, editing, or deleting a Google Calendar event.');
        };
        const syncEventActions: SyncEventActions = {
            createNote: eventKey => { void this.plugin.createNoteForCalendarEvent(eventKey); },
            openNote: eventKey => this.plugin.openNoteForCalendarEvent(eventKey),
            create: (dateKey: string) => {
                if (!canWriteCalendarEvents()) {
                    rejectUnavailableEventWrite();
                    return;
                }
                const sync = this.plugin.settings.sync;
                openSyncEventModal(this.app, {
                    dateKey,
                    timezone: sync.timezone,
                    onSubmit: event => this.plugin.createCalendarEvent(event),
                });
            },
            edit: (eventKey: string) => {
                if (!canWriteCalendarEvents()) {
                    rejectUnavailableEventWrite();
                    return;
                }
                const existing = this.plugin.getCalendarEvent(eventKey);
                if (!existing) {
                    new Notice('The Google Calendar event is no longer available.');
                    return;
                }
                openSyncEventModal(this.app, {
                    initialEvent: existing.event,
                    timezone: existing.event.timezone,
                    onSubmit: event => this.plugin.updateCalendarEvent(eventKey, event),
                });
            },
            delete: (eventKey: string) => {
                if (!canWriteCalendarEvents()) {
                    rejectUnavailableEventWrite();
                    return Promise.resolve(false);
                }
                return new Promise<boolean>(resolve => {
                    createConfirmationDialog(this.app, {
                        title: 'Delete Google Calendar event?',
                        text: 'This deletes the event from Google Calendar. Any linked note will be kept.',
                        cta: 'Delete event',
                        onAccept: async () => {
                            if (!canWriteCalendarEvents()) {
                                rejectUnavailableEventWrite();
                                resolve(false);
                                return;
                            }
                            try {
                                const deleted = await this.plugin.deleteCalendarEvent(eventKey);
                                new Notice(deleted ? 'Google Calendar event deleted' : 'Google Calendar event was not deleted');
                                resolve(deleted);
                            } catch (error) {
                                new Notice(`Google Calendar event was not deleted: ${sanitizeSyncUiError(error)}`);
                                resolve(false);
                            }
                        },
                    });
                });
            },
        };

        this.root = createRoot(reactRoot);
        this.root.render(
            <React.StrictMode>
                <ContinuousCalendar
                    index={this.calendarIndex}
                    app={this.app}
                    onOpenNote={handleOpenNote}
                    onCreateRange={handleCreateRange}
                    onYearChange={async (year: number) => {
                        await this.plugin.loadHolidaysForYear(year);
                    }}
                    syncEventActions={syncEventActions}
                />
            </React.StrictMode>
        );
    }

    async onClose() {
        this.root?.unmount();
    }
}
