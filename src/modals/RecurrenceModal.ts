import { App, Modal, TFile, Notice, Setting } from 'obsidian';
import { RRule, Frequency, Weekday } from 'rrule';

interface RecurrenceConfig {
    freq: Frequency;
    interval: number;
    byweekday: Weekday[] | null;
    count: number | null;
    until: Date | null;
}

export class RecurrenceModal extends Modal {
    file: TFile;
    config: RecurrenceConfig;

    // UI Elements
    private frequencyDropdown: HTMLSelectElement | null = null;
    private intervalInput: HTMLInputElement | null = null;
    private intervalDescEl: HTMLElement | null = null; // Reference to the description element
    private weekdayContainer: HTMLElement | null = null;
    private endTypeDropdown: HTMLSelectElement | null = null;
    private countInput: HTMLInputElement | null = null;
    private untilInput: HTMLInputElement | null = null;
    private endContainer: HTMLElement | null = null;

    constructor(app: App, file: TFile) {
        super(app);
        this.file = file;

        // Default configuration
        this.config = {
            freq: RRule.WEEKLY,
            interval: 1,
            byweekday: [RRule.MO],
            count: null,
            until: null
        };
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('recurrence-modal');

        // Title
        contentEl.createEl('h2', { text: 'Set Recurrence Pattern' });

        // Read existing recurrence from frontmatter
        await this.loadExistingRecurrence();

        // Build the form
        this.buildRecurrenceForm();

        // Buttons
        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());

