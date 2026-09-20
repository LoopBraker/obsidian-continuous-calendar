# Calendar Sync Implementation Plan and Orchestrator Handoff

Last updated: 2026-09-20  
Status: Active implementation of Google Sync. Workstreams A through H completed. Workstream I (Google Rollout) partially completed and manually tested.

## 1. What We Have Implemented So Far

- **Core Sync Engine & State Management**: Complete provider-agnostic synchronization logic (`SyncService`), queuing (`SyncQueue`), canonical event model parsing and hashing, and robust state storage (`PluginDataStore`, `SyncStateStore`, `CredentialStore`).
- **Markdown Vault Integration**: `CalendarEventRepository` and `FrontmatterEventCodec` handle bidirectional conversion of canonical models to Obsidian frontmatter via `processFrontMatter`, leaving bodies untouched. Tombs and conflict files are safely handled.
- **Native Plugin Interoperability**: The sync layer now seamlessly bridges into the existing plugin's native frontmatter definitions (`date`, `dateStart`, `dateEnd`).
  - Single-day events map to `date`.
  - Multi-day and timed cross-day events map to `dateStart` and `dateEnd`.
  - Underlying Google event metadata (exact timestamp constraints, exclusivity flags) is preserved opaquely via `calendar_start`, `calendar_end`, and `calendar_all_day`.
- **Google OAuth & Network Provider**: `GoogleOAuthProvider` implemented with loopback local desktop auth, PKCE, and refresh capabilities. Supports `client_secret` required by Desktop App configurations. `GoogleCalendarProvider` implements the calendar pagination and API boundaries.
- **UI & Lifecycle**: A dedicated Sync settings tab with Connect/Disconnect workflows, sync-mode options (disabled, import-only, bidirectional), and a list-calendars dropdown. A `SyncLifecycleCoordinator` wires all of this safely on plugin startup and cleans up intervals.

## 2. Architecture For Syncing

The architecture cleanly isolates the vault frontmatter reads/writes, the canonical agnostic sync orchestrator, and the remote provider adapters.

### High-Level Folder & File Map

```text
src/services/sync/
├── engine/                     # The brain of the synchronization loops
│   ├── SyncQueue.ts            # Throttles, limits, and queues event sync tasks
│   └── SyncService.ts          # Orchestrates diffing local vs remote and executing creates/updates/deletes
├── lifecycle/                  # Binds the engine to the Obsidian Plugin lifecycle
│   └── SyncLifecycleCoordinator.ts # Manages background polling, connection states, and plugin shutdown
├── model/                      # Provider-agnostic representations of events
│   ├── CalendarEvent.ts        # The canonical types that both Google and Vault must translate to
│   ├── CalendarEventMerge.ts   # Three-way merge logic (local vs remote vs last-sync-snapshot)
│   └── CalendarEventValidation.ts # Strict runtime type checking and fallback logic for dates
├── notes/                      # Translation between canonical models and Obsidian Markdown files
│   ├── CalendarEventRepository.ts # CRUD operations against the vault using safe Obsidian APIs
│   └── FrontmatterEventCodec.ts   # Handles the delicate read/write of frontmatter properties (date vs calendar_start)
├── providers/                  # The interface boundaries to external servers (Google, Microsoft)
│   ├── CalendarProvider.ts     # Interface that any sync provider must fulfill
│   └── google/                 # Google Calendar implementation details
│       ├── GoogleOAuthProvider.ts # Handles local loopback server for token exchange, PKCE, and refresh
│       ├── GoogleCalendarProvider.ts # Paginates lists and executes targeted PATCH/POST requests
│       ├── GoogleEventMapper.ts   # Maps raw Google JSON properties into canonical model and vice versa
│       └── GoogleSyncRuntime.ts   # Wires Obsidian HTTP transport to Google services
├── state/                      # Safe, encrypted (for credentials) and transactional persistence
│   ├── CredentialStore.ts      # Safely stores Refresh Tokens without exposing them to Data.json
│   └── PluginDataStore.ts      # Stores plugin settings, last-sync-tokens, and snapshots for diffing
└── util/
    └── date.ts                 # Date math (inclusive/exclusive translations for Google all-day requirements)
```

## 3. Immediate Next Steps / Left Off At

- Live authentication and mapping logic was verified visually.
- Timed events currently strip their time strings natively (`YYYY-MM-DD` extraction) but safely keep exact times in `calendar_start`/`calendar_end` to preserve them across sync roundtrips without polluting the plugin UI which doesn't fully support times yet.
- **Next Up**: Expand the native plugin view UI to actually visualize the times, or proceed with Microsoft Outlook implementation if Google is fully validated.


- A remote event carrying this plugin's private `calendar_uid` is matched by that UID, then verified against the persisted provider/calendar/remote-ID binding.
- A remote event without a plugin UID is deduplicated only by its persisted `(provider, account, calendar_id, remote_event_id)` binding. Never match by title, filename, time, or description.
- On first import, generate a local UUID, create exactly one event note, and persist the remote binding atomically with the imported snapshot.
- In `import-only` mode, do not patch the new UUID back to the provider; the remote-ID binding prevents duplicate imports.
- On the first permitted bidirectional write, add the UUID to provider-private application metadata and record the returned version.
- If a private UID and persisted remote-ID binding disagree, stop that event as a mapping conflict; do not merge or duplicate it automatically.

Calendar projection rules:

- An all-day event is indexed on every civil date in `[calendar_start, calendar_end)`.
- A timed event is indexed on every civil date intersected by `[calendar_start, calendar_end)` in `calendar_timezone`.
- Same-day timed events appear on one date; cross-midnight events appear on every intersected date.
- Day detail shows actual zoned start/end times. Calendar cells may use the existing dot/range presentation, but canonical timestamps are never flattened or rewritten.
- Zero/negative durations and missing or invalid timezones are validation errors and are not synchronized.

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
  engine/
    SyncService.ts
    SyncQueue.ts
    ConflictResolver.ts
  providers/
    CalendarProvider.ts
    ProviderErrors.ts
    google/
      GoogleOAuthProvider.ts
      GoogleCalendarProvider.ts
      GoogleEventMapper.ts
    microsoft/                 # Later phase
      MicrosoftOAuthProvider.ts
      MicrosoftCalendarProvider.ts
      MicrosoftEventMapper.ts
```

Names may be adjusted during implementation only when the root records the reason here. The layer boundaries must remain intact.

Provider interfaces must be cursor-opaque and provider-neutral. At minimum they cover:

```ts
type ProviderId = 'google' | 'microsoft';

interface PullChangesRequest {
	session: ProviderSession;
	calendarId: string;
	cursor?: string;
	window: SyncWindow;
	signal?: AbortSignal;
}

interface RemoteCalendarEvent {
	providerId: ProviderId;
	calendarId: string;
	remoteId: string;
	event: CalendarEvent;
	version?: string;
	remoteUpdatedAt?: string;
	recurrence: 'none' | 'unsupported';
}

type RemoteChange =
	| { type: 'upsert'; value: RemoteCalendarEvent }
	| { type: 'delete'; providerId: ProviderId; calendarId: string; remoteId: string };

interface ChangePage {
	changes: RemoteChange[];
	nextCursor?: string;
	hasMore: boolean;
}

interface CalendarProvider {
	readonly id: ProviderId;
	listCalendars(session: ProviderSession): Promise<RemoteCalendar[]>;
	pullChanges(request: PullChangesRequest): Promise<ChangePage>;
	createEvent(session: ProviderSession, calendarId: string, event: CalendarEvent): Promise<RemoteCalendarEvent>;
	updateEvent(session: ProviderSession, calendarId: string, remoteId: string, event: CalendarEvent, expectedVersion?: string): Promise<RemoteCalendarEvent>;
	deleteEvent(session: ProviderSession, calendarId: string, remoteId: string, expectedVersion?: string): Promise<void>;
}
```

Workstream A owns `CalendarEvent` and the pure canonical types. Workstream D owns `ProviderSession`, `RemoteCalendar`, `SyncWindow`, `PullChangesRequest`, `RemoteCalendarEvent`, `RemoteChange`, `ChangePage`, provider errors, and `CalendarProvider`. Provider sessions and cursors are opaque to the engine; provider wire payloads never appear in these interfaces.

Authentication and credentials remain separate:

```ts
interface OAuthProvider {
	authorize(): Promise<AccountConnection>;
	refresh(accountId: string): Promise<ProviderSession>;
	revoke(accountId: string): Promise<void>;
}

