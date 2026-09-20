import { BasesView, QueryController, TFile, Notice, Platform } from 'obsidian';
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
import { openSyncEventModal } from './modals/SyncEventModal';
import { sanitizeSyncUiError, type SyncUiActions } from './components/SyncUi';

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

        // Reset padding/margin on parent host element if present
        parentEl.style.padding = "0";
        parentEl.style.margin = "0";
        parentEl.style.height = "100%";
        parentEl.style.overflow = "hidden";

        this.containerEl = parentEl.createDiv('calendar-bases-view-container');
        this.plugin = plugin;

        // 1. Initialize Service
        this.calendarIndex = new IndexService(app);
        this.calendarIndex.setSettings(plugin.settings);
        void this.loadHolidaysForYear(new Date().getFullYear());

        // 2. Setup Container Styles
        this.containerEl.style.height = "100%";
        this.containerEl.style.width = "100%";
        this.containerEl.style.padding = "0";
        this.containerEl.style.margin = "0";
        this.containerEl.style.display = "flex";
        this.containerEl.style.flexDirection = "column";
        this.containerEl.style.overflow = "hidden";

        // 3. RENDER IMMEDIATELY
        this.mountReact();
    }

    private async loadHolidaysForYear(year: number): Promise<void> {
        await this.plugin.loadHolidaysForYear(year, this.calendarIndex);
    }

    private mountReact() {
        // --- FIX IS HERE: Use the correct class name for CSS ---
        const reactRoot = this.containerEl.createDiv({ cls: "Continuous-calendar-plugin" });
        // -----------------------------------------------------

        reactRoot.style.height = "100%";
        reactRoot.style.width = "100%";

        this.root = createRoot(reactRoot);

        const lifecycleActions = (this.plugin as unknown as { syncUiActions?: SyncUiActions }).syncUiActions;
        const syncEventActions = Platform.isDesktopApp ? {
            create: (dateKey: string) => {
                const sync = this.plugin.settings.sync;
                if (sync.syncMode !== 'bidirectional' || !sync.providerId || !sync.accountId || !sync.calendarId) {
                    new Notice('Enable a connected bidirectional calendar before creating a synced event.');
                    return;
                }
                openSyncEventModal(this.plugin.app, {
                    dateKey,
                    timezone: this.plugin.settings.sync.timezone,
                    onSubmit: async event => {
                        const created = await this.plugin.calendarEventRepository.create(event, { status: 'pending' });
                        this.plugin.syncLifecycle.handleCreate(created.path);
                    },
                });
            },
            edit: (uid: string) => {
                const existing = this.plugin.calendarEventRepository.getByUid(uid);
                if (!existing) {
                    new Notice('The synchronized event note is no longer indexed.');
                    return;
                }
                openSyncEventModal(this.plugin.app, {
                    initialEvent: existing.event,
                    timezone: existing.event.timezone,
                    onSubmit: async event => {
                        await this.plugin.calendarEventRepository.update(uid, event, { status: 'pending' });
                        this.plugin.syncLifecycle.handleModify(existing.path);
                    },
                });
            },
            delete: lifecycleActions?.deleteSyncedEvent ? async (uid: string) => new Promise<boolean>(resolve => {
                createConfirmationDialog(this.plugin.app, {
                    title: 'Delete synced event?',
                    text: 'This first requests remote deletion. The local note is moved to system trash only after provider confirmation.',
                    cta: 'Delete synced event',
                    onAccept: async () => {
                        try {
                            const deleted = await lifecycleActions.deleteSyncedEvent?.(uid) ?? false;
                            new Notice(deleted ? 'Synced event deleted' : 'Synced event was not fully deleted');
                            resolve(deleted);
                        } catch (error) {
                            new Notice(`Synced event was not deleted: ${sanitizeSyncUiError(error)}`);
                            resolve(false);
                        }
                    },
                });
            }) : undefined,
            resolveConflict: lifecycleActions?.openConflict,
        } : undefined;

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
                    await this.loadHolidaysForYear(year);
                }}
                syncEventActions={syncEventActions}
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
        this.calendarIndex.dispose();
    }
}
