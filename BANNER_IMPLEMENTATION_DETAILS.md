# Synced Event Banner Implementation Nuances

This document outlines the architectural strategy for implementing a lightweight, injected UI banner at the top of markdown notes that are synchronized with Google Calendar. This approach borrows heavily from the battle-tested dual-engine DOM injection technique seen in the `tasknotes` Obsidian plugin.

## Goal

Provide a visual banner at the top of any markdown note synced with Google Calendar. The banner should display the synced event details (title, time, status) and allow interaction. Crucially, the UI must remain fast and lightweight in both Live Preview and Reading Mode without utilizing React for the injected elements. 

In addition, an "Edit" button should be available in the `DayDetailView` to open the event directly in `SyncEventModal`.

## Architecture: Dual-Engine DOM Injection

Standard CodeMirror panels and Obsidian Markdown Post-Processors are insufficient for dynamic inline components at the top of a note. To prevent cursor jumping in Live Preview and DOM tearing in Reading Mode, use the following dual-engine vanilla DOM approach.

### 1. Identifying Synced Notes

Do not perform heavy frontmatter parsing during editor layout. Instead, rely on the fast, in-memory `CalendarEventIndex`.

*   **Logic**: 
    1. Hook into `app.workspace.on('file-open', ...)` or active leaf changes.
    2. Query the repository cache: `plugin.calendarEventRepository.index.getByPath(file.path)`.
    3. If the returned record has `association?.reference.providerId === 'google'`, the note is synced and the banner should be injected.

### 2. Live Preview Injection (CodeMirror 6)

*   Create a CodeMirror `ViewPlugin` (`registerEditorExtension`).
*   In the plugin update loop, locate the active file's scroll container (`.cm-sizer` inside `.markdown-source-view`).
*   **Target Location**: Inject your vanilla DOM widget immediately *after* the `.metadata-container` (properties block) or `.mod-header.mod-ui`.

### 3. Reading Mode Injection (Bypassing Virtualization)

*   Reading Mode virtualizes the document; it frequently strips unrecognised direct children from the `.markdown-preview-sizer`.
*   **The Hack**: Nest your injected banner *inside* Obsidian's `.mod-header.mod-ui` container block, directly after the `.metadata-container`. Because it is nested inside an existing native block, Obsidian’s `setChildrenInPlace` virtualization cleanup pass will skip over it, preventing your banner from being deleted and re-rendered on every scroll.
*   **Scroll Observer**: Implement a `MutationObserver` or listen to the reading mode scroll event to temporarily hide or pause injection if the header gets scrolled out of view.

### 4. Fast, Lightweight DOM UI (No React)

*   To keep the editor highly performant, avoid bootstrapping a React tree into every CodeMirror instance.
*   Use Obsidian's `createDiv()`, `createSpan()`, and `setIcon()` utilities to build the banner nodes manually.
*   Attach these elements to an Obsidian `Component` lifecycle object so that event listeners are cleanly unloaded when the editor pane is closed.

### 5. Wiring the Editor Modal

*   Clicking the banner, or clicking the "Edit" button in the Day Detail UI, should open the `SyncEventModal`.
*   Import and call `openSyncEventModal(app, { initialEvent: record.event, timezone: record.event.timezone, onSubmit: ... })`.
*   **Note on DayDetailView**: The `src/DayDetailView.tsx` already contains an edit hook (`onEditSyncEvent(syncEvent.key)`) in the `sync-note-actions` container (lines 531-535). Ensure this action opens the `SyncEventModal` using `openSyncEventModal` rather than simply navigating.
