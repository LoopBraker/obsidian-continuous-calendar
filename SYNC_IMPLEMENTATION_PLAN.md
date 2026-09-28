# Calendar Sync Implementation Plan and Orchestrator Handoff

Last updated: 2026-09-27  
Status: Gates 0–2 and Workstreams A–H completed and accepted. Workstream I (Google Rollout) live authorization and synchronization implemented and validated; automated lifecycle suite and cross-platform checks pending. Workstream J (Microsoft) deferred.  
Repository: `obsidian-continuous-calendar`

## Current state snapshot

Recorded on 2026-09-27 after Google Calendar bidirectional sync rollout and DayDetailView UI improvements.

### What works now

- **Local-first startup and gating**: Plugin loads safely with sync disabled, without credentials, or with missing client configuration without making network requests. Desktop sync controls are capability-gated via `Platform.isDesktopApp`.
- **Pure canonical event domain**: Full validation, RFC 3339 offset enforcement, deterministic SHA-256 hashing, and 3-way merge logic (`CalendarEventValidation`, `CalendarEventHash`, `CalendarEventMerge`).
- **Markdown vault integration & dual frontmatter encoding**: `CalendarEventRepository` and `FrontmatterEventCodec` handle non-destructive frontmatter updates via `processFrontMatter`. Dual frontmatter bridges native Obsidian properties (`date`, `dateStart`, `dateEnd`) with canonical sync boundaries (`calendar_start`, `calendar_end`, `calendar_all_day`).
- **State and credential storage**: Versioned migrations via `PluginDataStore`, sync tokens/snapshots/tombstones via `SyncStateStore`, and secure tokens via `CredentialStore` (`SecretStorage` / `safeStorage` with session fallback).
- **Google OAuth & provider runtime**: System browser PKCE authorization with loopback HTTP listener on `127.0.0.1:0`, refresh token exchange, revocation, calendar discovery, pagination, incremental sync tokens, 410 full resync, and ETag conditional updates (`GoogleOAuthProvider`, `GoogleCalendarProvider`, `GoogleDesktopOAuth`).
- **Provider-neutral sync engine**: Debounced serialized outbound queue (`SyncQueue`), 3-way reconciliation, conflict detection, feedback-loop suppression, and tombstone handling (`SyncService`).
- **Settings UI**: Dedicated Sync settings tab supporting Google Client ID and Client Secret configuration, dynamic `Connect` vs `Reconnect` actions, calendar selector dropdown, sync mode options (`disabled`, `dry-run`, `import-only`, `bidirectional`), intervals, horizons, folder picker, conflict viewer, and safe disconnect dialog.
- **Modals & UI projections**:
  - `SyncEventModal`: Create and edit canonical events.
  - `SyncConflictModal`: Side-by-side local vs remote diff resolution.
  - `DayDetailView`: Dedicated "Synced events" section with event cards, clean timezone-aware time formatting, status badges, and action buttons (`Edit`, `Resolve`, `Delete synced event`), filtered from generic notes.
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

1. **Dual Frontmatter Mapping for Native Interoperability (`date` / `dateStart` / `dateEnd` vs `calendar_start` / `calendar_end`)**:
   - *Original Plan*: Rely solely on `calendar_start`, `calendar_end`, and `calendar_all_day` with Google's exclusive end dates (`[start, end)`).
   - *Deviation*: `FrontmatterEventCodec` and `CalendarEventValidation` maintain native Continuous Calendar frontmatter properties alongside canonical sync properties. Single-day events map to `date`. Multi-day events map to `dateStart` and `dateEnd` using inclusive ends (`exclusiveToInclusive(end)`). Timed events extract the `YYYY-MM-DD` date into `date` while keeping exact RFC 3339 timestamps and offsets in `calendar_start`/`calendar_end`.
   - *Reason*: Allows the native calendar view to render event dots, range bars, and day lists immediately without rewriting the entire core plugin rendering engine, while preserving Google's exact timestamp constraints and exclusive end boundaries without data loss or date drift.
