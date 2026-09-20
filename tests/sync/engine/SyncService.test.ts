import { describe, expect, it } from 'vitest';
import {
	CalendarEventRepository,
	type CalendarEventVault,
	type CalendarVaultFileLike,
} from '../../../src/services/sync/notes';
import { decodeCalendarEventNote, encodeCalendarEventNote, parseFrontmatter, serializeFrontmatter } from '../../../src/services/sync/notes/FrontmatterEventCodec';
import { FakeCalendarProvider, fakeProviderSession } from '../../../src/services/sync/providers/FakeCalendarProvider';
import { throttlingError, transientError } from '../../../src/services/sync/providers/ProviderErrors';
import {
	SyncService,
	type SyncStateStoreLike,
} from '../../../src/services/sync/engine';
import {
	createDefaultSyncState,
	makeSyncStateKey,
	normalizeSyncState,
	type SyncState,
} from '../../../src/services/sync/state';
import type { CalendarEvent } from '../../../src/services/sync/model';
import type { ProviderSession, RemoteCalendarEvent } from '../../../src/services/sync/providers';

const WINDOW = {
	from: '2025-01-01T00:00:00Z',
	to: '2027-01-01T00:00:00Z',
};
const SESSION = fakeProviderSession('google', 'test-account');

function event(uid: string, patch: Partial<CalendarEvent> = {}): CalendarEvent {
	return {
		uid,
		title: uid,
		start: '2026-09-22T09:00:00-05:00',
		end: '2026-09-22T10:00:00-05:00',
		allDay: false,
		timezone: 'America/Bogota',
		location: '',
		description: '',
		...patch,
	};
}

class MemoryVault implements CalendarEventVault {
	readonly files = new Map<string, string>();
	readonly processCalls: string[] = [];

	constructor(initial: Record<string, string> = {}) {
		for (const [path, content] of Object.entries(initial)) this.files.set(path, content);
	}

	getMarkdownFiles(): readonly CalendarVaultFileLike[] {
		return Array.from(this.files.keys()).map(path => ({ path }));
	}

	read(file: CalendarVaultFileLike): string {
		const path = typeof file === 'string' ? file : file.path;
		const content = this.files.get(path);
		if (content === undefined) throw new Error(`Missing ${path}`);
		return content;
	}

	create(path: string, content: string): CalendarVaultFileLike {
		if (this.files.has(path)) throw new Error(`Already exists: ${path}`);
		this.files.set(path, content);
		return { path };
	}

	processFrontMatter(file: CalendarVaultFileLike, processor: (frontmatter: Record<string, unknown>) => void): void {
		const path = typeof file === 'string' ? file : file.path;
		const content = this.read(path);
		const parsed = parseFrontmatter(content);
		const frontmatter = { ...parsed.frontmatter };
		processor(frontmatter);
		this.files.set(path, `---\n${serializeFrontmatter(frontmatter)}---\n${parsed.body}`);
		this.processCalls.push(path);
	}

	rename(file: CalendarVaultFileLike, newPath: string): void {
		const path = typeof file === 'string' ? file : file.path;
		if (this.files.has(newPath)) throw new Error(`Already exists ${newPath}`);
		const content = this.read(path);
		this.files.delete(path);
		this.files.set(newPath, content);
	}
}

class MemoryStateStore implements SyncStateStoreLike {
	state: SyncState = createDefaultSyncState();
	saveCount = 0;

	async load(): Promise<SyncState> {
		return normalizeSyncState(JSON.parse(JSON.stringify(this.state)) as unknown);
	}

	async save(state: SyncState): Promise<void> {
		this.state = normalizeSyncState(JSON.parse(JSON.stringify(state)) as unknown);
		this.saveCount += 1;
	}
}

class AbortAfterCreateRepository extends CalendarEventRepository {
	controller?: AbortController;

	arm(controller: AbortController): void {
		this.controller = controller;
	}

	override async create(...args: Parameters<CalendarEventRepository['create']>): Promise<ReturnType<CalendarEventRepository['create']> extends Promise<infer T> ? T : never> {
		const result = await super.create(...args);
		this.controller?.abort(new Error('cancel after first remote import'));
		return result;
	}
}

class TrackingProvider extends FakeCalendarProvider {
	activeWrites = 0;
	maxActiveWrites = 0;

