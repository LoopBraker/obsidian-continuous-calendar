import { App, Modal, Notice } from 'obsidian';
import type { CalendarEvent } from '../services/sync/model';
import { sanitizeSyncUiError } from '../components/SyncUi';

export interface SyncConflictModalOptions {
	readonly key: string;
	readonly local: CalendarEvent;
	readonly remote: CalendarEvent;
	readonly onResolve: (choice: 'local' | 'remote') => Promise<void> | void;
}

const CONFLICT_FIELDS: readonly (keyof CalendarEvent)[] = [
	'title',
	'start',
	'end',
	'allDay',
	'timezone',
	'location',
	'description',
];

export class SyncConflictModal extends Modal {
	private readonly options: SyncConflictModalOptions;

	constructor(app: App, options: SyncConflictModalOptions) {
		super(app);
		this.options = options;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('sync-conflict-modal');
		contentEl.createEl('h2', { text: 'Resolve calendar conflict' });
		contentEl.createEl('p', {
			text: 'Choose one complete canonical event. No choice rewrites the Markdown body.',
			cls: 'setting-item-description',
		});

		const table = contentEl.createEl('table', { cls: 'sync-conflict-table' });
		const head = table.createEl('thead').createEl('tr');
		head.createEl('th', { text: 'Field' });
		head.createEl('th', { text: 'Local' });
		head.createEl('th', { text: 'Remote' });
		const body = table.createEl('tbody');
		for (const field of CONFLICT_FIELDS) {
			const row = body.createEl('tr');
			row.createEl('th', { text: field });
			row.createEl('td', { text: String(this.options.local[field]) });
			row.createEl('td', { text: String(this.options.remote[field]) });
		}

		const status = contentEl.createDiv('sync-form-error');
		status.hide();
		const buttons = contentEl.createDiv('modal-button-container');
		buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
		buttons.createEl('button', { text: 'Keep remote' }).addEventListener('click', () => { void this.resolve('remote', status); });
		buttons.createEl('button', { text: 'Keep local', cls: 'mod-cta' }).addEventListener('click', () => { void this.resolve('local', status); });
	}

	private async resolve(choice: 'local' | 'remote', status: HTMLElement): Promise<void> {
		try {
			await this.options.onResolve(choice);
			this.close();
		} catch (error) {
			const message = sanitizeSyncUiError(error);
			status.setText(message);
			status.show();
			new Notice(`Conflict was not resolved: ${message}`);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export function openSyncConflictModal(app: App, options: SyncConflictModalOptions): SyncConflictModal {
	const modal = new SyncConflictModal(app, options);
	modal.open();
	return modal;
}
