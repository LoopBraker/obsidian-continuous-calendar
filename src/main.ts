import { Platform, Plugin, WorkspaceLeaf, TFile, normalizePath } from 'obsidian';
import { CalendarView, VIEW_TYPE_CALENDAR } from "./CalendarView";
import {
    IndexService,
    notifyCalendarEventIndexChanged,
    registerCalendarEventIndex,
    unregisterCalendarEventIndex,
} from "./services/IndexService";
import { DEFAULT_SETTINGS, type CalendarPluginSettings } from "./settings/settings";
import { CalendarSettingTab } from "./settings/SettingsTab";
import { HolidayService } from './services/HolidayService';
import { CalendarBasesView, CALENDAR_BASES_VIEW_TYPE } from './CalendarBasesView';
import {
    CalendarEventRepository,
    ObsidianCalendarEventVaultAdapter,
    type FrontmatterProcessor,
} from './services/sync/notes';
import {
    PluginDataStore,
    SyncStateStore,
    createCredentialStore,
    type CredentialStore,
} from './services/sync/state';
import {
    SyncLifecycleCoordinator,
    createRegisteredSyncClock,
    resolveSyncRuntime,
    type SyncRuntimeFactory,
} from './services/sync/lifecycle';
import type { CalendarEvent, CalendarEventSnapshot } from './services/sync/model';
import type { SyncUiActions, SyncUiConflict } from './components/SyncUi';
import { openSyncConflictModal } from './modals/SyncConflictModal';

export default class ContinuousCalendarPlugin extends Plugin {
    settings: CalendarPluginSettings;
    calendarIndex: IndexService;
    holidayService: HolidayService;
    displayedYear: number;
    calendarEventRepository: CalendarEventRepository;
    syncLifecycle: SyncLifecycleCoordinator;
    syncRuntimeFactory?: SyncRuntimeFactory;
    syncUiActions: SyncUiActions;

    private pluginDataStore: PluginDataStore;
    private syncStateStore: SyncStateStore;
    private credentialStore: CredentialStore;
    private layoutReady = false;