	private async track<T>(work: () => Promise<T>): Promise<T> {
		this.activeWrites += 1;
		this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites);
		try {
			await new Promise<void>(resolve => setTimeout(resolve, 0));
			return await work();
		} finally {
			this.activeWrites -= 1;
		}
	}

	override createEvent(session: ProviderSession, calendarId: string, value: CalendarEvent, signal?: AbortSignal): Promise<RemoteCalendarEvent> {
		return this.track(() => super.createEvent(session, calendarId, value, signal));
	}

	override updateEvent(session: ProviderSession, calendarId: string, remoteId: string, value: CalendarEvent, expectedVersion?: string, signal?: AbortSignal): Promise<RemoteCalendarEvent> {
		return this.track(() => super.updateEvent(session, calendarId, remoteId, value, expectedVersion, signal));
	}

	override deleteEvent(session: ProviderSession, calendarId: string, remoteId: string, expectedVersion?: string, signal?: AbortSignal): Promise<void> {
		return this.track(() => super.deleteEvent(session, calendarId, remoteId, expectedVersion, signal));
	}
}

class ManualServiceClock {
	private nextId = 1;
	private readonly timers = new Map<number, () => void>();
	private readonly intervals = new Map<number, () => void>();
	readonly now = () => 1_800_000_000_000;

	setTimeout(callback: () => void): number {
		const id = this.nextId++;
		this.timers.set(id, callback);
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.timers.delete(handle as number);
	}

	setInterval(callback: () => void): number {
		const id = this.nextId++;
		this.intervals.set(id, callback);
		return id;
	}

	clearInterval(handle: unknown): void {
		this.intervals.delete(handle as number);
	}

	runNextTimeout(): void {
		const next = this.timers.entries().next().value as [number, () => void] | undefined;
		if (!next) return;
		this.timers.delete(next[0]);
		next[1]();
	}
}

function makeService(
	provider: FakeCalendarProvider,
	vault: MemoryVault,
	store = new MemoryStateStore(),
	mode: 'dry-run' | 'import-only' | 'bidirectional' | 'disabled' = 'bidirectional',
) {
	const repository = new CalendarEventRepository(vault, {
		folder: 'Events',
		uuidFactory: (() => {
			let number = 1;
			return () => `local-${number++}`;
		})(),
	});
	const service = new SyncService({
		provider,
		session: SESSION,
		calendarId: 'primary',
		repository,
		stateStore: store,
		mode,
		window: WINDOW,
		debounceMs: 0,
		retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
	});
	return { repository, service, store };
}

