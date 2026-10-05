import { App, Modal } from 'obsidian';
import type { CalendarEventNoteActionScope } from '../DayDetailView';

export interface SyncNoteScopeModalOptions {
	readonly eventTitle: string;
	readonly scopes: readonly CalendarEventNoteActionScope[];
	readonly selectedDate: string;
	readonly recurring: boolean;
	readonly onSelect: (scope: CalendarEventNoteActionScope) => void;
}

export class SyncNoteScopeModal extends Modal {
	constructor(app: App, private readonly options: SyncNoteScopeModalOptions) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Create linked note' });
		contentEl.createEl('p', { text: this.options.eventTitle || 'Untitled event', cls: 'setting-item-description' });
		contentEl.createEl('p', { text: 'Choose what this note belongs to.' });
		const buttons = contentEl.createDiv('modal-button-container');
		for (const scope of this.options.scopes) {
			const label = scope === 'series'
				? 'Whole series'
				: scope === 'occurrence-day'
					? `Selected day (${this.options.selectedDate})`
					: this.options.recurring ? 'This occurrence' : 'This event';
			buttons.createEl('button', { text: label }).addEventListener('click', () => {
				this.close();
				this.options.onSelect(scope);
			});
		}
		buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export function openSyncNoteScopeModal(app: App, options: SyncNoteScopeModalOptions): SyncNoteScopeModal {
	const modal = new SyncNoteScopeModal(app, options);
	modal.open();
	return modal;
}
