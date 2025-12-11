import { App, PluginSettingTab, Setting, AbstractInputSuggest, prepareFuzzySearch, TextComponent, Notice, TFolder, DropdownComponent } from 'obsidian';
import type SamplePlugin from '../main';
import type { CalendarPluginSettings, DateProperty } from './settings';
import { HolidaySource, CountryHolidaySource } from '../services/holiday/HolidayTypes';

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

export class CalendarSettingTab extends PluginSettingTab {
    plugin: SamplePlugin;

    constructor(app: App, plugin: SamplePlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h1', { text: 'Calendar Plugin Settings' });

        // ========== DEFAULT COLORS & CONFIRMATIONS ==========
        containerEl.createEl('h2', { text: 'Default Colors & Confirmations' });

        // Default Dot Color
        new Setting(containerEl)
            .setName('Default Event Dot Color')
            .setDesc('Fallback color for event dots if no color is specified')
            .addDropdown((dropdown) => {
                let colorPreview: HTMLDivElement;

                Object.keys(AVAILABLE_COLOR_OPTIONS).forEach((friendlyName) => {
                    const cssVar = AVAILABLE_COLOR_OPTIONS[friendlyName];
                    dropdown.addOption(cssVar, friendlyName);
                });

                dropdown.setValue(this.plugin.settings.defaultDotColor);

                dropdown.onChange(async (value: string) => {
                    this.plugin.settings.defaultDotColor = value;
                    await this.plugin.saveSettings();
                    if (colorPreview) {
                        colorPreview.style.backgroundColor = value;
                    }
                });

                // Create color preview dot
                colorPreview = dropdown.selectEl.parentElement?.createEl('div', {
                    attr: {
                        style: 'display: inline-block; width: 15px; height: 15px; border-radius: 50%; margin-left: 8px; vertical-align: middle; background-color: ' + this.plugin.settings.defaultDotColor
                    }
                }) as HTMLDivElement;
            });

        // Default Bar Color
        new Setting(containerEl)
            .setName('Default Range Bar Color')
            .setDesc('Fallback color for range bars if no color is specified')
            .addDropdown((dropdown) => {
                let colorPreview: HTMLDivElement;

                Object.keys(AVAILABLE_COLOR_OPTIONS).forEach((friendlyName) => {
                    const cssVar = AVAILABLE_COLOR_OPTIONS[friendlyName];
                    dropdown.addOption(cssVar, friendlyName);
                });

                dropdown.setValue(this.plugin.settings.defaultBarColor);

                dropdown.onChange(async (value: string) => {
                    this.plugin.settings.defaultBarColor = value;
                    await this.plugin.saveSettings();
                    if (colorPreview) {
                        colorPreview.style.backgroundColor = value;
                    }
                });

                // Create color preview dot
                colorPreview = dropdown.selectEl.parentElement?.createEl('div', {
                    attr: {
                        style: 'display: inline-block; width: 15px; height: 15px; border-radius: 50%; margin-left: 8px; vertical-align: middle; background-color: ' + this.plugin.settings.defaultBarColor
                    }
                }) as HTMLDivElement;
            });

        // Confirm before creating daily notes
        new Setting(containerEl)
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
        new Setting(containerEl)
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
        new Setting(containerEl)
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

        // Separator
        containerEl.createEl('hr', { cls: 'settings-separator' });

        // ========== TAG-BASED COLORS ==========
        this.renderTagColorSettings(containerEl);

        // Separator
        containerEl.createEl('hr', { cls: 'settings-separator' });

        // ========== CUSTOM DATE PROPERTIES ==========
        this.renderCustomDatePropertiesSettings(containerEl);

        // Separator
        containerEl.createEl('hr', { cls: 'settings-separator' });

        // ========== TASK SETTINGS ==========
        this.renderTaskSettings(containerEl);

        // Separator
        containerEl.createEl('hr', { cls: 'settings-separator' });

        // ========== HOLIDAYS ==========
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
        containerEl.createEl("h2", { text: "Custom Date Properties" });
        containerEl.createEl("p", {
            text: "Define additional frontmatter properties that should be treated as dates by the calendar. Adding or removing properties here will trigger a full re-index of your vault.",
            cls: "setting-item-description",
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
        const propertiesListEl = containerEl.createDiv("custom-date-properties-list");
        if (this.plugin.settings.customDateProperties.length === 0) {
            propertiesListEl.createEl("p", {
                text: "No custom date properties defined.",
                cls: "setting-item-description",
            });
        } else {
            this.renderCustomDateProperties(propertiesListEl);
        }

        // --- Add New Custom Property Controls ---
        containerEl.createEl("h4", { text: "Add New Date Property" });
        this.renderAddCustomDatePropertyControls(containerEl);
    }

    private renderCustomDateProperties(containerEl: HTMLElement): void {
        this.plugin.settings.customDateProperties.forEach((prop, index) => {
            const settingItem = new Setting(containerEl).setName(prop.name);

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
                    // Color change doesn't necessarily require re-index if we look it up dynamically,
                    // but for consistency and to ensure cache is fresh, we can re-index or just notify listeners.
                    // For now, let's just save. The index uses these settings dynamically if we implement it right.
                    // But if we want to be safe:
                    this.plugin.calendarIndex.indexVault();
                });
            });

            // Symbol Textbox
            settingItem.addText((text) => {
                text
                    .setPlaceholder("●")
                    .setValue(prop.symbol ?? "")
                    .onChange(async (val) => {
                        prop.symbol = val.trim() || undefined;
                        await this.plugin.saveSettings();
                        this.plugin.calendarIndex.indexVault();
                    });
            });

            // Recurring Toggle
            if (prop.isRecurring) {
                settingItem.addExtraButton(btn =>
                    btn.setIcon("repeat")
                        .setTooltip("Recurring annually")
                        .setDisabled(true) // Just an indicator for now, or make it toggleable?
                    // Let's make it an indicator here, and maybe editable if we want.
                    // Actually, let's make it a toggle in the setting item if possible, but Setting only supports one main control usually.
                    // We can add a toggle.
                );
            }

            // Color Preview Dot

            // Color Preview Dot
            const colorPreview = settingItem.controlEl.createEl("div");
            colorPreview.style.display = "inline-block";
            colorPreview.style.width = "15px";
            colorPreview.style.height = "15px";
            colorPreview.style.borderRadius = "50%";
            colorPreview.style.marginLeft = "10px";
            colorPreview.style.verticalAlign = "middle";
            colorPreview.style.backgroundColor = prop.color || AVAILABLE_COLOR_OPTIONS['Red pale'];

            // Remove Button
            settingItem.addButton((button) =>
                button
                    .setIcon("trash")
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

        const wrapper = containerEl.createDiv("add-custom-date-property-controls");
        const row = new Setting(wrapper).setName("New Property");

        row.addText((text) => {
            text
                .setPlaceholder("Property Name (e.g. due_date)")
                .onChange((v) => (newName = v.trim()));
            new PropertySuggest(this.app, text.inputEl);
        });

        row.addText((text) => {
            text
                .setPlaceholder("Symbol (e.g. ⏰)")
                .onChange((v) => (newSymbol = v.trim() || "●"));
        });

        row.addDropdown((dd) => {
            for (const key of Object.keys(AVAILABLE_COLOR_OPTIONS)) {
                dd.addOption(AVAILABLE_COLOR_OPTIONS[key], key);
            }
            dd.setValue(selectedColorVar);
            dd.onChange((v) => (selectedColorVar = v));
        });

        row.addToggle((toggle) => {
            toggle
                .setTooltip("Recurring Annually (e.g. Birthday)")
                .setValue(isRecurring)
                .onChange((v) => (isRecurring = v));
        });

        row.addButton((btn) =>
            btn
                .setButtonText("Add Property")
                .setCta()
                .onClick(async () => {
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
                        isRecurring: isRecurring
                    };

                    this.plugin.settings.customDateProperties.push(newProp);
                    await this.plugin.saveSettings();
                    this.display();

                    new Notice(`Added date property: ${newName}`);
                    this.plugin.calendarIndex.indexVault();
                })
        );
    }


