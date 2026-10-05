import { App, Modal } from 'obsidian';

export interface SyncLinkedNoteModalOptions {
	readonly eventTitle: string;
	readonly notePaths: readonly string[];
	readonly onSelect: (path: string) => void;
}

/** Ask which event-owned note to open when more than one applies to the row. */
export class SyncLinkedNoteModal extends Modal {
	constructor(app: App, private readonly options: SyncLinkedNoteModalOptions) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Open linked note' });
		contentEl.createEl('p', { text: this.options.eventTitle || 'Untitled event', cls: 'setting-item-description' });
		contentEl.createEl('p', { text: 'Choose a note to open.' });
		const buttons = contentEl.createDiv('modal-button-container');
		for (const path of this.options.notePaths) {
			buttons.createEl('button', { text: path }).addEventListener('click', () => {
				this.close();
				this.options.onSelect(path);
			});
		}
		buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export function openSyncLinkedNoteModal(app: App, options: SyncLinkedNoteModalOptions): SyncLinkedNoteModal {
	const modal = new SyncLinkedNoteModal(app, options);
	modal.open();
	return modal;
}
