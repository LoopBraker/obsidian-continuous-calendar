// src/settings.ts
import { App, PluginSettingTab, Setting } from 'obsidian';
import MyCalendarPlugin from './main';

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
							this.plugin.refreshCalendarView(); // This now works!
						}
					}));
	}
}