# Calendar Sync Implementation Plan and Orchestrator Handoff

Last updated: 2026-09-28
Status: Google event display and optional-note redesign is code-complete and in review. Workstream I remains open; Microsoft is deferred.
Repository: `obsidian-continuous-calendar`

## Current state snapshot

The 2026-09-27 snapshot below describes the previous note-backed implementation. The 2026-09-28 redesign in this document supersedes its automatic-note behavior; verify the current code and tests before treating a listed behavior as delivered.

### Approved 2026-09-28 redesign

- Google events appear in both calendar views and the day detail view without creating Markdown notes during import.
- A persistent provider-keyed cache retains fetched events across restarts and temporary outages. Dry-run does not populate it. Disconnect clears the selected binding's cache while preserving Google events and all vault notes.
- Each Google event offers **Create note** beside **Edit** in the day detail view. After linking, the action becomes **Open note**. Repeated actions reuse the same note.
- Optional notes are personal: Google is authoritative for synchronized event fields, while the note body and unrelated properties remain local. Note edits/deletions do not change Google events.
- Existing imported event notes remain and are linked to their Google events. A full fetch on first sync after migration populates the cache despite an existing incremental cursor.
- Calendar event creation, editing, and deletion operate directly on Google in bidirectional mode, without requiring a note. Import-only displays cached events and allows optional notes; it does not write events to Google. Remote deletion removes the event display and retains a linked note with deleted-event status.

### What works now

- **Local-first startup and gating**: Plugin loads safely with sync disabled, without credentials, or with missing client configuration without making network requests. Desktop sync controls are capability-gated via `Platform.isDesktopApp`.
- **Pure canonical event domain**: Full validation, RFC 3339 offset enforcement, deterministic SHA-256 hashing, and 3-way merge logic (`CalendarEventValidation`, `CalendarEventHash`, `CalendarEventMerge`).
- **Markdown vault integration & dual frontmatter encoding (legacy snapshot)**: `CalendarEventRepository` and `FrontmatterEventCodec` handle non-destructive frontmatter updates via `processFrontMatter`. Under the redesign these fields belong only to optional linked notes.
- **State and credential storage**: Versioned migrations via `PluginDataStore`, sync tokens/snapshots/tombstones via `SyncStateStore`, and secure tokens via `CredentialStore` (`SecretStorage` / `safeStorage` with session fallback).
- **Google OAuth & provider runtime**: System browser PKCE authorization with loopback HTTP listener on `127.0.0.1:0`, refresh token exchange, revocation, calendar discovery, pagination, incremental sync tokens, 410 full resync, and ETag conditional updates (`GoogleOAuthProvider`, `GoogleCalendarProvider`, `GoogleDesktopOAuth`).
- **Provider-neutral sync engine**: Debounced serialized outbound queue (`SyncQueue`), 3-way reconciliation, conflict detection, feedback-loop suppression, and tombstone handling (`SyncService`).
- **Settings UI**: Dedicated Sync settings tab supporting Google Client ID and Client Secret configuration, dynamic `Connect` vs `Reconnect` actions, calendar selector dropdown, sync mode options (`disabled`, `dry-run`, `import-only`, `bidirectional`), intervals, horizons, folder picker, conflict viewer, and safe disconnect dialog.
- **Modals & UI projections**:
  - `SyncEventModal`: Create and edit canonical events.
  - `SyncConflictModal`: Side-by-side local vs remote diff resolution.
  - `DayDetailView`: The redesigned event cards use the remote event cache and offer `Create note` or `Open note` alongside event actions.
  - Read-model projections shared across standard `CalendarView` and `CalendarBasesView`.
- **Test coverage**: 18 test files with 125 Vitest tests passing; production build passes TypeScript and esbuild cleanly.

### What does not work yet

- **End-to-end integration tests**: Automated test coverage for the full `main.ts` plugin lifecycle with mocked Google OAuth and network calls (first connect, reconnect, disconnect, error states) is not yet written.
- **Cross-platform OS verification**: Verified on macOS desktop; Windows and Linux desktop environments have not been formally qualified.
- **Mobile runtime smoke test**: Gated with `Platform.isDesktopApp`, but formal mobile smoke testing to verify uninterrupted local calendar operation is still pending.
- **Public OAuth distribution**: Uses user-supplied Google Cloud credentials (`docs/client-id-distribution.md`). An official pre-configured Client ID would require Google App verification and published privacy terms.
- **Microsoft Outlook adapter**: Workstream J remains deferred until Google is completely signed off.
- **Excluded feature scope**: Recurring series/exceptions (detected as `unsupported-recurrence`), attendees, reminders, conferencing, attachments, and note markdown body sync remain out of scope.