    private renderTagColorSettings(containerEl: HTMLElement): void {
        containerEl.createEl("h2", { text: "Tag-Based Default Colors" });
        containerEl.createEl("p", {
            text: "Define default colors for notes based on their tags. This color will be used if a note has a matching tag but does *not* have an explicit `color` property defined in its frontmatter.",
            cls: "setting-item-description",
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
        const mappingsListEl = containerEl.createDiv("tag-color-mappings-list");
        if (Object.keys(this.plugin.settings.tagAppearance).length === 0) {
            mappingsListEl.createEl("p", {
                text: "No tag-color mappings defined.",
                cls: "setting-item-description",
            });
        } else {
            this.renderTagMappings(mappingsListEl);
        }

        // --- Add New Tag Mapping Controls ---
        containerEl.createEl("h4", { text: "Add New Tag-Color Mapping" });
        this.renderAddTagMappingControls(containerEl);
    }

    private renderHolidaySettings(containerEl: HTMLElement): void {
        const holidayContainer = containerEl.createDiv('holiday-settings-container');
        holidayContainer.createEl('h2', { text: 'Holiday Settings' });

        // Holiday folder setting
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

        // Display current holiday sources
        holidayContainer.createEl('h4', { text: 'Active Holiday Sources' });
        const sourcesListEl = holidayContainer.createDiv('holiday-sources-list');

        if (!this.plugin.settings.holidaySources || this.plugin.settings.holidaySources.length === 0) {
            sourcesListEl.createEl('p', { text: 'No holiday sources configured.' });
        } else {
            this.renderHolidaySources(sourcesListEl);
        }

        // Add new holiday source button
        holidayContainer.createEl('h4', { text: 'Add New Holiday Source' });
        this.renderAddHolidaySource(holidayContainer);

        // Manual update button
        let targetYear = this.plugin.displayedYear || new Date().getFullYear();

        new Setting(holidayContainer)
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

        new Setting(holidayContainer)
            .setName('Update Country Holidays Now')
            .setDesc('Fetch and update holiday data for the target year')
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
            const settingItem = new Setting(containerEl).setName(
                source.type === 'country'
                    ? `Country: ${source.countryCode.toUpperCase()}`
                    : `Custom: ${source.name}`
            );

            // Add color picker for country sources
            if (source.type === 'country') {
                const colorPreview = settingItem.controlEl.createEl('div');
                colorPreview.style.display = 'inline-block';
                colorPreview.style.width = '15px';
                colorPreview.style.height = '15px';
                colorPreview.style.borderRadius = '3px';
                colorPreview.style.marginLeft = '10px';
                colorPreview.style.verticalAlign = 'middle';
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

        const addControlsContainer = containerEl.createDiv('add-holiday-source-controls');

        // Type selector
        new Setting(addControlsContainer)
            .setName('Source Type')
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
            const countrySetting = new Setting(addControlsContainer)
                .setName('Select Country')
                .setDesc('Loading countries...');

            // Async load countries
            this.fetchAvailableCountries().then((countries) => {
                if (countries.length > 0) {
                    countrySetting.setDesc('');
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
            new Setting(addControlsContainer)
                .setName('Assign Color')
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
            new Setting(addControlsContainer)
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

        // Add button
        new Setting(addControlsContainer).addButton((button) =>
            button
                .setButtonText('Add Source')
                .setCta()
                .onClick(async () => {
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
                })
        );
    }

    private renderTagMappings(containerEl: HTMLElement): void {
        const mappings = this.plugin.settings.tagAppearance;
        const sortedTags = Object.keys(mappings).sort();

        sortedTags.forEach((tag) => {
            const currentAppearance = mappings[tag];

            const settingItem = new Setting(containerEl).setName(tag);

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

            // Symbol Textbox
            settingItem.addText((text) => {
                text
                    .setPlaceholder("●")
                    .setValue(currentAppearance.symbol ?? "")
                    .onChange(async (val) => {
                        const appearance = this.plugin.settings.tagAppearance[tag];
                        appearance.symbol = val.trim() || undefined;
                        await this.plugin.saveSettings();
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

        const wrapper = containerEl.createDiv("add-tag-mapping-controls");
        const row = new Setting(wrapper).setName("New Tag Mapping");

        let tagInputComponent: TextComponent | null = null;

        row.addText((text) => {
            tagInputComponent = text;
            text.setPlaceholder("#your/tag").onChange(() => { });
            new TagSuggest(this.app, text.inputEl);
        });

        row.addText((text) => {
            text
                .setPlaceholder("● / 😎 / * …")
                .onChange((v) => (newSymbol = v.trim() || "●"));
        });

        row.addDropdown((dd) => {
            for (const key of Object.keys(AVAILABLE_COLOR_OPTIONS)) {
                dd.addOption(AVAILABLE_COLOR_OPTIONS[key], key);
            }
            dd.setValue(selectedColorVar);
            dd.onChange((v) => (selectedColorVar = v));
        });

        row.addButton((btn) =>
            btn
                .setButtonText("Add Mapping")
                .setCta()
                .onClick(async () => {
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

                    tagInputComponent?.setValue("");
                    newSymbol = "●";
                    selectedColorVar = AVAILABLE_COLOR_OPTIONS["Red pale"];
                })
        );
    }
}
