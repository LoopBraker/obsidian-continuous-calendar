import { App, Modal } from 'obsidian';

export type SyncEventEditScope = 'series' | 'occurrence';

export interface SyncEventEditScopeModalOptions {
	readonly eventTitle: string;
	readonly onSelect: (scope: SyncEventEditScope) => void;
}

/** Choose the provider object to edit before opening its event form. */
export class SyncEventEditScopeModal extends Modal {
	constructor(app: App, private readonly options: SyncEventEditScopeModalOptions) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Edit recurring event' });
		contentEl.createEl('p', { text: this.options.eventTitle || 'Untitled event', cls: 'setting-item-description' });
		contentEl.createEl('p', { text: 'Choose whether to change the entire series or only this occurrence.' });
		const buttons = contentEl.createDiv('modal-button-container');
		for (const [scope, label] of [
			['series', 'Whole series'],
			['occurrence', 'This occurrence'],
		] as const) {
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

export function openSyncEventEditScopeModal(app: App, options: SyncEventEditScopeModalOptions): SyncEventEditScopeModal {
	const modal = new SyncEventEditScopeModal(app, options);
	modal.open();
	return modal;
}
