# Google event-note reconciliation implementation plan

Status: approved for implementation on 2026-10-04. Baseline: `397f1aa`.
Companion: [risk register](event-note-reconciliation-risks.md). This checklist records
accepted implementation work. A checked item means the root agent reviewed its
diff and ran the relevant checks; an agent's completion report alone is not
acceptance.

## Product contract

- Google events remain visible from the remote cache without Markdown notes.
  Import, occurrence expansion, and sync never create a note.
- A user may explicitly create one series note, one whole-occurrence note, or
  notes for selected civil days of a multiday occurrence. A series note may
  coexist with occurrence notes. A whole-occurrence note and day notes cannot
  coexist for the same occurrence without an explicit conversion.
- Note bodies and unrelated frontmatter are local. Google owns mirrored event
  fields. Frontmatter edits do not write to Google; the explicit event editor
  does so only in bidirectional mode.
- `calendar_uid` identifies a local note. Its path, filename, title, and
  displayed date never establish provider identity. No automatic relink by
  similarity is allowed.
- A confirmed Google write remains a successful Google write if later cache or
  note reconciliation fails. The UI reports a separate, persistent local
  repair warning. A lost HTTP response remains outcome-unknown until checked.

## Identity and persistence design

Use a versioned `calendar_note_target` frontmatter object. The target key has
provider, account, calendar, scope, and provider identity:

| Scope | Stable target identity |
| --- | --- |
| Series | Google recurring master event ID |
| One-off occurrence | Google event ID |
| Recurring occurrence | Master ID plus Google's `originalStartTime`, retaining date versus dateTime and recurrence timezone |
| Occurrence day | Occurrence identity plus zero-based event-local civil-day offset |

The current exception ID and ETag belong in the event cache for provider writes,
not in the immutable note target. New notes retain the existing
`calendar_sync.google` association for compatibility, with `event_id` set to
the one-off event or recurring master; target metadata disambiguates scope.
Store a day note's last confirmed civil date and any proposed date separately
from its immutable target. On a move or range change, offer: accept the proposed
date, explicitly choose another valid offset after checking for collisions, or
keep the old confirmed date with an unresolved status. A disappeared recurrence
slot stays an unresolved historical target under its original master.

Frontmatter is the recoverable ownership record. Sync state stores a versioned
cache, complete occurrence generations, cursor, and repair status. On startup,
scan all marked notes, including malformed records as repair candidates. For
duplicate UID or target claimants, quarantine every claimant and show every
path. Never choose the first indexed file. Existing legacy references are
migrated only with verified provider identity: one-off to occurrence, verified
master to series, verified exception to its original slot. Ambiguous links are
left unchanged for explicit repair. Migration is idempotent and preserves bodies.

## Work packages and acceptance gates

### P0 — Durable handoff

- [x] Record the approved contract, work packages, failure behavior, and
  verification gates beside the risk register.
- [x] Keep this ledger updated after each root-accepted package, including
  commands run, remaining risks, and exact next action.

### P1 — Target domain and vault ownership

Owner: bounded note-model implementation agent. Files: target model and
`src/services/sync/notes/*`, with focused tests. Do not edit sync engine,
provider, UI, or shared plan files.

- [x] Define and validate canonical target keys and civil-day offsets; reject
  malformed `originalStartTime` and ambiguous scope.
- [x] Extend codec/repository/index for target metadata, one claimant per
  target, whole/day exclusivity, duplicate quarantine, rename-safe lookup,
  concurrency-safe explicit creation, and crash rediscovery.
- [x] Mirror only owned frontmatter through `processFrontMatter`; preserve
  bodies and unrelated properties. Compute timed dates in the event timezone.
- [x] Add conservative, idempotent legacy classification with unresolved cases.
- [x] Pass focused note-model tests and changed-file lint; root reviews diff.

### P2 — Google occurrence transport

Owner: bounded provider implementation agent. Files:
`src/services/sync/providers/google/*`, provider contracts as agreed with root,
and focused provider tests. Do not edit notes, UI, or sync engine.

- [x] Retain master ID, instance ID, exact `originalStartTime`, actual range,
  cancellation, ETag, and raw recurrence independently of canonical fields.
- [x] Keep unbounded `events.list(singleEvents=false, showDeleted=true)` and
  its incremental cursor; do not add date filters to token requests.
- [x] Add paginated `events.instances` retrieval for a bounded horizon and
  pinned original slots. Stage a complete result before returning it.
- [x] Preserve cancelled instance tombstones with only the guaranteed fields;
  distinguish them from deleted masters and one-off events.
- [x] Add a targeted GET for version/outcome checks and scoped instance edit
  payloads; avoid overwriting master recurrence or local note identity.
- [x] Pass focused mapper/provider tests and changed-file lint; root reviews diff.

### P3 — Cache, cursor, and repair engine

Owner: root integration. Files: sync state, engine, and integration tests.

- [x] Cache recurring masters regardless of their first start date. Coalesce
  regular instances, moved exceptions, and cancelled slots into one read model.
- [x] Track complete occurrence coverage per calendar/master revision/horizon;
  mark it dirty durably before cursor advancement and publish only after all
  instance pages succeed. Retain the last generation as stale on failure.