### Architectural and Design Deviations from Original Plan

1. **Dual Frontmatter Mapping for Optional Notes (`date` / `dateStart` / `dateEnd` vs `calendar_start` / `calendar_end`)**:
   - *Original Plan*: Rely solely on `calendar_start`, `calendar_end`, and `calendar_all_day` with Google's exclusive end dates (`[start, end)`).
   - *Deviation*: `FrontmatterEventCodec` and `CalendarEventValidation` maintain native Continuous Calendar frontmatter properties alongside canonical sync properties. All-day notes use `date` for one date or `dateStart`/`dateEnd` with an inclusive end; they omit `calendar_start`/`calendar_end` so the exclusive next day is not shown as a separate technical date. The canonical exclusive end is derived from those visible dates when decoded. Timed events extract the `YYYY-MM-DD` date into `date` while keeping exact RFC 3339 timestamps and offsets in `calendar_start`/`calendar_end`. Legacy all-day notes with canonical date keys continue to decode and migrate on write.
   - *Reason*: Preserves native dated-note interoperability for notes the user chooses to create. Cached Google events now contribute their own calendar indicators.
2. **Google OAuth Client Secret Requirement**:
   - *Original Plan*: Assumed public-client PKCE without client secrets.
   - *Deviation*: Added `googleClientSecret` to settings and `GoogleOAuthProvider`.
   - *Reason*: Google Cloud Console OAuth 2.0 Client IDs created for "Desktop app" applications mandate a `client_secret` during authorization code exchange at `https://oauth2.googleapis.com/token`. Omitting it causes Google to reject the request with `401 Unauthorized / invalid_client`.
3. **Dedicated Google Event Card Section in `DayDetailView`**:
   - *Original Plan*: Show sync events mixed into the existing markdown notes list with status badges.
   - *Deviation*: Added a dedicated event section in `DayDetailView.tsx` with card styling and distinct time range formatting (`formatCalendarEventTime`). The redesign displays pathless cached events, adds `Create note` / `Open note`, and edits events directly.
   - *Reason*: Provides clearer distinction between structured calendar events and local markdown notes, avoiding cluttered notes lists and duplicated items.
4. **Distinct `Connect` and `Reconnect` UI States**:
   - *Original Plan*: Single `Reconnect` button.
   - *Deviation*: `SettingsTab.ts` dynamically switches between `Connect` (initiating PKCE authorization) and `Reconnect` (refreshing tokens) based on whether an account binding exists.
   - *Reason*: Prevents error prompts when first setting up Google sync.

### External and user constraints

- The user cannot authorize Codex computer-use access to Obsidian on the current machine. Future sessions must not block code progress on that permission.
- Connecting Google requires a Google Cloud project with the Calendar API enabled and an OAuth 2.0 Desktop app client ID and secret. Never commit credentials into the repository.

## Purpose of this document

This file is the durable source of truth for implementing bidirectional calendar synchronization. It is written so a fresh Codex session can resume without relying on conversation history.

The implementation agent must act as the root orchestrator: plan and audit the work, delegate bounded packages to subagents with high reasoning, and keep shared integration surfaces under root ownership. Update this document after each accepted package.

## Approved outcome

Bidirectional synchronization is feasible and delivered incrementally:

- Google Calendar first, then Microsoft Outlook through the same provider-neutral engine.
- Desktop-only synchronization while retaining the plugin's existing local calendar behavior on mobile.
- Local operation only: sync on startup, manually, and every five minutes while Obsidian is open. No hosted webhook service.
- One optional, explicitly created Markdown note per selected Google event, stored in a configurable folder.
- Google events are cached independently of notes. Existing dated, range, task, and daily notes are never uploaded implicitly.
- Linked-note frontmatter mirrors Google event fields. The Markdown body remains local and is never rewritten by synchronization.
- Non-recurring events only in the first milestone. Recurring events are detected and reported as unsupported.
- Safe deletion: event deletion requires explicit confirmation and preserves the linked note. Deleting a note never deletes the Google event. Remote deletion marks a linked note and removes the cached event display.
- One Google account and one selected writable calendar in the first milestone.
- Default sync horizon: one year backward and two years forward.

