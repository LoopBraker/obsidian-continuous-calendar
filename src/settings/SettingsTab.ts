import { App, PluginSettingTab, Setting, AbstractInputSuggest, prepareFuzzySearch, TextComponent, Notice, TFolder, setIcon, Platform } from 'obsidian';
import type ContinuousCalendarPlugin from '../main';
import type { CalendarSyncSettings, DateProperty, SyncMode } from './settings';
import { HolidaySource } from '../services/holiday/HolidayTypes';
import type { SyncUiActions, SyncUiConflict } from '../components/SyncUi';
import { sanitizeSyncUiError, syncRunNotice } from '../components/SyncUi';
import { createConfirmationDialog } from '../modals/ConfirmationModal';
import { openSyncConflictModal } from '../modals/SyncConflictModal';

export interface SyncSettingsActions extends SyncUiActions {
	readonly onSettingsChanged?: () => Promise<void> | void;
}

export function clampSyncInterval(value: number): number {
	if (!Number.isFinite(value)) return 5;
	return Math.min(1440, Math.max(1, Math.round(value)));
}

export function syncConnectionLabel(
	sync: CalendarSyncSettings,
	lifecycleStarted: boolean,
	authenticationAvailable: boolean,
	authenticationIssueCode?: string,
	credentialPersistence: 'secure' | 'session-only' = 'secure',
): string {
	if (!Platform.isDesktopApp) return 'Desktop sync unavailable on this device';
	if (!sync.providerId || !sync.accountId) return 'Not connected';
	if (!authenticationAvailable && authenticationIssueCode === 'google-client-secret-missing') return 'Enter Google Client Secret to restore sync';
	if (!authenticationAvailable) return 'Reconnect required';
	if (!sync.calendarId) return 'Connected — choose a calendar';
	if (credentialPersistence === 'session-only') return 'Connected for this session only';
	return lifecycleStarted ? 'Connected and ready' : 'Connected — waiting for sync';
}

// Helper function to get all folder paths
function getAllFolderPaths(app: App): string[] {
    const folders: string[] = [];
    const root = app.vault.getRoot();
    if (!(root instanceof TFolder)) {
        return [];
    }

    function traverse(folder: TFolder) {
        folders.push(folder.path);
        for (const child of folder.children) {
            if (child instanceof TFolder) {
                traverse(child);
            }
        }
    }

    traverse(root);
    return folders;
}

// FolderSuggest class for folder autocomplete
class FolderSuggest extends AbstractInputSuggest<string> {
    private allFolders: string[];

    constructor(app: App, private inputEl: HTMLInputElement) {
        super(app, inputEl);
        this.allFolders = getAllFolderPaths(app);
        this.inputEl.addEventListener("input", this.onInputOrFocus.bind(this));
        this.inputEl.addEventListener("focus", this.onInputOrFocus.bind(this));
    }

    onInputOrFocus() {
        if (!this.inputEl.value && document.activeElement !== this.inputEl) {
            this.close();
            return;
        }
        this.open();
        // @ts-ignore
    }

    getSuggestions(query: string): string[] {
        const lowerCaseQuery = query.toLowerCase();
        try {
            if (!query) {
                return this.allFolders;
            }
            const searchFn = prepareFuzzySearch(query);
            const matches: { item: string, match: any }[] = [];

            for (const folder of this.allFolders) {
                const match = searchFn(folder);
                if (match) {
                    matches.push({ item: folder, match: match });
                }
            }

            matches.sort((a, b) => b.match.score - a.match.score);
            return matches.map((m) => m.item);
        } catch (e) {
            return this.allFolders.filter((folderPath) =>
                folderPath.toLowerCase().includes(lowerCaseQuery)
            );
        }
    }

    renderSuggestion(folderPath: string, el: HTMLElement): void {
        const displayPath = folderPath === "" ? "/" : folderPath;
        el.setText(displayPath);
    }

    selectSuggestion(folderPath: string, evt: MouseEvent | KeyboardEvent): void {
        this.inputEl.value = folderPath === "" ? "/" : folderPath;
        this.inputEl.dispatchEvent(new Event("input"));
        this.close();
    }
}

// Available color options for dropdowns
const AVAILABLE_COLOR_OPTIONS: Record<string, string> = {
    'Red pale': 'var(--color-red-tint)',
    'Grey pale': 'var(--color-grey-tint)',
    'Orange pale': 'var(--color-orange-tint)',
    'Yellow pale': 'var(--color-yellow-tint)',
    'Green pale': 'var(--color-green-tint)',
    'Mint pale': 'var(--color-mint-tint)',
    'Cyan pale': 'var(--color-cyan-tint)',
    'Blue pale': 'var(--color-blue-tint)',
    'Purple pale': 'var(--color-purple-tint)',
    'Red': 'var(--color-red-text)',
    'Grey': 'var(--color-grey-text)',
    'Orange': 'var(--color-orange-text)',
    'Yellow': 'var(--color-yellow-text)',
    'Green': 'var(--color-green-text)',
    'Mint': 'var(--color-mint-text)',
    'Cyan': 'var(--color-cyan-text)',
    'Blue': 'var(--color-blue-text)',
    'Purple': 'var(--color-purple-text)',
};

// --- Tag Suggester Class ---
class TagSuggest extends AbstractInputSuggest<string> {
    private allTags: string[];

    constructor(app: App, private inputEl: HTMLInputElement) {
        super(app, inputEl);
        // @ts-ignore
        this.allTags = Object.keys(app.metadataCache.getTags() || {});
        this.inputEl.addEventListener("input", this.onInput.bind(this));
        this.inputEl.addEventListener("focus", this.onInput.bind(this));
    }

    onInput() {
        if (!this.inputEl.value) {
            this.close();
            return;
        }
        this.open();
        // @ts-ignore
    }

    getSuggestions(query: string): string[] {
        const lowerCaseQuery = query.toLowerCase();
        try {
            if (!query) return this.allTags.slice(0, 50);

            const searchFn = prepareFuzzySearch(query);
            const matches: { item: string, match: any }[] = [];

            for (const tag of this.allTags) {
                const match = searchFn(tag);
                if (match) {
                    matches.push({ item: tag, match: match });
                }
            }

            // Sort by score
            matches.sort((a, b) => b.match.score - a.match.score);

            return matches.map((m) => m.item);
        } catch (e) {
            return this.allTags.filter((tag) =>
                tag.toLowerCase().includes(lowerCaseQuery)
            );
        }
    }

    renderSuggestion(tag: string, el: HTMLElement): void {
        el.setText(tag);
    }

    selectSuggestion(tag: string, evt: MouseEvent | KeyboardEvent): void {
        this.inputEl.value = tag;
        this.inputEl.dispatchEvent(new Event("input"));
        this.close();
    }
}

// --- Property Suggester Class ---
class PropertySuggest extends AbstractInputSuggest<string> {
    private allProperties: string[];

    constructor(app: App, private inputEl: HTMLInputElement) {
        super(app, inputEl);
        this.allProperties = this.getAllProperties();
        this.inputEl.addEventListener("input", this.onInput.bind(this));
        this.inputEl.addEventListener("focus", this.onInput.bind(this));
    }