describe('SyncService', () => {
	it('creates local notes remotely once and replays idempotently', async () => {
		const vault = new MemoryVault({
			'Events/Local.md': encodeCalendarEventNote(event('local-1'), {
				body: '\n# keep this body\n',
				unknownFrontmatter: { custom_field: 'retain' },
			}),
		});
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		const { repository, service, store } = makeService(provider, vault);

		const first = await service.syncNow();
		expect(first.remoteCreated).toBe(1);
		expect(provider.getEvents('primary')).toHaveLength(1);
		const second = await service.syncNow();
		expect(second.remoteCreated).toBe(0);
		expect(provider.getEvents('primary')).toHaveLength(1);
		expect(Object.keys(store.state.mappings)).toHaveLength(1);
		expect(repository.getByUid('local-1')?.status).toBe('synced');
	});

	it('serializes all outbound provider writes at one active write', async () => {
		const vault = new MemoryVault({
			'Events/One.md': encodeCalendarEventNote(event('write-one'), { body: 'one' }),
			'Events/Two.md': encodeCalendarEventNote(event('write-two'), { body: 'two' }),
		});
		const provider = new TrackingProvider({ accountId: SESSION.accountId });
		const { service } = makeService(provider, vault);
		await service.syncNow();
		expect(provider.maxActiveWrites).toBe(1);
		expect(provider.getEvents('primary')).toHaveLength(2);
	});

	it('restarts from persisted mappings without recreating a remote event', async () => {
		const vault = new MemoryVault({
			'Events/Restart.md': encodeCalendarEventNote(event('restart-1'), { body: 'body' }),
		});
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		const store = new MemoryStateStore();
		const first = makeService(provider, vault, store);
		await first.service.syncNow();
		const second = makeService(provider, vault, store);
		await second.service.syncNow();
		expect(provider.getCallCount('createEvent')).toBe(1);
		expect(second.repository.list()).toHaveLength(1);
	});

	it('imports remote events, matches by UID, and does not duplicate on replay', async () => {
		const vault = new MemoryVault();
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		provider.seedEvent('primary', event('remote-uid'), { remoteId: 'remote-1' });
		const { repository, service, store } = makeService(provider, vault, new MemoryStateStore(), 'import-only');

		const first = await service.syncNow();
		expect(first.imported).toBe(1);
		expect(repository.list()).toHaveLength(1);
		expect(repository.list()[0].event.uid).not.toBe('remote-uid');
		const second = await service.syncNow();
		expect(second.imported).toBe(0);
		expect(repository.list()).toHaveLength(1);
		expect(Object.keys(store.state.mappings)).toHaveLength(1);
	});

	it('persists an imported UID exactly once on the first bidirectional write', async () => {
		const vault = new MemoryVault();
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		provider.seedEvent('primary', event('provider-placeholder'), {
			remoteId: 'untagged-metadata',
		});
		const store = new MemoryStateStore();
		const importOnly = makeService(provider, vault, store, 'import-only');
		await importOnly.service.syncNow();
		const imported = importOnly.repository.list()[0];
		const key = makeSyncStateKey('google', SESSION.accountId, 'primary', 'local', imported.event.uid);
		expect(store.state.mappings[key]?.calendarUidPersisted).toBe(false);
		expect(provider.getCallCount('updateEvent')).toBe(0);

		const bidirectional = makeService(provider, vault, store, 'bidirectional');
		await bidirectional.service.syncNow();
		expect(provider.getCallCount('updateEvent')).toBe(1);
		expect(provider.getEvent('primary', 'untagged-metadata')?.calendarUid).toBe(imported.event.uid);
		expect(store.state.mappings[key]?.calendarUidPersisted).toBe(true);

		await bidirectional.service.syncNow();
		expect(provider.getCallCount('updateEvent')).toBe(1);
	});

	it('uses only private calendarUid for matching and stops tagged mapping collisions', async () => {
		const vault = new MemoryVault({
			'Events/Existing.md': encodeCalendarEventNote(event('same-uid', { title: 'Keep local' }), { body: 'local' }),
		});
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		provider.seedEvent('primary', event('same-uid', { title: 'Untagged remote' }), {
			remoteId: 'untagged-remote',
		});
		const importOnly = makeService(provider, vault, new MemoryStateStore(), 'import-only');
		await importOnly.service.syncNow();
		expect(importOnly.repository.list()).toHaveLength(2);
		expect(importOnly.repository.getByUid('same-uid')?.event.title).toBe('Keep local');

		const taggedProvider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		const taggedVault = new MemoryVault({
			'Events/Tagged.md': encodeCalendarEventNote(event('tagged-local'), { body: 'local' }),
		});
		const tagged = makeService(taggedProvider, taggedVault);
		await tagged.service.syncNow();
		const existingRemote = taggedProvider.getEvents('primary')[0];
		taggedProvider.seedEvent('primary', event('provider-placeholder', { title: 'Conflicting tagged event' }), {
			remoteId: 'different-remote',
			calendarUid: 'tagged-local',
		});
		const collisionRun = await tagged.service.syncNow();
		expect(collisionRun.conflicts[0]).toContain('tagged-local');
		expect(tagged.repository.getByUid('tagged-local')?.event.title).toBe('tagged-local');
		expect(tagged.repository.getByUid('tagged-local')?.status).toBe('conflict');
		expect(taggedProvider.getEvent('primary', existingRemote.remoteId)?.event.title).toBe('tagged-local');
	});

	it('updates only frontmatter through the repository and preserves body/unknown fields', async () => {
		const body = '\r\n# local body\r\n\r\n- [ ] untouched\r\n';
		const vault = new MemoryVault({
			'Events/Keep.md': encodeCalendarEventNote(event('local-2'), {
				body,
				unknownFrontmatter: { custom_field: 'keep', nested: { source: 'test' } },
			}),
		});
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		const { service } = makeService(provider, vault);
		await service.syncNow();
		const path = 'Events/Keep.md';
		const before = decodeCalendarEventNote(vault.files.get(path) ?? '');
		const storedRemote = provider.getEvents('primary')[0];
		await provider.updateEvent(SESSION, 'primary', storedRemote.remoteId, {
			...storedRemote.event,
			title: 'Remote title',
		}, storedRemote.version);
		await service.syncNow();

		const after = decodeCalendarEventNote(vault.files.get(path) ?? '');
		expect(after.note?.event.title).toBe('Remote title');
		expect(after.note?.body).toBe(body);
		expect(after.note?.frontmatter.custom_field).toBe('keep');
		expect(after.note?.frontmatter.nested).toEqual({ source: 'test' });
		expect(vault.processCalls).toContain(path);
		expect(before.note?.body).toBe(body);
	});

	it('follows a local rename by UID without creating or updating a remote event', async () => {
		const vault = new MemoryVault({
			'Events/Before.md': encodeCalendarEventNote(event('rename-1'), { body: 'body' }),
		});
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		const { repository, service, store } = makeService(provider, vault);
		await service.syncNow();
		const remoteBefore = provider.getEvents('primary')[0];
		await repository.rename('Events/Before.md', 'After.md');
		await service.syncNow();

		expect(provider.getCallCount('createEvent')).toBe(1);
		expect(provider.getCallCount('updateEvent')).toBe(0);
		const key = makeSyncStateKey('google', SESSION.accountId, 'primary', 'local', 'rename-1');
		expect(store.state.mappings[key]?.notePath).toBe('Events/After.md');
		expect(store.state.tombstones[key]).toBeUndefined();
		expect(provider.getEvent('primary', remoteBefore.remoteId)?.event.uid).toBe('rename-1');
	});

	it('merges disjoint local and remote edits and persists same-field conflicts', async () => {
		const vault = new MemoryVault({
			'Events/Merge.md': encodeCalendarEventNote(event('merge-1'), { body: 'body' }),
		});
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		const { repository, service } = makeService(provider, vault);
		await service.syncNow();
		const original = provider.getEvents('primary')[0];
		vault.files.set('Events/Merge.md', encodeCalendarEventNote(event('merge-1', { title: 'Local title' }), { body: 'body' }));
		await provider.updateEvent(SESSION, 'primary', original.remoteId, {
			...original.event,
			description: 'Remote description',
		}, original.version);
		await service.syncNow();
		expect(repository.getByUid('merge-1')?.event).toMatchObject({
			title: 'Local title',
			description: 'Remote description',
		});
		expect(provider.getEvent('primary', original.remoteId)?.event).toMatchObject({
			title: 'Local title',
			description: 'Remote description',
		});

		const mergedRemote = provider.getEvent('primary', original.remoteId);
		vault.files.set('Events/Merge.md', encodeCalendarEventNote(event('merge-1', { title: 'Local conflict' }), { body: 'body' }));
		await provider.updateEvent(SESSION, 'primary', mergedRemote?.remoteId ?? original.remoteId, {
			...(mergedRemote?.event ?? original.event),
			title: 'Remote conflict',
		}, mergedRemote?.version);
		const conflictRun = await service.syncNow();
		expect(conflictRun.conflicts.length).toBe(1);
		expect(service.conflicts).toHaveLength(1);
		expect(repository.getByUid('merge-1')?.status).toBe('conflict');
	});

	it('keeps actual remote snapshots in import-only mode for a later bidirectional upload', async () => {
		const vault = new MemoryVault({
			'Events/Mode.md': encodeCalendarEventNote(event('mode-1'), { body: 'body' }),
		});
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		const store = new MemoryStateStore();
		const initial = makeService(provider, vault, store, 'bidirectional');
		await initial.service.syncNow();
		const original = provider.getEvents('primary')[0];
		vault.files.set('Events/Mode.md', encodeCalendarEventNote(event('mode-1', { title: 'Local title' }), { body: 'body' }));
		await provider.updateEvent(SESSION, 'primary', original.remoteId, {
			...original.event,
			description: 'Remote description',
		}, original.version);

		const importOnly = makeService(provider, vault, store, 'import-only');
		await importOnly.service.syncNow();
		const key = makeSyncStateKey('google', SESSION.accountId, 'primary', 'local', 'mode-1');
		const importSnapshots = store.state.snapshots[key] as { local?: { event: CalendarEvent }; remote?: { event: CalendarEvent } };
		expect(importSnapshots.local?.event.title).toBe('Local title');
		expect(importSnapshots.remote?.event.title).toBe('mode-1');
		expect(importSnapshots.remote?.event.description).toBe('Remote description');
		expect(store.state.mappings[key]?.status).toBe('pending');

		const bidirectional = makeService(provider, vault, store, 'bidirectional');
		await bidirectional.service.syncNow();
		expect(provider.getEvent('primary', original.remoteId)?.event).toMatchObject({
			title: 'Local title',
			description: 'Remote description',
		});
		expect(store.state.mappings[key]?.status).toBe('synced');
	});

	it('resolves a stored conflict without rewriting the Markdown body', async () => {
		const body = '\n# preserve me\n';
		const vault = new MemoryVault({
			'Events/Conflict.md': encodeCalendarEventNote(event('conflict-1'), { body }),
		});
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		const { repository, service } = makeService(provider, vault);
		await service.syncNow();
		const original = provider.getEvents('primary')[0];
		vault.files.set('Events/Conflict.md', encodeCalendarEventNote(event('conflict-1', { title: 'Local' }), { body }));
		await provider.updateEvent(SESSION, 'primary', original.remoteId, {
			...original.event,
			title: 'Remote',
		}, original.version);
		await service.syncNow();
		const conflict = service.conflicts[0];
		const providerUpdatesBeforeResolution = provider.getCallCount('updateEvent');
		const resolved = await service.resolveConflict(conflict.key, 'remote');
		const note = repository.getByUid('conflict-1');
		expect(resolved.status).toBe('resolved');
		expect(note?.event.title).toBe('Remote');
		expect(note?.status).toBe('synced');
		expect(provider.getCallCount('updateEvent')).toBe(providerUpdatesBeforeResolution);
		expect(decodeCalendarEventNote(vault.files.get('Events/Conflict.md') ?? '').note?.body).toBe(body);
		expect(service.conflicts).toHaveLength(0);
	});

	it('resolves remote-wins and local-wins conflicts directionally in import-only mode', async () => {
		const vault = new MemoryVault({
			'Events/Direction.md': encodeCalendarEventNote(event('direction-1'), { body: 'body' }),
		});
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		const store = new MemoryStateStore();
		const initial = makeService(provider, vault, store);
		await initial.service.syncNow();
		const original = provider.getEvents('primary')[0];
		vault.files.set('Events/Direction.md', encodeCalendarEventNote(event('direction-1', { title: 'Local one' }), { body: 'body' }));
		await provider.updateEvent(SESSION, 'primary', original.remoteId, {
			...original.event,
			title: 'Remote one',
		}, original.version);
		const importOnly = makeService(provider, vault, store, 'import-only');
		await importOnly.service.syncNow();
		const key = importOnly.service.conflicts[0].key;
		const callsBeforeRemoteWin = provider.getCallCount('updateEvent');
		await importOnly.service.resolveConflict(key, 'remote');
		expect(provider.getCallCount('updateEvent')).toBe(callsBeforeRemoteWin);
		expect(store.state.mappings[key]?.status).toBe('synced');

		const remoteAfterResolution = provider.getEvent('primary', original.remoteId);
		vault.files.set('Events/Direction.md', encodeCalendarEventNote(event('direction-1', { title: 'Local two' }), { body: 'body' }));
		await provider.updateEvent(SESSION, 'primary', original.remoteId, {
			...(remoteAfterResolution?.event ?? original.event),
			title: 'Remote two',
		}, remoteAfterResolution?.version);
		await importOnly.service.syncNow();
		const localWinKey = importOnly.service.conflicts[0].key;
		const callsBeforeLocalWin = provider.getCallCount('updateEvent');
		await importOnly.service.resolveConflict(localWinKey, 'local');
		expect(provider.getCallCount('updateEvent')).toBe(callsBeforeLocalWin);
		expect(store.state.mappings[localWinKey]?.status).toBe('pending');
		const snapshots = store.state.snapshots[localWinKey] as { local?: { event: CalendarEvent }; remote?: { event: CalendarEvent } };
		expect(snapshots.local?.event.title).toBe('Local two');
		expect(snapshots.remote?.event.title).toBe('Remote two');

		const bidirectional = makeService(provider, vault, store, 'bidirectional');
		await bidirectional.service.syncNow();
		expect(provider.getEvent('primary', original.remoteId)?.event.title).toBe('Local two');
	});

	it('marks remote deletion without deleting the local note and records a tombstone', async () => {
		const vault = new MemoryVault();
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		provider.seedEvent('primary', event('remote-delete'), { remoteId: 'remote-delete-1' });
		const { repository, service, store } = makeService(provider, vault, new MemoryStateStore(), 'import-only');
		await service.syncNow();
		const imported = repository.list()[0];
		const mapping = Object.entries(store.state.mappings)[0];
		const remote = provider.getEvent('primary', 'remote-delete-1');
		await provider.deleteEvent(SESSION, 'primary', 'remote-delete-1', remote?.version);
		await service.syncNow();
		expect(repository.getByUid(imported.event.uid)?.status).toBe('remote_deleted');
		expect(repository.getByUid(imported.event.uid)).toBeDefined();
		expect(store.state.mappings[mapping[0]].status).toBe('remote_deleted');
		expect(store.state.tombstones[mapping[0]]?.reason).toBe('remote-delete');
	});

	it('emits local-deletion state before mapping loss and never deletes the remote event implicitly', async () => {
		const vault = new MemoryVault({
			'Events/Delete.md': encodeCalendarEventNote(event('local-delete'), { body: 'body' }),
		});
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		const { repository, service, store } = makeService(provider, vault);
		await service.syncNow();
		const remote = provider.getEvents('primary')[0];
		const path = 'Events/Delete.md';
		repository.notifyLocalDeletion(path);
		await service.syncNow();
		const key = makeSyncStateKey('google', SESSION.accountId, 'primary', 'local', 'local-delete');
		expect(store.state.tombstones[key]?.reason).toBe('local-delete');
		expect(store.state.mappings[key]?.status).toBe('local_deleted');
		expect(provider.getEvent('primary', remote.remoteId)).toBeDefined();
	});

	it('requires a local note and trash capability before explicit remote deletion', async () => {
		const vault = new MemoryVault({
			'Events/NoTrash.md': encodeCalendarEventNote(event('no-trash'), { body: 'body' }),
		});
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		const { service } = makeService(provider, vault);
		await service.syncNow();
		const deleted = await service.deleteSyncedEvent('no-trash');
		expect(deleted).toBe(false);
		expect(provider.getCallCount('deleteEvent')).toBe(0);
	});

	it('queues explicit deletion, trashes after provider confirmation, and persists a tombstone', async () => {
		const vault = new MemoryVault({
			'Events/Trash.md': encodeCalendarEventNote(event('trash-1'), { body: 'body' }),
		});
		const provider = new TrackingProvider({ accountId: SESSION.accountId });
		const { repository, service, store } = makeService(provider, vault);
		await service.syncNow();
		const trashRepository = repository as CalendarEventRepository & { trash(path: string): Promise<void> };
		trashRepository.trash = async path => {
			vault.files.delete(path);
			repository.notifyLocalDeletion(path);
		};
		const deleted = await service.deleteSyncedEvent('trash-1');
		const key = makeSyncStateKey('google', SESSION.accountId, 'primary', 'local', 'trash-1');
		expect(deleted).toBe(true);
		expect(provider.getCallCount('deleteEvent')).toBe(1);
		expect(store.state.tombstones[key]?.reason).toBe('explicit-delete');
		expect(provider.getEvents('primary')).toHaveLength(0);
	});

	it('reports a failed trash attempt as incomplete while retaining the sanitized tombstone', async () => {
		const vault = new MemoryVault({
			'Events/TrashFailure.md': encodeCalendarEventNote(event('trash-failure'), { body: 'body' }),
		});
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		const { repository, service, store } = makeService(provider, vault);
		await service.syncNow();
		const trashRepository = repository as CalendarEventRepository & { trash(path: string): Promise<void> };
		trashRepository.trash = async () => { throw new Error('vault trash failed'); };
		const deleted = await service.deleteSyncedEvent('trash-failure');
		const key = makeSyncStateKey('google', SESSION.accountId, 'primary', 'local', 'trash-failure');
		expect(deleted).toBe(false);
		expect(provider.getCallCount('deleteEvent')).toBe(1);
		expect(store.state.tombstones[key]).toMatchObject({ reason: 'explicit-delete', remoteEventId: expect.any(String) });
		expect(store.state.tombstones[key]).not.toHaveProperty('error');
	});

	it('recovers from cursor expiry with a full resync and retries transient pulls', async () => {
		let now = 1_000;
		const provider = new FakeCalendarProvider({
			accountId: SESSION.accountId,
			cursorTtlMs: 100,
			clock: { now: () => now },
		});
		const vault = new MemoryVault();
		const store = new MemoryStateStore();
		const { repository, service } = makeService(provider, vault, store, 'import-only');
		provider.seedEvent('primary', event('cursor-one'), { remoteId: 'cursor-one' });
		await service.syncNow();
		const cursorKey = makeSyncStateKey('google', SESSION.accountId, 'primary');
		const rawCursor = store.state.cursors[cursorKey];
		const cursor = typeof rawCursor === 'string' ? rawCursor : rawCursor?.cursor;
		expect(cursor).toEqual(expect.any(String));
		provider.expireCursor(cursor as string);
		now = 2_000;
		provider.seedEvent('primary', event('cursor-two'), { remoteId: 'cursor-two' });
		provider.failNext('pullChanges', throttlingError('temporary', 0));
		const result = await service.syncNow();
		expect(result.fullResync).toBe(true);
		expect(repository.list()).toHaveLength(2);
		expect(provider.getCallCount('pullChanges')).toBeGreaterThanOrEqual(4);
	});

	it('checkpoints each imported remote change before advancing the page cursor', async () => {
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId, pageSize: 2 });
		provider.seedEvent('primary', event('remote-one'), { remoteId: 'remote-one' });
		provider.seedEvent('primary', event('remote-two'), { remoteId: 'remote-two' });
		const vault = new MemoryVault();
		const repository = new AbortAfterCreateRepository(vault, {
			folder: 'Events',
			uuidFactory: (() => {
				let number = 1;
				return () => `checkpoint-${number++}`;
			})(),
		});
		const store = new MemoryStateStore();
		const service = new SyncService({
			provider,
			session: SESSION,
			calendarId: 'primary',
			repository,
			stateStore: store,
			mode: 'import-only',
			window: WINDOW,
			debounceMs: 0,
			retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
		});
		const controller = new AbortController();
		repository.arm(controller);
		const cancelled = await service.syncNow('manual', controller.signal);
		expect(cancelled.status).toBe('cancelled');
		expect(repository.list()).toHaveLength(1);
		expect(Object.keys(store.state.mappings)).toHaveLength(1);
		const cursorKey = makeSyncStateKey('google', SESSION.accountId, 'primary');
		expect(store.state.cursors[cursorKey]).toBeUndefined();

		repository.controller = undefined;
		const replay = await service.syncNow();
		expect(replay.status).toBe('idle');
		expect(repository.list()).toHaveLength(2);
		expect(Object.keys(store.state.mappings)).toHaveLength(2);
	});

	it('honors disabled, dry-run, and import-only gates without turning failures into deletions', async () => {
		const vault = new MemoryVault({
			'Events/Gated.md': encodeCalendarEventNote(event('gated'), { body: 'body' }),
		});
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		const disabled = makeService(provider, vault, new MemoryStateStore(), 'disabled');
		expect((await disabled.service.syncNow()).status).toBe('disabled');
		expect(provider.getCallCount()).toBe(0);

		const dryRun = makeService(provider, vault, new MemoryStateStore(), 'dry-run');
		expect((await dryRun.service.syncNow()).status).toBe('dry-run');
		expect(provider.getEvents('primary')).toHaveLength(0);

		provider.failNext('pullChanges', throttlingError('offline', 0));
		const importOnly = makeService(provider, new MemoryVault(), new MemoryStateStore(), 'import-only');
		const result = await importOnly.service.syncNow();
		expect(result.status).toBe('idle');
		expect(importOnly.service.status.lastError).toBeUndefined();
	});

	it('surfaces cancellation during retry backoff and cleans up the external abort bridge', async () => {
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		provider.failNext('pullChanges', transientError('retry later'));
		const vault = new MemoryVault();
		const store = new MemoryStateStore();
		const clock = new ManualServiceClock();
		const repository = new CalendarEventRepository(vault, { folder: 'Events' });
		const service = new SyncService({
			provider,
			session: SESSION,
			calendarId: 'primary',
			repository,
			stateStore: store,
			mode: 'import-only',
			window: WINDOW,
			clock,
			retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 100 },
		});
		const controller = new AbortController();
		const pending = service.syncNow('manual', controller.signal);
		for (let index = 0; index < 10; index += 1) await Promise.resolve();
		expect(provider.getCallCount('pullChanges')).toBe(1);
		controller.abort(new Error('user cancelled'));
		const result = await pending;
		expect(result.status).toBe('cancelled');
		expect(result.error).toContain('cancel');
		// A later run gets a fresh bridge and is not cancelled by the prior signal.
		const later = await service.syncNow();
		expect(later.status).toBe('idle');
	});
});
