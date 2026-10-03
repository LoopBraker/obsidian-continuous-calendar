import { App, Modal, Notice, Setting } from 'obsidian';
import type { CalendarEvent, EventRecurrence } from '../services/sync/model';
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
	recurrence?: EventRecurrence;
}

interface ZonedDateTimeFields {
	readonly date: string;
	readonly time: string;
}

type RecurrenceFrequency = EventRecurrence['frequency'];

function pad(value: number): string {
	return String(value).padStart(2, '0');
}

function dateKey(year: number, month: number, day: number): string {
	return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}

function shiftCivilDate(value: string, days: number): string {
	const [year, month, day] = value.split('-').map(Number);
	const date = new Date(Date.UTC(year, month - 1, day + days));
	return dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function nextCivilDate(value: string): string {
	return shiftCivilDate(value, 1);
}

function previousCivilDate(value: string): string {
	return shiftCivilDate(value, -1);
}

function isoWeekday(value: string): number {
	const date = parseDate(value);
	if (!date) return 1;
	const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
	return weekday === 0 ? 7 : weekday;
}

function readZonedDateTime(value: string, timezone: string): ZonedDateTimeFields | undefined {
	const instant = new Date(value);
	if (!Number.isFinite(instant.getTime())) return undefined;
	try {
		const parts = new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hourCycle: 'h23',
		}).formatToParts(instant);
		const part = (name: string) => parts.find(item => item.type === name)?.value;
		const year = part('year');
		const month = part('month');
		const day = part('day');
		const hour = part('hour');
		const minute = part('minute');
		const second = part('second');
		if (!year || !month || !day || !hour || !minute || !second) return undefined;
		return {
			date: `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
			time: `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}`,
		};
	} catch (_error) {
		return undefined;
	}
}

function parseTime(value: string): { hour: number; minute: number; second: number } | undefined {
	const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
	if (!match) return undefined;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	const second = Number(match[3] ?? '0');
	if (hour > 23 || minute > 59 || second > 59) return undefined;
	return { hour, minute, second };
}

function parseDate(value: string): { year: number; month: number; day: number } | undefined {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return undefined;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const date = new Date(Date.UTC(year, month - 1, day));
	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() + 1 !== month ||
		date.getUTCDate() !== day
	) return undefined;
	return { year, month, day };
}

function offsetMinutesAt(instantMs: number, timezone: string): number | undefined {
	try {
		const parts = new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hourCycle: 'h23',
		}).formatToParts(new Date(instantMs));
		const read = (name: string) => Number(parts.find(part => part.type === name)?.value);
		const wallClockMs = Date.UTC(
			read('year'), read('month') - 1, read('day'), read('hour'), read('minute'), read('second'),
		);
		return Math.round((wallClockMs - Math.floor(instantMs / 1000) * 1000) / 60_000);
	} catch (_error) {
		return undefined;
	}
}

function formatOffset(offsetMinutes: number): string {
	const sign = offsetMinutes >= 0 ? '+' : '-';
	const absolute = Math.abs(offsetMinutes);
	return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function formatInstantInZone(instantMs: number, timezone: string): string | undefined {
	const fields = readZonedDateTime(new Date(instantMs).toISOString(), timezone);
	const offset = offsetMinutesAt(instantMs, timezone);
	if (!fields || offset === undefined) return undefined;
	return `${fields.date}T${fields.time}${formatOffset(offset)}`;
}

/** Resolve a wall-clock value through IANA zone rules, including DST changes. */
export function zonedDateTimeToRfc3339(
	dateValue: string,
	timeValue: string,
	timezone: string,
	preferredTimestamp?: string,
): string | undefined {
	const date = parseDate(dateValue);
	const time = parseTime(timeValue);
	if (!date || !time) return undefined;
	const wallClockMs = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute, time.second);

	// Sampling both sides of the selected date discovers either offset at a DST
	// boundary. Candidate instants are then checked against the requested wall time.
	const offsets = new Set<number>();
	for (let hours = -48; hours <= 48; hours += 6) {
		const offset = offsetMinutesAt(wallClockMs + hours * 3_600_000, timezone);
		if (offset !== undefined) offsets.add(offset);
	}
	const matches = [...offsets]
		.map(offset => ({ offset, instantMs: wallClockMs - offset * 60_000 }))
		.filter(candidate => {
			const fields = readZonedDateTime(new Date(candidate.instantMs).toISOString(), timezone);
			return fields?.date === dateValue && fields.time === `${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}`;
		})
		.sort((left, right) => left.instantMs - right.instantMs);
	if (matches.length === 0) return undefined;

	const preferredMs = preferredTimestamp ? Date.parse(preferredTimestamp) : Number.NaN;
	const selected = matches.find(candidate => candidate.instantMs === preferredMs) ?? matches[0];
	return `${dateValue}T${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}${formatOffset(selected.offset)}`;
}

function zonedToday(timezone: string): string {
	return readZonedDateTime(new Date().toISOString(), timezone)?.date ?? new Date().toISOString().slice(0, 10);
}

/** Generate a local immutable identity without involving a provider. */
export function createSyncDraftUid(): string {
	const cryptoValue = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
	if (cryptoValue?.randomUUID) return cryptoValue.randomUUID();
	return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createSyncEventDraft(
	initialEvent: CalendarEvent | undefined,
	date: string | undefined = undefined,
	timezone = 'UTC',
): SyncEventDraft {
	if (initialEvent) return { ...initialEvent };
	const startDate = date ?? zonedToday(timezone);
	return {
		uid: createSyncDraftUid(),
		title: '',
		start: zonedDraftTimestamp(startDate, 9, timezone),
		end: zonedDraftTimestamp(startDate, 10, timezone),
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
	private startDateInput?: HTMLInputElement;
	private startTimeInput?: HTMLInputElement;
	private endDateInput?: HTMLInputElement;
	private endTimeInput?: HTMLInputElement;
	private startDraftTimezone: string;
	private endDraftTimezone: string;
	private submitButton?: HTMLButtonElement;
	private isSubmitting = false;

	constructor(app: App, options: SyncEventModalOptions) {
		super(app);
		this.options = options;
		this.draft = createSyncEventDraft(options.initialEvent, options.dateKey, options.timezone);
		this.startDraftTimezone = this.draft.timezone;
		this.endDraftTimezone = this.draft.timezone;
	}

	onOpen(): void {
		this.render();
	}

	private setAccessibleInput(input: HTMLInputElement, label: string): void {
		input.setAttribute('aria-label', label);
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('sync-event-modal');
		contentEl.createEl('h2', { text: this.options.title ?? (this.options.initialEvent ? 'Edit calendar event' : 'Create calendar event') });
		contentEl.createEl('p', {
			text: 'This changes the calendar event. You can create a personal note for it separately.',
			cls: 'setting-item-description',
		});

		const form = contentEl.createDiv('sync-event-form');
		new Setting(form)
			.setName('Title')
			.setDesc('A short, descriptive event title.')
			.addText(component => component.setValue(this.draft.title).onChange(value => { this.draft.title = value; }));

		const startFields = this.draft.allDay
			? { date: this.draft.start, time: '' }
			: readZonedDateTime(this.draft.start, this.draft.timezone) ?? { date: '', time: '' };
		const inclusiveEnd = this.draft.allDay
			? previousCivilDate(this.draft.end)
			: readZonedDateTime(this.draft.end, this.draft.timezone);
		const endFields = typeof inclusiveEnd === 'string'
			? { date: inclusiveEnd, time: '' }
			: inclusiveEnd ?? { date: '', time: '' };

		const startSetting = new Setting(form)
			.setName('Start')
			.setDesc(this.draft.allDay ? 'Choose the first day of the event.' : `Times are shown in ${this.draft.timezone}.`);
		startSetting.addText(component => {
			component.inputEl.type = 'date';
			component.inputEl.classList.add('sync-event-date-input');
			component.setValue(startFields.date);
			this.setAccessibleInput(component.inputEl, 'Start date');
			component.inputEl.addEventListener('input', () => this.handleStartChange());
			this.startDateInput = component.inputEl;
		});
		if (!this.draft.allDay) {
			startSetting.addText(component => {
				component.inputEl.type = 'time';
				component.inputEl.step = '1';
				component.inputEl.classList.add('sync-event-time-input');
				component.setValue(startFields.time);
				this.setAccessibleInput(component.inputEl, 'Start time');
				component.inputEl.addEventListener('input', () => this.handleStartChange());
				this.startTimeInput = component.inputEl;
			});
		}

		const endSetting = new Setting(form)
			.setName('End')
			.setDesc(this.draft.allDay ? 'Choose the last day of the event.' : 'The end must be after the start.');
		endSetting.addText(component => {
			component.inputEl.type = 'date';
			component.inputEl.classList.add('sync-event-date-input');
			component.setValue(endFields.date);
			this.setAccessibleInput(component.inputEl, this.draft.allDay ? 'Last day' : 'End date');
			component.inputEl.addEventListener('input', () => this.handleEndChange());
			this.endDateInput = component.inputEl;
		});
		if (!this.draft.allDay) {
			endSetting.addText(component => {
				component.inputEl.type = 'time';
				component.inputEl.step = '1';
				component.inputEl.classList.add('sync-event-time-input');
				component.setValue(endFields.time);
				this.setAccessibleInput(component.inputEl, 'End time');
				component.inputEl.addEventListener('input', () => this.handleEndChange());
				this.endTimeInput = component.inputEl;
			});
		}

		new Setting(form)
			.setName('All day')
			.setDesc('Use dates without times.')
			.addToggle(component => component.setValue(this.draft.allDay).onChange(value => {
				this.changeAllDay(value);
			}));
		new Setting(form)
			.setName('Timezone')
			.setDesc('IANA timezone used to display and save event times.')
			.addText(component => component.setValue(this.draft.timezone).onChange(value => {
				this.draft.timezone = value.trim();
				this.clearError();
			}));
		this.renderRecurrence(form);
		new Setting(form)
			.setName('Location')
			.addText(component => component.setValue(this.draft.location).onChange(value => { this.draft.location = value; }));
		new Setting(form)
			.setName('Description')
			.addTextArea(component => component.setValue(this.draft.description).onChange(value => { this.draft.description = value; }));

		this.errorEl = contentEl.createDiv('sync-form-error');
		this.errorEl.setAttribute('role', 'alert');
		this.errorEl.setAttribute('aria-live', 'polite');
		this.errorEl.hide();

		const footer = contentEl.createDiv('modal-button-container');
		footer.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
		this.submitButton = footer.createEl('button', {
			text: this.options.submitLabel ?? (this.options.initialEvent ? 'Save event' : 'Create event'),
			cls: 'mod-cta',
		});
		this.submitButton.addEventListener('click', () => { void this.submit(); });
	}

	private renderRecurrence(form: HTMLElement): void {
		new Setting(form)
			.setName('Repeat')
			.setDesc('Choose a repeating schedule for this event.')
			.addDropdown(dropdown => {
				dropdown.addOption('none', 'Does not repeat');
				dropdown.addOption('daily', 'Daily');
				dropdown.addOption('weekly', 'Weekly');
				dropdown.addOption('monthly', 'Monthly');
				dropdown.addOption('yearly', 'Yearly');
				dropdown.setValue(this.draft.recurrence?.frequency ?? 'none');
				dropdown.selectEl.setAttribute('aria-label', 'Repeat frequency');
				dropdown.onChange(value => this.setRecurrenceFrequency(value));
			});

		const recurrence = this.draft.recurrence;
		if (!recurrence) return;
		const unit = recurrence.frequency === 'daily'
			? 'day'
			: recurrence.frequency === 'weekly'
				? 'week'
				: recurrence.frequency === 'monthly' ? 'month' : 'year';
		new Setting(form)
			.setName('Every')
			.setDesc(`Repeat every ${unit} or group of ${unit}s.`)
			.addText(component => {
				component.inputEl.type = 'number';
				component.inputEl.min = '1';
				component.inputEl.step = '1';
				component.inputEl.classList.add('sync-recurrence-interval-input');
				component.setValue(String(recurrence.interval));
				this.setAccessibleInput(component.inputEl, 'Repeat interval');
				component.onChange(value => {
					const current = this.draft.recurrence;
					if (!current) return;
					this.draft.recurrence = {
						...current,
						interval: value === '' ? Number.NaN : Number(value),
					};
				});
			});

		if (recurrence.frequency === 'weekly') {
			const selectedDays = recurrence.weekdays ?? [isoWeekday(this.currentStartDate())];
			const setting = new Setting(form)
				.setName('On these days')
				.setDesc('Select one or more days of the week.');
			const group = setting.controlEl.createDiv('sync-recurrence-weekdays');
			const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
			const fullLabels = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
			labels.forEach((label, index) => {
				const weekday = index + 1;
				const button = group.createEl('button', { text: label, cls: 'sync-recurrence-weekday' });
				button.type = 'button';
				button.setAttribute('aria-label', fullLabels[index]);
				button.setAttribute('aria-pressed', String(selectedDays.includes(weekday)));
				button.classList.toggle('is-active', selectedDays.includes(weekday));
				button.addEventListener('click', () => {
					const current = this.draft.recurrence;
					if (!current || current.frequency !== 'weekly') return;
					const days = current.weekdays ?? [isoWeekday(this.currentStartDate())];
					const nextDays = days.includes(weekday)
						? days.filter(day => day !== weekday)
						: [...days, weekday].sort((left, right) => left - right);
					if (nextDays.length === 0) {
						this.showError('Select at least one day for a weekly event.');
						return;
					}
					this.draft.recurrence = { ...current, weekdays: nextDays };
					button.classList.toggle('is-active', nextDays.includes(weekday));
					button.setAttribute('aria-pressed', String(nextDays.includes(weekday)));
					this.clearError();
				});
			});
		}

		const endMode = recurrence.until ? 'until' : recurrence.count !== undefined ? 'count' : 'never';
		new Setting(form)
			.setName('Ends')
			.addDropdown(dropdown => {
				dropdown.addOption('never', 'Never');
				dropdown.addOption('count', 'After a number of events');
				dropdown.addOption('until', 'On a date');
				dropdown.setValue(endMode);
				dropdown.selectEl.setAttribute('aria-label', 'When the repeating schedule ends');
				dropdown.onChange(value => this.setRecurrenceEnd(value));
			});
		if (endMode === 'count') {
			new Setting(form)
				.setName('Occurrences')
				.setDesc('Include the first event in this count.')
				.addText(component => {
					component.inputEl.type = 'number';
					component.inputEl.min = '1';
					component.inputEl.step = '1';
					component.inputEl.classList.add('sync-recurrence-interval-input');
					component.setValue(String(recurrence.count ?? 10));
					this.setAccessibleInput(component.inputEl, 'Number of occurrences');
					component.onChange(value => {
						const current = this.draft.recurrence;
						if (!current) return;
						this.draft.recurrence = {
							...current,
							count: value === '' ? Number.NaN : Number(value),
						};
					});
				});
		} else if (endMode === 'until') {
			new Setting(form)
				.setName('Through date')
				.addText(component => {
					component.inputEl.type = 'date';
					component.inputEl.classList.add('sync-recurrence-until-input');
					component.setValue(recurrence.until ?? '');
					this.setAccessibleInput(component.inputEl, 'Repeat through date');
					component.onChange(value => {
						const current = this.draft.recurrence;
						if (current) this.draft.recurrence = { ...current, until: value };
					});
				});
		}
	}

	private currentStartDate(): string {
		return this.startDateInput?.value || (this.draft.allDay
			? this.draft.start
			: readZonedDateTime(this.draft.start, this.draft.timezone)?.date ?? this.draft.start.slice(0, 10));
	}

	private setRecurrenceFrequency(value: string): void {
		if (value === 'none') {
			this.draft.recurrence = undefined;
		} else if (['daily', 'weekly', 'monthly', 'yearly'].includes(value)) {
			const frequency = value as RecurrenceFrequency;
			const previous = this.draft.recurrence;
			this.draft.recurrence = {
				frequency,
				interval: previous?.interval ?? 1,
				...(frequency === 'weekly' ? { weekdays: previous?.weekdays ?? [isoWeekday(this.currentStartDate())] } : {}),
				...(previous?.count !== undefined ? { count: previous.count } : {}),
				...(previous?.until ? { until: previous.until } : {}),
			};
		}
		this.render();
	}

	private setRecurrenceEnd(value: string): void {
		const current = this.draft.recurrence;
		if (!current) return;
		const { count, until, ...base } = current;
		if (value === 'count') this.draft.recurrence = { ...base, count: count ?? 10 };
		else if (value === 'until') this.draft.recurrence = { ...base, until: until ?? this.currentStartDate() };
		else this.draft.recurrence = base;
		this.render();
	}

	private clearError(): void {
		this.errorEl?.empty();
		this.errorEl?.hide();
	}

	private showError(message: string): void {
		if (!this.errorEl) return;
		this.errorEl.setText(message);
		this.errorEl.show();
	}

	private handleStartChange(): void {
		this.clearError();
		if (this.draft.allDay) {
			this.draft.start = this.startDateInput?.value ?? '';
			return;
		}
		if (!this.startDateInput?.value || !this.startTimeInput?.value) return;
		const previousStart = Date.parse(this.draft.start);
		const previousEnd = Date.parse(this.draft.end);
		const durationMs = previousEnd - previousStart;
		const start = zonedDateTimeToRfc3339(
			this.startDateInput.value,
			this.startTimeInput.value,
			this.draft.timezone,
			this.startDraftTimezone === this.draft.timezone ? this.draft.start : undefined,
		);
		if (!start) {
			this.showError('That start time does not exist in this timezone because of a clock change. Choose another time.');
			return;
		}
		this.draft.start = start;
		this.startDraftTimezone = this.draft.timezone;
		if (durationMs > 0) {
			const end = formatInstantInZone(Date.parse(start) + durationMs, this.draft.timezone);
			if (end) {
				this.draft.end = end;
				this.endDraftTimezone = this.draft.timezone;
				const endFields = readZonedDateTime(end, this.draft.timezone);
				if (endFields && this.endDateInput && this.endTimeInput) {
					this.endDateInput.value = endFields.date;
					this.endTimeInput.value = endFields.time;
				}
			}
		}
	}

	private handleEndChange(): void {
		this.clearError();
		if (this.draft.allDay) {
			const lastDay = this.endDateInput?.value ?? '';
			this.draft.end = parseDate(lastDay) ? nextCivilDate(lastDay) : '';
			return;
		}
		if (!this.endDateInput?.value || !this.endTimeInput?.value) return;
		const end = zonedDateTimeToRfc3339(
			this.endDateInput.value,
			this.endTimeInput.value,
			this.draft.timezone,
			this.endDraftTimezone === this.draft.timezone ? this.draft.end : undefined,
		);
		if (!end) {
			this.showError('That end time does not exist in this timezone because of a clock change. Choose another time.');
			return;
		}
		this.draft.end = end;
		this.endDraftTimezone = this.draft.timezone;
	}

	private changeAllDay(allDay: boolean): void {
		if (allDay === this.draft.allDay) return;
		if (allDay) {
			const startFields = this.startDateInput && this.startTimeInput
				? { date: this.startDateInput.value, time: this.startTimeInput.value }
				: readZonedDateTime(this.draft.start, this.draft.timezone);
			const endFields = this.endDateInput && this.endTimeInput
				? { date: this.endDateInput.value, time: this.endTimeInput.value }
				: readZonedDateTime(this.draft.end, this.draft.timezone);
			if (!startFields || !endFields || !startFields.date || !endFields.date) {
				this.showError('Choose valid start and end dates before changing the event type.');
				this.render();
				return;
			}
			let inclusiveEnd = endFields.date;
			if (endFields.time === '00:00:00' && inclusiveEnd > startFields.date) {
				inclusiveEnd = previousCivilDate(inclusiveEnd);
			}
			if (inclusiveEnd < startFields.date) inclusiveEnd = startFields.date;
			this.draft.start = startFields.date;
			this.draft.end = nextCivilDate(inclusiveEnd);
			this.draft.allDay = true;
		} else {
			const startDate = this.startDateInput?.value || this.draft.start;
			const inclusiveEnd = this.endDateInput?.value || previousCivilDate(this.draft.end);
			this.draft.start = zonedDraftTimestamp(startDate, 9, this.draft.timezone);
			this.draft.end = zonedDraftTimestamp(inclusiveEnd, 10, this.draft.timezone);
			this.draft.allDay = false;
		}
		this.render();
	}

	private eventFromInputs(): CalendarEvent | undefined {
		if (this.draft.allDay) {
			const start = this.startDateInput?.value ?? '';
			const lastDay = this.endDateInput?.value ?? '';
			if (!start || !lastDay) {
				this.showError('Choose a start date and last day for the event.');
				return undefined;
			}
			this.draft.start = start;
			this.draft.end = nextCivilDate(lastDay);
		} else {
			const startDate = this.startDateInput?.value ?? '';
			const startTime = this.startTimeInput?.value ?? '';
			const endDate = this.endDateInput?.value ?? '';
			const endTime = this.endTimeInput?.value ?? '';
			if (!startDate || !startTime || !endDate || !endTime) {
				this.showError('Choose a start date, start time, end date, and end time.');
				return undefined;
			}
			const start = zonedDateTimeToRfc3339(
				startDate,
				startTime,
				this.draft.timezone,
				this.startDraftTimezone === this.draft.timezone ? this.draft.start : undefined,
			);
			if (!start) {
				this.showError('That start time does not exist in this timezone because of a clock change. Choose another time.');
				return undefined;
			}
			const end = zonedDateTimeToRfc3339(
				endDate,
				endTime,
				this.draft.timezone,
				this.endDraftTimezone === this.draft.timezone ? this.draft.end : undefined,
			);
			if (!end) {
				this.showError('That end time does not exist in this timezone because of a clock change. Choose another time.');
				return undefined;
			}
			this.draft.start = start;
			this.draft.end = end;
			this.startDraftTimezone = this.draft.timezone;
			this.endDraftTimezone = this.draft.timezone;
		}
		return { ...this.draft };
	}

	private async submit(): Promise<void> {
		if (this.isSubmitting) return;
		this.clearError();
		const event = this.eventFromInputs();
		if (!event) return;
		const validation = validateCalendarEvent(event);
		if (!validation.ok) {
			this.showError(draftValidationMessage(validation.errors));
			return;
		}

		this.isSubmitting = true;
		if (this.submitButton) {
			this.submitButton.disabled = true;
			this.submitButton.setAttribute('aria-busy', 'true');
			this.submitButton.setText('Saving…');
		}
		try {
			await this.options.onSubmit(validation.value);
			this.close();
		} catch (error) {
			const message = sanitizeSyncUiError(error);
			this.showError(message);
			new Notice(`Calendar event was not saved: ${message}`);
		} finally {
			this.isSubmitting = false;
			if (this.submitButton) {
				this.submitButton.disabled = false;
				this.submitButton.removeAttribute('aria-busy');
				this.submitButton.setText(this.options.submitLabel ?? (this.options.initialEvent ? 'Save event' : 'Create event'));
			}
		}
	}

	onClose(): void {
		this.contentEl.empty();
		this.errorEl = undefined;
		this.startDateInput = undefined;
		this.startTimeInput = undefined;
		this.endDateInput = undefined;
		this.endTimeInput = undefined;
		this.submitButton = undefined;
	}
}

export function openSyncEventModal(app: App, options: SyncEventModalOptions): SyncEventModal {
	const modal = new SyncEventModal(app, options);
	modal.open();
	return modal;
}