Deferred scope:
- Recurring series and per-occurrence exceptions.
- Attendees, invitations, reminders, conferencing, attachments, visibility.
- Full Markdown body synchronization.
- Multiple accounts or calendars per provider.
- Mobile OAuth and mobile background sync.

## Non-negotiable architecture boundaries

Keep these four layers independent:

1. **Vault layer:** parse, validate, create, and update event-note frontmatter without modifying note bodies.
2. **Canonical sync engine:** compare snapshots, queue work, merge fields, detect conflicts, manage tombstones, and coordinate providers.
3. **Provider adapters:** isolate Google and Microsoft authentication, HTTP shapes, cursors, ETags/change keys, pagination, and errors.
4. **UI/read-model projection:** display canonical events and statuses without performing provider calls.

Specific constraints:
- `IndexService` remains a calendar read model; it never calls provider APIs.
- UI components receive actions through callbacks/services; they do not instantiate repositories or providers.
- Provider-specific objects must not leak into canonical domain types.
- Access tokens remain memory-only; refresh tokens are stored via `CredentialStore`.
- Use `processFrontMatter` for synchronized field updates; never rewrite a complete Markdown file.
- File paths and filenames are not identities. `calendar_uid` is immutable and survives renames.

## Optional linked event-note contract

```yaml
---
calendar_event: true
calendar_uid: "stable-local-uuid"
calendar_title: "Project review"
date: "2026-09-22"
calendar_start: "2026-09-22T09:00:00-05:00"
calendar_end: "2026-09-22T10:00:00-05:00"
calendar_all_day: false
calendar_timezone: "America/Bogota"
calendar_location: "Conference room"
calendar_description: "Description synchronized with the provider"
calendar_sync:
  google:
    account_id: "stable-provider-account-id"
    calendar_id: "primary"
    event_id: "remote-event-id"
    status: "synced"
---
```

Contract rules (only when a note is explicitly created):
- `calendar_uid` is generated once and is the local identity.
- `calendar_title`, not the filename, is authoritative.
- Native keys (`date` or `dateStart`/`dateEnd`) coexist to render on Continuous Calendar views.
- Timed values are RFC 3339 timestamps with offsets and an IANA timezone in `calendar_start`/`calendar_end`.
- All-day values use `date` for one day or `dateStart`/`dateEnd` with an inclusive last date; `calendar_start` and `calendar_end` are omitted. Decode derives the canonical exclusive end, while legacy all-day `calendar_*` dates remain readable and migrate on write.
- `calendar_description` synchronizes in both directions; note markdown bodies remain local-only.
- Status values include: `pending`, `synced`, `conflict`, `remote_deleted`, `unsupported`, and `error`.

## Target module layout

