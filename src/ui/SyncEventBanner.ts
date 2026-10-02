import { Component, setIcon } from 'obsidian';
import type { CalendarEvent, SyncStatus } from '../services/sync/model';
import { formatCalendarEventTime, syncStatusLabel } from '../components/SyncUi';

/**
 * Options for configuring the synced Google Calendar event banner.
 */
export interface SyncEventBannerOptions {
	/**
	 * Explicit sync status to display on the badge.
	 * If omitted, defaults to `event.status` (if present) or 'synced'.
	 */
	readonly status?: SyncStatus;

	/**
	 * Optional click callback when the banner container is clicked.
	 * If provided without an explicit onEdit handler, clicking either
	 * the banner or the edit button invokes this.
	 */
	readonly onClick?: (evt: MouseEvent) => void;

	/**
	 * Optional handler called when the Edit action button (or banner) is clicked.
	 */
	readonly onEdit?: () => void;

	/**
	 * Obsidian Component lifecycle object.
	 * If provided, all event listeners are registered via `component.registerDomEvent`
	 * so they are automatically cleaned up when the editor leaf or view is unloaded.
	 */
	readonly component?: Component;

	/**
	 * Whether to render an explicit Edit action button.
	 * Defaults to true if onEdit or onClick is provided.
	 */
	readonly showEditButton?: boolean;

	/**
	 * Optional additional CSS class(es) to attach to the root banner element.
	 */
	readonly cls?: string;
}

/**
 * Extended HTMLDivElement providing lifecycle and in-place update methods
 * for the Google Calendar event banner.
 */
export interface SyncEventBannerElement extends HTMLDivElement {
	/** In-place update of banner DOM without recreating nodes. */
	update(event: CalendarEvent, status?: SyncStatus): void;
	/** Retrieve the current event data displayed in this banner. */
	getEvent(): CalendarEvent;
	/** Retrieve the current sync status displayed in this banner. */
	getStatus(): SyncStatus;
}

function safeCreateDiv(parent: HTMLElement, cls?: string): HTMLDivElement {
	if (typeof parent.createDiv === 'function') {
		return parent.createDiv(cls ? { cls } : undefined);
	}
	const div = document.createElement('div');
	if (cls) div.className = cls;
	parent.appendChild(div);
	return div;
}

function safeCreateSpan(parent: HTMLElement, cls?: string): HTMLSpanElement {
	if (typeof parent.createSpan === 'function') {
		return parent.createSpan(cls ? { cls } : undefined);
	}
	const span = document.createElement('span');
	if (cls) span.className = cls;
	parent.appendChild(span);
	return span;
}

function safeSetIcon(element: HTMLElement, iconId: string): void {
	if (typeof setIcon === 'function') {
		try {
			setIcon(element, iconId);
		} catch (_err) {
			// Gracefully fallback if icon is unavailable or in non-Obsidian environment
		}
	}
}

function registerListener<K extends keyof HTMLElementEventMap>(
	target: HTMLElement,
	type: K,
	listener: (ev: HTMLElementEventMap[K]) => void,
	component?: Component,
): void {
	if (component) {
		component.registerDomEvent(target, type, listener as (this: HTMLElement, ev: HTMLElementEventMap[K]) => any);
	} else {
		target.addEventListener(type, listener);
	}
}

function applyStatusClasses(container: HTMLElement, status: SyncStatus): void {
	const allStatusClasses = [
		'sync-banner-status-synced',
		'sync-banner-status-pending',
		'sync-banner-status-conflict',
		'sync-banner-status-error',
		'sync-banner-status-remote_deleted',
		'sync-banner-status-unsupported',
	];
	for (const cls of allStatusClasses) {
		container.classList.remove(cls);
	}
	container.classList.add(`sync-banner-status-${status}`);
}

/**
 * Creates a standalone, lightweight vanilla DOM banner element displaying Google Calendar
 * event details (title, formatted time, and sync status) without React overhead.
 */