    private getAllProperties(): string[] {
        const properties = new Set<string>();
        const files = this.app.vault.getMarkdownFiles();

        files.forEach((file) => {
            const cache = this.app.metadataCache.getFileCache(file);
            const frontmatter = cache?.frontmatter;
            if (frontmatter) {
                Object.keys(frontmatter).forEach((key) => {
                    // Skip internal keys like 'position'
                    if (key !== 'position') {
                        properties.add(key);
                    }
                });
            }
        });

        return Array.from(properties).sort();
    }

    onInput() {
        if (!this.inputEl.value && document.activeElement !== this.inputEl) {
            this.close();
            return;
        }
        this.open();
        // @ts-ignore
    }

    getSuggestions(query: string): string[] {
        const lowerCaseQuery = query.toLowerCase();
        try {
            if (!query) return this.allProperties.slice(0, 50);

            const searchFn = prepareFuzzySearch(query);
            const matches: { item: string; match: any }[] = [];

            for (const prop of this.allProperties) {
                const match = searchFn(prop);
                if (match) {
                    matches.push({ item: prop, match: match });
                }
            }

            // Sort by score
            matches.sort((a, b) => b.match.score - a.match.score);

            return matches.map((m) => m.item);
        } catch (e) {
            return this.allProperties.filter((prop) =>
                prop.toLowerCase().includes(lowerCaseQuery)
            );
        }
    }

    renderSuggestion(property: string, el: HTMLElement): void {
        el.setText(property);
    }

    selectSuggestion(property: string, evt: MouseEvent | KeyboardEvent): void {
        this.inputEl.value = property;
        this.inputEl.dispatchEvent(new Event("input"));
        this.close();
    }
}

export type SettingsTabId = 'general' | 'tasks' | 'holidays' | 'sync';

export class CalendarSettingTab extends PluginSettingTab {
    plugin: ContinuousCalendarPlugin;
    private activeTab: SettingsTabId = 'general';
    private readonly syncActions?: SyncSettingsActions;

    constructor(app: App, plugin: ContinuousCalendarPlugin, syncActions?: SyncSettingsActions) {
        super(app, plugin);
        this.plugin = plugin;
        this.syncActions = syncActions ?? (plugin as unknown as { syncUiActions?: SyncSettingsActions }).syncUiActions;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h1', { text: 'Calendar Plugin Settings' });

        this.renderTabNav(containerEl);

        const contentEl = containerEl.createDiv('calendar-settings-tab-content');

        switch (this.activeTab) {
            case 'general':
                this.renderGeneralTab(contentEl);
                break;
            case 'tasks':
                this.renderTasksTab(contentEl);
                break;
            case 'holidays':
                this.renderHolidaysTab(contentEl);
                break;
            case 'sync':
                this.renderSyncTab(contentEl);
                break;
        }
    }

    private renderTabNav(containerEl: HTMLElement): void {
        const navEl = containerEl.createDiv('calendar-settings-tab-nav');

        const tabs: { id: SettingsTabId; label: string; icon: string }[] = [
            { id: 'general', label: 'General', icon: 'sliders-horizontal' },
            { id: 'tasks', label: 'Tasks', icon: 'check-square' },
            { id: 'holidays', label: 'Holidays', icon: 'calendar' },
        ];
        if (Platform.isDesktopApp) tabs.push({ id: 'sync', label: 'Sync', icon: 'refresh-cw' });

        tabs.forEach((tab) => {
            const btn = navEl.createEl('button', {
                cls: `calendar-settings-tab-btn ${this.activeTab === tab.id ? 'is-active' : ''}`,
            });

            const iconSpan = btn.createSpan('calendar-settings-tab-icon');
            setIcon(iconSpan, tab.icon);

            btn.createSpan({ text: tab.label });

            btn.addEventListener('click', () => {
                if (this.activeTab !== tab.id) {
                    this.activeTab = tab.id;
                    this.display();
                }
            });
        });
    }

