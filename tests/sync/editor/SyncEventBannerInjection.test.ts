import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarEvent } from '../../../src/services/sync/model';
import type { IndexedCalendarEvent } from '../../../src/services/sync/notes/CalendarEventIndex';
import {
	CSS_SYNC_EVENT_BANNER,
	CSS_SYNC_EVENT_BANNER_PLACEHOLDER,
	createSyncEventBanner,
	findDirectHeader,
	findLivePreviewInsertionTarget,
	getSyncedGoogleEventRecord,
	injectReadingModeBanner,
	isSyncedGoogleNote,
	registerReadingModeBannerHandlers,
	registerSyncEventBanner,
	removeBannerElement,
	removeReadingModeBanner,
} from '../../../src/editor/SyncEventBannerInjection';

vi.mock('@codemirror/view', () => ({
	ViewPlugin: {
		fromClass: vi.fn(),
	},
	EditorView: {},
	PluginValue: class {},
}));

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
	isConnected = true;

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

	get previousElementSibling(): MockElement | null {
		if (!this.parentElement) return null;
		const idx = this.parentElement.children.indexOf(this);
		return idx > 0 ? this.parentElement.children[idx - 1] : null;
	}

	get nextElementSibling(): MockElement | null {
		if (!this.parentElement) return null;
		const idx = this.parentElement.children.indexOf(this);
		return idx >= 0 && idx < this.parentElement.children.length - 1
			? this.parentElement.children[idx + 1]
			: null;
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

	insertBefore<T extends MockElement>(child: T, reference: MockElement | null): T {
		child.parentElement = this;
		if (!reference) {
			this.children.push(child);
		} else {
			const idx = this.children.indexOf(reference);
			if (idx >= 0) this.children.splice(idx, 0, child);
			else this.children.push(child);
		}
		return child;
	}

	insertAdjacentElement(position: 'beforebegin' | 'afterbegin' | 'beforeend' | 'afterend', element: MockElement): MockElement | null {
		if (position === 'afterend') {
			if (!this.parentElement) return null;
			const idx = this.parentElement.children.indexOf(this);
			this.parentElement.children.splice(idx + 1, 0, element);
			element.parentElement = this.parentElement;
			return element;
		}
		if (position === 'beforebegin') {
			if (!this.parentElement) return null;
			const idx = this.parentElement.children.indexOf(this);
			this.parentElement.children.splice(idx, 0, element);
			element.parentElement = this.parentElement;
			return element;
		}
		return null;
	}

	createDiv(options?: { cls?: string }): MockElement {
		const div = new MockElement('div');
		if (options?.cls) div.className = options.cls;
		this.appendChild(div);
		return div;
	}

	createSpan(options?: { cls?: string; text?: string }): MockElement {
		const span = new MockElement('span');
		if (options?.cls) span.className = options.cls;
		if (options?.text) span.textContent = options.text;
		this.appendChild(span);
		return span;
	}

	createEl(tag: string, options?: { cls?: string; text?: string }): MockElement {
		const el = new MockElement(tag);
		if (options?.cls) el.className = options.cls;
		if (options?.text) el.textContent = options.text;
		this.appendChild(el);
		return el;
	}

	addEventListener(type: string, listener: (event: unknown) => void): void {
		if (!this.listeners[type]) this.listeners[type] = [];
		this.listeners[type].push(listener);
	}

	removeEventListener(type: string, listener: (event: unknown) => void): void {
		if (!this.listeners[type]) return;
		this.listeners[type] = this.listeners[type].filter(l => l !== listener);
	}

	querySelector(selector: string): MockElement | null {
		const selectors = selector.split(',').map(s => s.trim());
		for (const s of selectors) {
			const found = this.querySingle(s);
			if (found) return found;
		}
		return null;
	}

	private querySingle(selector: string): MockElement | null {
		for (const child of this.children) {
			if (selector.startsWith('.') && child.classList.contains(selector.slice(1))) {
				return child;
			}
			if (child.tagName.toLowerCase() === selector.toLowerCase()) {
				return child;
			}
			const found = child.querySingle(selector);
			if (found) return found;
		}
		return null;
	}

	querySelectorAll(selector: string): MockElement[] {
		const results: MockElement[] = [];
		for (const child of this.children) {
			if (selector.startsWith('.') && child.classList.contains(selector.slice(1))) {
				results.push(child);
			}
			results.push(...child.querySelectorAll(selector));
		}
		return results;
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

describe('SyncEventBannerInjection', () => {
	const sampleEvent: CalendarEvent = {
		uid: 'test-google-uid-1',
		title: 'Project Kickoff',
		start: '2026-10-02T14:00:00-04:00',
		end: '2026-10-02T15:00:00-04:00',
		allDay: false,
		timezone: 'America/New_York',
		location: 'Virtual',
		description: 'Google synced event kickoff.',
	};

	const sampleRecord: IndexedCalendarEvent = {
		path: 'Events/Project Kickoff.md',
		event: sampleEvent,
		status: 'synced',
		association: {
			calendarUid: 'test-google-uid-1',
			status: 'synced',
			reference: {
				providerId: 'google',
				accountId: 'acc-1',
				calendarId: 'primary',
				remoteEventId: 'remote-1',
			},
		},
	};

	let mockPlugin: any;

	beforeEach(() => {
		(globalThis as unknown as { document: typeof mockDocument }).document = mockDocument;

		mockPlugin = {
			settings: { sync: { timezone: 'America/New_York' } },
			calendarEventRepository: {
				index: {
					getByPath: vi.fn((path: string) => {
						if (path === sampleRecord.path) return sampleRecord;
						return undefined;
					}),
				},
				update: vi.fn(),
			},
			app: {
				workspace: {
					on: vi.fn((_evt: string, _cb: any) => ({})),
					getLeavesOfType: vi.fn(() => []),
				},
				metadataCache: {
					on: vi.fn((_evt: string, _cb: any) => ({})),
				},
			},
			registerEditorExtension: vi.fn(),
			registerEvent: vi.fn(),
		};
	});

	describe('Note identification', () => {
		it('detects synced Google Calendar note by path', () => {
			const found = getSyncedGoogleEventRecord(mockPlugin, sampleRecord.path);
			expect(found).toBe(sampleRecord);
			expect(found?.association?.reference.providerId).toBe('google');
		});

		it('returns null for non-synced notes', () => {
			const found = getSyncedGoogleEventRecord(mockPlugin, 'NonSynced.md');
			expect(found).toBeNull();
		});

		it('returns null if path or repository index is unavailable', () => {
			expect(getSyncedGoogleEventRecord(mockPlugin, null)).toBeNull();
			expect(getSyncedGoogleEventRecord({} as any, 'Events/Note.md')).toBeNull();
		});

		it('validates TFile extension and path with isSyncedGoogleNote', () => {
			const mdFile = { path: sampleRecord.path, extension: 'md' } as any;
			const pdfFile = { path: sampleRecord.path, extension: 'pdf' } as any;

			expect(isSyncedGoogleNote(mockPlugin, mdFile)).toBe(sampleRecord);
			expect(isSyncedGoogleNote(mockPlugin, pdfFile)).toBeNull();
			expect(isSyncedGoogleNote(mockPlugin, null)).toBeNull();
		});
	});

	describe('Banner element construction and cleanup', () => {
		it('creates a placeholder banner element with required attributes and classes', () => {
			const { banner, component } = createSyncEventBanner(sampleRecord, mockPlugin);

			expect(banner.classList.contains(CSS_SYNC_EVENT_BANNER)).toBe(true);
			expect(banner.classList.contains(CSS_SYNC_EVENT_BANNER_PLACEHOLDER)).toBe(true);
			expect(banner.getAttribute('data-sync-event-uid')).toBe(sampleRecord.event.uid);
			expect(banner.getAttribute('data-sync-event-path')).toBe(sampleRecord.path);
			expect(component).toBeDefined();
		});

		it('removes banner element and unloads attached component', () => {
			const { banner, component } = createSyncEventBanner(sampleRecord, mockPlugin);
			const parent = new MockElement('div');
			parent.appendChild(banner as any);

			const unloadSpy = vi.spyOn(component, 'unload');
			removeBannerElement(banner as any);

			expect(unloadSpy).toHaveBeenCalled();
			expect((banner as any).parentElement).toBeNull();
		});
	});

	describe('Target resolution for Live Preview and Reading Mode', () => {
		it('finds direct .mod-header.mod-ui container in Reading Mode sizer', () => {
			const sizer = new MockElement('div');
			const header = new MockElement('div');
			header.className = 'mod-header mod-ui';
			sizer.appendChild(header);

			const found = findDirectHeader(sizer as any);
			expect(found).toBe(header);
		});

		it('returns null if .mod-header.mod-ui is not in container', () => {
			const sizer = new MockElement('div');
			expect(findDirectHeader(sizer as any)).toBeNull();
		});

		it('resolves Live Preview insertion target after .metadata-container', () => {
			const sizer = new MockElement('div');
			const metadata = new MockElement('div');
			metadata.className = 'metadata-container';
			sizer.appendChild(metadata);

			const target = findLivePreviewInsertionTarget(sizer as any);
			expect(target?.target).toBe(metadata);
			expect(target?.position).toBe('after');
		});

		it('falls back to .mod-header.mod-ui in Live Preview if .metadata-container is absent', () => {
			const sizer = new MockElement('div');
			const header = new MockElement('div');
			header.className = 'mod-header mod-ui';
			sizer.appendChild(header);

			const target = findLivePreviewInsertionTarget(sizer as any);
			expect(target?.target).toBe(header);
			expect(target?.position).toBe('after');
		});

		it('falls back before .cm-content if headers are absent', () => {
			const sizer = new MockElement('div');
			const content = new MockElement('div');
			content.className = 'cm-content';
			sizer.appendChild(content);

			const target = findLivePreviewInsertionTarget(sizer as any);
			expect(target?.target).toBe(content);
			expect(target?.position).toBe('before');
		});
	});

	describe('Reading Mode Injection', () => {
		it('nests banner inside .mod-header.mod-ui directly after .metadata-container', () => {
			const sizer = new MockElement('div');
			sizer.className = 'markdown-preview-sizer';

			const header = new MockElement('div');
			header.className = 'mod-header mod-ui';
			sizer.appendChild(header);

			const metadata = new MockElement('div');
			metadata.className = 'metadata-container';
			header.appendChild(metadata);

			const previewContainer = new MockElement('div');
			previewContainer.appendChild(sizer);

			const mockLeaf = {
				view: {
					getMode: () => 'preview',
					file: { path: sampleRecord.path, extension: 'md' },
					previewMode: { containerEl: previewContainer },
				},
			};

			const injected = injectReadingModeBanner(mockPlugin, mockLeaf as any);
			expect(injected).toBe(true);

			// Banner should be nested inside header, immediately after metadata
			const banner = header.querySelector(`.${CSS_SYNC_EVENT_BANNER}`);
			expect(banner).not.toBeNull();
			expect(banner?.parentElement).toBe(header);
			expect(banner?.previousElementSibling).toBe(metadata);
		});

		it('skips injection if header is detached (scrolled out of view)', () => {
			const sizer = new MockElement('div');
			sizer.className = 'markdown-preview-sizer';

			const previewContainer = new MockElement('div');
			previewContainer.appendChild(sizer);

			const mockLeaf = {
				view: {
					getMode: () => 'preview',
					file: { path: sampleRecord.path, extension: 'md' },
					previewMode: { containerEl: previewContainer },
				},
			};

			const injected = injectReadingModeBanner(mockPlugin, mockLeaf as any);
			expect(injected).toBe(false);
		});

		it('removes reading mode banner on demand', () => {
			const previewContainer = new MockElement('div');
			const banner = new MockElement('div');
			banner.className = CSS_SYNC_EVENT_BANNER;
			previewContainer.appendChild(banner);

			const mockView = {
				previewMode: { containerEl: previewContainer },
			};

			removeReadingModeBanner(mockView as any);
			expect(previewContainer.querySelector(`.${CSS_SYNC_EVENT_BANNER}`)).toBeNull();
		});
	});

	describe('Registration and main.ts integration hooks', () => {
		it('registers Reading Mode workspace events and returns unregister cleanup', () => {
			const cleanup = registerReadingModeBannerHandlers(mockPlugin);
			expect(mockPlugin.app.workspace.on).toHaveBeenCalledWith('file-open', expect.any(Function));
			expect(mockPlugin.app.workspace.on).toHaveBeenCalledWith('active-leaf-change', expect.any(Function));
			expect(mockPlugin.app.workspace.on).toHaveBeenCalledWith('layout-change', expect.any(Function));
			expect(mockPlugin.app.metadataCache.on).toHaveBeenCalledWith('changed', expect.any(Function));

			cleanup();
		});

		it('all-in-one registerSyncEventBanner registers editor extension and reading mode handlers', () => {
			const unregister = registerSyncEventBanner(mockPlugin);

			expect(mockPlugin.registerEditorExtension).toHaveBeenCalledTimes(1);
			expect(mockPlugin.registerEvent).toHaveBeenCalled();

			unregister();
		});
	});
});
