import { Notice, Platform, Plugin, WorkspaceLeaf, TFile, normalizePath } from 'obsidian';
import { CalendarView, VIEW_TYPE_CALENDAR } from "./CalendarView";
import {
    IndexService,
    notifyCalendarEventIndexChanged,
    registerCalendarEventIndex,
    registerCalendarEventSource,
    unregisterCalendarEventIndex,
    unregisterCalendarEventSource,
    type CalendarDisplayEvent,
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
    createSecretValueStore,
    type CredentialStore,
    type SecretValueStore,
    type SyncState,
} from './services/sync/state';
import {
    SyncLifecycleCoordinator,
    createRegisteredSyncClock,
    resolveSyncRuntime,
    type SyncRuntimeFactory,
} from './services/sync/lifecycle';
import type { CalendarEvent, CalendarEventSnapshot } from './services/sync/model';
import { sanitizeSyncUiError, type SyncUiActions, type SyncUiConflict } from './components/SyncUi';
import { openSyncConflictModal } from './modals/SyncConflictModal';
import {
    createGoogleAuthenticatedRuntime,
    extractLegacyGoogleClientSecret,
    googleClientSecretKey,
    migrateLegacyGoogleClientSecret,
} from './services/sync/providers/google/GoogleRuntimeFactory';

export default class ContinuousCalendarPlugin extends Plugin {
    settings: CalendarPluginSettings;
    calendarIndex: IndexService;
    holidayService: HolidayService;
    displayedYear: number;
    calendarEventRepository: CalendarEventRepository;
    syncLifecycle: SyncLifecycleCoordinator;
    syncRuntimeFactory?: SyncRuntimeFactory;
    syncUiActions: SyncUiActions;
    syncAuthenticationAvailable = false;
    syncAuthenticationErrorCode?: string;

    private pluginDataStore: PluginDataStore;
    private syncStateStore: SyncStateStore;
    private credentialStore: CredentialStore;
    private clientSecretStore: SecretValueStore;
    private temporaryLegacyClientSecret?: { clientId: string; secret: string };
    private layoutReady = false;
    private unsubscribeSyncState?: () => void;
    private calendarEventState?: SyncState;
    private calendarEventProjection?: readonly CalendarDisplayEvent[];

    get syncCredentialPersistence(): CredentialStore['persistence'] {
        return this.credentialStore?.persistence === 'secure' && this.clientSecretStore?.persistence === 'secure'
            ? 'secure'
            : 'session-only';
    }