    private renderGeneralTab(containerEl: HTMLElement): void {
        const generalContainer = containerEl.createDiv('calendar-settings-container');

        // Section 1: Default Visuals
        const visualsHeader = generalContainer.createDiv('calendar-settings-section-header');
        visualsHeader.createEl('h3', { text: 'Default Visuals' });

        const visualsCard = generalContainer.createDiv('calendar-settings-card');

        // Default Dot Color
        new Setting(visualsCard)
            .setName('Default Event Dot Color')
            .setDesc('Fallback color for event dots if no color is specified')
            .addDropdown((dropdown) => {
                Object.keys(AVAILABLE_COLOR_OPTIONS).forEach((friendlyName) => {
                    const cssVar = AVAILABLE_COLOR_OPTIONS[friendlyName];
                    dropdown.addOption(cssVar, friendlyName);
                });

                dropdown.setValue(this.plugin.settings.defaultDotColor);

                const colorPreview = dropdown.selectEl.parentElement?.createDiv('calendar-settings-color-swatch');
                if (colorPreview) colorPreview.style.backgroundColor = this.plugin.settings.defaultDotColor;

                dropdown.onChange(async (value: string) => {
                    this.plugin.settings.defaultDotColor = value;
                    await this.plugin.saveSettings();
                    if (colorPreview) {
                        colorPreview.style.backgroundColor = value;
                    }
                });
            });

        // Default Bar Color
        new Setting(visualsCard)
            .setName('Default Range Bar Color')
            .setDesc('Fallback color for range bars if no color is specified')
            .addDropdown((dropdown) => {
                Object.keys(AVAILABLE_COLOR_OPTIONS).forEach((friendlyName) => {
                    const cssVar = AVAILABLE_COLOR_OPTIONS[friendlyName];
                    dropdown.addOption(cssVar, friendlyName);
                });

                dropdown.setValue(this.plugin.settings.defaultBarColor);

                const colorPreview = dropdown.selectEl.parentElement?.createDiv('calendar-settings-color-swatch');
                if (colorPreview) colorPreview.style.backgroundColor = this.plugin.settings.defaultBarColor;

                dropdown.onChange(async (value: string) => {
                    this.plugin.settings.defaultBarColor = value;
                    await this.plugin.saveSettings();
                    if (colorPreview) {
                        colorPreview.style.backgroundColor = value;
                    }
                });
            });

        // Section 2: Creation Prompts & Behavior
        const behaviorHeader = generalContainer.createDiv('calendar-settings-section-header');
        behaviorHeader.createEl('h3', { text: 'Creation Prompts & Behavior' });

        const behaviorCard = generalContainer.createDiv('calendar-settings-card');

        // Confirm before creating daily notes
        new Setting(behaviorCard)
            .setName('Confirm before creating daily notes')
            .setDesc('Show a confirmation dialog when creating a new daily note')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.shouldConfirmBeforeCreate)
                    .onChange(async (value) => {
                        this.plugin.settings.shouldConfirmBeforeCreate = value;
                        await this.plugin.saveSettings();
                    })
            );

        // Confirm before creating range notes
        new Setting(behaviorCard)
            .setName('Confirm before creating range notes')
            .setDesc('Show a confirmation dialog when creating a note for a date range')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.shouldConfirmBeforeCreateRange)
                    .onChange(async (value) => {
                        this.plugin.settings.shouldConfirmBeforeCreateRange = value;
                        await this.plugin.saveSettings();
                    })
            );

        // Collapse duplicate icons
        new Setting(behaviorCard)
            .setName('Collapse duplicate icons')
            .setDesc('Show just one icon per tag/property per day, even if several notes share that tag or property')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.collapseDuplicateTagSymbols)
                    .onChange(async (value) => {
                        this.plugin.settings.collapseDuplicateTagSymbols = value;
                        await this.plugin.saveSettings();
                    })
            );

        // Section 3: Tag-Based Colors
        this.renderTagColorSettings(generalContainer);

        // Section 4: Custom Date Properties
        this.renderCustomDatePropertiesSettings(generalContainer);
    }

    private renderSyncTab(containerEl: HTMLElement): void {
        const sync = this.plugin.settings.sync;
        const syncContainer = containerEl.createDiv('calendar-sync-settings');
        syncContainer.createEl('h2', { text: 'Calendar synchronization' });
        syncContainer.createEl('p', {
            text: 'Sync is desktop-only and opt-in. Provider access is supplied by the plugin lifecycle; this panel never creates an OAuth client or stores a token.',
            cls: 'setting-item-description',
        });

        if (!Platform.isDesktopApp) {
            const mobileNotice = syncContainer.createDiv('calendar-settings-callout');
            setIcon(mobileNotice.createSpan(), 'monitor');
            mobileNotice.createSpan({ text: 'Synchronization controls are hidden on mobile. Your local calendar remains available.' });
            return;
        }

        const connectionCard = syncContainer.createDiv('calendar-settings-card sync-connection-card');
        const connectionHeader = connectionCard.createDiv('sync-connection-header');
        connectionHeader.createEl('h3', { text: 'Connection' });
        const connected = Boolean(sync.accountId && this.plugin.syncAuthenticationAvailable);
        const connectionState = connectionHeader.createSpan({
            text: this.getConnectionLabel(),
            cls: `sync-connection-state ${connected ? 'is-connected' : 'is-disconnected'}`,
        });

        new Setting(connectionCard)
            .setName('Provider')
            .setDesc('Choose the provider that the lifecycle callback will authenticate.')
            .addDropdown(dropdown => {
                dropdown.addOption('', 'Not connected');
                dropdown.addOption('google', 'Google Calendar');
                if (sync.providerId === 'microsoft') dropdown.addOption('microsoft', 'Microsoft Outlook (deferred)');
                dropdown.setValue(sync.providerId ?? '');
                dropdown.onChange(async value => {
                    sync.providerId = value === 'google' || value === 'microsoft' ? value : null;
                    if (!sync.providerId) {
                        sync.accountId = null;
                        sync.calendarId = null;
                    }
                    await this.saveSyncSettings();
                    this.display();
                });
            });

        if (sync.providerId === 'google') {
            new Setting(connectionCard)
                .setName('Google Client ID')
                .setDesc('Supply a testing Google OAuth Client ID (Desktop app type). Do not commit your credentials.')
                .addText(text => {
                    text.setValue(sync.googleClientId ?? '')
                        .setPlaceholder('client-id.apps.googleusercontent.com')
                        .onChange(async value => {
                            sync.googleClientId = value.trim() || null;
                            await this.saveSyncSettings();
                        });
                });

            let clientSecretInput: HTMLInputElement | undefined;
            new Setting(connectionCard)
                .setName('Google Client Secret')
                .setDesc('Saved in Obsidian SecretStorage, not plugin settings. Leave blank to keep the saved value; enter a value to save or replace it.')
                .addText(text => {
                    text.setPlaceholder('Enter to save or replace');
                    text.inputEl.type = 'password';
                    text.inputEl.autocomplete = 'new-password';
                    text.inputEl.setAttribute('aria-label', 'Google Client Secret');
                    clientSecretInput = text.inputEl;
                })
                .addButton(button => button
                    .setButtonText('Save securely')
                    .onClick(async () => {
                        try {
                            await this.plugin.saveGoogleClientSecret(clientSecretInput?.value ?? '');
                            if (clientSecretInput) clientSecretInput.value = '';
                            new Notice('Google Client Secret saved securely');
                            this.display();
                        } catch (error) {
                            new Notice(`Google Client Secret could not be saved: ${sanitizeSyncUiError(error)}`);
                        }
                    }));
        }

        new Setting(connectionCard)
            .setName('Account')
            .setDesc(sync.accountId ? 'Authenticated account supplied by the lifecycle.' : 'Connect an account to select a calendar.')
            .addText(text => {
                text.setValue(sync.accountId ?? '').setDisabled(true);
                text.inputEl.setAttribute('aria-label', 'Connected calendar account');
            });

        new Setting(connectionCard)
            .setName('Calendar')
            .setDesc('Only writable calendars are offered by the injected provider callback.')
            .addDropdown(dropdown => {
                dropdown.addOption('', 'Select a calendar');
                if (sync.calendarId) dropdown.setValue(sync.calendarId);
                void this.populateCalendars(dropdown);
                dropdown.onChange(async value => {
                    sync.calendarId = value || null;
                    await this.saveSyncSettings();
                });
            });

        const isConnected = !!sync.accountId;
        
        new Setting(connectionCard)
            .setName('Actions')
            .setDesc('Connect authorizes the plugin. Reconnect restores an expired or missing session without clearing cached events. Disconnect removes this calendar\'s cached events while preserving notes and Google events.')
            .addButton(button => button
                .setButtonText('Sync now')
                .setCta()
                .onClick(() => { void this.runSyncNow(connectionState); }))
            .addButton(button => button
                .setButtonText(isConnected ? 'Reconnect' : 'Connect')
                .onClick(() => {
                    if (isConnected) void this.reconnect(connectionState);
                    else void this.connect(connectionState);
                }))
            .addButton(button => button
                .setButtonText('Disconnect')
                .setWarning()
                .onClick(() => this.confirmDisconnect()));

        const configurationCard = syncContainer.createDiv('calendar-settings-card');
        configurationCard.createEl('h3', { text: 'Sync configuration' });
        new Setting(configurationCard)
            .setName('Event folder')
            .setDesc('Notes you choose to create for calendar events are stored here. Existing notes are never moved automatically.')
            .addText(text => {
                text.setValue(sync.eventFolder === '' ? '/' : sync.eventFolder)
                    .setPlaceholder('Calendar Events')
                    .onChange(async value => {
                        sync.eventFolder = value.trim() === '/' ? '' : value.trim();
                        await this.saveSyncSettings();
                    });
                new FolderSuggest(this.app, text.inputEl);
            });
        new Setting(configurationCard)
            .setName('Timezone')
            .setDesc('IANA timezone used for the bounded sync window and event defaults.')
            .addText(text => text.setValue(sync.timezone).onChange(async value => {
                if (value.trim()) {
                    sync.timezone = value.trim();
                    await this.saveSyncSettings();
                }
            }));
        new Setting(configurationCard)
            .setName('Polling interval (minutes)')
            .setDesc('The lifecycle bounds polling while Obsidian is open.')
            .addText(text => text
                .setValue(String(sync.pollIntervalMinutes))
                .onChange(async value => {
                    const numeric = Number(value);
                    if (!Number.isFinite(numeric) || numeric <= 0) return;
                    sync.pollIntervalMinutes = clampSyncInterval(numeric);
                    await this.saveSyncSettings();
                }));
        new Setting(configurationCard)
            .setName('Past horizon (days)')
            .addText(text => text
                .setValue(String(sync.horizon.pastDays))
                .onChange(async value => {
                    const numeric = Number(value);
                    if (!Number.isInteger(numeric) || numeric < 0) return;
                    sync.horizon.pastDays = numeric;
                    await this.saveSyncSettings();
                }));
        new Setting(configurationCard)
            .setName('Future horizon (days)')
            .addText(text => text
                .setValue(String(sync.horizon.futureDays))
                .onChange(async value => {
                    const numeric = Number(value);
                    if (!Number.isInteger(numeric) || numeric < 0) return;
                    sync.horizon.futureDays = numeric;
                    await this.saveSyncSettings();
                }));
        new Setting(configurationCard)
            .setName('Mode')
            .setDesc('Dry run previews without saving events. Import only caches Google events and allows optional personal notes. Bidirectional also enables event creation and editing.')
            .addDropdown(dropdown => {
                const modes: Array<[SyncMode, string]> = [
                    ['disabled', 'Disabled'],
                    ['dry-run', 'Dry run / preview'],
                    ['import-only', 'Import only'],
                    ['bidirectional', 'Bidirectional'],
                ];
                modes.forEach(([value, label]) => dropdown.addOption(value, label));
                dropdown.setValue(sync.syncMode);
                dropdown.onChange(async value => {
                    sync.syncMode = value as SyncMode;
                    await this.saveSyncSettings();
                });
            });

        const status = this.syncActions?.getStatus?.();
        if (status?.lastError) {
            const errorCallout = syncContainer.createDiv('calendar-settings-callout is-error');
            setIcon(errorCallout.createSpan(), 'alert-triangle');
            errorCallout.createSpan({ text: `Last sync error: ${sanitizeSyncUiError(status.lastError)}` });
        }

        if (sync.accountId && this.plugin.syncCredentialPersistence === 'session-only') {
            const persistenceNotice = syncContainer.createDiv('calendar-settings-callout is-error');
            setIcon(persistenceNotice.createSpan(), 'alert-triangle');
            persistenceNotice.createSpan({
                text: 'Obsidian SecretStorage is unavailable. This connection lasts only until Obsidian closes; use an Obsidian version that supports SecretStorage to keep it connected after restart.',
            });
        }

        const conflicts = syncContainer.createDiv('sync-conflict-settings');
        conflicts.createEl('h3', { text: 'Conflicts' });
        const conflictBody = conflicts.createDiv('sync-conflict-list');
        void this.loadConflicts(conflictBody);
    }

    private async saveSyncSettings(): Promise<void> {
        try {
            await this.plugin.saveSettings();
            await this.syncActions?.onSettingsChanged?.();
        } catch (error) {
            new Notice(`Sync settings were not saved: ${sanitizeSyncUiError(error)}`);
        }
    }

    private getConnectionLabel(): string {
        return syncConnectionLabel(
            this.plugin.settings.sync,
            Boolean(this.plugin.syncLifecycle?.isStarted),
            this.plugin.syncAuthenticationAvailable,
            this.plugin.syncAuthenticationErrorCode,
            this.plugin.syncCredentialPersistence,
        );
    }

    private async populateCalendars(dropdown: { addOption(value: string, label: string): unknown; setValue(value: string): unknown }): Promise<void> {
        if (!this.syncActions?.listCalendars) return;
        try {
            const calendars = await this.syncActions.listCalendars();
            for (const calendar of calendars) {
                if (calendar.writable === false) continue;
                dropdown.addOption(calendar.calendarId, calendar.name);
            }
            dropdown.setValue(this.plugin.settings.sync.calendarId ?? '');
        } catch (error) {
            new Notice(`Calendars could not be loaded: ${sanitizeSyncUiError(error)}`);
        }
    }

    private async runSyncNow(connectionState: HTMLElement): Promise<void> {
        try {
            const run = this.syncActions?.syncNow
                ? this.syncActions.syncNow()
                : this.plugin.syncLifecycle?.syncNow('manual');
            if (run === undefined) {
                connectionState.setText(this.getConnectionLabel());
                new Notice('Calendar sync is not running');
                return;
            }
            const result = await run;
            connectionState.setText(this.getConnectionLabel());
            new Notice(result === undefined ? 'Calendar sync is not running' : syncRunNotice(result));
        } catch (error) {
            new Notice(`Sync could not start: ${sanitizeSyncUiError(error)}`);
        }
    }

    private async connect(connectionState: HTMLElement): Promise<void> {
        if (!this.syncActions?.connect) {
            new Notice('Connect is not available until the plugin supplies an authentication callback.');
            return;
        }
        try {
            await this.syncActions.connect();
            connectionState.setText(this.getConnectionLabel());
            new Notice('Calendar account connected');
            this.display();
        } catch (error) {
            console.warn('[Calendar Sync] Connect failed:', sanitizeSyncUiError(error));
            new Notice(`Connect failed: ${sanitizeSyncUiError(error)}`);
        }
    }

    private async reconnect(connectionState: HTMLElement): Promise<void> {
        if (!this.syncActions?.reconnect) {
            new Notice('Reconnect is not available until the plugin supplies an authentication callback.');
            return;
        }
        try {
            await this.syncActions.reconnect();
            connectionState.setText(this.getConnectionLabel());
            new Notice('Calendar account reconnected');
            this.display();
        } catch (error) {
            new Notice(`Reconnect failed: ${sanitizeSyncUiError(error)}`);
        }
    }

    private confirmDisconnect(): void {
        createConfirmationDialog(this.app, {
            title: 'Disconnect calendar sync?',
            text: 'This clears cached Google events and the connection. Linked notes and events in Google Calendar are preserved.',
            cta: 'Disconnect',
            onAccept: async () => {
                if (!this.syncActions?.disconnect) {
                    new Notice('Disconnect is not available until the plugin supplies a lifecycle callback.');
                    return;
                }
                try {
                    await this.syncActions.disconnect();
                    this.plugin.settings.sync = {
                        ...this.plugin.settings.sync,
                        providerId: null,
                        accountId: null,
                        calendarId: null,
                        syncMode: 'disabled',
                    };
                    await this.saveSyncSettings();
                    new Notice('Calendar disconnected; cached events cleared and notes preserved.');
                    this.display();
                } catch (error) {
                    new Notice(`Disconnect failed: ${sanitizeSyncUiError(error)}`);
                }
            },
        });
    }

    private async loadConflicts(containerEl: HTMLElement): Promise<void> {
        if (!this.syncActions?.getConflicts) {
            containerEl.createEl('p', { text: 'No conflict provider is attached.', cls: 'setting-item-description' });
            return;
        }
        try {
            const conflicts = await this.syncActions.getConflicts();
            if (conflicts.length === 0) {
                containerEl.createEl('p', { text: 'No unresolved conflicts.', cls: 'setting-item-description' });
                return;
            }
            for (const conflict of conflicts) this.renderConflictCard(containerEl, conflict);
        } catch (error) {
            containerEl.createEl('p', { text: `Conflicts could not be loaded: ${sanitizeSyncUiError(error)}`, cls: 'sync-form-error' });
        }
    }

    private renderConflictCard(containerEl: HTMLElement, conflict: SyncUiConflict): void {
        const card = containerEl.createDiv('sync-conflict-card');
        card.createEl('strong', { text: conflict.local.title || 'Untitled event' });
        card.createEl('p', { text: `Local: ${conflict.local.start} → ${conflict.local.end}` });
        card.createEl('p', { text: `Remote: ${conflict.remote.start} → ${conflict.remote.end}` });
        const controls = card.createDiv('sync-conflict-actions');
        controls.createEl('button', { text: 'Compare all fields' }).addEventListener('click', () => {
            openSyncConflictModal(this.app, {
                key: conflict.key,
                local: conflict.local,
                remote: conflict.remote,
                onResolve: async choice => {
                    await this.syncActions?.resolveConflict?.(conflict.key, choice);
                    this.display();
                },
            });
        });
        controls.createEl('button', { text: 'Keep local', cls: 'mod-cta' }).addEventListener('click', () => {
            void this.resolveConflict(conflict.key, 'local');
        });
        controls.createEl('button', { text: 'Keep remote' }).addEventListener('click', () => {
            void this.resolveConflict(conflict.key, 'remote');
        });
    }

    private async resolveConflict(key: string, choice: 'local' | 'remote'): Promise<void> {
        try {
            await this.syncActions?.resolveConflict?.(key, choice);
            new Notice(`Conflict resolved using ${choice} values`);
            this.display();
        } catch (error) {
            new Notice(`Conflict resolution failed: ${sanitizeSyncUiError(error)}`);
        }
    }

    private renderTasksTab(containerEl: HTMLElement): void {
        this.renderTaskSettings(containerEl);
    }

    private renderHolidaysTab(containerEl: HTMLElement): void {
        this.renderHolidaySettings(containerEl);
    }

    private renderTaskSettings(containerEl: HTMLElement): void {
        containerEl.createEl("h2", { text: "Properties related to TASKS" });
        containerEl.createEl("p", {
            text: "Customize the appearance of task-related dates in the calendar.",
            cls: "setting-item-description",
        });

        const taskProps = [
            { key: 'scheduled', name: 'Scheduled Date' },
            { key: 'due', name: 'Due Date' },
            { key: 'completed', name: 'Completed Date & Instances' }
        ];

        taskProps.forEach(prop => {
            const key = prop.key as keyof typeof this.plugin.settings.taskSettings;
            // Ensure object exists (migration safety)
            if (!this.plugin.settings.taskSettings[key]) {
                this.plugin.settings.taskSettings[key] = {};
            }
            const settings = this.plugin.settings.taskSettings[key];

            const settingItem = new Setting(containerEl).setName(prop.name);

            // Color Dropdown
            settingItem.addDropdown((dd) => {
                Object.keys(AVAILABLE_COLOR_OPTIONS).forEach((k) => {
                    dd.addOption(AVAILABLE_COLOR_OPTIONS[k], k);
                });
                // Find readable name from value or default
                const initialColor = settings.color || '';
                dd.setValue(initialColor);

                // If the stored color isn't one of the options (e.g. customized manually in file), simpler to just show it or default
                // But for this UI based on AVAILABLE_COLOR_OPTIONS, we try to match.

                dd.onChange(async (val) => {
                    settings.color = val;
                    colorPreview.style.backgroundColor = val;
                    await this.plugin.saveSettings();
                    this.plugin.calendarIndex.indexVault();
                });
            });

            // Symbol
            settingItem.addText((text) => {
                text.setPlaceholder("Sym")
                    .setValue(settings.symbol || "")
                    .onChange(async (val) => {
                        settings.symbol = val;
                        await this.plugin.saveSettings();
                        this.plugin.calendarIndex.indexVault();
                    });
            });

            // Color Preview Dot
            const colorPreview = settingItem.controlEl.createEl("div");
            colorPreview.style.display = "inline-block";
            colorPreview.style.width = "15px";
            colorPreview.style.height = "15px";
            colorPreview.style.borderRadius = "50%";
            colorPreview.style.marginLeft = "10px";
            colorPreview.style.verticalAlign = "middle";
            colorPreview.style.backgroundColor = settings.color || 'transparent';
        });
    }

    private renderCustomDatePropertiesSettings(containerEl: HTMLElement): void {
        const header = containerEl.createDiv('calendar-settings-section-header');
        header.createEl('h3', { text: 'Custom Date Properties' });
        const propCount = this.plugin.settings.customDateProperties.length;
        header.createSpan({
            text: `${propCount} ${propCount === 1 ? 'property' : 'properties'}`,
            cls: 'calendar-settings-count-badge',
        });

        // Info Callout
        const callout = containerEl.createDiv('calendar-settings-callout');
        const iconSpan = callout.createSpan();
        setIcon(iconSpan, 'info');
        callout.createSpan({
            text: 'Frontmatter properties defined here are treated as dates. Adding or removing properties will trigger a full re-index of your vault.'
        });

        // --- Dots-only toggle for properties ---
        new Setting(containerEl)
            .setName('Show dots only in calendar (properties)')
            .setDesc('Replace property icons with colored dots in calendar view. Icons will still appear in Day Detail view.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.useDotsOnlyForProperties)
                    .onChange(async (value) => {
                        this.plugin.settings.useDotsOnlyForProperties = value;
                        await this.plugin.saveSettings();
                    })
            );

        // --- Display Current Custom Properties ---
        const propertiesListEl = containerEl.createDiv('custom-date-properties-list');
        if (this.plugin.settings.customDateProperties.length === 0) {
            const emptyEl = propertiesListEl.createDiv('holiday-empty-state');
            const emptyIconEl = emptyEl.createSpan('holiday-empty-state-icon');
            setIcon(emptyIconEl, 'calendar-clock');
            emptyEl.createDiv({ text: 'No Custom Date Properties Defined', cls: 'holiday-empty-state-title' });
            emptyEl.createEl('p', {
                text: 'Define custom frontmatter properties (e.g. birthday, anniversary) below.',
                cls: 'holiday-empty-state-desc',
            });
        } else {
            this.renderCustomDateProperties(propertiesListEl);
        }

        // --- Add New Custom Property Controls ---
        const addHeader = containerEl.createDiv('calendar-settings-section-header');
        addHeader.createEl('h4', { text: 'Add New Date Property' });
        this.renderAddCustomDatePropertyControls(containerEl);
    }

    private renderCustomDateProperties(containerEl: HTMLElement): void {
        this.plugin.settings.customDateProperties.forEach((prop, index) => {
            const itemWrapper = containerEl.createDiv('calendar-mapping-item');
            const settingItem = new Setting(itemWrapper);

            // Left side: Name + Recurring Badge
            settingItem.nameEl.empty();
            settingItem.nameEl.createSpan({
                text: prop.name,
                cls: 'calendar-settings-prop-name',
            });

            if (prop.isRecurring) {
                const recurringBadge = settingItem.nameEl.createSpan({
                    cls: 'calendar-settings-recurring-badge',
                });
                const iconSpan = recurringBadge.createSpan();
                setIcon(iconSpan, 'repeat');
                recurringBadge.createSpan({ text: 'Annual' });
            }

            // Color Dropdown
            settingItem.addDropdown((dd) => {
                Object.keys(AVAILABLE_COLOR_OPTIONS).forEach((key) => {
                    dd.addOption(AVAILABLE_COLOR_OPTIONS[key], key);
                });
                dd.setValue(prop.color || AVAILABLE_COLOR_OPTIONS['Red pale']);

                dd.onChange(async (newVar) => {
                    prop.color = newVar;
                    colorPreview.style.backgroundColor = newVar;
                    await this.plugin.saveSettings();
                    this.plugin.calendarIndex.indexVault();
                });
            });

            // Symbol Textbox (compact)
            settingItem.addText((text) => {
                text
                    .setPlaceholder("●")
                    .setValue(prop.symbol ?? "")
                    .onChange(async (val) => {
                        prop.symbol = val.trim() || undefined;
                        await this.plugin.saveSettings();
                        this.plugin.calendarIndex.indexVault();
                    });
                text.inputEl.style.width = '55px';
                text.inputEl.style.textAlign = 'center';
            });

            // Color Preview Dot
            const colorPreview = settingItem.controlEl.createDiv('calendar-settings-color-swatch');
            colorPreview.style.backgroundColor = prop.color || AVAILABLE_COLOR_OPTIONS['Red pale'];

            // Remove Button
            settingItem.addButton((button) =>
                button
                    .setIcon('trash')
                    .setTooltip(`Remove property ${prop.name}`)
                    .setWarning()
                    .onClick(async () => {
                        this.plugin.settings.customDateProperties.splice(index, 1);
                        await this.plugin.saveSettings();
                        new Notice(`Removed date property: ${prop.name}`);
                        this.display();
                        this.plugin.calendarIndex.indexVault();
                    })
            );
        });
    }

    private renderAddCustomDatePropertyControls(containerEl: HTMLElement): void {
        let newName = "";
        let newSymbol = "●";
        let selectedColorVar = AVAILABLE_COLOR_OPTIONS["Red pale"];
        let isRecurring = false;

        const card = containerEl.createDiv('calendar-settings-card');

        // Field 1: Property Name
        new Setting(card)
            .setName('Property Name')
            .setDesc('Frontmatter property key to treat as a date (e.g. due_date)')
            .addText((text) => {
                text
                    .setPlaceholder("due_date")
                    .onChange((v) => (newName = v.trim()));
                new PropertySuggest(this.app, text.inputEl);
            });

        // Field 2: Symbol
        new Setting(card)
            .setName('Display Symbol')
            .setDesc('Symbol or emoji for this property (e.g. ⏰)')
            .addText((text) => {
                text
                    .setPlaceholder("● / ⏰ / * …")
                    .onChange((v) => (newSymbol = v.trim() || "●"));
            });

        // Field 3: Color
        new Setting(card)
            .setName('Property Color')
            .setDesc('Indicator color on the calendar')
            .addDropdown((dd) => {
                for (const key of Object.keys(AVAILABLE_COLOR_OPTIONS)) {
                    dd.addOption(AVAILABLE_COLOR_OPTIONS[key], key);
                }
                dd.setValue(selectedColorVar);
                dd.onChange((v) => (selectedColorVar = v));
            });

        // Field 4: Recurring
        new Setting(card)
            .setName('Recurring Annually')
            .setDesc('Repeat this date every year (e.g. birthdays or anniversaries)')
            .addToggle((toggle) => {
                toggle
                    .setValue(isRecurring)
                    .onChange((v) => (isRecurring = v));
            });

        // Action Footer
        const footer = card.createDiv('calendar-settings-card-footer');
        const addBtn = footer.createEl('button', {
            cls: 'mod-cta',
            text: 'Add Property',
        });

        addBtn.addEventListener('click', async () => {
            if (!newName) {
                new Notice("Enter a property name first");
                return;
            }
            if (this.plugin.settings.customDateProperties.some(p => p.name === newName)) {
                new Notice(`Property "${newName}" already exists`);
                return;
            }

            const newProp: DateProperty = {
                name: newName,
                color: selectedColorVar,
                symbol: newSymbol,
                isRecurring: isRecurring,
            };

            this.plugin.settings.customDateProperties.push(newProp);
            await this.plugin.saveSettings();
            this.display();

            new Notice(`Added date property: ${newName}`);
            this.plugin.calendarIndex.indexVault();
        });
    }


    private renderTagColorSettings(containerEl: HTMLElement): void {
        const header = containerEl.createDiv('calendar-settings-section-header');
        header.createEl('h3', { text: 'Tag-Based Default Colors' });
        const tagCount = Object.keys(this.plugin.settings.tagAppearance).length;
        header.createSpan({
            text: `${tagCount} ${tagCount === 1 ? 'tag' : 'tags'}`,
            cls: 'calendar-settings-count-badge',
        });

        containerEl.createEl('p', {
            text: 'Define default colors and symbols for notes based on their tags when no explicit color property exists in frontmatter.',
            cls: 'setting-item-description',
        });

        // --- Dots-only toggle for tags ---
        new Setting(containerEl)
            .setName('Show dots only in calendar (tags)')
            .setDesc('Replace tag icons with colored dots in calendar view. Icons will still appear in Day Detail view.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.useDotsOnlyForTags)
                    .onChange(async (value) => {
                        this.plugin.settings.useDotsOnlyForTags = value;
                        await this.plugin.saveSettings();
                    })
            );

        // --- Display Current Tag Mappings ---
        const mappingsListEl = containerEl.createDiv('tag-color-mappings-list');
        if (Object.keys(this.plugin.settings.tagAppearance).length === 0) {
            const emptyEl = mappingsListEl.createDiv('holiday-empty-state');
            const iconEl = emptyEl.createSpan('holiday-empty-state-icon');
            setIcon(iconEl, 'tags');
            emptyEl.createDiv({ text: 'No Tag-Color Mappings Defined', cls: 'holiday-empty-state-title' });
            emptyEl.createEl('p', {
                text: 'Add a tag mapping below to color-code calendar events by tag.',
                cls: 'holiday-empty-state-desc',
            });
        } else {
            this.renderTagMappings(mappingsListEl);
        }

        // --- Add New Tag Mapping Controls ---
        const addHeader = containerEl.createDiv('calendar-settings-section-header');
        addHeader.createEl('h4', { text: 'Add New Tag-Color Mapping' });
        this.renderAddTagMappingControls(containerEl);
    }

    private renderHolidaySettings(containerEl: HTMLElement): void {
        const holidayContainer = containerEl.createDiv('holiday-settings-container');

        holidayContainer.createEl('h2', { text: 'Holiday Settings' });
        holidayContainer.createEl('p', {
            text: 'Manage national and custom holiday calendars to display celebrations and observances on your continuous calendar.',
            cls: 'holiday-section-desc',
        });

        // Section 1: Storage Folder
        new Setting(holidayContainer)
            .setName('Holiday Definition Folder')
            .setDesc('Folder for holiday definition files. Type to search, "/" for root.')
            .addText((text) => {
                const displayValue = this.plugin.settings.holidayStorageFolder === ""
                    ? "/"
                    : this.plugin.settings.holidayStorageFolder;
                text
                    .setPlaceholder('Example: Holidays')
                    .setValue(displayValue)
                    .onChange(async (value) => {
                        const storageValue = value.trim() === "/" ? "" : value.trim();
                        this.plugin.settings.holidayStorageFolder = storageValue;
                        await this.plugin.saveSettings();
                    });

                new FolderSuggest(this.app, text.inputEl);
            });

        // Section 2: Active Holiday Sources
        const sourcesHeader = holidayContainer.createDiv('holiday-settings-section-header');
        sourcesHeader.createEl('h4', { text: 'Active Holiday Sources' });
        const sourceCount = this.plugin.settings.holidaySources?.length || 0;
        sourcesHeader.createSpan({
            text: `${sourceCount} ${sourceCount === 1 ? 'source' : 'sources'}`,
            cls: 'holiday-count-badge',
        });

        const sourcesListEl = holidayContainer.createDiv('holiday-sources-list');

        if (!this.plugin.settings.holidaySources || this.plugin.settings.holidaySources.length === 0) {
            const emptyEl = sourcesListEl.createDiv('holiday-empty-state');
            const iconEl = emptyEl.createSpan('holiday-empty-state-icon');
            setIcon(iconEl, 'calendar-off');
            emptyEl.createDiv({ text: 'No Holiday Sources Configured', cls: 'holiday-empty-state-title' });
            emptyEl.createEl('p', {
                text: 'Add a national holiday calendar or create a custom holiday set below.',
                cls: 'holiday-empty-state-desc',
            });
        } else {
            this.renderHolidaySources(sourcesListEl);
        }

        // Section 3: Add New Holiday Source
        const addHeader = holidayContainer.createDiv('holiday-settings-section-header');
        addHeader.createEl('h4', { text: 'Add New Holiday Source' });
        holidayContainer.createEl('p', {
            text: 'Select a country calendar to import standard holidays, or create a custom set for personal events.',
            cls: 'holiday-section-desc',
        });
        this.renderAddHolidaySource(holidayContainer);

        // Section 4: Data Sync & Maintenance Card
        const syncHeader = holidayContainer.createDiv('holiday-settings-section-header');
        syncHeader.createEl('h4', { text: 'Holiday Data Synchronization' });
        holidayContainer.createEl('p', {
            text: 'Country holidays are stored locally per year. Select a target year to download or refresh definitions.',
            cls: 'holiday-section-desc',
        });

        const syncCard = holidayContainer.createDiv('holiday-card');
        let targetYear = this.plugin.displayedYear || new Date().getFullYear();

        new Setting(syncCard)
            .setName('Target Year')
            .setDesc('Year to fetch holidays for (defaults to currently viewed year)')
            .addText((text) =>
                text
                    .setValue(targetYear.toString())
                    .onChange((value) => {
                        const val = parseInt(value);
                        if (!isNaN(val) && val > 1900 && val < 2100) {
                            targetYear = val;
                        }
                    })
            );

        new Setting(syncCard)
            .setName('Update Country Holidays Now')
            .setDesc('Fetch official holiday data from the library and update vault files')
            .addButton((button) =>
                button
                    .setButtonText('Fetch & Update')
                    .setCta()
                    .onClick(async () => {
                        if (!this.plugin.holidayService) {
                            new Notice('Holiday service is not ready');
                            return;
                        }
                        const yearToUpdate = targetYear;
                        button.setDisabled(true).setButtonText(`Updating ${yearToUpdate}...`);
                        await this.plugin.holidayService.fetchAndUpdateAllCountryFilesForYear(yearToUpdate);
                        await this.plugin.loadHolidaysForYear(yearToUpdate);
                        button.setDisabled(false).setButtonText('Fetch & Update');
                    })
            );
    }

    private renderHolidaySources(containerEl: HTMLElement): void {
        this.plugin.settings.holidaySources.forEach((source, index) => {
            const itemWrapper = containerEl.createDiv('holiday-source-item');
            const settingItem = new Setting(itemWrapper);

            // Left side: Type badge + Name
            const isCountry = source.type === 'country';
            settingItem.nameEl.empty();
            settingItem.nameEl.createSpan({
                text: isCountry ? 'Country' : 'Custom',
                cls: `holiday-source-pill ${isCountry ? 'is-country' : 'is-custom'}`,
            });
            settingItem.nameEl.createSpan({
                text: isCountry ? source.countryCode.toUpperCase() : source.name,
                cls: 'holiday-source-name',
            });

            // Add color picker for country sources
            if (source.type === 'country') {
                const colorPreview = settingItem.controlEl.createDiv('holiday-color-swatch');
                colorPreview.style.backgroundColor = source.color || AVAILABLE_COLOR_OPTIONS['Red pale'];

                settingItem.addDropdown((dropdown) => {
                    Object.keys(AVAILABLE_COLOR_OPTIONS).forEach((key) => {
                        dropdown.addOption(AVAILABLE_COLOR_OPTIONS[key], key);
                    });
                    dropdown.setValue(source.color ?? AVAILABLE_COLOR_OPTIONS['Red pale']);

                    dropdown.onChange(async (value) => {
                        const sourceToUpdate = this.plugin.settings.holidaySources[index];
                        if (sourceToUpdate?.type === 'country') {
                            sourceToUpdate.color = value;
                        }
                        await this.plugin.saveSettings();
                        colorPreview.style.backgroundColor = value;
                        await this.plugin.loadHolidaysForYear(new Date().getFullYear());
                    });
                });
            }

            // Remove button
            settingItem.addButton((button) =>
                button
                    .setIcon('trash')
                    .setTooltip('Remove this source')
                    .setWarning()
                    .onClick(async () => {
                        this.plugin.settings.holidaySources.splice(index, 1);
                        await this.plugin.saveSettings();
                        this.display();
                        new Notice('Removed holiday source');
                        await this.plugin.loadHolidaysForYear(new Date().getFullYear());
                    })
            );
        });
    }

    private async fetchAvailableCountries(): Promise<{ code: string; name: string }[]> {
        if (!this.plugin.holidayService) {
            return [];
        }
        try {
            const countries = await this.plugin.holidayService.getAvailableCountries();
            return countries.sort((a, b) => a.name.localeCompare(b.name));
        } catch (error) {
            console.error('Error fetching available countries:', error);
            new Notice('Could not load list of countries');
            return [];
        }
    }

    private renderAddHolidaySource(containerEl: HTMLElement): void {
        let selectedType: 'country' | 'custom' = 'country';
        let selectedCountryCode = '';
        let selectedColor = AVAILABLE_COLOR_OPTIONS['Red pale'];
        let customName = '';

        const card = containerEl.createDiv('holiday-card');

        // Type selector
        new Setting(card)
            .setName('Source Type')
            .setDesc('Choose between pre-configured national holidays or a custom holiday file')
            .addDropdown((dropdown) => {
                dropdown
                    .addOption('country', 'Country (uses library)')
                    .addOption('custom', 'Custom (manual file)')
                    .setValue(selectedType)
                    .onChange((value) => {
                        selectedType = value as 'country' | 'custom';
                        this.display();
                    });
            });

        // Country-specific controls
        if (selectedType === 'country') {
            const countrySetting = new Setting(card)
                .setName('Select Country')
                .setDesc('Loading countries...');

            // Async load countries
            this.fetchAvailableCountries().then((countries) => {
                if (countries.length > 0) {
                    countrySetting.setDesc('Select the country whose holidays should be included');
                    countrySetting.addDropdown((dropdown) => {
                        dropdown.addOption('', 'Select a country...');
                        countries.forEach((country) => {
                            dropdown.addOption(
                                country.code,
                                `${country.name} (${country.code.toUpperCase()})`
                            );
                        });
                        dropdown.setValue('');
                        dropdown.onChange((value) => {
                            selectedCountryCode = value;
                        });
                    });
                } else {
                    countrySetting.setDesc('Could not load country list');
                }
            });

            // Color picker
            new Setting(card)
                .setName('Assign Color')
                .setDesc('Dot/indicator color for this country’s holidays on the calendar')
                .addDropdown((dropdown) => {
                    Object.keys(AVAILABLE_COLOR_OPTIONS).forEach((key) => {
                        dropdown.addOption(AVAILABLE_COLOR_OPTIONS[key], key);
                    });
                    dropdown.setValue(selectedColor);
                    dropdown.onChange((value) => {
                        selectedColor = value;
                    });
                });
        } else {
            // Custom name input
            new Setting(card)
                .setName('Custom Set Name')
                .setDesc('A short name for this custom set (e.g., "Family", "Work Events")')
                .addText((text) => {
                    text
                        .setPlaceholder('Enter custom name')
                        .setValue(customName)
                        .onChange((value) => {
                            customName = value.trim();
                        });
                });
        }

        // Action Footer for Add Button
        const footer = card.createDiv('holiday-card-footer');
        const addBtn = footer.createEl('button', {
            cls: 'mod-cta',
            text: 'Add Source',
        });

        addBtn.addEventListener('click', async () => {
            let newSource: HolidaySource | null = null;

            if (selectedType === 'country') {
                if (!selectedCountryCode) {
                    new Notice('Please select a country');
                    return;
                }
                if (this.plugin.settings.holidaySources.some(
                    (s) => s.type === 'country' && s.countryCode.toUpperCase() === selectedCountryCode.toUpperCase()
                )) {
                    new Notice(`Country source '${selectedCountryCode.toUpperCase()}' already exists`);
                    return;
                }
                newSource = {
                    type: 'country',
                    countryCode: selectedCountryCode,
                    color: selectedColor,
                };
            } else {
                if (!customName) {
                    new Notice('Please enter a name for the custom set');
                    return;
                }
                const sourceId = this.plugin.holidayService.getHolidaySourceId({
                    type: 'custom',
                    name: customName,
                });
                if (this.plugin.settings.holidaySources.some(
                    (s) => s.type === 'custom' && this.plugin.holidayService.getHolidaySourceId(s) === sourceId
                )) {
                    new Notice(`A custom source with ID '${sourceId}' already exists`);
                    return;
                }
                newSource = { type: 'custom', name: customName };
            }

            if (newSource) {
                this.plugin.settings.holidaySources.push(newSource);
                await this.plugin.saveSettings();
                const currentYear = new Date().getFullYear();
                await this.plugin.holidayService.ensureHolidayFileExists(currentYear, newSource);
                new Notice('Added holiday source');
                this.display();
                await this.plugin.loadHolidaysForYear(currentYear);
            }
        });
    }

    private renderTagMappings(containerEl: HTMLElement): void {
        const mappings = this.plugin.settings.tagAppearance;
        const sortedTags = Object.keys(mappings).sort();

        sortedTags.forEach((tag) => {
            const currentAppearance = mappings[tag];
            const itemWrapper = containerEl.createDiv('calendar-mapping-item');
            const settingItem = new Setting(itemWrapper);

            // Left side: tag pill
            settingItem.nameEl.empty();
            settingItem.nameEl.createSpan({
                text: tag,
                cls: 'calendar-settings-tag-pill',
            });

            // Color Dropdown
            settingItem.addDropdown((dd) => {
                Object.keys(AVAILABLE_COLOR_OPTIONS).forEach((key) => {
                    dd.addOption(AVAILABLE_COLOR_OPTIONS[key], key);
                });
                dd.setValue(currentAppearance.color || AVAILABLE_COLOR_OPTIONS['Red pale']);

                dd.onChange(async (newVar) => {
                    currentAppearance.color = newVar;
                    colorPreview.style.backgroundColor = newVar;
                    await this.plugin.saveSettings();
                });
            });

            // Symbol Textbox (compact)
            settingItem.addText((text) => {
                text
                    .setPlaceholder("●")
                    .setValue(currentAppearance.symbol ?? "")
                    .onChange(async (val) => {
                        const appearance = this.plugin.settings.tagAppearance[tag];
                        appearance.symbol = val.trim() || undefined;
                        await this.plugin.saveSettings();
                    });
                text.inputEl.style.width = '55px';
                text.inputEl.style.textAlign = 'center';
            });

            // Color Preview Dot
            const colorPreview = settingItem.controlEl.createDiv('calendar-settings-color-swatch');
            colorPreview.style.backgroundColor = currentAppearance.color || AVAILABLE_COLOR_OPTIONS['Red pale'];

            // Remove Button
            settingItem.addButton((button) =>
                button
                    .setIcon("trash")
                    .setTooltip(`Remove mapping for ${tag}`)
                    .setWarning()
                    .onClick(async () => {
                        delete this.plugin.settings.tagAppearance[tag];
                        await this.plugin.saveSettings();
                        new Notice(`Removed color mapping for tag: ${tag}`);
                        this.display();
                    })
            );
        });
    }

    private renderAddTagMappingControls(containerEl: HTMLElement): void {
        let newSymbol = "●";
        let selectedColorVar = AVAILABLE_COLOR_OPTIONS["Red pale"];
        let tagInputComponent: TextComponent | null = null;

        const card = containerEl.createDiv('calendar-settings-card');

        // Field 1: Tag Name
        new Setting(card)
            .setName('Tag')
            .setDesc('Vault tag to associate with color and symbol (must start with #)')
            .addText((text) => {
                tagInputComponent = text;
                text.setPlaceholder("#your/tag");
                new TagSuggest(this.app, text.inputEl);
            });

        // Field 2: Symbol
        new Setting(card)
            .setName('Display Symbol')
            .setDesc('Emoji, character, or dot to display on calendar dates')
            .addText((text) => {
                text
                    .setPlaceholder("● / 😎 / * …")
                    .onChange((v) => (newSymbol = v.trim() || "●"));
            });

        // Field 3: Color Dropdown
        new Setting(card)
            .setName('Default Color')
            .setDesc('Fallback color for notes with this tag')
            .addDropdown((dd) => {
                for (const key of Object.keys(AVAILABLE_COLOR_OPTIONS)) {
                    dd.addOption(AVAILABLE_COLOR_OPTIONS[key], key);
                }
                dd.setValue(selectedColorVar);
                dd.onChange((v) => (selectedColorVar = v));
            });

        // Action Footer
        const footer = card.createDiv('calendar-settings-card-footer');
        const addBtn = footer.createEl('button', {
            cls: 'mod-cta',
            text: 'Add Tag Mapping',
        });

        addBtn.addEventListener('click', async () => {
            const tag = tagInputComponent?.getValue().trim() ?? "";
            if (!tag) {
                new Notice("Enter a tag first");
                return;
            }
            if (!tag.startsWith("#")) {
                new Notice("Tag must start with '#'");
                return;
            }
            if (this.plugin.settings.tagAppearance?.[tag]) {
                new Notice(`Mapping for "${tag}" already exists`);
                return;
            }

            this.plugin.settings.tagAppearance[tag] = {
                color: selectedColorVar,
                symbol: newSymbol,
            };

            await this.plugin.saveSettings();
            this.display();
            new Notice(`Added color mapping for ${tag}`);
        });
    }
}
