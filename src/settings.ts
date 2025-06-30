// src/settings.ts
import { App, PluginSettingTab, Setting } from 'obsidian';
import MyCalendarPlugin from './main';

const AVAILABLE_COLOR_OPTIONS: Record<string, string> = {
	"Default (Theme-based)": "currentColor",
	"Red": "var(--color-red-tint)",
	"Orange": "var(--color-orange-tint)",
	"Yellow": "var(--color-yellow-tint)",
	"Green": "var(--color-green-tint)",
	"Cyan": "var(--color-cyan-tint)",
	"Blue": "var(--color-blue-tint)",
	"Purple": "var(--color-purple-tint)",
    "Accent Color": "var(--interactive-accent)", // Add accent color as an option
};

export class CalendarSettingTab extends PluginSettingTab {
	plugin: MyCalendarPlugin;

	constructor(app: App, plugin: MyCalendarPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Continuous Calendar Settings' });

		new Setting(containerEl)
			.setName('Year to Display')
			.setDesc('Which year the calendar should show.')
			.addText(text =>
				text
					.setPlaceholder('e.g., 2024')
					.setValue(this.plugin.settings.year.toString())
					.onChange(async (value) => {
						const year = parseInt(value);
						if (!isNaN(year)) {
							this.plugin.settings.year = year;
							await this.plugin.saveSettings();
							this.plugin.refreshCalendarView();
						}
					}));
        
        new Setting(containerEl)
			.setName('Default Event Dot Color')
			.setDesc('Fallback color if a note has a date but no `color` frontmatter specified.')
			.addDropdown(dropdown => {
				Object.keys(AVAILABLE_COLOR_OPTIONS).forEach((friendlyName) => {
					dropdown.addOption(AVAILABLE_COLOR_OPTIONS[friendlyName], friendlyName);
				});
				dropdown.setValue(this.plugin.settings.defaultDotColor);
				dropdown.onChange(async (value: string) => {
					this.plugin.settings.defaultDotColor = value;
					await this.plugin.saveSettings();
					this.plugin.refreshCalendarView();
				});
			});

        // --- New Setting for Default Bar Color ---
        new Setting(containerEl)
			.setName('Default Range Bar Color')
			.setDesc('Fallback color for range bars if note has no `color` frontmatter.')
			.addDropdown(dropdown => {
				Object.keys(AVAILABLE_COLOR_OPTIONS).forEach((friendlyName) => {
					dropdown.addOption(AVAILABLE_COLOR_OPTIONS[friendlyName], friendlyName);
				});
				dropdown.setValue(this.plugin.settings.defaultBarColor);
				dropdown.onChange(async (value: string) => {
					this.plugin.settings.defaultBarColor = value;
					await this.plugin.saveSettings();
					this.plugin.refreshCalendarView();
				});
			});
	}
}