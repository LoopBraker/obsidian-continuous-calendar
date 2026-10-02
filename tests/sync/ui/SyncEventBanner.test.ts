import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarEvent, SyncStatus } from '../../../src/services/sync/model';
import {
	createSyncEventBanner,
	SyncEventBannerComponent,
} from '../../../src/ui/SyncEventBanner';

class MockClassList {
	private classes = new Set<string>();

	add(...tokens: string[]): void {
		for (const t of tokens) this.classes.add(t);
	}

	remove(...tokens: string[]): void {
		for (const t of tokens) this.classes.delete(t);
	}

	contains(token: string): boolean {
		return this.classes.has(token);
	}

	get value(): string {
		return Array.from(this.classes).join(' ');
	}
}

class MockElement {
	tagName: string;
	children: MockElement[] = [];
	parentElement: MockElement | null = null;
	attributes: Record<string, string> = {};
	dataset: Record<string, string> = {};
	classList = new MockClassList();
	style: Record<string, string> = {};
	listeners: Record<string, Array<(event: unknown) => void>> = {};
	textContent = '';
	title = '';
	type?: string;

	constructor(tagName: string) {
		this.tagName = tagName.toUpperCase();
	}

	get className(): string {
		return this.classList.value;
	}

	set className(val: string) {
		this.classList = new MockClassList();
		if (val) {
			this.classList.add(...val.split(' ').filter(Boolean));
		}
	}

	setAttribute(name: string, value: string): void {
		this.attributes[name] = value;
	}

	getAttribute(name: string): string | null {
		return this.attributes[name] ?? null;
	}

	appendChild<T extends MockElement>(child: T): T {
		child.parentElement = this;
		this.children.push(child);
		return child;
	}

	addEventListener(type: string, listener: (event: unknown) => void): void {
		if (!this.listeners[type]) this.listeners[type] = [];
		this.listeners[type].push(listener);
	}

	dispatchEvent(event: { type: string; stopPropagation?: () => void; target?: unknown }): boolean {
		event.target = this;
		const list = this.listeners[event.type] || [];
		for (const listener of list) {
			listener(event);
		}
		return true;
	}

	closest(selector: string): MockElement | null {
		if (selector.toLowerCase() === this.tagName.toLowerCase()) {
			return this;
		}
		return this.parentElement ? this.parentElement.closest(selector) : null;
	}

	querySelector(selector: string): MockElement | null {
		for (const child of this.children) {
			if (selector.startsWith('.') && child.classList.contains(selector.slice(1))) {
				return child;
			}
			if (child.tagName.toLowerCase() === selector.toLowerCase()) {
				return child;
			}
			const found = child.querySelector(selector);
			if (found) return found;
		}
		return null;
	}

	remove(): void {
		if (this.parentElement) {
			const idx = this.parentElement.children.indexOf(this);
			if (idx >= 0) this.parentElement.children.splice(idx, 1);
			this.parentElement = null;
		}
	}
}

const mockDocument = {
	createElement(tagName: string): MockElement {
		return new MockElement(tagName);
	},
};