2. **Google OAuth Client Secret Requirement**:
   - *Original Plan*: Assumed public-client PKCE without client secrets.
   - *Deviation*: Added `googleClientSecret` to settings and `GoogleOAuthProvider`.
   - *Reason*: Google Cloud Console OAuth 2.0 Client IDs created for "Desktop app" applications mandate a `client_secret` during authorization code exchange at `https://oauth2.googleapis.com/token`. Omitting it causes Google to reject the request with `401 Unauthorized / invalid_client`.
3. **Dedicated "Synced Events" Card Section in `DayDetailView`**:
   - *Original Plan*: Show sync events mixed into the existing markdown notes list with status badges.
   - *Deviation*: Added a dedicated "Synced events" section in `DayDetailView.tsx` with card styling, distinct time range formatting (`formatCalendarEventTime`), status badges, and action buttons (`Edit`, `Resolve`, `Delete synced event`), filtering synced events out of the generic notes list.
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
- One explicit Markdown event note per calendar event, stored in a configurable folder.
- Only notes with `calendar_event: true` participate. Existing dated, range, task, and daily notes are never uploaded implicitly.
- Frontmatter contains synchronized event fields. The Markdown body remains local and is never rewritten by synchronization.
- Non-recurring events only in the first milestone. Recurring events are detected and reported as unsupported.
- Safe deletion: neither side is deleted automatically. Remote deletion marks the note; local deletion creates a tombstone. Remote deletion occurs only through explicit confirmation.
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

## Canonical event-note contract

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

Contract rules:
- `calendar_uid` is generated once and is the local identity.
- `calendar_title`, not the filename, is authoritative.
- Native keys (`date` or `dateStart`/`dateEnd`) coexist to render on Continuous Calendar views.
- Timed values are RFC 3339 timestamps with offsets and an IANA timezone in `calendar_start`/`calendar_end`.
- All-day values in `calendar_start`/`calendar_end` are `YYYY-MM-DD` where `calendar_end` is exclusive.
- `calendar_description` synchronizes in both directions; note markdown bodies remain local-only.
- Status values include: `pending`, `synced`, `conflict`, `remote_deleted`, `unsupported`, and `error`.

## Target module layout

```text
src/services/sync/
  model/
    CalendarEvent.ts
    CalendarEventValidation.ts
    CalendarEventHash.ts
    CalendarEventMerge.ts
  notes/
    FrontmatterEventCodec.ts
    CalendarEventRepository.ts
    CalendarEventIndex.ts
  state/
    PluginDataStore.ts
    SyncStateStore.ts
    CredentialStore.ts
    redaction.ts
  engine/
    SyncService.ts
    SyncQueue.ts
    ConflictResolver.ts
  providers/
    CalendarProvider.ts
    ProviderErrors.ts
    FakeCalendarProvider.ts
    google/
      GoogleOAuthProvider.ts
      GoogleDesktopOAuth.ts
      GoogleCalendarProvider.ts
      GoogleEventMapper.ts
      GoogleSyncRuntime.ts
    microsoft/                 # Later phase
      MicrosoftOAuthProvider.ts
      MicrosoftCalendarProvider.ts
      MicrosoftEventMapper.ts
  lifecycle/
    SyncLifecycleCoordinator.ts
  util/
    date.ts
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

### Workstream J — Microsoft adapter
- Status: `TODO — deferred until Google is accepted`.

### Final audit and release handoff
- Status: `TODO`.

## Current baseline evidence

Recorded on 2026-09-27:
- `npm test`: 18 test files, 125 tests passed.
- `npm run build`: passes TypeScript checking and production bundle cleanly.
- Sync lint: `./node_modules/.bin/eslint src/services/sync tests/sync vitest.config.ts` passes with zero errors (1 pre-existing warning).
- Live Google OAuth PKCE and bidirectional sync: validated manually in Obsidian.

## Exact next action for the fresh session

1. Verify the test suite and build remain green:
   ```sh
   npm test
   npm run build
   ```
2. Write automated lifecycle integration tests for `main.ts` simulating:
   - First-time `Connect` success and error handling.
   - Session restoration on plugin startup with existing credentials.
   - `Disconnect` clearing credentials and state while preserving notes.
3. Validate desktop execution on Windows/Linux if testing environments are available.
4. Perform mobile smoke test (iOS/Android) confirming local calendar functionality remains intact and sync tab is hidden.
5. Once Google milestone is signed off, begin Workstream J (Microsoft adapter).