    async onload() {

        // Load settings
        await this.loadSettings();

        //Initialize index service
        this.calendarEventRepository = this.createEventRepository();
        registerCalendarEventIndex(this.app, this.calendarEventRepository.index);
        this.calendarIndex = new IndexService(this.app);
        this.calendarIndex.setSettings(this.settings);
        this.calendarIndex.setCalendarEventIndex(this.calendarEventRepository.index);
        registerCalendarEventSource(this.app, () => this.getCalendarEvents());
        this.unsubscribeSyncState = this.syncStateStore.subscribe(state => {
            this.calendarEventState = state;
            this.calendarEventProjection = undefined;
            notifyCalendarEventIndexChanged(this.app);
        });

        await this.setSyncRuntimeFactory(async (context) => {
            const sync = context.settings.sync;
            if (!sync.providerId || !sync.accountId) return undefined;
            if (sync.providerId !== 'google') throw new Error('Only Google Calendar is currently supported for connection');
            if (!sync.googleClientId) throw new Error('Configure a Google Client ID before reconnecting');
            const clientId = sync.googleClientId;
            const accountId = sync.accountId;
            const { createGoogleOAuthProvider, obsidianHttpTransport } = await import('./services/sync/providers/google/GoogleSyncRuntime');
            const { asGoogleCredentialStore } = await import('./services/sync/lifecycle/SyncLifecycleCoordinator');
            const { GoogleCalendarProvider } = await import('./services/sync/providers/google/GoogleCalendarProvider');

            return createGoogleAuthenticatedRuntime({
                clientId,
                accountId,
                secretStore: this.clientSecretStore,
                credentialStore: asGoogleCredentialStore(context.credentialStore),
                createOAuthProvider: createGoogleOAuthProvider,
                createCalendarProvider: () => new GoogleCalendarProvider({ transport: obsidianHttpTransport }),
            });
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
        this.unsubscribeSyncState?.();
        unregisterCalendarEventSource(this.app);
        if (this.calendarEventRepository) {
            unregisterCalendarEventIndex(this.app, this.calendarEventRepository.index);
        }
        this.calendarIndex?.dispose();
    }

    private getCalendarEvents(): readonly CalendarDisplayEvent[] {
        if (this.calendarEventProjection) return this.calendarEventProjection;
        const sync = this.settings.sync;
        if (sync.syncMode === 'disabled' || sync.syncMode === 'dry-run' || !sync.providerId || !sync.accountId || !sync.calendarId) return [];
        const records = Object.entries(this.calendarEventState?.remoteEvents ?? {});
        const notePaths = new Map<string, string>();
        for (const note of this.calendarEventRepository.index.values()) {
            const ref = note.association?.reference;
            if (ref) notePaths.set(JSON.stringify([ref.providerId, ref.accountId, ref.calendarId, ref.remoteEventId]), note.path);
        }
        this.calendarEventProjection = records.flatMap(([key, record]) => {
            if (record.providerId !== sync.providerId || record.accountId !== sync.accountId || record.calendarId !== sync.calendarId || record.status === 'remote_deleted') return [];
            const indexedPath = record.noteUid ? this.calendarEventRepository.index.getByUid(record.noteUid)?.path : undefined;
            const associatedPath = notePaths.get(JSON.stringify([record.providerId, record.accountId, record.calendarId, record.remoteEventId]));
            const candidatePath = indexedPath ?? associatedPath ?? record.notePath;
            const notePath = candidatePath && this.app.vault.getAbstractFileByPath(candidatePath) instanceof TFile
                ? candidatePath
                : undefined;
            return [{ key, event: record.event, status: record.status, notePath }];
        });
        return this.calendarEventProjection;
    }

    getCalendarEvent(key: string): CalendarDisplayEvent | undefined {
        return this.getCalendarEvents().find(record => record.key === key);
    }

    private requireWritableCalendarService() {
        if (this.settings.sync.syncMode !== 'bidirectional') throw new Error('Enable bidirectional sync to change Google events.');
        const service = this.syncLifecycle?.service;
        if (!service) throw new Error('Connect to Google Calendar before changing events.');
        return service;
    }

    async createCalendarEvent(event: CalendarEvent): Promise<void> {
        const create = this.requireWritableCalendarService().createCalendarEvent;
        if (!create) throw new Error('Calendar event creation is unavailable.');
        await create.call(this.syncLifecycle.service, event);
        notifyCalendarEventIndexChanged(this.app);
    }

    async updateCalendarEvent(key: string, event: CalendarEvent): Promise<void> {
        const update = this.requireWritableCalendarService().updateCalendarEvent;
        if (!update) throw new Error('Calendar event editing is unavailable.');
        await update.call(this.syncLifecycle.service, key, event);
        notifyCalendarEventIndexChanged(this.app);
    }

    async deleteCalendarEvent(key: string): Promise<boolean> {
        const remove = this.requireWritableCalendarService().deleteCalendarEvent;
        if (!remove) throw new Error('Calendar event deletion is unavailable.');
        const deleted = await remove.call(this.syncLifecycle.service, key);
        notifyCalendarEventIndexChanged(this.app);
        return deleted;
    }

    openNoteForCalendarEvent(key: string): void {
        const path = this.getCalendarEvent(key)?.notePath;
        if (!path) {
            new Notice('This calendar event has no linked note.');
            return;
        }
        void this.app.workspace.openLinkText(path, '', false);
    }

    async createNoteForCalendarEvent(key: string): Promise<void> {
        const record = this.syncStateStore.getState().remoteEvents[key];
        if (!record || record.status === 'remote_deleted' || !this.getCalendarEvent(key)) {
            new Notice('This calendar event is no longer available.');
            return;
        }
        const reference = {
            providerId: record.providerId,
            accountId: record.accountId,
            calendarId: record.calendarId,
            remoteEventId: record.remoteEventId,
            version: record.version,
        };
        try {
            const note = await this.calendarEventRepository.createLinkedNote(
                { ...record.event, uid: undefined }, reference,
                { status: record.status === 'unsupported' ? 'unsupported' : 'synced' },
            );
            const link = this.syncLifecycle?.service?.linkNote;
            if (link) await link.call(this.syncLifecycle.service, key, note.path, note.event.uid);
            else await this.syncStateStore.update(state => {
                const cached = state.remoteEvents[key];
                if (cached) state.remoteEvents[key] = { ...cached, notePath: note.path, noteUid: note.event.uid };
            });
            notifyCalendarEventIndexChanged(this.app);
            void this.app.workspace.openLinkText(note.path, '', false);
        } catch (error) {
            new Notice(`Could not create event note: ${sanitizeSyncUiError(error)}`);
        }
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
        this.syncAuthenticationAvailable = false;
        this.syncAuthenticationErrorCode = undefined;
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
                if (runtime?.provider?.id === sync.providerId && runtime?.session?.accountId === sync.accountId) {
                    this.syncAuthenticationAvailable = true;
                    await this.syncStateStore.clearLastError();
                } else if (sync.providerId && sync.accountId) {
                    throw new Error('The saved calendar account could not create an authenticated sync session. Reconnect the account.');
                }
            } catch (error) {
                const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
                this.syncAuthenticationErrorCode = typeof code === 'string' ? code : undefined;
                await this.syncStateStore.setLastError(error);
            }
        } else if (!sync.providerId || !sync.accountId) {
            await this.syncStateStore.clearLastError();
        } else if (Platform.isDesktopApp) {
            this.syncAuthenticationErrorCode = 'google-runtime-unavailable';
            await this.syncStateStore.setLastError(new Error(
                this.syncRuntimeFactory
                    ? 'Google authentication could not be initialized. Reconnect the account.'
                    : 'Google authentication is not configured for this installation.',
            ));
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
            onIndexChanged: () => {
                this.calendarEventProjection = undefined;
                notifyCalendarEventIndexChanged(this.app);
            },
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
                if (!sync.googleClientId) throw new Error('Please configure a Google Client ID in settings first');
                const clientSecret = await this.getGoogleClientSecret(sync.googleClientId);
                if (!clientSecret) throw new Error('Please save the Google Client Secret in settings first');

                const { createGoogleOAuthProvider } = await import('./services/sync/providers/google/GoogleSyncRuntime');
                const { asGoogleCredentialStore } = await import('./services/sync/lifecycle/SyncLifecycleCoordinator');
                const provider = createGoogleOAuthProvider(sync.googleClientId, clientSecret, asGoogleCredentialStore(this.credentialStore));
                
                const result = await provider.authorize();
                this.settings.sync.accountId = result.accountId;
                await this.saveSettings();
                if (!this.syncAuthenticationAvailable) {
                    const error = this.syncStateStore.getState().lastError?.message;
                    throw new Error(error ?? 'The Google account was authorized, but its sync session could not be restored.');
                }
            },
            reconnect: async () => {
                if (!this.syncRuntimeFactory) throw new Error('Google authentication is not configured for this installation');
                const sync = this.settings.sync;
                if (sync.providerId !== 'google') throw new Error('Only Google Calendar is currently supported for connection');
                if (!sync.googleClientId) throw new Error('Please configure a Google Client ID in settings first');
                const clientSecret = await this.getGoogleClientSecret(sync.googleClientId);
                if (!clientSecret) throw new Error('Please save the Google Client Secret in settings first');

                const { createGoogleOAuthProvider } = await import('./services/sync/providers/google/GoogleSyncRuntime');
                const { asGoogleCredentialStore } = await import('./services/sync/lifecycle/SyncLifecycleCoordinator');
                const provider = createGoogleOAuthProvider(sync.googleClientId, clientSecret, asGoogleCredentialStore(this.credentialStore));
                const result = await provider.reconnect(undefined, sync.accountId ?? undefined);
                this.settings.sync.accountId = result.accountId;
                await this.saveSettings();
                if (!this.syncAuthenticationAvailable) {
                    const error = this.syncStateStore.getState().lastError?.message;
                    throw new Error(error ?? 'The Google account was authorized, but its sync session could not be restored.');
                }
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
            getStatus: () => {
                const status = this.syncLifecycle?.service?.status;
                if (status) return status;
                const lastError = this.syncStateStore.getState().lastError?.message;
                return lastError ? { status: 'error', lastError } : undefined;
            },
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
        const rawData = await this.loadData();
        this.credentialStore = createCredentialStore(this.app);
        this.clientSecretStore = createSecretValueStore(this.app);
        this.temporaryLegacyClientSecret = extractLegacyGoogleClientSecret(rawData);
        if (this.temporaryLegacyClientSecret) {
            try {
                await migrateLegacyGoogleClientSecret(rawData, this.clientSecretStore);
                this.temporaryLegacyClientSecret = undefined;
            } catch (error) {
                new Notice(`A saved Google Client Secret could not be moved to SecretStorage. Re-enter it in settings. ${sanitizeSyncUiError(error)}`);
            }
        }
        this.pluginDataStore = new PluginDataStore({
            loadData: () => this.loadData(),
            saveData: data => this.saveData(data),
        }, { defaults: DEFAULT_SETTINGS });
        const loaded = await this.pluginDataStore.load();
        this.settings = loaded.settings;
        this.settings.sync.googleClientSecret = null;
        if (extractLegacyGoogleClientSecret(rawData)) await this.pluginDataStore.saveSettings(this.settings);
        this.syncStateStore = new SyncStateStore(this.pluginDataStore);
        this.calendarEventState = await this.syncStateStore.load();
    }

    async saveGoogleClientSecret(value: string): Promise<void> {
        const clientId = this.settings.sync.googleClientId?.trim();
        const secret = value.trim();
        if (!clientId) throw new Error('Configure a Google Client ID before saving its Client Secret');
        if (!secret) throw new Error('Enter a Google Client Secret');
        await this.clientSecretStore.set(googleClientSecretKey(clientId), secret);
        this.temporaryLegacyClientSecret = undefined;
        await this.saveSettings();
    }

    async clearGoogleClientSecret(): Promise<void> {
        const clientId = this.settings.sync.googleClientId?.trim();
        if (!clientId) return;
        await this.clientSecretStore.remove(googleClientSecretKey(clientId));
        this.temporaryLegacyClientSecret = undefined;
        if (this.settings.sync.providerId && this.settings.sync.accountId) await this.configureSyncLifecycle(true);
    }

    private async getGoogleClientSecret(clientId: string): Promise<string | null> {
        try {
            const secret = await this.clientSecretStore.get(googleClientSecretKey(clientId));
            if (secret) return secret;
        } catch (error) {
            if (this.temporaryLegacyClientSecret?.clientId === clientId) return this.temporaryLegacyClientSecret.secret;
            throw error;
        }
        return this.temporaryLegacyClientSecret?.clientId === clientId
            ? this.temporaryLegacyClientSecret.secret
            : null;
    }

    async saveSettings() {
        await this.pluginDataStore.saveSettings(this.settings);
        this.calendarEventProjection = undefined;
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