- [x] Reconcile note targets from frontmatter at startup and after partial
  writes; never turn a horizon miss, incomplete expansion, or malformed note
  into a remote deletion or a new note.
- [x] Return distinct provider-committed/local-repair, provider-conflict, and
  provider-outcome-unknown results. Never repeat a confirmed provider edit for
  a local repair. Refetch on 412; do not auto-resend stale fields.
- [x] Persist a create intent/correlation and verify uncertain POST outcomes
  before retrying, so a lost response cannot silently duplicate Google events.
- [x] Pass engine/state fault-injection and restart tests; root reviews diff.

### P4 — Calendar and note projection

Owner: bounded UI implementation agent after P1/P3 contracts stabilize. Files:
`src/DayDetailView.tsx`, `src/services/IndexService.ts`, calendar view wiring,
`src/main.ts` action wiring, and focused UI tests, as exclusively assigned.

- [x] Give displayed occurrences distinct target keys and provider write keys;
  never pass a generated occurrence to a master edit action.
- [x] Offer explicit series, occurrence, and selected-day note actions; show
  confirmed, stale, cancelled, and unresolved ownership states.
- [x] Exclude every event-owned note from generic Notes, ranges, recurrence,
  and duplicate symbols in both calendar views, even outside the horizon.
- [x] Report Google-save success separately from local-repair warnings.
- [x] Pass focused UI tests; compare changed-file lint with baseline; root reviews diff.

### P5 — Reconciliation actions and integration

Owner: root, with focused delegation after P1–P4.

The following task briefs are ready for bounded agents. Root owns the API
boundary, final diff review, and integrated acceptance. Agents must not commit.

**P5a — local reconciliation transactions.** Own a new focused service in
`src/services/sync/notes/` and its tests; coordinate repository edits with
root before touching `CalendarEventRepository.ts`. Implement a pure preview
result containing old and proposed target/date, every claimant path, provider
evidence status, and exact frontmatter changes. Implement explicit accept-day,
rebind-day, whole/day conversion, relink, and duplicate resolution commands.
Each command must rescan claimants and validate ownership immediately before
writing. A conversion must never delete or overwrite a body. If it needs two
notes, stage a recoverable intent and leave both intact on a partial failure.
Do not call Google APIs or infer a new target from title, path, or date.
Acceptance: restart, conflicting claimant, stale preview, partial frontmatter
write, and body-preservation tests.

**P5b — repair UI.** Own a new modal in `src/modals/`, scoped edits in
`DayDetailView.tsx` and `src/main.ts`, and focused UI tests after P5a's API is
fixed. Expose unresolved and duplicate note paths even when their event row no
longer intersects the old date. Show old and proposed identities and dates and
require an explicit choice for each mutation. Keep Google event editing gated
by bidirectional mode; permit local note repairs in import-only mode. Never
turn a repair click into a provider write. Acceptance: keyboard access,
cancel-without-write, stale-preview feedback, and persistent repair warning in
both calendar views.

**P5c — root integration and adversarial review.** Audit the two agent diffs,
then exercise moved exceptions, cancellations, recurrence re-anchor/split,
range shrink/extension, duplicate target claims, 412, lost responses, restart,
offline and account switching. Check the exact provider call count, note body
bytes, target keys, and visible rows. Run the full gates below. Keep P6 live
checks separate from mocked results.

- [ ] Provide previewed accept-day, rebind-day, representation-conversion,
  manual relink, and duplicate-resolution actions. Recheck uniqueness at write.
- [ ] Verify mode gates: import-only permits local notes; disabled and dry-run
  do not create notes or write Google; bidirectional controls Google edits.
- [x] Run full `npm test`, `npm run build`, `git diff --check`, and changed-file
  ESLint. Report repository-wide baseline lint separately.
- [x] Inspect the integrated diff for unrelated changes, generated artifacts,
  credentials, and secret-shaped literals. Do not commit without instruction.

### P6 — Live verification

- [ ] In a throwaway vault/calendar: verify pathless import; each note scope;
  repeat actions; rename/restart; moved and cancelled instances; range
  move/shrink/extension; recurrence re-anchor and split; 412 conflict;
  disconnect/reconnect; both calendar views; Notes suppression; and each mode.
- [ ] Simulate a local note write failure after a confirmed Google edit and
  observe success plus a repair warning. Capture screenshots or a short UI
  recording. If native/provider access is unavailable, mark this unverified
  and provide a manual checklist rather than claiming validation.

## Failure behavior required for acceptance

| Failure | Expected result |
| --- | --- |
| Moved instance | Same original-slot target; show actual new time. Changed day projection waits for a user choice. |
| Rule re-anchor or split | Preserve series note if master ID stays; unresolved old child slots or new master get no automatic note transfer. |
| Cancelled instance or deleted parent | Preserve all note bodies; affect only the targeted slot, or mark parent and child targets for review. |
| Range shrink or expansion | Out-of-range day notes remain unresolved; expansion creates no notes. |
| Offline, stale cache, or incomplete instance pages | Keep last complete projection marked stale; infer no deletion. |
| File written but state save fails | Rediscover target frontmatter at restart; repair link without a second file. |
| Note write fails after Google 2xx | Report Google saved with local repair pending; retry local work only. |
| HTTP 412 | Fetch latest provider version and present a conflict decision; do not resend stale fields. |
| HTTP response lost | Mark provider outcome unknown and verify before any retry, especially POST. |
| Duplicate or malformed note metadata | Quarantine all claimants, show paths, and block automatic reassignment or overwrite. |