export function createSyncEventBanner(
	event: CalendarEvent,
	options?: SyncEventBannerOptions,
): SyncEventBannerElement;
export function createSyncEventBanner(
	options: SyncEventBannerOptions & { event: CalendarEvent },
): SyncEventBannerElement;
export function createSyncEventBanner(
	eventOrOptions: CalendarEvent | (SyncEventBannerOptions & { event: CalendarEvent }),
	maybeOptions?: SyncEventBannerOptions,
): SyncEventBannerElement {
	let initialEvent: CalendarEvent;
	let options: SyncEventBannerOptions | undefined;

	if ('uid' in eventOrOptions && 'title' in eventOrOptions && 'start' in eventOrOptions) {
		initialEvent = eventOrOptions as CalendarEvent;
		options = maybeOptions;
	} else {
		const fullOptions = eventOrOptions as SyncEventBannerOptions & { event: CalendarEvent };
		initialEvent = fullOptions.event;
		options = fullOptions;
	}

	let currentEvent = initialEvent;
	let currentStatus: SyncStatus =
		options?.status ??
		((initialEvent as unknown as { status?: SyncStatus }).status ?? 'synced');

	// Create root container
	const bannerEl = (
		typeof createDiv === 'function'
			? createDiv({ cls: 'sync-event-banner' })
			: document.createElement('div')
	) as SyncEventBannerElement;

	if (!bannerEl.classList.contains('sync-event-banner')) {
		bannerEl.classList.add('sync-event-banner');
	}

	if (options?.cls) {
		for (const c of options.cls.split(' ').filter(Boolean)) {
			bannerEl.classList.add(c);
		}
	}

	bannerEl.setAttribute('role', 'region');
	bannerEl.dataset.calendarUid = currentEvent.uid;
	applyStatusClasses(bannerEl, currentStatus);

	const initialTitle = currentEvent.title?.trim() ? currentEvent.title : 'Untitled event';
	bannerEl.setAttribute('aria-label', `Google Calendar event: ${initialTitle}`);

	// Leading section (Icon + Main Content)
	const leadingEl = safeCreateDiv(bannerEl, 'sync-event-banner-leading');

	// Calendar Icon
	const iconContainer = safeCreateDiv(leadingEl, 'sync-event-banner-icon');
	iconContainer.setAttribute('aria-hidden', 'true');
	safeSetIcon(iconContainer, 'calendar');

	// Main content column
	const contentEl = safeCreateDiv(leadingEl, 'sync-event-banner-content');

	// Header row: Title + Status Badge
	const headerEl = safeCreateDiv(contentEl, 'sync-event-banner-header');

	const titleEl = safeCreateSpan(headerEl, 'sync-event-banner-title');
	titleEl.textContent = initialTitle;
	titleEl.title = initialTitle;

	const statusBadgeEl = safeCreateSpan(headerEl, `sync-status-badge sync-status-${currentStatus}`);
	const initialStatusLabel = syncStatusLabel(currentStatus) ?? currentStatus;
	statusBadgeEl.textContent = initialStatusLabel;
	statusBadgeEl.setAttribute('role', 'status');
	statusBadgeEl.setAttribute('aria-label', `Sync status: ${initialStatusLabel}`);

	// Meta row: Time + Location
	const metaEl = safeCreateDiv(contentEl, 'sync-event-banner-meta');

	// Time span
	const timeSpan = safeCreateSpan(metaEl, 'sync-event-banner-time');
	const timeIcon = safeCreateSpan(timeSpan, 'sync-event-banner-meta-icon');
	timeIcon.setAttribute('aria-hidden', 'true');
	safeSetIcon(timeIcon, 'clock');

	const timeTextEl = safeCreateSpan(timeSpan, 'sync-event-banner-time-text');
	timeTextEl.textContent = formatCalendarEventTime(currentEvent);
	timeSpan.title = 'Event time';

	// Location span
	const locationSpan = safeCreateSpan(metaEl, 'sync-event-banner-location');
	const locationIcon = safeCreateSpan(locationSpan, 'sync-event-banner-meta-icon');
	locationIcon.setAttribute('aria-hidden', 'true');
	safeSetIcon(locationIcon, 'map-pin');

	const locationTextEl = safeCreateSpan(locationSpan, 'sync-event-banner-location-text');
	if (currentEvent.location && currentEvent.location.trim().length > 0) {
		locationTextEl.textContent = currentEvent.location.trim();
		locationSpan.title = currentEvent.location.trim();
		locationSpan.style.display = 'inline-flex';
	} else {
		locationSpan.style.display = 'none';
	}

	// Action buttons (trailing)
	const hasEditAction = Boolean(options?.onEdit || options?.onClick);
	const showEditButton = options?.showEditButton ?? hasEditAction;

	let editButton: HTMLButtonElement | undefined;
	if (showEditButton) {
		const actionsEl = safeCreateDiv(bannerEl, 'sync-event-banner-actions');
		editButton = document.createElement('button');
		editButton.type = 'button';
		editButton.className = 'sync-event-banner-action-btn sync-note-action clickable-icon';
		editButton.setAttribute('aria-label', `Edit ${initialTitle}`);
		editButton.title = 'Edit Google Calendar event';

		const editIconEl = safeCreateSpan(editButton, 'sync-event-banner-action-icon');
		editIconEl.setAttribute('aria-hidden', 'true');
		safeSetIcon(editIconEl, 'pencil');

		const editTextEl = safeCreateSpan(editButton, 'sync-event-banner-action-text');
		editTextEl.textContent = 'Edit';

		actionsEl.appendChild(editButton);

		registerListener(
			editButton,
			'click',
			(evt: MouseEvent) => {
				evt.stopPropagation();
				if (options?.onEdit) {
					options.onEdit();
				} else if (options?.onClick) {
					options.onClick(evt);
				}
			},
			options?.component,
		);
	}

	// Clickable banner container
	if (hasEditAction) {
		bannerEl.classList.add('is-clickable');
		registerListener(
			bannerEl,
			'click',
			(evt: MouseEvent) => {
				if ((evt.target as HTMLElement | null)?.closest('button, a')) {
					return;
				}
				if (options?.onClick) {
					options.onClick(evt);
				} else if (options?.onEdit) {
					options.onEdit();
				}
			},
			options?.component,
		);
	}

	// In-place update function
	const update = (nextEvent: CalendarEvent, nextStatus?: SyncStatus): void => {
		currentEvent = nextEvent;
		if (nextStatus !== undefined) {
			currentStatus = nextStatus;
		} else if ((nextEvent as unknown as { status?: SyncStatus }).status !== undefined) {
			currentStatus = (nextEvent as unknown as { status?: SyncStatus }).status!;
		}

		const nextTitle = currentEvent.title?.trim() ? currentEvent.title : 'Untitled event';
		titleEl.textContent = nextTitle;
		titleEl.title = nextTitle;
		bannerEl.setAttribute('aria-label', `Google Calendar event: ${nextTitle}`);
		bannerEl.dataset.calendarUid = currentEvent.uid;

		// Status badge update
		statusBadgeEl.className = `sync-status-badge sync-status-${currentStatus}`;
		const nextStatusLabel = syncStatusLabel(currentStatus) ?? currentStatus;
		statusBadgeEl.textContent = nextStatusLabel;
		statusBadgeEl.setAttribute('aria-label', `Sync status: ${nextStatusLabel}`);
		applyStatusClasses(bannerEl, currentStatus);

		// Time update
		timeTextEl.textContent = formatCalendarEventTime(currentEvent);

		// Location update
		if (currentEvent.location && currentEvent.location.trim().length > 0) {
			locationTextEl.textContent = currentEvent.location.trim();
			locationSpan.title = currentEvent.location.trim();
			locationSpan.style.display = 'inline-flex';
		} else {
			locationSpan.style.display = 'none';
		}

		// Edit button update
		if (editButton) {
			editButton.setAttribute('aria-label', `Edit ${nextTitle}`);
		}
	};

	bannerEl.update = update;
	bannerEl.getEvent = () => currentEvent;
	bannerEl.getStatus = () => currentStatus;

	return bannerEl;
}

/**
 * Obsidian Component wrapping the synced event banner to integrate with
 * Obsidian view component lifecycles.
 */
export class SyncEventBannerComponent extends Component {
	public readonly containerEl: SyncEventBannerElement;

	constructor(event: CalendarEvent, options?: Omit<SyncEventBannerOptions, 'component'>) {
		super();
		this.containerEl = createSyncEventBanner(event, {
			...options,
			component: this,
		});
	}

	update(event: CalendarEvent, status?: SyncStatus): void {
		this.containerEl.update(event, status);
	}

	getEvent(): CalendarEvent {
		return this.containerEl.getEvent();
	}

	getStatus(): SyncStatus {
		return this.containerEl.getStatus();
	}

	onunload(): void {
		this.containerEl.remove();
	}
}
