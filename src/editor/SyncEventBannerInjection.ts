import { EditorView, PluginValue, ViewPlugin, ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import {
    Component,
    MarkdownView,
    TFile,
    WorkspaceLeaf,
    editorInfoField,
    editorLivePreviewField,
} from 'obsidian';
import type ContinuousCalendarPlugin from '../main';
import type { IndexedCalendarEvent } from '../services/sync/notes/CalendarEventIndex';
import type { CalendarEvent } from '../services/sync/model';
import type { CalendarDisplayEvent } from '../services/IndexService';
import { openSyncEventModal } from '../modals/SyncEventModal';
import { makeSyncStateKey } from '../services/sync/state/SyncStateStore';
import {
    createSyncEventBanner as createUiSyncEventBanner,
    type SyncEventBannerElement,
} from '../ui/SyncEventBanner';

// DOM class names
export const CSS_SYNC_EVENT_BANNER = 'sync-event-banner';
export const CSS_SYNC_EVENT_BANNER_PLACEHOLDER = 'sync-event-banner-placeholder';

export interface BannerElementWithComponent extends HTMLElement {
    _bannerComponent?: Component;
    update?: (event: CalendarEvent, status?: any) => void;
}

/**
 * Checks the in-memory CalendarEventIndex to see if a note at the given path is synced to Google Calendar.
 */
export function getSyncedGoogleEventRecord(
    plugin: ContinuousCalendarPlugin,
    filePath: string | null | undefined
): IndexedCalendarEvent | null {
    if (!filePath || !plugin.calendarEventRepository?.index) {
        return null;
    }
    const record = plugin.calendarEventRepository.index.getByPath(filePath);
    if (record?.association?.reference?.providerId === 'google') {
        return record;
    }
    return null;
}

/**
 * Checks whether a given markdown file corresponds to an active Google Calendar synced note.
 */
export function isSyncedGoogleNote(
    plugin: ContinuousCalendarPlugin,
    file: TFile | null | undefined
): IndexedCalendarEvent | null {
    if (!file || file.extension !== 'md') {
        return null;
    }
    return getSyncedGoogleEventRecord(plugin, file.path);
}

/**
 * Opens the SyncEventModal for a synced calendar event record.
 */
export function openBannerSyncEventModal(
    plugin: ContinuousCalendarPlugin,
    record: IndexedCalendarEvent
): void {
    const freshRecord = getSyncedGoogleEventRecord(plugin, record.path) ?? record;
    const timezone = freshRecord.event.timezone || plugin.settings?.sync?.timezone || 'UTC';

    openSyncEventModal(plugin.app, {
        initialEvent: freshRecord.event,
        timezone,
        title: 'Edit Google Calendar event',
        submitLabel: 'Save event',
        onSubmit: async (updatedEvent: CalendarEvent) => {
            const ref = freshRecord.association?.reference;
            let targetKey: string | undefined;

            if (ref) {
                targetKey = makeSyncStateKey(ref.providerId, ref.accountId, ref.calendarId, ref.remoteEventId);
            }

            if (!targetKey && typeof (plugin as any).getCalendarEvents === 'function') {
                const displayEvents: readonly CalendarDisplayEvent[] = (plugin as any).getCalendarEvents();
                const matched = displayEvents.find(
                    (item) => item.notePath === freshRecord.path || item.event.uid === freshRecord.event.uid
                );
                targetKey = matched?.key;
            }

            if (targetKey && typeof plugin.updateCalendarEvent === 'function') {
                await plugin.updateCalendarEvent(targetKey, updatedEvent);
            } else if (plugin.calendarEventRepository) {
                await plugin.calendarEventRepository.update(freshRecord.path, updatedEvent);
            }
        },
    });
}

/**
 * Removes an injected banner node and unloads its attached Obsidian Component.
 */
export function removeBannerElement(banner: HTMLElement): void {
    const holder = banner as BannerElementWithComponent;
    if (holder._bannerComponent) {
        holder._bannerComponent.unload();
        holder._bannerComponent = undefined;
    }
    banner.remove();
}

/**
 * Constructs a lightweight, vanilla DOM banner element for a synced note.
 */
export function createSyncEventBanner(
    record: IndexedCalendarEvent,
    plugin: ContinuousCalendarPlugin
): { banner: SyncEventBannerElement; component: Component } {
    const component = new Component();
    component.load();

    const banner = createUiSyncEventBanner(record.event, {
        status: record.status ?? 'synced',
        component,
        cls: CSS_SYNC_EVENT_BANNER_PLACEHOLDER,
        onEdit: () => openBannerSyncEventModal(plugin, record),
        onClick: () => openBannerSyncEventModal(plugin, record),
    });

    banner.setAttribute('contenteditable', 'false');
    banner.setAttribute('spellcheck', 'false');
    banner.setAttribute('data-sync-event-uid', record.event.uid);
    banner.setAttribute('data-sync-event-path', record.path);
    (banner as BannerElementWithComponent)._bannerComponent = component;

    return { banner, component };
}

/**
 * Updates the text and UI elements of an existing banner DOM node.
 */
export function updateBannerContent(
    banner: HTMLElement,
    record: IndexedCalendarEvent,
    plugin: ContinuousCalendarPlugin
): void {
    banner.setAttribute('data-sync-event-uid', record.event.uid);
    banner.setAttribute('data-sync-event-path', record.path);

    const bannerWithUpdate = banner as SyncEventBannerElement;
    if (typeof bannerWithUpdate.update === 'function') {
        bannerWithUpdate.update(record.event, record.status);
    }
}

/**
 * Finds direct `.mod-header.mod-ui` inside a reading view sizer.
 */
export function findDirectHeader(container: HTMLElement): HTMLElement | null {
    if (!container || !container.children) return null;
    for (let i = 0; i < container.children.length; i++) {
        const child = (container.children as any)[i];
        if (
            child &&
            child.classList &&
            typeof child.classList.contains === 'function' &&
            child.classList.contains('mod-header') &&
            child.classList.contains('mod-ui')
        ) {
            return child as HTMLElement;
        }
    }
    return null;
}

/**
 * Locates the target element in Live Preview `.cm-sizer` after which the banner should be injected.
 */
export function findLivePreviewInsertionTarget(
    cmSizer: HTMLElement
): { target: Element; position: 'after' | 'before' } | null {
    // 1. Primary target: immediately after .metadata-container
    const metadataContainer = cmSizer.querySelector('.metadata-container');
    if (metadataContainer) {
        return { target: metadataContainer, position: 'after' };
    }

    // 2. Secondary target: immediately after .mod-header.mod-ui or .mod-header
    const modHeader = cmSizer.querySelector('.mod-header.mod-ui, .mod-header');
    if (modHeader) {
        return { target: modHeader, position: 'after' };
    }

    // 3. Tertiary target: immediately after .inline-title
    const inlineTitle = cmSizer.querySelector('.inline-title');
    if (inlineTitle) {
        return { target: inlineTitle, position: 'after' };
    }

    // 4. Fallback: immediately before .cm-content
    const cmContent = cmSizer.querySelector('.cm-content');
    if (cmContent) {
        return { target: cmContent, position: 'before' };
    }

    return null;
}

/**
 * CodeMirror 6 ViewPlugin implementation for Live Preview injection.
 */
class LivePreviewBannerPlugin implements PluginValue {
    private view: EditorView;
    private plugin: ContinuousCalendarPlugin;
    private bannerEl: SyncEventBannerElement | null = null;
    private component: Component | null = null;
    private currentFilePath: string | null = null;
    private currentEventUid: string | null = null;
    private currentEventVersion: string | null = null;

    constructor(view: EditorView, plugin: ContinuousCalendarPlugin) {
        this.view = view;
        this.plugin = plugin;
        this.checkAndInject();
    }

    update(update: ViewUpdate): void {
        this.view = update.view;
        if (
            update.docChanged ||
            update.viewportChanged ||
            update.geometryChanged ||
            !this.bannerEl ||
            !this.bannerEl.isConnected
        ) {
            this.checkAndInject();
        }
    }

    destroy(): void {
        this.removeBanner();
    }

    private isEmbeddedEditor(): boolean {
        const dom = this.view.dom;
        if (!dom) return false;
        return Boolean(
            dom.closest('.cm-table-widget, td, th') ||
            dom.closest('.popover.hover-popover') ||
            dom.closest('.markdown-embed[data-type="footnote"]')
        );
    }

    private findCmSizer(): HTMLElement | null {
        return (
            (this.view.dom.querySelector('.cm-sizer') as HTMLElement | null) ??
            (this.view.scrollDOM?.querySelector('.cm-sizer') as HTMLElement | null) ??
            (this.view.dom.closest('.markdown-source-view')?.querySelector('.cm-sizer') as HTMLElement | null)
        );
    }

    private cleanupOrphanedBanners(container: HTMLElement): void {
        const banners = container.querySelectorAll<HTMLElement>(`.${CSS_SYNC_EVENT_BANNER}`);
        banners.forEach((el) => {
            if (el !== this.bannerEl) {
                removeBannerElement(el);
            }
        });
    }

    private isPlacedCorrectly(targetInfo: { target: Element; position: 'after' | 'before' }): boolean {
        if (!this.bannerEl || !this.bannerEl.isConnected) return false;
        if (targetInfo.position === 'after') {
            return (
                this.bannerEl.parentElement === targetInfo.target.parentElement &&
                this.bannerEl.previousElementSibling === targetInfo.target
            );
        } else {
            return (
                this.bannerEl.parentElement === targetInfo.target.parentElement &&
                this.bannerEl.nextElementSibling === targetInfo.target
            );
        }
    }

    private removeBanner(): void {
        if (this.component) {
            this.component.unload();
            this.component = null;
        }
        if (this.bannerEl) {
            this.bannerEl.remove();
            this.bannerEl = null;
        }
        this.currentFilePath = null;
        this.currentEventUid = null;
        this.currentEventVersion = null;
    }

    private checkAndInject(): void {
        // 1. Live Preview check
        const isLivePreview = this.view.state.field(editorLivePreviewField, false) ?? true;
        if (!isLivePreview) {
            this.removeBanner();
            return;
        }

        // 2. Skip embedded editors (tables, footnotes, hovers)
        if (this.isEmbeddedEditor()) {
            this.removeBanner();
            return;
        }

        // 3. Resolve active markdown file
        const file = this.view.state.field(editorInfoField, false)?.file;
        if (!file || file.extension !== 'md') {
            this.removeBanner();
            return;
        }

        // 4. Query repository index for Google sync status
        const record = isSyncedGoogleNote(this.plugin, file);
        if (!record) {
            this.removeBanner();
            return;
        }

        // 5. Locate CodeMirror sizer
        const cmSizer = this.findCmSizer();
        if (!cmSizer) return;

        this.cleanupOrphanedBanners(cmSizer);

        const targetInfo = findLivePreviewInsertionTarget(cmSizer);
        if (!targetInfo) return;

        const eventVersion = `${record.event.title}|${record.event.start}|${record.event.end}|${record.status}|${record.event.location}`;

        // If banner is already placed correctly and up to date, skip
        if (
            this.bannerEl &&
            this.bannerEl.isConnected &&
            this.currentFilePath === file.path &&
            this.currentEventUid === record.event.uid &&
            this.currentEventVersion === eventVersion &&
            this.isPlacedCorrectly(targetInfo)
        ) {
            return;
        }

        // Update existing or inject fresh
        if (
            this.bannerEl &&
            this.currentFilePath === record.path &&
            this.currentEventUid === record.event.uid
        ) {
            if (this.currentEventVersion !== eventVersion) {
                updateBannerContent(this.bannerEl, record, this.plugin);
                this.currentEventVersion = eventVersion;
            }
            if (!this.isPlacedCorrectly(targetInfo)) {
                if (targetInfo.position === 'after') {
                    targetInfo.target.insertAdjacentElement('afterend', this.bannerEl);
                } else {
                    targetInfo.target.insertAdjacentElement('beforebegin', this.bannerEl);
                }
            }
            return;
        }

        // Create new banner
        this.removeBanner();
        const { banner, component } = createSyncEventBanner(record, this.plugin);
        this.bannerEl = banner;
        this.component = component;
        this.currentFilePath = record.path;
        this.currentEventUid = record.event.uid;
        this.currentEventVersion = eventVersion;

        if (targetInfo.position === 'after') {
            targetInfo.target.insertAdjacentElement('afterend', this.bannerEl);
        } else {
            targetInfo.target.insertAdjacentElement('beforebegin', this.bannerEl);
        }
    }
}

/**
 * Creates the CodeMirror 6 ViewPlugin extension for Live Preview banner injection.
 */
export function createLivePreviewBannerPlugin(plugin: ContinuousCalendarPlugin): Extension {
    return ViewPlugin.fromClass(
        class extends LivePreviewBannerPlugin {
            constructor(view: EditorView) {
                super(view, plugin);
            }
        }
    );
}

/**
 * Registers the Live Preview CodeMirror 6 extension with Obsidian.
 */
export function registerSyncEventBannerExtension(plugin: ContinuousCalendarPlugin): void {
    plugin.registerEditorExtension(createLivePreviewBannerPlugin(plugin));
}

/**
 * Helper to check if a view is a MarkdownView (supports instanceof or duck-typing).
 */
export function isMarkdownView(view: unknown): view is MarkdownView {
    if (!view || typeof view !== 'object') return false;
    return view instanceof MarkdownView || (typeof (view as any).getMode === 'function' && Boolean((view as any).previewMode));
}

/**
 * Injects the synced event banner into Reading Mode for a specific leaf.
 * Bypasses virtualization by nesting inside `.mod-header.mod-ui`.
 */
export function injectReadingModeBanner(plugin: ContinuousCalendarPlugin, leaf: WorkspaceLeaf): boolean {
    const view = leaf.view;
    if (!isMarkdownView(view) || view.getMode() !== 'preview') {
        return false;
    }

    const file = view.file;
    if (!file || file.extension !== 'md') {
        removeReadingModeBanner(view);
        return false;
    }

    const record = isSyncedGoogleNote(plugin, file);
    if (!record) {
        removeReadingModeBanner(view);
        return false;
    }

    const previewContainer = view.previewMode?.containerEl;
    if (!previewContainer) return false;

    const sizer = previewContainer.querySelector<HTMLElement>('.markdown-preview-sizer');
    if (!sizer) return false;

    // Nest inside .mod-header.mod-ui to bypass virtualization deletions
    const header = findDirectHeader(sizer);
    if (!header) {
        // Header is scrolled out or not rendered yet; skip injection until header is present
        return false;
    }

    const metadata = header.querySelector<HTMLElement>('.metadata-container');
    const existingBanner = header.querySelector<HTMLElement>(`.${CSS_SYNC_EVENT_BANNER}`);

    if (existingBanner) {
        const existingUid = existingBanner.getAttribute('data-sync-event-uid') ?? (existingBanner as any).dataset?.calendarUid;
        const existingPath = existingBanner.getAttribute('data-sync-event-path');

        if (existingUid === record.event.uid && (existingPath === record.path || !existingPath)) {
            updateBannerContent(existingBanner, record, plugin);
            if (metadata && existingBanner.previousElementSibling !== metadata) {
                metadata.insertAdjacentElement('afterend', existingBanner);
            }
            return true;
        } else {
            removeBannerElement(existingBanner);
        }
    }

    const { banner } = createSyncEventBanner(record, plugin);

    if (metadata) {
        metadata.insertAdjacentElement('afterend', banner);
    } else {
        const inlineTitle = header.querySelector('.inline-title');
        if (inlineTitle) {
            inlineTitle.insertAdjacentElement('afterend', banner);
        } else {
            header.appendChild(banner);
        }
    }

    return true;
}

/**
 * Removes any injected reading mode banner from a MarkdownView.
 */
export function removeReadingModeBanner(view: MarkdownView): void {
    const previewContainer = view.previewMode?.containerEl;
    if (!previewContainer) return;

    previewContainer.querySelectorAll<HTMLElement>(`.${CSS_SYNC_EVENT_BANNER}`).forEach((banner) => {
        removeBannerElement(banner);
    });
}

/**
 * Observes DOM mutations and scroll events in Reading Mode to maintain the banner
 * without causing scroll instability.
 */
function observeReadingModeLeaf(
    plugin: ContinuousCalendarPlugin,
    leaf: WorkspaceLeaf,
    observedContainers: WeakSet<HTMLElement>,
    cleanupCallbacks: Array<() => void>
): void {
    const view = leaf.view;
    if (!isMarkdownView(view) || view.getMode() !== 'preview') return;

    const containerEl = view.previewMode?.containerEl;
    if (!containerEl || observedContainers.has(containerEl)) return;

    let pendingFrame: number | null = null;
    let lastScrollAt = Number.NEGATIVE_INFINITY;
    const scrollQuietPeriodMs = 150;

    const handleScroll = () => {
        lastScrollAt = Date.now();
    };

    containerEl.addEventListener('scroll', handleScroll, { capture: true, passive: true });

    const requestRefresh = () => {
        if (pendingFrame !== null) return;
        const win = containerEl.ownerDocument.defaultView ?? window;
        pendingFrame = win.requestAnimationFrame(() => {
            pendingFrame = null;
            if (
                !containerEl.isConnected ||
                !isMarkdownView(leaf.view) ||
                leaf.view.getMode() !== 'preview'
            ) {
                return;
            }

            const sizer = containerEl.querySelector<HTMLElement>('.markdown-preview-sizer');
            if (!sizer) return;

            const header = findDirectHeader(sizer);
            if (!header) {
                // Header detached while scrolled down; do not inject
                return;
            }

            // Defer if recently scrolling
            if (Date.now() - lastScrollAt < scrollQuietPeriodMs) {
                requestRefresh();
                return;
            }

            injectReadingModeBanner(plugin, leaf);
        });
    };

    const observer = new MutationObserver((mutations) => {
        const shouldCheck = mutations.some((mutation) => {
            for (let i = 0; i < mutation.addedNodes.length; i++) {
                const node = mutation.addedNodes[i];
                if (
                    node instanceof HTMLElement &&
                    (node.classList.contains('mod-header') ||
                        node.classList.contains('metadata-container') ||
                        node.classList.contains('markdown-preview-sizer'))
                ) {
                    return true;
                }
            }
            for (let i = 0; i < mutation.removedNodes.length; i++) {
                const node = mutation.removedNodes[i];
                if (
                    node instanceof HTMLElement &&
                    (node.classList.contains(CSS_SYNC_EVENT_BANNER) || node.classList.contains('mod-header'))
                ) {
                    return true;
                }
            }
            return false;
        });

        if (shouldCheck) {
            requestRefresh();
        }
    });

    observer.observe(containerEl, {
        childList: true,
        subtree: true,
    });

    observedContainers.add(containerEl);
    cleanupCallbacks.push(() => {
        if (pendingFrame !== null) {
            const win = containerEl.ownerDocument.defaultView ?? window;
            win.cancelAnimationFrame(pendingFrame);
        }
        containerEl.removeEventListener('scroll', handleScroll, { capture: true });
        observer.disconnect();
    });
}

/**
 * Registers Reading Mode workspace event hooks (`file-open`, `active-leaf-change`, `layout-change`, `metadataCache:changed`).
 * Returns an unregister cleanup callback.
 */
export function registerReadingModeBannerHandlers(plugin: ContinuousCalendarPlugin): () => void {
    const observedContainers = new WeakSet<HTMLElement>();
    const cleanupCallbacks: Array<() => void> = [];

    const refreshLeaves = () => {
        const leaves = plugin.app.workspace.getLeavesOfType('markdown');
        for (const leaf of leaves) {
            if (isMarkdownView(leaf.view) && leaf.view.getMode() === 'preview') {
                injectReadingModeBanner(plugin, leaf);
                observeReadingModeLeaf(plugin, leaf, observedContainers, cleanupCallbacks);
            }
        }
    };

    // 1. file-open
    plugin.registerEvent(
        plugin.app.workspace.on('file-open', () => {
            refreshLeaves();
        })
    );

    // 2. active-leaf-change
    plugin.registerEvent(
        plugin.app.workspace.on('active-leaf-change', (leaf) => {
            if (leaf && isMarkdownView(leaf.view) && leaf.view.getMode() === 'preview') {
                injectReadingModeBanner(plugin, leaf);
                observeReadingModeLeaf(plugin, leaf, observedContainers, cleanupCallbacks);
            }
        })
    );

    // 3. layout-change
    plugin.registerEvent(
        plugin.app.workspace.on('layout-change', () => {
            refreshLeaves();
        })
    );

    // 4. metadataCache changed (frontmatter or properties modified)
    plugin.registerEvent(
        plugin.app.metadataCache.on('changed', () => {
            refreshLeaves();
        })
    );

    // Initial pass on existing leaves
    refreshLeaves();

    return () => {
        for (const cleanup of cleanupCallbacks) {
            cleanup();
        }
        cleanupCallbacks.length = 0;
        const leaves = plugin.app.workspace.getLeavesOfType('markdown');
        for (const leaf of leaves) {
            if (isMarkdownView(leaf.view)) {
                removeReadingModeBanner(leaf.view);
            }
        }
    };
}

/**
 * Refreshes all open leaves (both Live Preview and Reading Mode) across the workspace.
 */
export function updateSyncEventBanners(plugin: ContinuousCalendarPlugin): void {
    const leaves = plugin.app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
        if (!isMarkdownView(leaf.view)) continue;
        if (leaf.view.getMode() === 'preview') {
            injectReadingModeBanner(plugin, leaf);
        } else {
            const editor = (leaf.view as any).editor;
            if (editor?.cm) {
                try {
                    editor.cm.dispatch({});
                } catch {
                    // Ignore if editor not ready
                }
            }
        }
    }
}

/**
 * All-in-one registration helper to hook both Live Preview and Reading Mode banner handlers into main.ts.
 */
export function registerSyncEventBanner(plugin: ContinuousCalendarPlugin): () => void {
    registerSyncEventBannerExtension(plugin);
    const unregisterReadingMode = registerReadingModeBannerHandlers(plugin);

    return () => {
        unregisterReadingMode();
    };
}