## Current evidence and next action

### Follow-up calendar actions (2026-10-04)

- [x] Commit the current specification and implementation snapshot as
  `d4cccdf` (`wip: add explicit Google event note ownership`). This is a
  checkpoint, not feature completion; P5 repair actions and P6 live checks
  remain open.
- [x] Default new occurrence and selected-day note filenames to
  `YYYY-MM-DD Event title.md`; keep a series note at `Event title.md`.
  Existing filenames and immutable note targets are left intact.
- [x] Replace separate note-scope icons with one note button and a scope
  selection modal. A multiday occurrence also offers its selected-day scope.
- [x] Restore the delete action for one-off events and recurring rows. A
  recurring-row delete explicitly confirms deletion of the whole series; it
  never pretends to delete only that occurrence.
- [x] Cover same-title series/occurrence naming and a later selected-day
  creation with focused repository tests. Production build and full test suite
  pass; native Obsidian behavior remains in P6.
- [x] Hide deleted masters and one-off events from the live calendar projection
  while retaining state tombstones and note bodies. Keep individually cancelled
  occurrence tombstones visible.
- [x] Label synced occurrences as recurring and offer a provider-scoped edit
  choice for the whole series or this occurrence. A series edit opens the
  cached master with its recurrence rule and dirties instance coverage until
  the next complete refresh.
- [x] When deleting a series directly from this plugin, leave child note
  targets unresolved and preserve their bodies. Regression tests cover the
  direct delete, series date PATCH, post-sync recurrence, and projection.
- [x] After a confirmed calendar create, occurrence edit, series edit, or
  delete, request a provider refresh automatically. If an older pull is in
  flight, run a new pull after it; coalesce requests and keep refresh errors
  separate from the confirmed Google write. Verify this with an in-flight
  pull, failed pull, and stop/restart tests before checking this item.
- [ ] Design a separate “this occurrence and future” edit scope before adding
  it to the UI. Google splits the master into an old and new series, so the
  design must cover partial success, exceptions, and explicit note ownership
  across the new master ID. Keep this out of the automatic-refresh change.
- [x] Hide the detail-row create-note icon when a linked note applies to the
  selected date. Make the event name open its one note or offer a path choice
  when several notes apply. Keep additional explicit scopes available from
  the linked name's context menu without reusing the create icon.

Baseline at `397f1aa`: pre-existing untracked `.codex/` and
`docs/event-note-reconciliation-risks.md` were preserved. P1 and P2 were
root-accepted as isolated agent packages. P3 and P4 are root-accepted as
integrated code packages, subject to P5 actions and P6 live verification.
On 2026-10-04, `npm test` passed 231/231 tests, `npm run build` and
`git diff --check` passed. The 23 focused engine tests include cross-account
cache isolation, sparse cancellation, deleted parent, confirmed provider writes
with failed note or state writes, lost POST response, 412, and restart repair.
The 4 focused calendar projection tests pass. Changed-file ESLint has eight
pre-existing `IndexService.ts` errors and 13 warnings; the new hunks add no
reported errors. The integrated diff contains no generated bundle or new
secret-shaped literal; a fixture in an unchanged test already contains such a
pattern. No native Obsidian or live Google check has run.

After the WIP checkpoint, automatic post-write refresh was root-accepted.
The engine queues a new pull behind an older in-flight pull, coalesces saves,
and runs one trailing pull if another save arrives during a refresh. Pull
errors are reported separately from the confirmed Google write. Focused tests
cover older and rejected pulls, coalescing, a failed refresh followed by a
second save, and lifecycle restart. `npm test` passed 238/238 tests,
`npm run build`, `git diff --check`, and changed-file ESLint passed (one
pre-existing warning in `src/main.ts`). Live Obsidian and Google verification
remain open in P6.

The detail-row note action was corrected after the post-write refresh commit.
`npm test` passed 239/239 tests, `npm run build` and `git diff --check`
passed, and changed-file ESLint had no errors (five pre-existing `any`
warnings in `DayDetailView.tsx`). Native Obsidian interaction remains
unverified; check the linked title and context menu in P6.

The next work is P5a's previewed local transaction API, then P5b's repair UI,
then P5c's integration audit. The current UI has no explicit accept/rebind,
representation conversion, manual relink, or duplicate-resolution flow. A
historical day note whose confirmed date is no longer inside the moved event
range is retained in the vault but needs P5b's repair view for in-calendar
discovery. The sparse cancelled-instance display uses a noneditable placeholder
when Google has no event fields; its exact visual behavior needs P6 review.
Do not call the feature complete until P5 is accepted and P6 is reported
honestly. The current snapshot was committed as a clearly marked WIP at the
user's request.