```text
src/services/sync/
  model/                       # Pure canonical event domain (agnostic to Google/Vault)
    CalendarEvent.ts           # Types and interfaces for the canonical event
    CalendarEventValidation.ts # Strict runtime type checking and fallback logic for dates
    CalendarEventHash.ts       # Deterministic SHA-256 hashing for event snapshots
    CalendarEventMerge.ts      # Three-way merge logic (local vs remote vs last-sync-snapshot)
  notes/                       # Translation between canonical models and Obsidian Markdown notes
    FrontmatterEventCodec.ts   # Safely reads/writes frontmatter properties (date vs calendar_start)
    CalendarEventRepository.ts # CRUD operations against the vault using safe Obsidian APIs
    CalendarEventIndex.ts      # Read-model projection indexing events by UID, path, and date intervals
  state/                       # Safe, encrypted (for credentials) and transactional persistence
    PluginDataStore.ts         # Stores plugin settings, last-sync-tokens, and snapshots for diffing
    SyncStateStore.ts          # Persists mappings, cursors, tombstones, and sanitized errors
    CredentialStore.ts         # Safely stores OAuth refresh tokens using Obsidian SecretStorage
    redaction.ts               # Scrubs sensitive tokens/auth headers from logs and diagnostics
  engine/                      # The brain of the provider-neutral synchronization loops
    SyncService.ts             # Orchestrates diffing local vs remote and executing creates/updates/deletes
    SyncQueue.ts               # Debounces, limits, and queues asynchronous sync tasks
    ConflictResolver.ts        # Helpers for determining conflict candidates
  providers/                   # The interface boundaries to external servers
    CalendarProvider.ts        # Contract that any calendar sync provider (Google, MS) must fulfill
    ProviderErrors.ts          # Structured error types (e.g., 410 Gone, 401 Unauthorized)
    FakeCalendarProvider.ts    # Deterministic in-memory provider for unit tests
    google/                    # Google Calendar specific implementations
      GoogleOAuthProvider.ts   # PKCE auth, token exchange, refresh logic
      GoogleDesktopOAuth.ts    # Local loopback server (127.0.0.1:0) and browser launcher for Desktop auth
      GoogleCalendarProvider.ts# Paginates lists and executes targeted PATCH/POST requests to Google API
      GoogleEventMapper.ts     # Maps raw Google JSON properties into canonical model and vice versa
      GoogleSyncRuntime.ts     # Wires Obsidian's HTTP transport (requestUrl) to Google services
    microsoft/                 # Later phase (Deferred)
      MicrosoftOAuthProvider.ts
      MicrosoftCalendarProvider.ts
      MicrosoftEventMapper.ts
  lifecycle/                   # Binds the sync engine to the Obsidian Plugin lifecycle
    SyncLifecycleCoordinator.ts# Manages vault listeners, background polling intervals, and startup state
  util/
    date.ts                    # Date math (inclusive/exclusive translations for Google all-day events)
```

## Task ledger

### Gate 0 — Freeze the plan
- Status: `ACCEPTED` (2026-09-20).

### Gate 1 — Desktop OAuth and secure-storage feasibility spike
- Status: `ACCEPTED` (2026-09-20). Decision record in `docs/calendar-sync-feasibility.md`.

### Gate 2 — Test harness and reproducible dependency policy
- Status: `ACCEPTED` (2026-09-20). Vitest, lockfile, and npm scripts configured.

### Workstream A — Pure canonical event domain
- Status: `ACCEPTED` (2026-09-20). Canonical types, validation, stable serialization, hashing, and 3-way merge.

### Workstream B — Event-note codec, repository, and index
- Status: `ACCEPTED` (2026-09-20). Non-destructive frontmatter codec, dual native frontmatter integration, collision-safe repository, and read-model index.

### Workstream C — Versioned plugin data, sync state, settings, and credentials
- Status: `ACCEPTED` (2026-09-20). Envelope migration, sync state store, SecretStorage/session credentials, secret redaction.

### Workstream D — Provider contract, injected transport, and fake provider
- Status: `ACCEPTED` (2026-09-20). Provider-neutral contracts, categorized errors, deterministic fake provider.

### Workstream E — Provider-neutral sync engine
- Status: `ACCEPTED` (2026-09-20). Outbound queue, reconciliation, 3-way merge, tombstones, backoff, and idempotent retries.

### Workstream F — Google OAuth and Calendar adapter
- Status: `ACCEPTED` (2026-09-20). Loopback listener, system browser launcher, PKCE token exchange/refresh, pagination, sync tokens, ETag updates, mapper.

### Workstream G — Plugin lifecycle and read-model integration
- Status: `ACCEPTED` (2026-09-20). Lifecycle coordinator, vault event listeners, interval polling, index sharing across calendar views.

### Workstream H — Settings, event editor, status, and conflict UI
- Status: `ACCEPTED` (2026-09-27). Sync settings tab, Google Client ID & Secret configuration, Connect/Reconnect actions, SyncEventModal, SyncConflictModal, dedicated "Synced events" section in DayDetailView, and time formatting helpers.

### Workstream I — Staged Google rollout and live validation
- Status: `IN_PROGRESS` (Active).
- [x] Document client-ID distribution model (`docs/client-id-distribution.md`).
- [x] Add validated Client ID and Client Secret settings.
- [x] Compose and inject authenticated Google runtime in `main.ts`.
- [x] Distinct `Connect` and `Reconnect` UI paths.
- [x] Discover account, list writable calendars, persist binding.
- [x] Manual live testing: connect, calendar discovery, initial import, bidirectional updates, and remote-first deletion verified.
- [ ] Automated end-to-end integration tests for `main.ts` connection/lifecycle flow.
- [ ] Windows and Linux desktop runtime verification.
- [ ] Mobile smoke testing to confirm local calendar behavior remains unaffected.