        const applyBtn = buttonContainer.createEl('button', {
            text: 'Apply',
            cls: 'mod-cta'
        });
        applyBtn.addEventListener('click', () => this.applyRecurrence());
    }

    private async loadExistingRecurrence() {
        const cache = this.app.metadataCache.getFileCache(this.file);
        const existingRRule = cache?.frontmatter?.['recurrence'];

        if (existingRRule && typeof existingRRule === 'string') {
            try {
                const rule = RRule.fromString(existingRRule);
                const options = rule.origOptions;

                this.config.freq = options.freq ?? RRule.WEEKLY;
                this.config.interval = options.interval || 1;
                this.config.byweekday = options.byweekday as Weekday[] || null;
                this.config.count = options.count || null;
                this.config.until = options.until || null;
            } catch (error) {
                console.error('Failed to parse existing recurrence rule:', error);
                new Notice('Failed to parse existing recurrence rule. Using defaults.');
            }
        }
    }

    private buildRecurrenceForm() {
        const { contentEl } = this;

        // Frequency
        new Setting(contentEl)
            .setName('Frequency')
            .setDesc('How often the event repeats')
            .addDropdown(dropdown => {
                this.frequencyDropdown = dropdown.selectEl;
                dropdown
                    .addOption(String(RRule.DAILY), 'Daily')
                    .addOption(String(RRule.WEEKLY), 'Weekly')
                    .addOption(String(RRule.MONTHLY), 'Monthly')
                    .addOption(String(RRule.YEARLY), 'Yearly')
                    .setValue(String(this.config.freq))
                    .onChange(value => {
                        this.config.freq = parseInt(value) as Frequency;
                        this.updateWeekdayVisibility();
                        // Update the text under the interval input (e.g., "weeks" vs "days")
                        this.updateIntervalDescription();
                    });
            });

        // Interval (Repeat every...)
        const intervalSetting = new Setting(contentEl)
            .setName('Repeat every')
            // Initial description based on current frequency
            .setDesc(this.getIntervalUnitLabel(this.config.freq))
            .addText(text => {
                this.intervalInput = text.inputEl;
                text
                    .setPlaceholder('1')
                    .setValue(String(this.config.interval))
                    .onChange(value => {
                        const num = parseInt(value);
                        this.config.interval = isNaN(num) || num < 1 ? 1 : num;
                    });
                text.inputEl.type = 'number';
                text.inputEl.min = '1';
            });

        // Capture the description element so we can update it later
        this.intervalDescEl = intervalSetting.descEl;

        // Weekday selector (only for weekly)
        this.weekdayContainer = contentEl.createDiv({ cls: 'recurrence-weekday-container' });
        this.buildWeekdaySelector();
        this.updateWeekdayVisibility();

        // End condition
        this.endContainer = contentEl.createDiv({ cls: 'recurrence-end-container' });
        this.buildEndCondition();
    }

    // Helper to get text like "days", "weeks"
    private getIntervalUnitLabel(freq: Frequency): string {
        switch (freq) {
            case RRule.DAILY: return 'days';
            case RRule.WEEKLY: return 'weeks';
            case RRule.MONTHLY: return 'months';
            case RRule.YEARLY: return 'years';
            default: return 'periods';
        }
    }

    // Update the description element text
    private updateIntervalDescription() {
        if (this.intervalDescEl) {
            this.intervalDescEl.innerText = this.getIntervalUnitLabel(this.config.freq);
        }
    }

    private buildWeekdaySelector() {
        if (!this.weekdayContainer) return;

        this.weekdayContainer.empty();

        const setting = new Setting(this.weekdayContainer)
            .setName('Repeat on')
            .setDesc('Select days of the week');

        const weekdays = [
            { label: 'Mon', value: RRule.MO },
            { label: 'Tue', value: RRule.TU },
            { label: 'Wed', value: RRule.WE },
            { label: 'Thu', value: RRule.TH },
            { label: 'Fri', value: RRule.FR },
            { label: 'Sat', value: RRule.SA },
            { label: 'Sun', value: RRule.SU }
        ];

        const buttonContainer = setting.controlEl.createDiv({ cls: 'recurrence-weekday-buttons' });

        weekdays.forEach(day => {
            const isSelected = this.config.byweekday?.some(wd => wd.weekday === day.value.weekday) || false;

            const btn = buttonContainer.createEl('button', {
                text: day.label,
                cls: isSelected ? 'recurrence-day-btn active' : 'recurrence-day-btn'
            });

            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const isCurrentlyActive = btn.hasClass('active');

                if (isCurrentlyActive) {
                    btn.removeClass('active');
                    this.config.byweekday = this.config.byweekday?.filter(
                        wd => wd.weekday !== day.value.weekday
                    ) || null;
                } else {
                    btn.addClass('active');
                    if (!this.config.byweekday) {
                        this.config.byweekday = [];
                    }
                    this.config.byweekday.push(day.value);
                }
            });
        });
    }

    private buildEndCondition() {
        if (!this.endContainer) return;

        this.endContainer.empty();

        // End type selector
        new Setting(this.endContainer)
            .setName('Ends')
            .setDesc('When the recurrence ends')
            .addDropdown(dropdown => {
                this.endTypeDropdown = dropdown.selectEl;

                let defaultValue = 'never';
                if (this.config.count) defaultValue = 'count';
                if (this.config.until) defaultValue = 'until';

                dropdown
                    .addOption('never', 'Never')
                    .addOption('count', 'After')
                    .addOption('until', 'On date')
                    .setValue(defaultValue)
                    .onChange(value => {
                        this.updateEndInputVisibility(value);
                    });
            });

        // Count input
        const countSetting = new Setting(this.endContainer)
            .setName('Occurrences')
            .setDesc('Number of occurrences')
            .addText(text => {
                this.countInput = text.inputEl;
                text
                    .setPlaceholder('10')
                    .setValue(this.config.count ? String(this.config.count) : '')
                    .onChange(value => {
                        const num = parseInt(value);
                        this.config.count = isNaN(num) || num < 1 ? null : num;
                    });
                text.inputEl.type = 'number';
                text.inputEl.min = '1';
            });
        countSetting.settingEl.style.display = this.config.count ? 'flex' : 'none';

        // Until date input
        const untilSetting = new Setting(this.endContainer)
            .setName('End date')
            .setDesc('Date when recurrence ends')
            .addText(text => {
                this.untilInput = text.inputEl;
                text
                    .setPlaceholder('YYYY-MM-DD')
                    .setValue(this.config.until ? this.formatDate(this.config.until) : '')
                    .onChange(value => {
                        if (!value) {
                            this.config.until = null;
                            return;
                        }
                        const date = new Date(value);
                        this.config.until = isNaN(date.getTime()) ? null : date;
                    });
                text.inputEl.type = 'date';
            });
        untilSetting.settingEl.style.display = this.config.until ? 'flex' : 'none';
    }

    private updateWeekdayVisibility() {
        if (!this.weekdayContainer) return;
        this.weekdayContainer.style.display = this.config.freq === RRule.WEEKLY ? 'block' : 'none';
    }

    private updateEndInputVisibility(endType: string) {
        if (!this.endContainer) return;

        const settings = this.endContainer.querySelectorAll('.setting-item');
        settings.forEach((setting, index) => {
            if (index === 0) return; // Skip the dropdown itself

            const settingEl = setting as HTMLElement;
            if (index === 1) { // Count input
                settingEl.style.display = endType === 'count' ? 'flex' : 'none';
                if (endType !== 'count') this.config.count = null;
            } else if (index === 2) { // Until input
                settingEl.style.display = endType === 'until' ? 'flex' : 'none';
                if (endType !== 'until') this.config.until = null;
            }
        });
    }

    private formatDate(date: Date): string {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    private async applyRecurrence() {
        try {
            // Generate RRULE string
            const ruleOptions: any = {
                freq: this.config.freq,
                interval: this.config.interval
            };

            // Add weekday for weekly recurrence
            if (this.config.freq === RRule.WEEKLY && this.config.byweekday && this.config.byweekday.length > 0) {
                ruleOptions.byweekday = this.config.byweekday;
            }

            // Add end condition
            if (this.config.count) {
                ruleOptions.count = this.config.count;
            } else if (this.config.until) {
                ruleOptions.until = this.config.until;
            }

            const rule = new RRule(ruleOptions);
            const rruleString = rule.toString().replace('RRULE:', '');

            console.log('Generated RRULE:', rruleString);

            // Update frontmatter
            await this.app.fileManager.processFrontMatter(this.file, (frontmatter) => {
                frontmatter['recurrence'] = rruleString;
            });

            new Notice('Recurrence pattern set successfully!');
            this.close();
        } catch (error) {
            console.error('Failed to apply recurrence:', error);
            new Notice('Failed to set recurrence pattern. Check console for details.');
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}