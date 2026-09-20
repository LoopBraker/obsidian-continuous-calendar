import { App, Modal, Notice, Setting } from 'obsidian';
import type { CalendarEvent } from '../services/sync/model';
import { validateCalendarEvent } from '../services/sync/model';
import type { CalendarEventValidationError } from '../services/sync/model';
import { sanitizeSyncUiError, zonedDraftTimestamp } from '../components/SyncUi';

export interface SyncEventModalOptions {
	readonly initialEvent?: CalendarEvent;
	readonly dateKey?: string;
	readonly timezone: string;
	readonly title?: string;
	readonly submitLabel?: string;
	readonly onSubmit: (event: CalendarEvent) => Promise<void> | void;
}

export interface SyncEventDraft {
	uid: string;
	title: string;
	start: string;
	end: string;
	allDay: boolean;
	timezone: string;
	location: string;
	description: string;
}

function pad(value: number): string {
	return String(value).padStart(2, '0');
}

function nextCivilDate(dateKey: string): string {
	const [year, month, day] = dateKey.split('-').map(Number);
	const date = new Date(Date.UTC(year, month - 1, day + 1));
	return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Generate a local immutable identity without involving a provider. */
export function createSyncDraftUid(): string {
	const cryptoValue = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
	if (cryptoValue?.randomUUID) return cryptoValue.randomUUID();
	return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createSyncEventDraft(
	initialEvent: CalendarEvent | undefined,
	dateKey: string = new Date().toISOString().slice(0, 10),
	timezone = 'UTC',
): SyncEventDraft {
	if (initialEvent) return { ...initialEvent };
	return {
		uid: createSyncDraftUid(),
		title: '',
		start: zonedDraftTimestamp(dateKey, 9, timezone),
		end: zonedDraftTimestamp(dateKey, 10, timezone),
		allDay: false,
		timezone,
		location: '',
		description: '',
	};
}

export function draftValidationMessage(errors: readonly CalendarEventValidationError[]): string {
	return errors.length === 0
		? ''
		: errors.map(error => `${String(error.field)}: ${error.message}`).join(' ');
}

export class SyncEventModal extends Modal {
	private readonly options: SyncEventModalOptions;
	private draft: SyncEventDraft;
	private errorEl?: HTMLElement;

	constructor(app: App, options: SyncEventModalOptions) {
		super(app);
		this.options = options;
		this.draft = createSyncEventDraft(options.initialEvent, options.dateKey, options.timezone);
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('sync-event-modal');
		contentEl.createEl('h2', { text: this.options.title ?? (this.options.initialEvent ? 'Edit calendar event' : 'Create calendar event') });
		contentEl.createEl('p', {
			text: 'Only canonical event fields are synchronized. The note body remains local.',
			cls: 'setting-item-description',
		});

		const form = contentEl.createDiv('sync-event-form');
		new Setting(form)
			.setName('Title')
			.setDesc('A short, descriptive event title.')
			.addText(component => component.setValue(this.draft.title).onChange(value => { this.draft.title = value; }));
		new Setting(form)
			.setName('Start')
			.setDesc('YYYY-MM-DD for all-day events, or RFC 3339 with an offset.')
			.addText(component => component.setValue(this.draft.start).onChange(value => { this.draft.start = value; }));
		new Setting(form)
			.setName('End')
			.setDesc('All-day end is exclusive.')
			.addText(component => component.setValue(this.draft.end).onChange(value => { this.draft.end = value; }));
		new Setting(form)
			.setName('All day')
			.setDesc('Use civil dates instead of timed timestamps.')
			.addToggle(component => component.setValue(this.draft.allDay).onChange(value => {
				this.draft.allDay = value;
				if (value && this.draft.start.includes('T')) {
					const startDate = this.draft.start.slice(0, 10);
					this.draft.start = startDate;
					this.draft.end = nextCivilDate(startDate);
				} else if (!value && !this.draft.start.includes('T')) {
					this.draft.start = zonedDraftTimestamp(this.draft.start, 9, this.draft.timezone);
					this.draft.end = zonedDraftTimestamp(this.draft.end, 9, this.draft.timezone);
				}
				this.render();
			}));
		new Setting(form)
			.setName('Timezone')
			.setDesc('IANA timezone, for example America/Bogota.')
			.addText(component => component.setValue(this.draft.timezone).onChange(value => { this.draft.timezone = value; }));
		new Setting(form)
			.setName('Location')
			.addText(component => component.setValue(this.draft.location).onChange(value => { this.draft.location = value; }));
		new Setting(form)
			.setName('Description')
			.addTextArea(component => component.setValue(this.draft.description).onChange(value => { this.draft.description = value; }));

		this.errorEl = contentEl.createDiv('sync-form-error');
		this.errorEl.setAttribute('role', 'alert');
		this.errorEl.hide();

		const footer = contentEl.createDiv('modal-button-container');
		footer.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
		footer.createEl('button', {
			text: this.options.submitLabel ?? (this.options.initialEvent ? 'Save event' : 'Create event'),
			cls: 'mod-cta',
		}).addEventListener('click', () => { void this.submit(); });
	}

	private showError(message: string): void {
		if (!this.errorEl) return;
		this.errorEl.setText(message);
		this.errorEl.show();
	}

	private async submit(): Promise<void> {
		const validation = validateCalendarEvent(this.draft);
		if (!validation.ok) {
			this.showError(draftValidationMessage(validation.errors));
			return;
		}
		try {
			await this.options.onSubmit(validation.value);
			this.close();
		} catch (error) {
			const message = sanitizeSyncUiError(error);
			this.showError(message);
			new Notice(`Calendar event was not saved: ${message}`);
		}
	}

	onClose(): void {
		this.contentEl.empty();
		this.errorEl = undefined;
	}
}

export function openSyncEventModal(app: App, options: SyncEventModalOptions): SyncEventModal {
	const modal = new SyncEventModal(app, options);
	modal.open();
	return modal;
}