### Workstream K — Cached Google events and optional linked notes
- Status: `REVIEW` (2026-09-28; automated checks pass, native rendering remains unverified).
- [x] Separate provider event cache from Markdown note index and expose calendar projections.
- [x] Replace automatic inbound note creation with explicit linked-note creation.
- [x] Wire day detail actions to provider events in both calendar views.
- [x] Automated migration, CRUD, link, deletion, mode, and restart checks; root diff review.
- [ ] Verify calendar rendering and actions in native Obsidian when available.

### Workstream L — TaskNotes-Style Banner Injection for Synced Notes
- Status: `TODO`
- [ ] Implement dual-engine direct DOM injection for notes synced with Google Calendar.
- [ ] Provide lightweight, vanilla DOM view for banner rendering.
- [x] Ensure explicit "Edit event" interaction inside `DayDetailView.tsx` correctly triggers `SyncEventModal`.
- [ ] Review `BANNER_IMPLEMENTATION_DETAILS.md` for architectural nuances, CodeMirror integration, and Reading Mode workarounds.

### Workstream J — Microsoft adapter
- Status: `TODO — deferred until Google is accepted`.

### Final audit and release handoff
- Status: `TODO`.

## Current baseline evidence

Recorded on 2026-09-29 after the restart-authentication fix:
- Live inspection of the Playground vault found a saved refresh credential but no Google Client Secret in restored settings; startup therefore created no sync service while settings still showed the saved account as connected.
- Google Client Secrets now persist in Obsidian SecretStorage and are restored before session refresh. Settings expose missing credentials and offer an explicit secure Save action; the saved account can recover without disconnecting once the secret is entered again.
- `npm test`: 19 test files, 136 tests passed. `npm run build` and `git diff --check` pass. Changed-file lint has zero errors and five existing warnings. A live Obsidian restart check after one-time Client Secret re-entry remains pending.

Recorded on 2026-09-29 after the follow-up Google sync fix:
- Full Google event pulls now establish an unbounded incremental cursor; the configured horizon is applied when caching events. Existing bounded-query cursors trigger one automatic full resync, without disconnecting the account.
- Manual sync reports offline and error results in the settings notice. Live Google verification is still required to confirm the reported repeat-sync failure is resolved.
- `npm test`: 18 test files, 124 tests passed. `npm run build` and `git diff --check` pass. Focused changed-file lint has zero errors and three existing warnings; repository-wide lint retains 16 pre-existing errors.

Recorded on 2026-09-28 after Workstream K:
- `npm test`: 18 test files, 119 tests passed.
- `npm run build`: passes TypeScript checking and production bundle.
- Focused sync/UI/lifecycle lint: zero errors, four existing warnings.
- `git diff --check`: passes.
- Native Obsidian event-card and calendar-dot rendering has not been checked in this session.

Prior baseline recorded on 2026-09-27:
- `npm test`: 18 test files, 125 tests passed.
- `npm run build`: passes TypeScript checking and production bundle cleanly.
- Sync lint: `./node_modules/.bin/eslint src/services/sync tests/sync vitest.config.ts` passes with zero errors (1 pre-existing warning).
- Live Google OAuth PKCE and bidirectional sync: validated manually in Obsidian.

## Exact next action for the fresh session

1. Reload the plugin in Obsidian desktop and inspect calendar dots, Google event cards, Create note / Open note, direct Edit/Delete, and retained existing notes in a throwaway vault/calendar. Capture screenshots or a short recording when native UI access is available.
2. Verify the test suite and build remain green after any visual fixes:
   ```sh
   npm test
   npm run build
   ```
3. Write automated lifecycle integration tests for `main.ts` simulating:
   - First-time `Connect` success and error handling.
   - Session restoration on plugin startup with existing credentials.
   - `Disconnect` clearing credentials and state while preserving notes.
4. Validate desktop execution on Windows/Linux if testing environments are available, and perform a mobile smoke test confirming local calendar functionality remains intact.
5. Once Google milestone is signed off, begin Workstream J (Microsoft adapter).