describe('SyncEventBanner', () => {
	const sampleEvent: CalendarEvent = {
		uid: 'evt-123',
		title: 'Sprint Planning',
		start: '2026-10-02T10:00:00-04:00',
		end: '2026-10-02T11:00:00-04:00',
		allDay: false,
		timezone: 'America/New_York',
		location: 'Conference Room B',
		description: 'Weekly team sprint planning session.',
	};

	beforeEach(() => {
		(globalThis as unknown as { document: typeof mockDocument }).document = mockDocument;
	});

	it('creates a standalone banner element with title, formatted time, and status', () => {
		const banner = createSyncEventBanner(sampleEvent, { status: 'synced' });

		expect(banner.classList.contains('sync-event-banner')).toBe(true);
		expect(banner.classList.contains('sync-banner-status-synced')).toBe(true);
		expect(banner.getAttribute('role')).toBe('region');
		expect(banner.dataset.calendarUid).toBe('evt-123');

		const titleEl = (banner as unknown as MockElement).querySelector('.sync-event-banner-title');
		expect(titleEl?.textContent).toBe('Sprint Planning');

		const badgeEl = (banner as unknown as MockElement).querySelector('.sync-status-badge');
		expect(badgeEl?.textContent).toBe('Synced');
		expect(badgeEl?.classList.contains('sync-status-synced')).toBe(true);

		const timeEl = (banner as unknown as MockElement).querySelector('.sync-event-banner-time-text');
		expect(timeEl?.textContent).toContain('10:00');
		expect(timeEl?.textContent).toContain('11:00');

		const locationEl = (banner as unknown as MockElement).querySelector('.sync-event-banner-location-text');
		expect(locationEl?.textContent).toBe('Conference Room B');
	});

	it('handles untitled events and missing location gracefully', () => {
		const untitledEvent: CalendarEvent = {
			...sampleEvent,
			title: '',
			location: '',
		};

		const banner = createSyncEventBanner(untitledEvent);
		const titleEl = (banner as unknown as MockElement).querySelector('.sync-event-banner-title');
		expect(titleEl?.textContent).toBe('Untitled event');

		const locationSpan = (banner as unknown as MockElement).querySelector('.sync-event-banner-location');
		expect(locationSpan?.style.display).toBe('none');
	});

	it('reflects different sync statuses', () => {
		const statuses: SyncStatus[] = ['pending', 'conflict', 'error', 'remote_deleted', 'unsupported'];

		for (const status of statuses) {
			const banner = createSyncEventBanner(sampleEvent, { status });
			expect(banner.classList.contains(`sync-banner-status-${status}`)).toBe(true);

			const badgeEl = (banner as unknown as MockElement).querySelector('.sync-status-badge');
			expect(badgeEl?.classList.contains(`sync-status-${status}`)).toBe(true);
		}
	});

	it('wires onEdit and onClick callbacks correctly', () => {
		const onEdit = vi.fn();
		const onClick = vi.fn();

		const banner = createSyncEventBanner(sampleEvent, {
			onEdit,
			onClick,
		});

		expect(banner.classList.contains('is-clickable')).toBe(true);

		const editBtn = (banner as unknown as MockElement).querySelector('button');
		expect(editBtn).not.toBeNull();

		// Clicking edit button invokes onEdit and stops propagation
		const clickEvent = { type: 'click', stopPropagation: vi.fn() };
		editBtn?.dispatchEvent(clickEvent);
		expect(onEdit).toHaveBeenCalledTimes(1);
		expect(clickEvent.stopPropagation).toHaveBeenCalled();
		expect(onClick).not.toHaveBeenCalled();

		// Clicking the banner invokes onClick
		(banner as unknown as MockElement).dispatchEvent({ type: 'click' });
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it('updates event data and status in place', () => {
		const banner = createSyncEventBanner(sampleEvent, { status: 'pending' });
		expect(banner.getStatus()).toBe('pending');

		const updatedEvent: CalendarEvent = {
			...sampleEvent,
			title: 'Sprint Planning (Rescheduled)',
			location: 'Room 404',
		};

		banner.update(updatedEvent, 'synced');

		expect(banner.getEvent().title).toBe('Sprint Planning (Rescheduled)');
		expect(banner.getStatus()).toBe('synced');
		expect(banner.classList.contains('sync-banner-status-synced')).toBe(true);
		expect(banner.classList.contains('sync-banner-status-pending')).toBe(false);

		const titleEl = (banner as unknown as MockElement).querySelector('.sync-event-banner-title');
		expect(titleEl?.textContent).toBe('Sprint Planning (Rescheduled)');

		const badgeEl = (banner as unknown as MockElement).querySelector('.sync-status-badge');
		expect(badgeEl?.textContent).toBe('Synced');

		const locationEl = (banner as unknown as MockElement).querySelector('.sync-event-banner-location-text');
		expect(locationEl?.textContent).toBe('Room 404');
	});

	it('accepts options object syntax as first parameter', () => {
		const banner = createSyncEventBanner({
			event: sampleEvent,
			status: 'conflict',
			cls: 'custom-banner-class',
		});

		expect(banner.classList.contains('custom-banner-class')).toBe(true);
		expect(banner.getStatus()).toBe('conflict');
	});

	it('wraps banner in SyncEventBannerComponent lifecycle', () => {
		const comp = new SyncEventBannerComponent(sampleEvent, { status: 'synced' });
		expect(comp.containerEl).not.toBeNull();
		expect(comp.getEvent().title).toBe('Sprint Planning');
		expect(comp.getStatus()).toBe('synced');

		comp.update({ ...sampleEvent, title: 'Updated title' });
		expect(comp.getEvent().title).toBe('Updated title');
	});
});