interface CredentialStore {
	readonly persistence: 'secure' | 'session-only';
	get(provider: ProviderId, accountId: string): Promise<RefreshCredential | null>;
	set(provider: ProviderId, accountId: string, credential: RefreshCredential): Promise<void>;
	remove(provider: ProviderId, accountId: string): Promise<void>;
}
```

## Orchestration protocol

### Fresh-session startup

The next root session must begin with:

1. Read `AGENTS.md` and this file completely.
2. Run `git status --short` and preserve unrelated changes.
3. Re-run the baseline commands if dependencies or source files changed since this document was written.
4. Inspect the task ledger and choose the first `TODO` item whose dependencies are `ACCEPTED`.
5. Mark that item `IN_PROGRESS`, record the assigned agent and owned paths, then delegate it to a Luna subagent with max reasoning.
6. Keep root work useful while agents run: inspect adjacent integration points, prepare acceptance checks, and audit returned diffs.

### Delegation rules

- Every subagent receives one bounded deliverable, exact owned paths, dependencies, acceptance checks, and an instruction to avoid unrelated edits.
- Do not give two live agents ownership of the same file.
- `main.ts`, `settings/settings.ts`, `SettingsTab.ts`, `package.json`, `tsconfig.json`, and shared provider contracts have one active owner at a time.
- Subagents report files changed, commands run, results, assumptions, and remaining risks.
- Root reviews the entire diff; a subagent's statement that work is complete is not acceptance.
- Root performs shared integration edits and resolves cross-package API decisions.
- Update this file after every accepted task with status, evidence, changed paths, and the exact next task.

### Task states

`TODO -> IN_PROGRESS -> REVIEW -> ACCEPTED`

Use `BLOCKED_EXTERNAL` only for genuine external requirements such as missing OAuth application registrations or test accounts. Do not mark incomplete code as accepted because it compiles.

### Root acceptance loop

For every work package:

- [ ] Inspect the full diff and confirm ownership boundaries.
- [ ] Run focused tests for the package.
- [ ] Run `git diff --check`.
- [ ] Run `npm run build`.
- [ ] Run ESLint and compare with the recorded baseline.
- [ ] Confirm no credentials or tokens are logged or persisted improperly.
- [ ] Confirm no generated `main.js`, `data.json`, `node_modules`, or unrelated changes are included.
- [ ] Record evidence and move the package to `ACCEPTED`, or return it for correction.

## Task ledger

### Gate 0 — Freeze the plan

Owner: root orchestrator  
Dependencies: none  
Owned path: `SYNC_IMPLEMENTATION_PLAN.md`

- [x] Record the approved product scope and exclusions.
- [x] Record architecture boundaries and data contracts.
- [x] Define dependency-ordered work packages for subagents.
- [x] Record validation, rollout, recovery, and fresh-session instructions.
- [ ] In the new session, verify the checkout still matches the baseline below.

Acceptance: this document exists, implementation remains untouched, and a fresh session can identify the first executable task without conversation history.

Status: `ACCEPTED`; baseline refreshed on 2026-09-20.

### Gate 1 — Desktop OAuth and secure-storage feasibility spike

Owner: one feasibility subagent; root audits  
Dependencies: Gate 0  
Owned path: `docs/calendar-sync-feasibility.md`; no production provider implementation

- [ ] Verify that the supported Obsidian desktop runtime can open the system browser and receive a PKCE loopback callback.
- [ ] Verify the exact Electron OS-protected storage API available on macOS, Windows, and Linux.
- [ ] Verify the session-only fallback when secure persistence is unavailable.
- [ ] Verify `requestUrl` behavior for JSON bodies, headers, ETags, pagination, and non-2xx responses.
- [ ] Record exact Google redirect/client configuration and later Microsoft public-client configuration.
- [ ] Record mobile behavior: existing plugin works; sync controls and network activity are disabled.

Acceptance: a reviewed decision record identifies the callback mechanism, credential-store mechanism, fallback, and supported desktop behavior. No provider implementation starts before this gate is accepted.

Status: `ACCEPTED` (2026-09-20). Root reviewed `docs/calendar-sync-feasibility.md`. The record selects external-browser PKCE with a loopback listener, Obsidian `SecretStorage` with a session-only fallback, conditional Electron `safeStorage`, an injected `requestUrl` transport, exact Google/Microsoft registration boundaries, and mobile feature gating. Live OAuth, cross-OS, and Obsidian-runtime checks remain correctly deferred to their implementation/rollout gates.

### Gate 2 — Test harness and reproducible dependency policy

Owner: root or one tooling subagent with temporary exclusive ownership of package/config files  
Dependencies: Gate 0  
Owned paths: `package.json`, `package-lock.json`, `vitest.config.ts`, `tests/sync/**`

- [ ] Add and configure Vitest for pure domain and mocked-provider tests.
- [ ] Add `npm test` and a focused/watch variant if appropriate.
- [ ] Generate and commit `package-lock.json` as the reproducible dependency policy.
- [ ] Add one passing smoke test without changing production behavior.
- [ ] Document commands in `README.md` or this file.

Acceptance: a clean install has deterministic dependencies, the smoke test passes, build still passes, and no production code behavior changes.

Status: `ACCEPTED` (2026-09-20). Added Vitest 0.34.6, a lockfile, `test`, `test:sync`, and `test:watch` scripts, focused configuration, and a mocked-provider smoke test. Root reproduced the dependency graph with `npm ci` using an isolated cache, then verified all three test commands, `npm run build`, focused zero-error lint, `git diff --check`, and the unchanged full-lint baseline of 16 errors and 49 warnings. The Vite CJS deprecation warning and existing dependency audit findings are recorded but do not invalidate the harness.

### Workstream A — Pure canonical event domain

Owner: domain-model subagent  
Dependencies: Gate 2  
Owned paths: `src/services/sync/model/**` and matching tests

- [ ] Define canonical event, provider reference, remote event, validation result, snapshot, conflict, and status types.
- [ ] Implement deterministic validation and normalization.
- [ ] Implement stable canonical serialization and hashing independent of object key order.
- [ ] Implement field-level diff and three-way merge primitives.
- [ ] Enforce RFC 3339 timed values, IANA timezones, and exclusive all-day ends.
- [ ] Return structured errors for invalid fields and unsupported recurrence.

Acceptance:

- [ ] Pure modules import neither Obsidian nor provider SDKs.
- [ ] Hashes are deterministic.
- [ ] DST and exclusive-end cases are tested.
- [ ] Disjoint edits merge; divergent edits to the same field conflict.

Status: `ACCEPTED` (2026-09-20). Added provider-neutral canonical types, deterministic validation/normalization, stable serialization and hashing, field diffs, and invariant-safe three-way merge. Root-required corrections preserve provider-visible text exactly, reject UID mutation as an identity conflict, and prevent invalid cross-field merge results. Root verified 19 passing tests, clean focused lint, passing build and diff checks, and the unchanged full-lint baseline.

### Workstream B — Event-note codec, repository, and index

Owner: note-model subagent  
Dependencies: Workstream A  
Owned paths: `src/services/sync/notes/**` and matching tests

- [ ] Parse only Markdown files explicitly marked `calendar_event: true`.
- [ ] Create event notes in the configured folder with collision-safe filenames and immutable UUIDs.
- [ ] Update canonical frontmatter via `processFrontMatter` without changing the body.
- [ ] Maintain UID-to-path and path-to-event maps.
- [ ] Handle renames without remote operations.
- [ ] Detect duplicate UIDs and expose a recoverable error.
- [ ] Emit local-deletion information before the mapping is lost.
- [ ] Represent `remote_deleted`, `unsupported`, and error states without deleting notes.

Acceptance:

- [ ] Create/read/update/rename/reload preserves UID.
- [ ] Unknown frontmatter and body bytes are preserved.
- [ ] Unmarked notes remain untouched.
- [ ] Duplicate IDs and path collisions are deterministic and tested.

Status: `ACCEPTED` (2026-09-20). Added the explicit-marker frontmatter codec, collision-safe repository, and UID/path index with process-frontmatter-only updates, deletion signals, rename stability, deterministic duplicate handling, and non-destructive statuses. Root-required corrections exclude versions/errors from frontmatter and preserve literal/folded YAML description semantics. Twelve focused note tests pass.

### Workstream C — Versioned plugin data, sync state, settings, and credentials

Owner: state/config subagent  
Dependencies: Gates 1 and 2; Workstream A accepted  
Owned paths: `src/services/sync/state/**`; temporary exclusive ownership of `src/settings/settings.ts`

- [ ] Replace the current implicit flat settings load with a backward-compatible, versioned plugin-data envelope.
- [ ] Migrate existing flat settings without data loss.
- [ ] Add sync settings: event folder, timezone, polling interval, horizon, provider/account/calendar selection, and persisted `syncMode`.
- [ ] Define `syncMode` as `disabled | dry-run | import-only | bidirectional`, defaulting to `disabled`.
- [ ] Persist mappings, cursors, snapshots, conflicts, tombstones, retry state, schema version, and sanitized last error.
- [ ] Implement the credential-store abstraction chosen in Gate 1.
- [ ] Keep access tokens in memory and prevent plaintext refresh-token persistence.
- [ ] Make corrupt state disable sync safely rather than preventing plugin startup.
- [ ] Implement disconnect cleanup that preserves notes and remote events.

Acceptance:

- [ ] Existing settings migrate and retain values.
- [ ] Restart restores mappings/cursors.
- [ ] Corrupt state and failed migrations preserve the prior state and disable sync.
- [ ] Secret scanning finds no tokens in plugin state, frontmatter, logs, or fixtures.

Status: `ACCEPTED` (2026-09-20). Added versioned plugin-data migration, sync state, safe defaults, SecretStorage/session credential stores, sanitized errors, and non-destructive disconnect. Root-required correction separates credential-key stripping from diagnostic value redaction so opaque cursors and snapshots round-trip exactly. Migration, restart, corruption, disconnect, credential, and secret-scan tests pass.

### Workstream D — Provider contract, injected transport, and fake provider

Owner: provider-contract subagent  
Dependencies: Gates 1 and 2; Workstream A  
Owned paths: shared provider interfaces/error types and fake-provider tests

- [ ] Define provider-neutral authentication sessions, calendar discovery, change pages, opaque cursors, CRUD operations, cancellation, and conditional versions.
- [ ] Define categorized errors: authentication, authorization, throttling, transient, permanent, conflict, cursor expired, and unsupported.
- [ ] Inject HTTP and time dependencies for deterministic tests.
- [ ] Build a fake provider supporting pagination, cursor expiry, retries, conditional conflicts, and deletions.

Acceptance:

- [ ] Provider-specific payloads do not leak into domain or engine APIs.
- [ ] The fake provider can exercise the complete engine without network access.
- [ ] Cancellation and retry metadata are testable.

Status: `ACCEPTED` (2026-09-20). Added provider-neutral contracts, categorized errors with retry metadata, injected HTTP/time boundaries, and a deterministic fake provider covering discovery, CRUD, versions, pagination, cursor expiry, deletion, cancellation, queued failures, and call observability. Root required and verified terminal cursor progress across filtered records. Seven provider tests and focused lint pass; build and diff checks pass.

### Workstream E — Provider-neutral sync engine

Owner: sync-engine subagent  
Dependencies: A, B, C, and D  
Owned paths: `src/services/sync/engine/**` and matching tests

- [x] Implement the debounced, serialized outbound queue.
- [x] Implement startup/manual/interval pull coordination.
- [x] Reconcile local, remote, and last-synchronized snapshots.
- [x] Merge disjoint changes and persist same-field conflicts without overwriting either side.
- [x] Suppress feedback loops with internal-write guards and canonical hashes.
- [x] Implement bounded backoff, throttling support, offline recovery, and cancellation.
- [x] Persist tombstones and make remote deletion explicit-only.
- [x] Expose observable status and conflict-resolution operations for UI.
- [x] Make all operations idempotent across retry and restart.

Acceptance:

- [x] Local-only and remote-only changes propagate correctly.
- [x] Disjoint edits merge; same-field edits stop as conflicts.
- [x] Replayed changes create neither duplicate notes nor duplicate remote events.
- [x] Markdown bodies are never read or changed by the engine.
- [x] Transient errors never become deletions.

Status: `ACCEPTED` (2026-09-20). Added serialized provider writes, pull/reconcile coordination, durable per-change checkpoints, three-way merge/conflicts, cancellation-safe retry, internal-write suppression, tombstones, explicit-only remote deletion, status/conflict APIs, and restart-safe replay. Root-required corrections enforce private-UID-only matching, import-only snapshot directionality, conditional deletion before trash, and exactly one private-UID patch when an imported untagged event first enters bidirectional mode. Root verified 77 tests, clean sync-focused lint, passing build and diff checks; Vitest now runs single-threaded to avoid the observed Node 26 worker crash.

### Workstream F — Google OAuth and Calendar adapter

Owner: Google-provider subagent  
Dependencies: Gates 1 and 2; A, C, and D; engine contract stable  
Owned paths: `src/services/sync/providers/google/**` and matching tests

- [x] Implement system-browser PKCE authorization with loopback callback, state validation, timeout, cancel, refresh, reconnect, and revoke.
- [x] Request the narrow event-write scope and discover writable calendars.
- [x] Map title, timed/all-day dates, timezone, location, and description.
- [x] Store local UUID in Google private extended properties.
- [x] Implement initial and incremental pull with pagination and `syncToken`.
- [x] Recover an expired token with a bounded full resync.
- [x] Use ETag-aware conditional updates.
- [x] Categorize 401, 403, 404, 410, 412, 429, and 5xx responses.
- [x] Preserve provider-owned fields by updating only supported fields.
- [x] Detect recurring events and return `unsupported` without modifying them.

Acceptance:

- [x] Mocked contract suite covers success, pagination, auth expiry, cursor expiry, conflicts, throttling, cancellation, and server failures.
- [x] No credentials or tokens appear in errors/logs.
- [x] Google-specific semantics remain inside the adapter/auth modules.

Status: `ACCEPTED` (2026-09-20). Added an injected Google Calendar adapter, canonical wire mapper, desktop PKCE OAuth coordinator, loopback listener, and guarded system-browser bridge. Root completed the package after the delegated subagent hit its usage cap, correcting text preservation, exact redirect reuse, refresh-token persistence, scope validation, stable account discovery, cancellation races, private-UID confirmation, pagination query stability, final sync-token enforcement, and operation-aware 410 handling. The mocked suite covers OAuth, loopback security, discovery, CRUD, mapping, paging, errors, and redaction. Root verified 111 total tests, clean sync-focused lint, passing build and diff checks; live OAuth and cross-OS Obsidian qualification remain deferred to Workstream I as recorded.

### Workstream G — Plugin lifecycle and read-model integration

Owner: lifecycle subagent; root owns final shared integration  
Dependencies: B and E; Google plugs in after F  
Owned paths: temporary exclusive ownership of `src/main.ts` and `src/services/IndexService.ts`; consumes B's `CalendarEventIndex`

- [x] Construct repositories, stores, providers, and sync service after settings load.
- [x] Index the vault before the first pull/reconciliation.
- [x] Forward cleanup-safe create/modify/delete/rename events to the sync service.
- [x] Register the five-minute poll through `registerInterval` and add `Sync now`.
- [x] Stop queues and abort requests on unload.
- [x] Integrate B's `CalendarEventIndex` as the dedicated read-model projection rather than overloading current note/task managers.
- [x] Ensure the standard and Bases calendar views observe the same plugin-wide vault-backed sync state.
- [x] Gate OAuth controls and network activity with desktop capability without changing `manifest.json` to desktop-only.

Acceptance:

- [x] Plugin starts with sync disabled, missing credentials, or malformed sync state.
- [x] Startup never uploads unmarked notes.
- [x] Rename/delete lifecycle is safe and deterministic.
- [x] Unload leaves no active timers, listeners, callbacks, or requests.
- [x] Existing daily-note, range, task, recurrence, holiday, and Bases behavior remains intact.

Status: `ACCEPTED` (2026-09-20). Added a local-first lifecycle coordinator, versioned plugin-data loading, feature-detected credentials, production vault adapter, authenticated runtime gate, host-registered polling clock, Sync now command, cleanup-safe vault event forwarding, and shared plugin-wide `CalendarEventIndex` projection for standard and Bases views. Root completed and audited the integration after the delegated subagent stalled, including the rename-before-reload fix that prevents false tombstones, local projection refresh with no provider runtime, event-folder reconfiguration, and view-registry cleanup. No network runtime is invented when credentials/client configuration are absent. Root verified 118 tests, build, focused sync lint, diff checks, and the unchanged full-lint baseline of 16 errors and 49 warnings. Obsidian runtime smoke testing remains part of H/I.

### Workstream H — Settings, event editor, status, and conflict UI

Owner: UI subagent  
Dependencies: C, E, and G  
Owned paths: temporary exclusive ownership of `src/settings/SettingsTab.ts`; new modals/components/styles

- [x] Add a desktop-only sync settings tab/section with connection state.
- [x] Add calendar selection, event folder, timezone, interval/horizon, sync-now, reconnect, disconnect, and dry-run controls.
- [x] Add a create/edit event modal using canonical fields.
- [x] Display synchronized events and statuses in day detail while preserving existing actions.
- [x] Add conflict UI showing local and remote values with explicit resolution.
- [x] Add confirmed `Delete synced event` and non-destructive `Disconnect` actions.
- [x] Ensure errors are actionable and redact secrets.

Deletion behavior is fixed: `Delete synced event` first deletes the remote event conditionally. Only after provider confirmation does it move the local note to Obsidian's system trash and retain a sanitized tombstone in sync state. If remote deletion fails, the note is not trashed. `Disconnect` removes the binding and credentials as applicable while preserving both the note and remote event.

Acceptance:

- [ ] User can connect, select a calendar, preview, create/edit, sync now, resolve a conflict, disconnect, and explicitly delete.
- [ ] Mobile retains local calendar behavior and does not expose sync controls.
- [ ] Existing daily-note and range-note workflows are unchanged.
- [ ] UI screenshots or a short recording are captured for review.

Status: `REVIEW` (2026-09-20). The delegated UI package was completed and root-audited. Settings, canonical create/edit, timezone-aware day projection, status badges, conflict choices, non-destructive disconnect, and remote-first confirmed deletion are wired through lifecycle callbacks; Outlook is visibly deferred. Root added explicit-trash, asynchronous calendar-selection, timezone-formatting, and JWT-redaction regressions. Validation passes with 124 tests, production build, clean focused sync/UI lint, `git diff --check`, and the unchanged full-lint baseline of 16 errors and 49 warnings. Native Obsidian computer-use access was not approved, so actual rendering and screenshot/recording evidence remain unverified. A real connect flow also remains unavailable until an injected Google OAuth client/runtime and disposable account are supplied; that live-provider portion belongs to Workstream I.

### Workstream I — Staged Google rollout and live validation

Owner: root orchestrator  
Dependencies: A through H  
External requirements: Google OAuth application registration, redirect/consent configuration, disposable test account/calendar

- [ ] Decide and document the client-ID distribution model: plugin-owned Desktop OAuth client for releases, or an explicitly labeled user/developer-supplied client ID for testing. Do not invent or commit a credential.
- [ ] Add non-secret Google client-ID configuration and validate it without accepting a client secret.
- [ ] Compose `GoogleOAuthProvider`, the loopback listener, system-browser opener, injected HTTP transport, credential store, and `createGoogleSyncService()` behind the desktop runtime factory.
- [ ] Replace the ambiguous first-use `Reconnect` path with a real `Connect` action; retain `Reconnect` for an existing binding/credential.
- [ ] After authorization, discover the stable account, list writable calendars, persist the selected account/calendar binding, and reconstruct the runtime after restart.
- [ ] Add integration tests for first connect, denied/cancelled authorization, missing client ID, reconnect, disconnect/revoke, restart restoration, and calendar-selection persistence.
- [ ] Stage 1: enable authentication, calendar selection, dry-run, and import preview only.
- [ ] Stage 2: enable explicit local create/update; keep remote writes opt-in and deletion disabled.
- [ ] Stage 3: enable remote-to-local updates, conflict resolution, tombstones, restart recovery, and explicit deletion.
- [ ] Complete the manual acceptance matrix below in a throwaway vault/calendar.
- [ ] Record evidence and known limitations before enabling sync by default.

Acceptance: all automated and manual Google checks pass; no data-loss defect remains open.

Status: `TODO`. Runtime composition and first-connect UI are incomplete code work and are not externally blocked. Choosing/providing a real Google Desktop client ID and disposable account blocks only live-provider validation. Keep remote writes disabled while implementing and testing connection assembly.

### Workstream J — Microsoft adapter

Owner: Microsoft-provider subagent  
Dependencies: stable accepted Google engine and UI; A, C, D, and E  
Owned paths: `src/services/sync/providers/microsoft/**` and matching tests

- [ ] Implement public-client PKCE authentication with delegated `Calendars.ReadWrite`.
- [ ] Discover/select a calendar and map the canonical fields.
- [ ] Implement `calendarView/delta` pagination with complete opaque delta-link persistence.
- [ ] Handle Microsoft timezone mapping, change keys, cancellation, throttling, and authorization errors.
- [ ] Reuse the canonical schema, engine, conflict behavior, tombstones, and UI.

Acceptance: the Microsoft adapter passes the common provider contract suite and the same live acceptance matrix as Google.

Status: `TODO — deferred until Google is accepted`

### Final audit and release handoff

Owner: root orchestrator  
Dependencies: desired provider milestone accepted

- [ ] Audit the complete diff and module boundaries.
- [ ] Run all automated and manual validation.
- [ ] Confirm no secrets, generated artifacts, or unrelated files are included.
- [ ] Document OAuth registration, consent/privacy requirements, supported fields, recurrence limitations, and recovery procedures.
- [ ] Update this ledger with evidence, unresolved defects, and exact continuation steps.

Status: `TODO`

## Dependency and concurrency map

```text
Gate 0
  ├─ Gate 1: OAuth/storage feasibility
  └─ Gate 2: test/dependency foundation
       └─ A: canonical domain
            ├─ B: note repository/index
            ├─ C: state/settings/credentials  (also needs Gate 1)
            └─ D: provider contract/fake      (also needs Gate 1)

A + B + C + D
  └─ E: sync engine

A + C + D + stable E contract
  └─ F: Google adapter

B + E + F
  └─ G: lifecycle/index integration

C + E + G
  └─ H: settings/event/conflict UI

A through H
  └─ I: staged Google rollout
       └─ J: Microsoft adapter
```

After Gates 1 and 2, A is the first shared dependency and must be accepted. Root may then parallelize B, C, and D because their ownership is disjoint. No package may invent duplicate canonical or provider-contract types.

## Validation and acceptance strategy

### Automated coverage

- [ ] Frontmatter parse/serialize round trips preserve unknown fields and body content.
- [ ] UUID identity survives rename and filename changes.
- [ ] Timed events preserve RFC 3339 offsets and IANA zones.
- [ ] All-day events use exclusive end dates.
- [ ] DST boundaries, invalid dates, missing fields, duplicate UIDs, and unsupported recurrence are deterministic.
- [ ] Local create, remote import, each update direction, disjoint merge, same-field conflict, remote deletion, local tombstone, reconnect, and restart recovery.
- [ ] Queue debounce, serialization, idempotency, backoff, throttling, offline recovery, cancellation, and feedback-loop suppression.
- [ ] Plugin-data migrations from the current flat shape, older versions, malformed state, and failed migration.
- [ ] OAuth state/PKCE checks, denied consent, timeout/cancel, refresh failure, and secret redaction.
- [ ] Google pagination, `syncToken` expiry, ETag conflict, and relevant error statuses.
- [ ] Microsoft delta-link behavior when that phase begins.

All provider tests use injected transports, fake credentials, and deterministic clocks. Live tests are opt-in and use disposable accounts/calendars.

### Manual acceptance matrix

- [ ] Create one eligible event note; exactly one remote event appears.
- [ ] Edit title, time, timezone, location, and description locally; only supported remote fields change.
- [ ] Edit each supported field remotely; frontmatter updates and body bytes remain unchanged.
- [ ] Rename the note; the same remote event remains linked.
- [ ] Create a remote event; exactly one marked note is imported with no feedback loop.
- [ ] Change different fields on both sides; they merge.
- [ ] Change the same field on both sides; sync stops for that event and records a conflict.
- [ ] Resolve conflicts in both local-wins and remote-wins directions.
- [ ] Delete remotely; note remains and is marked `remote_deleted`.
- [ ] Delete locally; remote event remains until explicit deletion.
- [ ] Disconnect and reconnect; notes and mappings survive.
- [ ] Restart Obsidian; missed changes catch up safely.
- [ ] Go offline, queue work, reconnect, and verify idempotent recovery.
- [ ] Exercise all-day, multi-day, DST-zone, malformed, duplicate-UID, and recurring/unsupported events.
- [ ] Confirm daily notes, range notes, tasks, holidays, normal calendar view, and Bases view are unchanged.
- [ ] Confirm mobile retains local functionality with sync controls hidden.

## Current baseline evidence

Recorded on 2026-09-19/20 before implementation:

- `git status --short`: clean.
- `npm run build`: passes TypeScript checking and production esbuild.
- `./node_modules/.bin/eslint src`: 65 existing findings — 16 errors and 49 warnings.
- No test directory or `npm test` script exists.
- No dependency lockfile exists.
- No OAuth, provider, sync-state, or credential-storage implementation exists.
- `manifest.json` has `isDesktopOnly: false` and should remain mobile-compatible.
- `main.js` is generated and ignored.

Baseline refreshed on 2026-09-20 before Gates 1 and 2:

- `git status --short`: only this untracked implementation-plan handoff was present.
- `npm run build`: passed.
- `./node_modules/.bin/eslint src`: unchanged at 65 existing findings — 16 errors and 49 warnings.

Current implementation evidence after the Workstream H code audit on 2026-09-20:

- `npm test -- --run`: 18 files and 124 tests passed.
- `npm run build`: passed TypeScript checking and the production bundle.
- Focused sync/UI/lifecycle lint: passed with no findings.
- `./node_modules/.bin/eslint src`: unchanged at 65 findings — 16 errors and 49 warnings.
- `git diff --check`: passed.
- Native Obsidian visual validation: not run because computer-use access was not available.
- Live Google OAuth/provider validation: not run because connection assembly and external test configuration are not complete.

Acceptance policy: new sync modules introduce zero lint errors. Existing lint findings must be reported honestly; unrelated cleanup is not required unless a touched line/module makes it necessary.

## External prerequisites and blockers

Live Google validation requires:

- A Google Cloud project with Calendar API enabled.
- A desktop OAuth client ID configured for PKCE/loopback use.
- Consent-screen configuration and appropriate test users.
- A disposable Google account/calendar.
- For public release: owned branding/homepage, privacy policy, terms where applicable, and Google verification for requested scopes.

Live Microsoft validation later requires:

- A Microsoft Entra application registered as a public desktop client.
- Appropriate redirect/public-client configuration and delegated `Calendars.ReadWrite` consent.
- Personal and/or organizational test accounts matching the supported audience.
- A disposable Outlook calendar.

Missing external credentials block live acceptance only. They do not excuse skipped mocked tests or incomplete provider error handling.

## Data safety and recovery

Before first live sync:

- [ ] Use a copied/throwaway vault and dedicated provider calendar.
- [ ] Back up the vault and plugin state.
- [ ] Record the sync-state schema version.
- [ ] Run dry-run/import preview and review the exact affected objects.
- [ ] Require explicit opt-in before enabling remote writes.

If a defect is found:

1. Disable synchronization and stop the queue.
2. Preserve vault and plugin state; do not delete either side.
3. Export diagnostics with tokens and secrets redacted.
4. Restore local mapped fields/body from backup or the last accepted snapshot.
5. Use explicit per-event local/remote resolution rather than a bulk overwrite.
6. Fix and test the failing path with mocks.
7. Re-authenticate only if required.
8. Repeat dry-run/import-only validation before re-enabling writes.

A failed data migration must leave the prior persisted state intact and disable sync. It must not partially rewrite mappings or continue with an unknown state.

## Files and data that must remain untouched by rollout work

- Do not commit generated `main.js`, vault `data.json`, `node_modules/`, OAuth secrets/tokens, or real-account fixtures.
- Do not edit or delete ordinary user notes while assembling authentication or running mocked tests.
- Live validation must use a copied/throwaway vault and disposable provider calendar until all staged gates pass.

## Exact next action for the fresh session

1. Read `AGENTS.md` and this file, then verify Workstreams E through G remain green with:

   ```sh
   npm test
   npm run build
   ./node_modules/.bin/eslint src/services/sync tests/sync vitest.config.ts
   git diff --check
   ```

2. Keep Workstream H in `REVIEW` until the user can manually inspect the Sync settings tab, day-detail event projection, create/edit modal, conflict modal, and destructive confirmations in Obsidian. Provide a short checklist; do not repeatedly request unavailable computer-use authorization.
3. Continue the non-destructive portion of Workstream I by implementing the missing connection assembly in this order:
   1. decide/document the public client-ID distribution model;
   2. add validated non-secret client-ID configuration;
   3. inject the Google OAuth/provider runtime through `setSyncRuntimeFactory()`;
   4. implement first-time `Connect`, existing-account `Reconnect`, calendar discovery/selection, disconnect/revoke, and restart restoration;
   5. cover the complete flow with mocked integration tests.
4. Stop before live authorization if no Google Desktop client ID and disposable test account/calendar are available. Record that portion as `BLOCKED_EXTERNAL`; do not paste secrets into source, settings fixtures, logs, or this plan.
5. When external test configuration becomes available, run Stage 1 in a throwaway vault/calendar using dry-run and import preview only. Review exact affected objects before enabling any provider write. Stages 2 and 3 require separately recorded acceptance evidence.

Do not perform provider writes, migrations, or destructive recovery actions merely because this document exists. Advance only through the recorded gates.
# Calendar Sync Implementation Plan and Orchestrator Handoff

Last updated: 2026-09-20  
Status: Gates 1 and 2 and Workstreams A through G accepted; Workstream H is in review pending Obsidian visual validation  
Repository: `obsidian-continuous-calendar`

## Current state snapshot

Recorded on 2026-09-20 after the Workstream H code audit.

### What should work now

- The plugin should load with synchronization disabled, without credentials, and without making provider requests.
- Canonical event-note parsing, validation, hashing, merging, indexing, safe frontmatter updates, tombstones, and body preservation are implemented.
- The provider-neutral engine, deterministic fake provider, and Google adapter/OAuth primitives pass mocked tests.
- Desktop builds expose a Sync settings section, canonical create/edit and conflict modals, sync status badges, timezone-aware day-detail projection, non-destructive disconnect, and confirmed remote-first deletion callbacks.
- Standard and Bases calendar views share the same vault-backed synchronized-event index.
- Mobile keeps the existing local calendar code path and hides the Sync settings tab by capability check; this still needs a real mobile smoke test.
- With no injected authenticated runtime, network synchronization fails closed. Existing local calendar, daily-note, range, task, recurrence, and holiday behavior should remain available.

### What does not work yet

- A user cannot connect a Google account from the UI. Selecting Google and pressing `Reconnect` currently produces `Google authentication is not configured for this installation`.
- No production code supplies a Google OAuth client ID or constructs and injects the authenticated Google runtime through `setSyncRuntimeFactory()`.
- The current `Reconnect` action does not start first-time authorization. The UI needs distinct `Connect` and `Reconnect` behavior backed by the OAuth provider.
- Live calendar discovery, import preview, provider reads/writes, refresh/restart behavior, and explicit remote deletion have not been exercised against Google.
- Native Obsidian rendering, screenshots, and mobile/cross-platform runtime checks are unverified because computer-use access to Obsidian was unavailable. This is an evidence gap, not permission to claim acceptance.
- Microsoft Outlook remains deferred.

### External and user constraints

- The user cannot authorize Codex computer-use access to Obsidian on the current machine. Future agents must not block all code progress on that permission or claim visual validation. Provide the user a concise manual checklist and accept screenshots or reported results as evidence when available.
- Connecting Google should not require operating-system administrator privileges. A managed Google Workspace account may nevertheless restrict Cloud project creation or OAuth consent; begin with a personal test account and disposable calendar when possible.
- Never commit an OAuth client secret, refresh token, access token, or real-account fixture. A Google Desktop client ID is public configuration, but its ownership and distribution model must be chosen explicitly before wiring it into the released plugin.

## Purpose of this document

This file is the durable source of truth for implementing bidirectional calendar synchronization. It is intentionally written so a fresh Codex session can resume without relying on conversation history.

The implementation agent must act as the root orchestrator. It should plan and audit the work, delegate bounded packages to Luna subagents at **max reasoning**, and keep shared integration surfaces under root ownership. Subagents may implement their assigned packages, but the root orchestrator is responsible for reviewing every diff, running validation, resolving integration issues, and updating this document after each accepted package.

Do not start by redesigning the feature. Read this document, inspect the current checkout, and resume the first incomplete task whose dependencies are accepted.

## Approved outcome

Bidirectional synchronization is feasible and will be delivered incrementally:

- Google Calendar first, then Microsoft Outlook through the same provider-neutral engine.
- Desktop-only synchronization while retaining the plugin's existing local calendar behavior on mobile.
- Local operation only: sync on startup, manually, and every five minutes while Obsidian is open. No hosted webhook service.
- One explicit Markdown event note per calendar event, stored in a configurable folder.
- Only notes with `calendar_event: true` participate. Existing dated, range, task, and daily notes are never uploaded implicitly.
- Frontmatter contains the synchronized event fields. The Markdown body remains local and must never be rewritten by synchronization.
- Non-recurring events only in the first Google milestone. Recurring events are detected and reported as unsupported.
- Safe deletion: neither side is deleted automatically. Remote deletion marks the note; local deletion creates a tombstone. Remote deletion occurs only through an explicit confirmed command.
- One Google account and one selected writable calendar in the first milestone.
- Default sync horizon: one year backward and two years forward.

Deferred scope:

- Recurring series and per-occurrence exceptions.
- Attendees, invitations, reminders, conferencing, attachments, visibility, and organizer management.
- Full Markdown/body synchronization.
- Multiple accounts or calendars per provider.
- Mobile OAuth and mobile background sync.
- Always-on webhooks or a hosted relay.

## Non-negotiable architecture boundaries

Keep these four layers independent:

1. **Vault layer:** parse, validate, create, and update event-note frontmatter without modifying note bodies.
2. **Canonical sync engine:** compare snapshots, queue work, merge fields, detect conflicts, manage tombstones, and coordinate providers.
3. **Provider adapters:** isolate Google and Microsoft authentication, HTTP shapes, cursors, ETags/change keys, pagination, and errors.
4. **UI/read-model projection:** display canonical events and statuses without performing provider calls.

Specific constraints:

- `IndexService` remains a calendar read model. It must never call Google or Microsoft APIs.
- UI components receive actions through callbacks/services; they do not instantiate repositories, OAuth clients, or providers.
- Provider-specific objects must not leak into canonical domain types.
- Access tokens remain memory-only. Refresh tokens must never appear in frontmatter, logs, diagnostics, or ordinary `Plugin.saveData()` state.
- Use `processFrontMatter` for synchronized field updates; never rewrite a complete Markdown file.
- File paths and filenames are not identities. `calendar_uid` is immutable and survives renames.
- Network writes are disabled by default until the staged rollout reaches the appropriate gate.

## Canonical event-note contract

```yaml
---
calendar_event: true
calendar_uid: "stable-local-uuid"
calendar_title: "Project review"
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
- Timed values are RFC 3339 timestamps with offsets and an IANA timezone.
- All-day values are `YYYY-MM-DD`; `calendar_end` is exclusive.
- `calendar_description` synchronizes in both directions.
- The Markdown body is local-only and remains byte-for-byte unchanged.
- `calendar_sync` contains visible association/status only.
- ETags, provider cursors, last synchronized snapshots, retry state, conflict candidates, and tombstones belong in plugin sync state, not frontmatter.
- Status values are typed and include at least `pending`, `synced`, `conflict`, `remote_deleted`, `unsupported`, and `error`.

Initial remote import and matching rules:

- A remote event carrying this plugin's private `calendar_uid` is matched by that UID, then verified against the persisted provider/calendar/remote-ID binding.
- A remote event without a plugin UID is deduplicated only by its persisted `(provider, account, calendar_id, remote_event_id)` binding. Never match by title, filename, time, or description.
- On first import, generate a local UUID, create exactly one event note, and persist the remote binding atomically with the imported snapshot.
- In `import-only` mode, do not patch the new UUID back to the provider; the remote-ID binding prevents duplicate imports.
- On the first permitted bidirectional write, add the UUID to provider-private application metadata and record the returned version.
- If a private UID and persisted remote-ID binding disagree, stop that event as a mapping conflict; do not merge or duplicate it automatically.

Calendar projection rules:

- An all-day event is indexed on every civil date in `[calendar_start, calendar_end)`.
- A timed event is indexed on every civil date intersected by `[calendar_start, calendar_end)` in `calendar_timezone`.
- Same-day timed events appear on one date; cross-midnight events appear on every intersected date.
- Day detail shows actual zoned start/end times. Calendar cells may use the existing dot/range presentation, but canonical timestamps are never flattened or rewritten.
- Zero/negative durations and missing or invalid timezones are validation errors and are not synchronized.

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
  engine/
    SyncService.ts
    SyncQueue.ts
    ConflictResolver.ts
  providers/
    CalendarProvider.ts
    ProviderErrors.ts
    google/
      GoogleOAuthProvider.ts
      GoogleCalendarProvider.ts
      GoogleEventMapper.ts
    microsoft/                 # Later phase
      MicrosoftOAuthProvider.ts
      MicrosoftCalendarProvider.ts
      MicrosoftEventMapper.ts
```

Names may be adjusted during implementation only when the root records the reason here. The layer boundaries must remain intact.

Provider interfaces must be cursor-opaque and provider-neutral. At minimum they cover:

```ts
type ProviderId = 'google' | 'microsoft';

interface PullChangesRequest {
	session: ProviderSession;
	calendarId: string;
	cursor?: string;
	window: SyncWindow;
	signal?: AbortSignal;
}

interface RemoteCalendarEvent {
	providerId: ProviderId;
	calendarId: string;
	remoteId: string;
	event: CalendarEvent;
	version?: string;
	remoteUpdatedAt?: string;
	recurrence: 'none' | 'unsupported';
}

type RemoteChange =
	| { type: 'upsert'; value: RemoteCalendarEvent }
	| { type: 'delete'; providerId: ProviderId; calendarId: string; remoteId: string };

interface ChangePage {
	changes: RemoteChange[];
	nextCursor?: string;
	hasMore: boolean;
}

interface CalendarProvider {
	readonly id: ProviderId;
	listCalendars(session: ProviderSession): Promise<RemoteCalendar[]>;
	pullChanges(request: PullChangesRequest): Promise<ChangePage>;
	createEvent(session: ProviderSession, calendarId: string, event: CalendarEvent): Promise<RemoteCalendarEvent>;
	updateEvent(session: ProviderSession, calendarId: string, remoteId: string, event: CalendarEvent, expectedVersion?: string): Promise<RemoteCalendarEvent>;
	deleteEvent(session: ProviderSession, calendarId: string, remoteId: string, expectedVersion?: string): Promise<void>;
}
```

Workstream A owns `CalendarEvent` and the pure canonical types. Workstream D owns `ProviderSession`, `RemoteCalendar`, `SyncWindow`, `PullChangesRequest`, `RemoteCalendarEvent`, `RemoteChange`, `ChangePage`, provider errors, and `CalendarProvider`. Provider sessions and cursors are opaque to the engine; provider wire payloads never appear in these interfaces.

Authentication and credentials remain separate:

```ts
interface OAuthProvider {
	authorize(): Promise<AccountConnection>;
	refresh(accountId: string): Promise<ProviderSession>;
	revoke(accountId: string): Promise<void>;
}

interface CredentialStore {
	readonly persistence: 'secure' | 'session-only';
	get(provider: ProviderId, accountId: string): Promise<RefreshCredential | null>;
	set(provider: ProviderId, accountId: string, credential: RefreshCredential): Promise<void>;
	remove(provider: ProviderId, accountId: string): Promise<void>;
}
```

## Orchestration protocol

### Fresh-session startup

The next root session must begin with:

1. Read `AGENTS.md` and this file completely.
2. Run `git status --short` and preserve unrelated changes.
3. Re-run the baseline commands if dependencies or source files changed since this document was written.
4. Inspect the task ledger and choose the first `TODO` item whose dependencies are `ACCEPTED`.
5. Mark that item `IN_PROGRESS`, record the assigned agent and owned paths, then delegate it to a Luna subagent with max reasoning.
6. Keep root work useful while agents run: inspect adjacent integration points, prepare acceptance checks, and audit returned diffs.

### Delegation rules

- Every subagent receives one bounded deliverable, exact owned paths, dependencies, acceptance checks, and an instruction to avoid unrelated edits.
- Do not give two live agents ownership of the same file.
- `main.ts`, `settings/settings.ts`, `SettingsTab.ts`, `package.json`, `tsconfig.json`, and shared provider contracts have one active owner at a time.
- Subagents report files changed, commands run, results, assumptions, and remaining risks.
- Root reviews the entire diff; a subagent's statement that work is complete is not acceptance.
- Root performs shared integration edits and resolves cross-package API decisions.
- Update this file after every accepted task with status, evidence, changed paths, and the exact next task.

### Task states

`TODO -> IN_PROGRESS -> REVIEW -> ACCEPTED`

Use `BLOCKED_EXTERNAL` only for genuine external requirements such as missing OAuth application registrations or test accounts. Do not mark incomplete code as accepted because it compiles.

### Root acceptance loop

For every work package:

- [ ] Inspect the full diff and confirm ownership boundaries.
- [ ] Run focused tests for the package.
- [ ] Run `git diff --check`.
- [ ] Run `npm run build`.
- [ ] Run ESLint and compare with the recorded baseline.
- [ ] Confirm no credentials or tokens are logged or persisted improperly.
- [ ] Confirm no generated `main.js`, `data.json`, `node_modules`, or unrelated changes are included.
- [ ] Record evidence and move the package to `ACCEPTED`, or return it for correction.

## Task ledger

### Gate 0 — Freeze the plan

Owner: root orchestrator  
Dependencies: none  
Owned path: `SYNC_IMPLEMENTATION_PLAN.md`

- [x] Record the approved product scope and exclusions.
- [x] Record architecture boundaries and data contracts.
- [x] Define dependency-ordered work packages for subagents.
- [x] Record validation, rollout, recovery, and fresh-session instructions.
- [ ] In the new session, verify the checkout still matches the baseline below.

Acceptance: this document exists, implementation remains untouched, and a fresh session can identify the first executable task without conversation history.

Status: `ACCEPTED`; baseline refreshed on 2026-09-20.

### Gate 1 — Desktop OAuth and secure-storage feasibility spike

Owner: one feasibility subagent; root audits  
Dependencies: Gate 0  
Owned path: `docs/calendar-sync-feasibility.md`; no production provider implementation

- [ ] Verify that the supported Obsidian desktop runtime can open the system browser and receive a PKCE loopback callback.
- [ ] Verify the exact Electron OS-protected storage API available on macOS, Windows, and Linux.
- [ ] Verify the session-only fallback when secure persistence is unavailable.
- [ ] Verify `requestUrl` behavior for JSON bodies, headers, ETags, pagination, and non-2xx responses.
- [ ] Record exact Google redirect/client configuration and later Microsoft public-client configuration.
- [ ] Record mobile behavior: existing plugin works; sync controls and network activity are disabled.

Acceptance: a reviewed decision record identifies the callback mechanism, credential-store mechanism, fallback, and supported desktop behavior. No provider implementation starts before this gate is accepted.

Status: `ACCEPTED` (2026-09-20). Root reviewed `docs/calendar-sync-feasibility.md`. The record selects external-browser PKCE with a loopback listener, Obsidian `SecretStorage` with a session-only fallback, conditional Electron `safeStorage`, an injected `requestUrl` transport, exact Google/Microsoft registration boundaries, and mobile feature gating. Live OAuth, cross-OS, and Obsidian-runtime checks remain correctly deferred to their implementation/rollout gates.

### Gate 2 — Test harness and reproducible dependency policy

Owner: root or one tooling subagent with temporary exclusive ownership of package/config files  
Dependencies: Gate 0  
Owned paths: `package.json`, `package-lock.json`, `vitest.config.ts`, `tests/sync/**`

- [ ] Add and configure Vitest for pure domain and mocked-provider tests.
- [ ] Add `npm test` and a focused/watch variant if appropriate.
- [ ] Generate and commit `package-lock.json` as the reproducible dependency policy.
- [ ] Add one passing smoke test without changing production behavior.
- [ ] Document commands in `README.md` or this file.

Acceptance: a clean install has deterministic dependencies, the smoke test passes, build still passes, and no production code behavior changes.

Status: `ACCEPTED` (2026-09-20). Added Vitest 0.34.6, a lockfile, `test`, `test:sync`, and `test:watch` scripts, focused configuration, and a mocked-provider smoke test. Root reproduced the dependency graph with `npm ci` using an isolated cache, then verified all three test commands, `npm run build`, focused zero-error lint, `git diff --check`, and the unchanged full-lint baseline of 16 errors and 49 warnings. The Vite CJS deprecation warning and existing dependency audit findings are recorded but do not invalidate the harness.

### Workstream A — Pure canonical event domain

Owner: domain-model subagent  
Dependencies: Gate 2  
Owned paths: `src/services/sync/model/**` and matching tests

- [ ] Define canonical event, provider reference, remote event, validation result, snapshot, conflict, and status types.
- [ ] Implement deterministic validation and normalization.
- [ ] Implement stable canonical serialization and hashing independent of object key order.
- [ ] Implement field-level diff and three-way merge primitives.
- [ ] Enforce RFC 3339 timed values, IANA timezones, and exclusive all-day ends.
- [ ] Return structured errors for invalid fields and unsupported recurrence.

Acceptance:

- [ ] Pure modules import neither Obsidian nor provider SDKs.
- [ ] Hashes are deterministic.
- [ ] DST and exclusive-end cases are tested.
- [ ] Disjoint edits merge; divergent edits to the same field conflict.

Status: `ACCEPTED` (2026-09-20). Added provider-neutral canonical types, deterministic validation/normalization, stable serialization and hashing, field diffs, and invariant-safe three-way merge. Root-required corrections preserve provider-visible text exactly, reject UID mutation as an identity conflict, and prevent invalid cross-field merge results. Root verified 19 passing tests, clean focused lint, passing build and diff checks, and the unchanged full-lint baseline.

### Workstream B — Event-note codec, repository, and index

Owner: note-model subagent  
Dependencies: Workstream A  
Owned paths: `src/services/sync/notes/**` and matching tests

- [ ] Parse only Markdown files explicitly marked `calendar_event: true`.
- [ ] Create event notes in the configured folder with collision-safe filenames and immutable UUIDs.
- [ ] Update canonical frontmatter via `processFrontMatter` without changing the body.
- [ ] Maintain UID-to-path and path-to-event maps.
- [ ] Handle renames without remote operations.
- [ ] Detect duplicate UIDs and expose a recoverable error.
- [ ] Emit local-deletion information before the mapping is lost.
- [ ] Represent `remote_deleted`, `unsupported`, and error states without deleting notes.

Acceptance:

- [ ] Create/read/update/rename/reload preserves UID.
- [ ] Unknown frontmatter and body bytes are preserved.
- [ ] Unmarked notes remain untouched.
- [ ] Duplicate IDs and path collisions are deterministic and tested.

Status: `ACCEPTED` (2026-09-20). Added the explicit-marker frontmatter codec, collision-safe repository, and UID/path index with process-frontmatter-only updates, deletion signals, rename stability, deterministic duplicate handling, and non-destructive statuses. Root-required corrections exclude versions/errors from frontmatter and preserve literal/folded YAML description semantics. Twelve focused note tests pass.

### Workstream C — Versioned plugin data, sync state, settings, and credentials

Owner: state/config subagent  
Dependencies: Gates 1 and 2; Workstream A accepted  
Owned paths: `src/services/sync/state/**`; temporary exclusive ownership of `src/settings/settings.ts`

- [ ] Replace the current implicit flat settings load with a backward-compatible, versioned plugin-data envelope.
- [ ] Migrate existing flat settings without data loss.
- [ ] Add sync settings: event folder, timezone, polling interval, horizon, provider/account/calendar selection, and persisted `syncMode`.
- [ ] Define `syncMode` as `disabled | dry-run | import-only | bidirectional`, defaulting to `disabled`.
- [ ] Persist mappings, cursors, snapshots, conflicts, tombstones, retry state, schema version, and sanitized last error.
- [ ] Implement the credential-store abstraction chosen in Gate 1.
- [ ] Keep access tokens in memory and prevent plaintext refresh-token persistence.
- [ ] Make corrupt state disable sync safely rather than preventing plugin startup.
- [ ] Implement disconnect cleanup that preserves notes and remote events.

Acceptance:

- [ ] Existing settings migrate and retain values.
- [ ] Restart restores mappings/cursors.
- [ ] Corrupt state and failed migrations preserve the prior state and disable sync.
- [ ] Secret scanning finds no tokens in plugin state, frontmatter, logs, or fixtures.

Status: `ACCEPTED` (2026-09-20). Added versioned plugin-data migration, sync state, safe defaults, SecretStorage/session credential stores, sanitized errors, and non-destructive disconnect. Root-required correction separates credential-key stripping from diagnostic value redaction so opaque cursors and snapshots round-trip exactly. Migration, restart, corruption, disconnect, credential, and secret-scan tests pass.

### Workstream D — Provider contract, injected transport, and fake provider

Owner: provider-contract subagent  
Dependencies: Gates 1 and 2; Workstream A  
Owned paths: shared provider interfaces/error types and fake-provider tests

- [ ] Define provider-neutral authentication sessions, calendar discovery, change pages, opaque cursors, CRUD operations, cancellation, and conditional versions.
- [ ] Define categorized errors: authentication, authorization, throttling, transient, permanent, conflict, cursor expired, and unsupported.
- [ ] Inject HTTP and time dependencies for deterministic tests.
- [ ] Build a fake provider supporting pagination, cursor expiry, retries, conditional conflicts, and deletions.

Acceptance:

- [ ] Provider-specific payloads do not leak into domain or engine APIs.
- [ ] The fake provider can exercise the complete engine without network access.
- [ ] Cancellation and retry metadata are testable.

Status: `ACCEPTED` (2026-09-20). Added provider-neutral contracts, categorized errors with retry metadata, injected HTTP/time boundaries, and a deterministic fake provider covering discovery, CRUD, versions, pagination, cursor expiry, deletion, cancellation, queued failures, and call observability. Root required and verified terminal cursor progress across filtered records. Seven provider tests and focused lint pass; build and diff checks pass.

### Workstream E — Provider-neutral sync engine

Owner: sync-engine subagent  
Dependencies: A, B, C, and D  
Owned paths: `src/services/sync/engine/**` and matching tests

- [x] Implement the debounced, serialized outbound queue.
- [x] Implement startup/manual/interval pull coordination.
- [x] Reconcile local, remote, and last-synchronized snapshots.
- [x] Merge disjoint changes and persist same-field conflicts without overwriting either side.
- [x] Suppress feedback loops with internal-write guards and canonical hashes.
- [x] Implement bounded backoff, throttling support, offline recovery, and cancellation.
- [x] Persist tombstones and make remote deletion explicit-only.
- [x] Expose observable status and conflict-resolution operations for UI.
- [x] Make all operations idempotent across retry and restart.

Acceptance:

- [x] Local-only and remote-only changes propagate correctly.
- [x] Disjoint edits merge; same-field edits stop as conflicts.
- [x] Replayed changes create neither duplicate notes nor duplicate remote events.
- [x] Markdown bodies are never read or changed by the engine.
- [x] Transient errors never become deletions.

Status: `ACCEPTED` (2026-09-20). Added serialized provider writes, pull/reconcile coordination, durable per-change checkpoints, three-way merge/conflicts, cancellation-safe retry, internal-write suppression, tombstones, explicit-only remote deletion, status/conflict APIs, and restart-safe replay. Root-required corrections enforce private-UID-only matching, import-only snapshot directionality, conditional deletion before trash, and exactly one private-UID patch when an imported untagged event first enters bidirectional mode. Root verified 77 tests, clean sync-focused lint, passing build and diff checks; Vitest now runs single-threaded to avoid the observed Node 26 worker crash.

### Workstream F — Google OAuth and Calendar adapter

Owner: Google-provider subagent  
Dependencies: Gates 1 and 2; A, C, and D; engine contract stable  
Owned paths: `src/services/sync/providers/google/**` and matching tests

- [x] Implement system-browser PKCE authorization with loopback callback, state validation, timeout, cancel, refresh, reconnect, and revoke.
- [x] Request the narrow event-write scope and discover writable calendars.
- [x] Map title, timed/all-day dates, timezone, location, and description.
- [x] Store local UUID in Google private extended properties.
- [x] Implement initial and incremental pull with pagination and `syncToken`.
- [x] Recover an expired token with a bounded full resync.
- [x] Use ETag-aware conditional updates.
- [x] Categorize 401, 403, 404, 410, 412, 429, and 5xx responses.
- [x] Preserve provider-owned fields by updating only supported fields.
- [x] Detect recurring events and return `unsupported` without modifying them.

Acceptance:

- [x] Mocked contract suite covers success, pagination, auth expiry, cursor expiry, conflicts, throttling, cancellation, and server failures.
- [x] No credentials or tokens appear in errors/logs.
- [x] Google-specific semantics remain inside the adapter/auth modules.

Status: `ACCEPTED` (2026-09-20). Added an injected Google Calendar adapter, canonical wire mapper, desktop PKCE OAuth coordinator, loopback listener, and guarded system-browser bridge. Root completed the package after the delegated subagent hit its usage cap, correcting text preservation, exact redirect reuse, refresh-token persistence, scope validation, stable account discovery, cancellation races, private-UID confirmation, pagination query stability, final sync-token enforcement, and operation-aware 410 handling. The mocked suite covers OAuth, loopback security, discovery, CRUD, mapping, paging, errors, and redaction. Root verified 111 total tests, clean sync-focused lint, passing build and diff checks; live OAuth and cross-OS Obsidian qualification remain deferred to Workstream I as recorded.

### Workstream G — Plugin lifecycle and read-model integration

Owner: lifecycle subagent; root owns final shared integration  
Dependencies: B and E; Google plugs in after F  
Owned paths: temporary exclusive ownership of `src/main.ts` and `src/services/IndexService.ts`; consumes B's `CalendarEventIndex`

- [x] Construct repositories, stores, providers, and sync service after settings load.
- [x] Index the vault before the first pull/reconciliation.
- [x] Forward cleanup-safe create/modify/delete/rename events to the sync service.
- [x] Register the five-minute poll through `registerInterval` and add `Sync now`.
- [x] Stop queues and abort requests on unload.
- [x] Integrate B's `CalendarEventIndex` as the dedicated read-model projection rather than overloading current note/task managers.
- [x] Ensure the standard and Bases calendar views observe the same plugin-wide vault-backed sync state.
- [x] Gate OAuth controls and network activity with desktop capability without changing `manifest.json` to desktop-only.

Acceptance:

- [x] Plugin starts with sync disabled, missing credentials, or malformed sync state.
- [x] Startup never uploads unmarked notes.
- [x] Rename/delete lifecycle is safe and deterministic.
- [x] Unload leaves no active timers, listeners, callbacks, or requests.
- [x] Existing daily-note, range, task, recurrence, holiday, and Bases behavior remains intact.

Status: `ACCEPTED` (2026-09-20). Added a local-first lifecycle coordinator, versioned plugin-data loading, feature-detected credentials, production vault adapter, authenticated runtime gate, host-registered polling clock, Sync now command, cleanup-safe vault event forwarding, and shared plugin-wide `CalendarEventIndex` projection for standard and Bases views. Root completed and audited the integration after the delegated subagent stalled, including the rename-before-reload fix that prevents false tombstones, local projection refresh with no provider runtime, event-folder reconfiguration, and view-registry cleanup. No network runtime is invented when credentials/client configuration are absent. Root verified 118 tests, build, focused sync lint, diff checks, and the unchanged full-lint baseline of 16 errors and 49 warnings. Obsidian runtime smoke testing remains part of H/I.

### Workstream H — Settings, event editor, status, and conflict UI

Owner: UI subagent  
Dependencies: C, E, and G  
Owned paths: temporary exclusive ownership of `src/settings/SettingsTab.ts`; new modals/components/styles

- [x] Add a desktop-only sync settings tab/section with connection state.
- [x] Add calendar selection, event folder, timezone, interval/horizon, sync-now, reconnect, disconnect, and dry-run controls.
- [x] Add a create/edit event modal using canonical fields.
- [x] Display synchronized events and statuses in day detail while preserving existing actions.
- [x] Add conflict UI showing local and remote values with explicit resolution.
- [x] Add confirmed `Delete synced event` and non-destructive `Disconnect` actions.
- [x] Ensure errors are actionable and redact secrets.

Deletion behavior is fixed: `Delete synced event` first deletes the remote event conditionally. Only after provider confirmation does it move the local note to Obsidian's system trash and retain a sanitized tombstone in sync state. If remote deletion fails, the note is not trashed. `Disconnect` removes the binding and credentials as applicable while preserving both the note and remote event.

Acceptance:

- [ ] User can connect, select a calendar, preview, create/edit, sync now, resolve a conflict, disconnect, and explicitly delete.
- [ ] Mobile retains local calendar behavior and does not expose sync controls.
- [ ] Existing daily-note and range-note workflows are unchanged.
- [ ] UI screenshots or a short recording are captured for review.

Status: `REVIEW` (2026-09-20). The delegated UI package was completed and root-audited. Settings, canonical create/edit, timezone-aware day projection, status badges, conflict choices, non-destructive disconnect, and remote-first confirmed deletion are wired through lifecycle callbacks; Outlook is visibly deferred. Root added explicit-trash, asynchronous calendar-selection, timezone-formatting, and JWT-redaction regressions. Validation passes with 124 tests, production build, clean focused sync/UI lint, `git diff --check`, and the unchanged full-lint baseline of 16 errors and 49 warnings. Native Obsidian computer-use access was not approved, so actual rendering and screenshot/recording evidence remain unverified. A real connect flow also remains unavailable until an injected Google OAuth client/runtime and disposable account are supplied; that live-provider portion belongs to Workstream I.

### Workstream I — Staged Google rollout and live validation

Owner: root orchestrator  
Dependencies: A through H  
External requirements: Google OAuth application registration, redirect/consent configuration, disposable test account/calendar

- [ ] Decide and document the client-ID distribution model: plugin-owned Desktop OAuth client for releases, or an explicitly labeled user/developer-supplied client ID for testing. Do not invent or commit a credential.
- [ ] Add non-secret Google client-ID configuration and validate it without accepting a client secret.
- [ ] Compose `GoogleOAuthProvider`, the loopback listener, system-browser opener, injected HTTP transport, credential store, and `createGoogleSyncService()` behind the desktop runtime factory.
- [ ] Replace the ambiguous first-use `Reconnect` path with a real `Connect` action; retain `Reconnect` for an existing binding/credential.
- [ ] After authorization, discover the stable account, list writable calendars, persist the selected account/calendar binding, and reconstruct the runtime after restart.
- [ ] Add integration tests for first connect, denied/cancelled authorization, missing client ID, reconnect, disconnect/revoke, restart restoration, and calendar-selection persistence.
- [ ] Stage 1: enable authentication, calendar selection, dry-run, and import preview only.
- [ ] Stage 2: enable explicit local create/update; keep remote writes opt-in and deletion disabled.
- [ ] Stage 3: enable remote-to-local updates, conflict resolution, tombstones, restart recovery, and explicit deletion.
- [ ] Complete the manual acceptance matrix below in a throwaway vault/calendar.
- [ ] Record evidence and known limitations before enabling sync by default.

Acceptance: all automated and manual Google checks pass; no data-loss defect remains open.

Status: `TODO`. Runtime composition and first-connect UI are incomplete code work and are not externally blocked. Choosing/providing a real Google Desktop client ID and disposable account blocks only live-provider validation. Keep remote writes disabled while implementing and testing connection assembly.

### Workstream J — Microsoft adapter

Owner: Microsoft-provider subagent  
Dependencies: stable accepted Google engine and UI; A, C, D, and E  
Owned paths: `src/services/sync/providers/microsoft/**` and matching tests

- [ ] Implement public-client PKCE authentication with delegated `Calendars.ReadWrite`.
- [ ] Discover/select a calendar and map the canonical fields.
- [ ] Implement `calendarView/delta` pagination with complete opaque delta-link persistence.
- [ ] Handle Microsoft timezone mapping, change keys, cancellation, throttling, and authorization errors.
- [ ] Reuse the canonical schema, engine, conflict behavior, tombstones, and UI.

Acceptance: the Microsoft adapter passes the common provider contract suite and the same live acceptance matrix as Google.

Status: `TODO — deferred until Google is accepted`

### Final audit and release handoff

Owner: root orchestrator  
Dependencies: desired provider milestone accepted

- [ ] Audit the complete diff and module boundaries.
- [ ] Run all automated and manual validation.
- [ ] Confirm no secrets, generated artifacts, or unrelated files are included.
- [ ] Document OAuth registration, consent/privacy requirements, supported fields, recurrence limitations, and recovery procedures.
- [ ] Update this ledger with evidence, unresolved defects, and exact continuation steps.

Status: `TODO`

## Dependency and concurrency map

```text
Gate 0
  ├─ Gate 1: OAuth/storage feasibility
  └─ Gate 2: test/dependency foundation
       └─ A: canonical domain
            ├─ B: note repository/index
            ├─ C: state/settings/credentials  (also needs Gate 1)
            └─ D: provider contract/fake      (also needs Gate 1)

A + B + C + D
  └─ E: sync engine

A + C + D + stable E contract
  └─ F: Google adapter

B + E + F
  └─ G: lifecycle/index integration

C + E + G
  └─ H: settings/event/conflict UI

A through H
  └─ I: staged Google rollout
       └─ J: Microsoft adapter
```

After Gates 1 and 2, A is the first shared dependency and must be accepted. Root may then parallelize B, C, and D because their ownership is disjoint. No package may invent duplicate canonical or provider-contract types.

## Validation and acceptance strategy

### Automated coverage

- [ ] Frontmatter parse/serialize round trips preserve unknown fields and body content.
- [ ] UUID identity survives rename and filename changes.
- [ ] Timed events preserve RFC 3339 offsets and IANA zones.
- [ ] All-day events use exclusive end dates.
- [ ] DST boundaries, invalid dates, missing fields, duplicate UIDs, and unsupported recurrence are deterministic.
- [ ] Local create, remote import, each update direction, disjoint merge, same-field conflict, remote deletion, local tombstone, reconnect, and restart recovery.
- [ ] Queue debounce, serialization, idempotency, backoff, throttling, offline recovery, cancellation, and feedback-loop suppression.
- [ ] Plugin-data migrations from the current flat shape, older versions, malformed state, and failed migration.
- [ ] OAuth state/PKCE checks, denied consent, timeout/cancel, refresh failure, and secret redaction.
- [ ] Google pagination, `syncToken` expiry, ETag conflict, and relevant error statuses.
- [ ] Microsoft delta-link behavior when that phase begins.

All provider tests use injected transports, fake credentials, and deterministic clocks. Live tests are opt-in and use disposable accounts/calendars.

### Manual acceptance matrix

- [ ] Create one eligible event note; exactly one remote event appears.
- [ ] Edit title, time, timezone, location, and description locally; only supported remote fields change.
- [ ] Edit each supported field remotely; frontmatter updates and body bytes remain unchanged.
- [ ] Rename the note; the same remote event remains linked.
- [ ] Create a remote event; exactly one marked note is imported with no feedback loop.
- [ ] Change different fields on both sides; they merge.
- [ ] Change the same field on both sides; sync stops for that event and records a conflict.
- [ ] Resolve conflicts in both local-wins and remote-wins directions.
- [ ] Delete remotely; note remains and is marked `remote_deleted`.
- [ ] Delete locally; remote event remains until explicit deletion.
- [ ] Disconnect and reconnect; notes and mappings survive.
- [ ] Restart Obsidian; missed changes catch up safely.
- [ ] Go offline, queue work, reconnect, and verify idempotent recovery.
- [ ] Exercise all-day, multi-day, DST-zone, malformed, duplicate-UID, and recurring/unsupported events.
- [ ] Confirm daily notes, range notes, tasks, holidays, normal calendar view, and Bases view are unchanged.
- [ ] Confirm mobile retains local functionality with sync controls hidden.

## Current baseline evidence

Recorded on 2026-09-19/20 before implementation:

- `git status --short`: clean.
- `npm run build`: passes TypeScript checking and production esbuild.
- `./node_modules/.bin/eslint src`: 65 existing findings — 16 errors and 49 warnings.
- No test directory or `npm test` script exists.
- No dependency lockfile exists.
- No OAuth, provider, sync-state, or credential-storage implementation exists.
- `manifest.json` has `isDesktopOnly: false` and should remain mobile-compatible.
- `main.js` is generated and ignored.

Baseline refreshed on 2026-09-20 before Gates 1 and 2:

- `git status --short`: only this untracked implementation-plan handoff was present.
- `npm run build`: passed.
- `./node_modules/.bin/eslint src`: unchanged at 65 existing findings — 16 errors and 49 warnings.

Current implementation evidence after the Workstream H code audit on 2026-09-20:

- `npm test -- --run`: 18 files and 124 tests passed.
- `npm run build`: passed TypeScript checking and the production bundle.
- Focused sync/UI/lifecycle lint: passed with no findings.
- `./node_modules/.bin/eslint src`: unchanged at 65 findings — 16 errors and 49 warnings.
- `git diff --check`: passed.
- Native Obsidian visual validation: not run because computer-use access was not available.
- Live Google OAuth/provider validation: not run because connection assembly and external test configuration are not complete.

Acceptance policy: new sync modules introduce zero lint errors. Existing lint findings must be reported honestly; unrelated cleanup is not required unless a touched line/module makes it necessary.

## External prerequisites and blockers

Live Google validation requires:

- A Google Cloud project with Calendar API enabled.
- A desktop OAuth client ID configured for PKCE/loopback use.
- Consent-screen configuration and appropriate test users.
- A disposable Google account/calendar.
- For public release: owned branding/homepage, privacy policy, terms where applicable, and Google verification for requested scopes.

Live Microsoft validation later requires:

- A Microsoft Entra application registered as a public desktop client.
- Appropriate redirect/public-client configuration and delegated `Calendars.ReadWrite` consent.
- Personal and/or organizational test accounts matching the supported audience.
- A disposable Outlook calendar.

Missing external credentials block live acceptance only. They do not excuse skipped mocked tests or incomplete provider error handling.

## Data safety and recovery

Before first live sync:

- [ ] Use a copied/throwaway vault and dedicated provider calendar.
- [ ] Back up the vault and plugin state.
- [ ] Record the sync-state schema version.
- [ ] Run dry-run/import preview and review the exact affected objects.
- [ ] Require explicit opt-in before enabling remote writes.

If a defect is found:

1. Disable synchronization and stop the queue.
2. Preserve vault and plugin state; do not delete either side.
3. Export diagnostics with tokens and secrets redacted.
4. Restore local mapped fields/body from backup or the last accepted snapshot.
5. Use explicit per-event local/remote resolution rather than a bulk overwrite.
6. Fix and test the failing path with mocks.
7. Re-authenticate only if required.
8. Repeat dry-run/import-only validation before re-enabling writes.

A failed data migration must leave the prior persisted state intact and disable sync. It must not partially rewrite mappings or continue with an unknown state.

## Files and data that must remain untouched by rollout work

- Do not commit generated `main.js`, vault `data.json`, `node_modules/`, OAuth secrets/tokens, or real-account fixtures.
- Do not edit or delete ordinary user notes while assembling authentication or running mocked tests.
- Live validation must use a copied/throwaway vault and disposable provider calendar until all staged gates pass.

## Exact next action for the fresh session

1. Read `AGENTS.md` and this file, then verify Workstreams E through G remain green with:

   ```sh
   npm test
   npm run build
   ./node_modules/.bin/eslint src/services/sync tests/sync vitest.config.ts
   git diff --check
   ```

2. Keep Workstream H in `REVIEW` until the user can manually inspect the Sync settings tab, day-detail event projection, create/edit modal, conflict modal, and destructive confirmations in Obsidian. Provide a short checklist; do not repeatedly request unavailable computer-use authorization.
3. Continue the non-destructive portion of Workstream I by implementing the missing connection assembly in this order:
   1. decide/document the public client-ID distribution model;
   2. add validated non-secret client-ID configuration;
   3. inject the Google OAuth/provider runtime through `setSyncRuntimeFactory()`;
   4. implement first-time `Connect`, existing-account `Reconnect`, calendar discovery/selection, disconnect/revoke, and restart restoration;
   5. cover the complete flow with mocked integration tests.
4. Stop before live authorization if no Google Desktop client ID and disposable test account/calendar are available. Record that portion as `BLOCKED_EXTERNAL`; do not paste secrets into source, settings fixtures, logs, or this plan.
5. When external test configuration becomes available, run Stage 1 in a throwaway vault/calendar using dry-run and import preview only. Review exact affected objects before enabling any provider write. Stages 2 and 3 require separately recorded acceptance evidence.

Do not perform provider writes, migrations, or destructive recovery actions merely because this document exists. Advance only through the recorded gates.