    async onload() {

        // Load settings
        await this.loadSettings();

        //Initialize index service
        this.calendarEventRepository = this.createEventRepository();
        registerCalendarEventIndex(this.app, this.calendarEventRepository.index);
        this.calendarIndex = new IndexService(this.app);
        this.calendarIndex.setSettings(this.settings);
        this.calendarIndex.setCalendarEventIndex(this.calendarEventRepository.index);

        await this.setSyncRuntimeFactory(async (context) => {
            const sync = context.settings.sync;
            if (sync.providerId !== 'google' || !sync.accountId || !sync.googleClientId || !sync.googleClientSecret) return undefined;

            const { createGoogleOAuthProvider, obsidianHttpTransport } = await import('./services/sync/providers/google/GoogleSyncRuntime');
            const { asGoogleCredentialStore } = await import('./services/sync/lifecycle/SyncLifecycleCoordinator');
            const { GoogleCalendarProvider } = await import('./services/sync/providers/google/GoogleCalendarProvider');

            const provider = createGoogleOAuthProvider(sync.googleClientId, sync.googleClientSecret, asGoogleCredentialStore(context.credentialStore));
            const result = await provider.refresh(sync.accountId, undefined);

            return {
                provider: new GoogleCalendarProvider({ transport: obsidianHttpTransport }),
                session: result.session,
            };
        });

        await this.configureSyncLifecycle(false);
        this.configureSyncUiActions();

        //Add settings tab after lifecycle actions are available
        this.addSettingTab(new CalendarSettingTab(this.app, this, this.syncUiActions));


        //Initialize holiday service
        this.holidayService = new HolidayService(this.app, this);

        this.displayedYear = new Date().getFullYear();

        // 1. Wait for layout to be ready to index
        this.app.workspace.onLayoutReady(async () => {
            this.layoutReady = true;
            this.calendarIndex.indexVault();
            await this.syncLifecycle.start();
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

        this.addCommand({
            id: "sync-calendar-now",
            name: "Sync calendar now",
            callback: () => {
                void this.syncLifecycle.syncNow('manual');
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

        // Listen for file changes (Frontmatter updates, content edits)
        this.registerEvent(
            this.app.metadataCache.on("changed", async (file) => {
                // Update the index for this specific file
                this.calendarIndex.indexFile(file);
                this.syncLifecycle.handleModify(file.path);

                // If the file is a Holiday file, reload holidays
                if (file.path.includes(' Holidays ')) {
                    await this.loadHolidaysForYear(new Date().getFullYear());
                }
            })
        );

        this.registerEvent(
            this.app.vault.on("create", (file) => {
                if (file instanceof TFile && file.extension === 'md') {
                    this.syncLifecycle.handleCreate(file.path);
                }
            })
        );

        // Listen for metadata cache resolution to ensure holiday files are loaded if they were not cached yet on startup
        this.registerEvent(
            this.app.metadataCache.on("resolved", async () => {
                await this.loadHolidaysForYear(new Date().getFullYear());
            })
        );

        // Listen for file deletions
        this.registerEvent(
            this.app.vault.on("delete", (file) => {
                if (file instanceof TFile && file.extension === 'md') {
                    this.syncLifecycle.handleDelete(file.path);
                    this.calendarIndex.removeFile(file.path);
                }
            })
        );

        // Listen for file renames
        this.registerEvent(
            this.app.vault.on("rename", (file, oldPath) => {
                if (file instanceof TFile && file.extension === 'md') {
                    this.syncLifecycle.handleRename(file.path, oldPath);
                    this.calendarIndex.renameFile(file, oldPath);
                }
            })
        );


    }

    onunload() {
        void this.syncLifecycle?.stop();
        if (this.calendarEventRepository) {
            unregisterCalendarEventIndex(this.app, this.calendarEventRepository.index);
        }
        this.calendarIndex?.dispose();
    }

    private createEventRepository(): CalendarEventRepository {
        return new CalendarEventRepository(
            new ObsidianCalendarEventVaultAdapter({
                getMarkdownFiles: () => this.app.vault.getMarkdownFiles(),
                read: (file) => this.app.vault.read(file as TFile),
                create: async (path, content) => {
                    await this.ensureParentFolder(path);
                    return this.app.vault.create(path, content);
                },
                processFrontMatter: (file, processor: FrontmatterProcessor) =>
                    this.app.fileManager.processFrontMatter(file as TFile, processor),
                rename: (file, newPath) => this.app.fileManager.renameFile(file as TFile, newPath),
                trash: (file) => this.app.vault.trash(file as TFile, true),
                getAbstractFileByPath: (path) => this.app.vault.getAbstractFileByPath(path),
            }),
            { folder: this.settings.sync.eventFolder },
        );
    }

    private async ensureParentFolder(path: string): Promise<void> {
        const normalized = normalizePath(path);
        const slash = normalized.lastIndexOf('/');
        if (slash < 0) return;
        const segments = normalized.slice(0, slash).split('/');
        let current = '';
        for (const segment of segments) {
            current = current ? `${current}/${segment}` : segment;
            if (!this.app.vault.getAbstractFileByPath(current)) {
                await this.app.vault.createFolder(current);
            }
        }
    }

    private async configureSyncLifecycle(startWhenReady: boolean): Promise<void> {
        await this.syncLifecycle?.stop();
        if (this.calendarEventRepository.folder !== this.settings.sync.eventFolder) {
            this.calendarEventRepository = this.createEventRepository();
            registerCalendarEventIndex(this.app, this.calendarEventRepository.index);
            this.calendarIndex?.setCalendarEventIndex(this.calendarEventRepository.index);
        }
        let runtime;
        const sync = this.settings.sync;
        const canConstructRuntime = Platform.isDesktopApp &&
            sync.providerId !== null &&
            sync.accountId !== null &&
            this.syncRuntimeFactory !== undefined;
        if (canConstructRuntime && this.syncRuntimeFactory) {
            try {
                runtime = await this.syncRuntimeFactory({
                    settings: this.settings,
                    repository: this.calendarEventRepository,
                    calendarEventIndex: this.calendarEventRepository.index,
                    dataStore: this.pluginDataStore,
                    stateStore: this.syncStateStore,
                    credentialStore: this.credentialStore,
                    isDesktop: true,
                    app: this.app,
                });
            } catch (error) {
                await this.syncStateStore.setLastError(error);
            }
        }
        const service = resolveSyncRuntime(runtime, {
            settings: this.settings,
            repository: this.calendarEventRepository,
            stateStore: this.syncStateStore,
            clock: createRegisteredSyncClock(intervalId => this.registerInterval(intervalId)),
        });
        this.syncLifecycle = new SyncLifecycleCoordinator({
            repository: this.calendarEventRepository,
            syncService: service,
            onIndexChanged: () => notifyCalendarEventIndexChanged(this.app),
            onError: error => { void this.syncStateStore.setLastError(error); },
        });
        if (startWhenReady && this.layoutReady) await this.syncLifecycle.start();
    }

    private configureSyncUiActions(): void {
        const readConflictEvent = (value: unknown): CalendarEvent | undefined => {
            if (!value || typeof value !== 'object') return undefined;
            return (value as CalendarEventSnapshot).event;
        };
        const conflicts = (): SyncUiConflict[] => (this.syncLifecycle?.service?.conflicts ?? [])
            .map(conflict => {
                const local = readConflictEvent(conflict.local);
                const remote = readConflictEvent(conflict.remote);
                return local && remote && conflict.localUid
                    ? { key: conflict.key, localUid: conflict.localUid, local, remote }
                    : undefined;
            })
            .filter((conflict): conflict is SyncUiConflict => conflict !== undefined);
        this.syncUiActions = {
            syncNow: () => this.syncLifecycle.syncNow('manual'),
            connect: async () => {
                if (!this.syncRuntimeFactory) throw new Error('Google authentication is not configured for this installation');
                const sync = this.settings.sync;
                if (sync.providerId !== 'google') throw new Error('Only Google Calendar is currently supported for connection');
                if (!sync.googleClientId || !sync.googleClientSecret) throw new Error('Please configure a Google Client ID and Client Secret in settings first');
                
                const { createGoogleOAuthProvider } = await import('./services/sync/providers/google/GoogleSyncRuntime');
                const { asGoogleCredentialStore } = await import('./services/sync/lifecycle/SyncLifecycleCoordinator');
                const provider = createGoogleOAuthProvider(sync.googleClientId, sync.googleClientSecret, asGoogleCredentialStore(this.credentialStore));
                
                const result = await provider.authorize();
                this.settings.sync.accountId = result.accountId;
                await this.saveSettings();
            },
            reconnect: async () => {
                if (!this.syncRuntimeFactory) throw new Error('Google authentication is not configured for this installation');
                await this.configureSyncLifecycle(true);
            },
            disconnect: async () => {
                if (!this.syncStateStore.isLoaded) await this.syncStateStore.load();
                await this.syncStateStore.disconnect({
                    providerId: this.settings.sync.providerId ?? undefined,
                    accountId: this.settings.sync.accountId ?? undefined,
                    calendarId: this.settings.sync.calendarId ?? undefined,
                }, this.credentialStore);
                this.settings.sync = {
                    ...this.settings.sync,
                    providerId: null,
                    accountId: null,
                    calendarId: null,
                    syncMode: 'disabled',
                };
                await this.saveSettings();
            },
            listCalendars: async () => {
                const service = this.syncLifecycle?.service;
                if (!service?.provider || !service.session) return [];
                return service.provider.listCalendars(service.session);
            },
            deleteSyncedEvent: async localUid =>
                this.syncLifecycle?.service?.deleteSyncedEvent?.(localUid) ?? false,
            resolveConflict: async (key, choice) => {
                const resolver = this.syncLifecycle?.service?.resolveConflict;
                if (!resolver) throw new Error('Conflict resolution is unavailable until sync is connected');
                return resolver.call(this.syncLifecycle.service, key, choice);
            },
            openConflict: localUid => {
                const conflict = conflicts().find(candidate => candidate.localUid === localUid);
                if (!conflict) return;
                openSyncConflictModal(this.app, {
                    key: conflict.key,
                    local: conflict.local,
                    remote: conflict.remote,
                    onResolve: async choice => {
                        await this.syncUiActions.resolveConflict?.(conflict.key, choice);
                        notifyCalendarEventIndexChanged(this.app);
                    },
                });
            },
            getConflicts: conflicts,
            getStatus: () => this.syncLifecycle?.service?.status,
        };
    }

    /** Workstream H installs an authenticated provider/session through this gate. */
    async setSyncRuntimeFactory(factory: SyncRuntimeFactory | undefined): Promise<void> {
        this.syncRuntimeFactory = factory;
        await this.configureSyncLifecycle(true);
    }

    async loadHolidaysForYear(year: number, targetIndex?: IndexService) {
        const index = targetIndex || this.calendarIndex;
        // Load holidays for the requested year, plus previous and next year to handle scrolling
        const yearsToLoad = [year - 1, year, year + 1];

        // We can load them in parallel
        await Promise.all(yearsToLoad.map(async (y) => {
            const holidayMap = await this.holidayService.getAggregatedHolidays(y);
            index.setHolidaysForYear(y, holidayMap);
        }));
    }
    async loadSettings() {
        this.pluginDataStore = new PluginDataStore({
            loadData: () => this.loadData(),
            saveData: data => this.saveData(data),
        }, { defaults: DEFAULT_SETTINGS });
        const loaded = await this.pluginDataStore.load();
        this.settings = loaded.settings;
        this.syncStateStore = new SyncStateStore(this.pluginDataStore);
        this.credentialStore = createCredentialStore(this.app);
    }

    async saveSettings() {
        await this.pluginDataStore.saveSettings(this.settings);
        this.calendarIndex.setSettings(this.settings);
        this.calendarIndex.notifyListeners(null);
        await this.configureSyncLifecycle(true);
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

        // Check if leaf exists before revealing
        if (leaf) {
            workspace.revealLeaf(leaf);
        }
    }
}
