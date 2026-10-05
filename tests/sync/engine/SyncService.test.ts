import { describe, expect, it } from 'vitest';
import {
	CalendarEventRepository,
	type CalendarEventVault,
	type CalendarVaultFileLike,
} from '../../../src/services/sync/notes';
import { decodeCalendarEventNote, parseFrontmatter, serializeFrontmatter } from '../../../src/services/sync/notes/FrontmatterEventCodec';
import { FakeCalendarProvider, fakeProviderSession } from '../../../src/services/sync/providers/FakeCalendarProvider';
import type { ListInstancesRequest, RemoteCalendarEvent, RemoteEventLookupResult, RemoteOccurrence, ProviderSession, UpdateOccurrenceRequest } from '../../../src/services/sync/providers/CalendarProvider';
import { cursorExpiredError, transientError } from '../../../src/services/sync/providers/ProviderErrors';
import { ProviderOutcomeUnknownError, ProviderWriteConflictError, SyncService, type SyncStateStoreLike } from '../../../src/services/sync/engine';
import { createDefaultSyncState, makeSyncStateKey, normalizeSyncState, type SyncState } from '../../../src/services/sync/state';
import type { CalendarEvent } from '../../../src/services/sync/model';

const WINDOW = { from: '2025-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' };
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
	failNextProcess = false;

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
		if (this.failNextProcess) {
			this.failNextProcess = false;
			throw new Error('injected frontmatter failure');
		}
		const path = typeof file === 'string' ? file : file.path;
		const parsed = parseFrontmatter(this.read(path));
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
	failNextSave = false;

	async load(): Promise<SyncState> {
		return normalizeSyncState(JSON.parse(JSON.stringify(this.state)) as unknown);
	}

	async save(state: SyncState): Promise<void> {
		if (this.failNextSave) {
			this.failNextSave = false;
			throw new Error('injected state write failure');
		}
		this.state = normalizeSyncState(JSON.parse(JSON.stringify(state)) as unknown);
		this.saveCount += 1;
	}
}

class HidingFullResyncProvider extends FakeCalendarProvider {
	hiddenRemoteId?: string;

	override pullChanges(request: Parameters<FakeCalendarProvider['pullChanges']>[0]) {
		return super.pullChanges(request).then(page => {
			if (!this.hiddenRemoteId || request.cursor !== undefined) return page;
			return {
				...page,
				changes: page.changes.filter(change => {
					const remoteId = change.type === 'upsert'
						? change.value.remoteId
						: change.type === 'delete' ? change.remoteId
							: change.type === 'occurrence-cancelled' ? change.occurrence.instanceRemoteId : change.masterRemoteId;
					return remoteId !== this.hiddenRemoteId;
				}),
			};
		});
	}
}

class ExceptionGuardProvider extends FakeCalendarProvider {
	private reportException = true;

	override pullChanges(request: Parameters<FakeCalendarProvider['pullChanges']>[0]) {
		return super.pullChanges(request).then(page => {
			if (!this.reportException) return page;
			this.reportException = false;
			return {
				...page,
				changes: [
					...page.changes,
					{ type: 'series-unsupported' as const, providerId: 'google' as const, calendarId: request.calendarId, masterRemoteId: 'exception-series' },
				],
			};
		});
	}
}

class UnboundedPullProvider extends FakeCalendarProvider {
	override pullChanges(request: Parameters<FakeCalendarProvider['pullChanges']>[0]) {
		return super.pullChanges({
			...request,
			window: { from: '1900-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' },
		});
	}
}

class InstanceProvider extends UnboundedPullProvider {
	instances: RemoteOccurrence[] = [];
	failInstances = false;

	async listInstances(_request: ListInstancesRequest): Promise<RemoteOccurrence[]> {
		if (this.failInstances) throw transientError('instance expansion unavailable');
		return this.instances;
	}
}

class EditableInstanceProvider extends InstanceProvider {
	updateCalls = 0;

	async updateOccurrence(request: UpdateOccurrenceRequest): Promise<Extract<RemoteOccurrence, { readonly status: 'active' }>> {
		this.updateCalls += 1;
		const existing = this.instances.find((value): value is Extract<RemoteOccurrence, { readonly status: 'active' }> =>
			value.status === 'active' && value.instanceRemoteId === request.instanceRemoteId);
		if (!existing) throw new Error('Missing test occurrence');
		const updated: Extract<RemoteOccurrence, { readonly status: 'active' }> = {
			...existing,
			event: { ...existing.event, event: request.event, version: 'v2' },
			actualStart: { dateTime: request.event.start, timeZone: request.event.timezone },
			actualEnd: { dateTime: request.event.end, timeZone: request.event.timezone },
			version: 'v2',
		};
		this.instances = this.instances.map(value => value.instanceRemoteId === updated.instanceRemoteId ? updated : value);
		return updated;
	}
}

class LostCreateResponseProvider extends FakeCalendarProvider {
	posts = 0;

	override async createEvent(
		_session: ProviderSession, calendarId: string, value: CalendarEvent,
		_signal?: AbortSignal, requestId?: string,
	): Promise<RemoteCalendarEvent> {
		if (!requestId) throw new Error('Expected a stable request ID');
		this.posts += 1;
		this.seedEvent(calendarId, value, { remoteId: requestId });
		throw transientError('response lost after Google accepted POST');
	}

	async fetchEvent(_session: ProviderSession, calendarId: string, remoteId: string): Promise<RemoteEventLookupResult> {
		const found = this.getEvent(calendarId, remoteId);
		return found
			? { status: 'active', event: found }
			: { status: 'not-found', providerId: this.id, calendarId, remoteId };
	}
}

class UnavailableLookupProvider extends FakeCalendarProvider {
	async fetchEvent(): Promise<RemoteEventLookupResult> {
		throw transientError('targeted lookup unavailable');
	}
}

class ExpiringCursorOnceProvider extends FakeCalendarProvider {
	readonly seenCursors: Array<string | undefined> = [];
	private didExpire = false;

	override pullChanges(request: Parameters<FakeCalendarProvider['pullChanges']>[0]) {
		this.seenCursors.push(request.cursor);
		if (request.cursor && !this.didExpire) {
			this.didExpire = true;
			return Promise.reject(cursorExpiredError('Legacy Google cursor must be replaced', {
				providerId: 'google',
				code: 'invalid-google-cursor',
			}));
		}
		return super.pullChanges(request);
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
		retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
	});
	return { repository, service, store };
}

describe('SyncService remote event cache', () => {
	it('checks an uncertain create by its persisted request ID before any second POST', async () => {
		const provider = new LostCreateResponseProvider({ accountId: SESSION.accountId });
		const { service, store } = makeService(provider, new MemoryVault());
		const draft = event('create-once');
		await expect(service.createCalendarEvent(draft)).rejects.toBeInstanceOf(ProviderOutcomeUnknownError);
		expect(provider.posts).toBe(1);
		expect(Object.values(store.state.providerCreateIntents)[0]?.status).toBe('unknown');

		const recovered = await service.createCalendarEvent(draft);
		expect(recovered.event.uid).toBe(draft.uid);
		expect(provider.posts).toBe(1);
		expect(Object.values(store.state.providerCreateIntents)[0]?.status).toBe('confirmed');
	});

	it('keeps an old recurring master and its last complete instance generation when refresh fails', async () => {
		const provider = new InstanceProvider({ accountId: SESSION.accountId });
		const master = provider.seedEvent('primary', event('series-uid', {
			start: '2020-01-01T09:00:00-05:00', end: '2020-01-01T10:00:00-05:00',
			recurrence: { frequency: 'weekly', interval: 1 },
		}), { remoteId: 'old-series' });
		const slot = { dateTime: '2026-09-23T09:00:00-05:00', timeZone: 'America/Bogota' };
		provider.instances = [{
			status: 'active', providerId: 'google', calendarId: 'primary',
			masterRemoteId: 'old-series', instanceRemoteId: 'instance-1', originalStartTime: slot,
			actualStart: slot, actualEnd: { dateTime: '2026-09-23T10:00:00-05:00', timeZone: 'America/Bogota' },
			event: { ...master, remoteId: 'instance-1', recurrenceMasterId: 'old-series', originalStartTime: slot,
				event: event('instance-uid', { start: slot.dateTime, end: '2026-09-23T10:00:00-05:00', recurrence: undefined }) },
		}];
		const store = new MemoryStateStore();
		const { service } = makeService(provider, new MemoryVault(), store);
		await service.syncNow();
		const masterKey = makeSyncStateKey('google', SESSION.accountId, 'primary', 'old-series');
		expect(store.state.remoteEvents[masterKey]).toBeDefined();
		expect(Object.values(store.state.remoteOccurrences)).toHaveLength(1);
		expect(Object.values(store.state.occurrenceCoverage)[0]?.dirty).toBe(false);

		provider.failInstances = true;
		await provider.updateEvent(SESSION, 'primary', 'old-series', { ...master.event, title: 'Changed rule title' }, master.version);
		const refresh = await service.syncNow();
		expect(refresh.status).toBe('offline');
		expect(Object.values(store.state.remoteOccurrences)).toHaveLength(1);
		expect(Object.values(store.state.occurrenceCoverage)[0]?.dirty).toBe(true);
	});

	it('keeps a created recurring master editable after sync and refreshes its instances after a series date change', async () => {
		const provider = new InstanceProvider({ accountId: SESSION.accountId });
		const { service, store } = makeService(provider, new MemoryVault());
		const created = await service.createCalendarEvent(event('editable-series', {
			recurrence: { frequency: 'daily', interval: 1, count: 3 },
		}));
		const remoteMaster = provider.getEvent('primary', created.remoteEventId);
		if (!remoteMaster) throw new Error('Expected the newly created recurring master');
		const slot = { dateTime: '2026-09-22T09:00:00-05:00', timeZone: 'America/Bogota' };
		provider.instances = [{
			status: 'active', providerId: 'google', calendarId: 'primary', masterRemoteId: created.remoteEventId,
			instanceRemoteId: 'series-instance', originalStartTime: slot, actualStart: slot,
			actualEnd: { dateTime: '2026-09-22T10:00:00-05:00', timeZone: 'America/Bogota' },
			event: { ...remoteMaster, remoteId: 'series-instance',
				recurrenceMasterId: created.remoteEventId, originalStartTime: slot,
				event: event('instance', { recurrence: undefined }) },
		}];
		await service.syncNow();
		expect(store.state.remoteEvents[created.key]?.event.recurrence).toMatchObject({ frequency: 'daily', count: 3 });
		expect(Object.values(store.state.remoteOccurrences)).toHaveLength(1);
		const changed = {
			...store.state.remoteEvents[created.key].event,
			start: '2026-09-23T09:00:00-05:00', end: '2026-09-23T10:00:00-05:00',
		};
		await service.updateCalendarEvent(created.key, changed);
		expect(store.state.remoteEvents[created.key]?.event.recurrence).toMatchObject({ frequency: 'daily', count: 3 });
		expect(Object.values(store.state.occurrenceCoverage)[0]?.dirty).toBe(true);
		await service.syncNow();
		expect(Object.values(store.state.occurrenceCoverage)[0]?.dirty).toBe(false);
	});

	it('does not delete another account’s occurrence rows while refreshing a shared master ID', async () => {
		const provider = new InstanceProvider({ accountId: SESSION.accountId });
		provider.seedEvent('primary', event('series', { recurrence: { frequency: 'daily', interval: 1 } }), { remoteId: 'shared-master' });
		const store = new MemoryStateStore();
		const otherKey = makeSyncStateKey('google', 'other-account', 'primary', 'occurrence', 'shared-master', 'old-slot');
		store.state.remoteOccurrences[otherKey] = {
			providerId: 'google', accountId: 'other-account', calendarId: 'primary',
			masterRemoteId: 'shared-master', instanceRemoteId: 'other-instance',
			originalStartTime: { dateTime: '2026-09-22T09:00:00-05:00', timeZone: 'America/Bogota' },
			cancelled: false, unresolved: false,
		};
		const { service } = makeService(provider, new MemoryVault(), store);
		await service.syncNow();
		expect(store.state.remoteOccurrences[otherKey]?.instanceRemoteId).toBe('other-instance');
	});

	it('keeps a cancelled slot note and its body when the tombstone has no event fields', async () => {
		const provider = new InstanceProvider({ accountId: SESSION.accountId });
		const master = provider.seedEvent('primary', event('series', { recurrence: { frequency: 'daily', interval: 1 } }), { remoteId: 'series-cancel' });
		const slot = { dateTime: '2026-09-22T09:00:00-05:00', timeZone: 'America/Bogota' };
		provider.instances = [{
			status: 'active', providerId: 'google', calendarId: 'primary', masterRemoteId: 'series-cancel',
			instanceRemoteId: 'instance-cancel', originalStartTime: slot, actualStart: slot,
			actualEnd: { dateTime: '2026-09-22T10:00:00-05:00', timeZone: 'America/Bogota' },
			event: { ...master, remoteId: 'instance-cancel', recurrenceMasterId: 'series-cancel', originalStartTime: slot,
				event: event('instance', { recurrence: undefined }) },
		}];
		const vault = new MemoryVault();
		const { service, repository, store } = makeService(provider, vault);
		await service.syncNow();
		const note = await repository.createForTarget(event('local-note'), {
			version: 1, providerId: 'google', accountId: SESSION.accountId, calendarId: 'primary',
			scope: 'occurrence', occurrence: { kind: 'recurrence', masterEventId: 'series-cancel', originalStartTime: slot },
		}, { providerId: 'google', accountId: SESSION.accountId, calendarId: 'primary', remoteEventId: 'series-cancel' },
		{ body: '\n# Kept body\n' });
		provider.instances = [{
			status: 'cancelled', providerId: 'google', calendarId: 'primary', masterRemoteId: 'series-cancel',
			instanceRemoteId: 'instance-cancel', originalStartTime: slot,
		}];
		await provider.updateEvent(SESSION, 'primary', 'series-cancel', { ...master.event, title: 'Revised series' }, master.version);
		await service.syncNow();
		expect(Object.values(store.state.remoteOccurrences)[0]?.cancelled).toBe(true);
		expect(repository.getByUid(note.event.uid)?.status).toBe('remote_deleted');
		expect(decodeCalendarEventNote(vault.files.get(note.path) ?? '').note?.body).toBe('\n# Kept body\n');
	});

	it('leaves child targets unresolved after their recurring parent is deleted', async () => {
		const provider = new InstanceProvider({ accountId: SESSION.accountId });
		const master = provider.seedEvent('primary', event('series', { recurrence: { frequency: 'daily', interval: 1 } }), { remoteId: 'series-delete' });
		const slot = { dateTime: '2026-09-22T09:00:00-05:00', timeZone: 'America/Bogota' };
		provider.instances = [{
			status: 'active', providerId: 'google', calendarId: 'primary', masterRemoteId: 'series-delete',
			instanceRemoteId: 'instance-delete', originalStartTime: slot, actualStart: slot,
			actualEnd: { dateTime: '2026-09-22T10:00:00-05:00', timeZone: 'America/Bogota' },
			event: { ...master, remoteId: 'instance-delete', recurrenceMasterId: 'series-delete', originalStartTime: slot,
				event: event('instance', { recurrence: undefined }) },
		}];
		const vault = new MemoryVault();
		const { service, repository, store } = makeService(provider, vault);
		await service.syncNow();
		const note = await repository.createForTarget(event('local-note'), {
			version: 1, providerId: 'google', accountId: SESSION.accountId, calendarId: 'primary',
			scope: 'occurrence', occurrence: { kind: 'recurrence', masterEventId: 'series-delete', originalStartTime: slot },
		}, { providerId: 'google', accountId: SESSION.accountId, calendarId: 'primary', remoteEventId: 'series-delete' },
		{ body: '\n# Do not lose\n' });
		await service.syncNow();
		await provider.deleteEvent(SESSION, 'primary', 'series-delete', master.version);
		await service.syncNow();
		expect(Object.values(store.state.remoteOccurrences)[0]?.unresolved).toBe(true);
		expect(Object.values(store.state.localRepairs).some(repair => repair.reason === 'parent-series-deleted')).toBe(true);
		expect(repository.getByUid(note.event.uid)?.status).toBe('synced');
		expect(decodeCalendarEventNote(vault.files.get(note.path) ?? '').note?.body).toBe('\n# Do not lose\n');
	});

	it('marks child targets unresolved when deleting a series from this plugin', async () => {
		const provider = new InstanceProvider({ accountId: SESSION.accountId });
		const master = provider.seedEvent('primary', event('series', { recurrence: { frequency: 'daily', interval: 1 } }), { remoteId: 'direct-series-delete' });
		const slot = { dateTime: '2026-09-22T09:00:00-05:00', timeZone: 'America/Bogota' };
		provider.instances = [{
			status: 'active', providerId: 'google', calendarId: 'primary', masterRemoteId: 'direct-series-delete',
			instanceRemoteId: 'direct-instance', originalStartTime: slot, actualStart: slot,
			actualEnd: { dateTime: '2026-09-22T10:00:00-05:00', timeZone: 'America/Bogota' },
			event: { ...master, remoteId: 'direct-instance', recurrenceMasterId: 'direct-series-delete', originalStartTime: slot,
				event: event('instance', { recurrence: undefined }) },
		}];
		const vault = new MemoryVault();
		const { service, repository, store } = makeService(provider, vault);
		await service.syncNow();
		const note = await repository.createForTarget(event('local-note'), {
			version: 1, providerId: 'google', accountId: SESSION.accountId, calendarId: 'primary',
			scope: 'occurrence', occurrence: { kind: 'recurrence', masterEventId: 'direct-series-delete', originalStartTime: slot },
		}, { providerId: 'google', accountId: SESSION.accountId, calendarId: 'primary', remoteEventId: 'direct-series-delete' },
		{ body: '\n# Do not lose\n' });
		const masterKey = makeSyncStateKey('google', SESSION.accountId, 'primary', 'direct-series-delete');
		expect(await service.deleteCalendarEvent(masterKey)).toBe(true);
		expect(store.state.remoteEvents[masterKey]?.status).toBe('remote_deleted');
		expect(Object.values(store.state.remoteOccurrences)[0]?.unresolved).toBe(true);
		expect(Object.values(store.state.localRepairs).some(repair => repair.reason === 'parent-series-deleted')).toBe(true);
		expect(decodeCalendarEventNote(vault.files.get(note.path) ?? '').note?.body).toBe('\n# Do not lose\n');
	});

	it('pulls and persists Google events without creating notes, including across restart and offline pulls', async () => {
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		provider.seedEvent('primary', event('remote-uid'), { remoteId: 'remote-1' });
		const vault = new MemoryVault();
		const store = new MemoryStateStore();
		const first = makeService(provider, vault, store, 'import-only');
		const result = await first.service.syncNow();
		const key = makeSyncStateKey('google', SESSION.accountId, 'primary', 'remote-1');

		expect(result.pulled).toBe(1);
		expect(result.imported).toBe(0);
		expect(first.repository.list()).toHaveLength(0);
		expect(store.state.remoteEvents[key]).toMatchObject({
			remoteEventId: 'remote-1',
			event: { uid: 'remote-uid', title: 'remote-uid' },
			status: 'synced',
		});

		const restarted = makeService(provider, vault, store, 'import-only');
		provider.failNext('pullChanges', transientError('temporarily offline'));
		const offline = await restarted.service.syncNow();
		expect(offline.status).toBe('offline');
		expect(restarted.service.listCachedEvents()).toContainEqual(expect.objectContaining({ key, event: expect.objectContaining({ title: 'remote-uid' }) }));
		expect(restarted.repository.list()).toHaveLength(0);
	});

	it('creates, updates, and deletes provider events directly without notes', async () => {
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		const { repository, service, store } = makeService(provider, new MemoryVault());
		const created = await service.createCalendarEvent(event('direct-create'));
		expect(created.key).toBe(makeSyncStateKey('google', SESSION.accountId, 'primary', created.remoteEventId));
		expect(repository.list()).toHaveLength(0);
		expect(provider.getCallCount('createEvent')).toBe(1);

		const updated = await service.updateCalendarEvent(created.key, { ...created.event, title: 'Direct edit' });
		expect(updated.event.title).toBe('Direct edit');
		expect(provider.getEvent('primary', created.remoteEventId)?.event.title).toBe('Direct edit');
		await expect(service.updateCalendarEvent(created.key, { ...updated.event, uid: 'different-uid' })).rejects.toThrow('UID cannot be changed');

		expect(await service.deleteCalendarEvent(created.key)).toBe(true);
		expect(provider.getEvent('primary', created.remoteEventId)).toBeUndefined();
		expect(store.state.remoteEvents[created.key]?.status).toBe('remote_deleted');
		expect(repository.list()).toHaveLength(0);
	});

	it('surfaces a stale delete as a provider conflict and keeps the event', async () => {
		const provider = new LostCreateResponseProvider({ accountId: SESSION.accountId });
		const original = provider.seedEvent('primary', event('conflicting'), { remoteId: 'stale-delete' });
		const { service, store } = makeService(provider, new MemoryVault());
		await service.syncNow();
		await provider.updateEvent(SESSION, 'primary', 'stale-delete', { ...original.event, title: 'Updated elsewhere' }, original.version);
		const key = makeSyncStateKey('google', SESSION.accountId, 'primary', 'stale-delete');
		await expect(service.deleteCalendarEvent(key)).rejects.toBeInstanceOf(ProviderWriteConflictError);
		expect(provider.getEvent('primary', 'stale-delete')?.event.title).toBe('Updated elsewhere');
		expect(store.state.remoteEvents[key]?.status).toBe('synced');
	});

	it('reports a confirmed Google edit as saved when note mirroring fails, then repairs locally', async () => {
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		provider.seedEvent('primary', event('remote-uid', { title: 'Before' }), { remoteId: 'remote-edit' });
		const vault = new MemoryVault();
		const { repository, service, store } = makeService(provider, vault);
		await service.syncNow();
		const key = makeSyncStateKey('google', SESSION.accountId, 'primary', 'remote-edit');
		const cached = service.listCachedEvents().find(value => value.key === key);
		if (!cached) throw new Error('Expected cached event');
		const note = await repository.createForTarget({ ...cached.event, uid: undefined }, {
			version: 1, providerId: 'google', accountId: SESSION.accountId, calendarId: 'primary',
			scope: 'occurrence', occurrence: { kind: 'event', eventId: 'remote-edit' },
		}, {
			providerId: 'google', accountId: SESSION.accountId, calendarId: 'primary', remoteEventId: 'remote-edit',
		});
		vault.failNextProcess = true;

		const result = await service.updateCalendarEvent(key, { ...cached.event, title: 'Saved on Google' });
		expect(result.localRepairPending).toBe(true);
		expect(provider.getEvent('primary', 'remote-edit')?.event.title).toBe('Saved on Google');
		expect(repository.getByUid(note.event.uid)?.event.title).toBe('Before');
		expect(Object.values(store.state.localRepairs)).toHaveLength(1);

		const restarted = makeService(provider, vault, store);
		await restarted.service.syncNow();
		expect(restarted.repository.getByUid(note.event.uid)?.event.title).toBe('Saved on Google');
		expect(store.state.localRepairs).toEqual({});
	});

	it('keeps provider success when its first local state write fails', async () => {
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		provider.seedEvent('primary', event('remote', { title: 'Before' }), { remoteId: 'state-failure' });
		const store = new MemoryStateStore();
		const { service } = makeService(provider, new MemoryVault(), store);
		await service.syncNow();
		const key = makeSyncStateKey('google', SESSION.accountId, 'primary', 'state-failure');
		const current = store.state.remoteEvents[key];
		store.failNextSave = true;
		const result = await service.updateCalendarEvent(key, { ...current.event, title: 'Saved remotely' });
		expect(result.localRepairPending).toBe(true);
		expect(provider.getEvent('primary', 'state-failure')?.event.title).toBe('Saved remotely');
		expect(store.state.remoteEvents[key]?.event.title).toBe('Saved remotely');
		expect(Object.values(store.state.localRepairs)).toHaveLength(1);
		await service.syncNow();
		expect(store.state.localRepairs).toEqual({});
	});

	it('keeps an occurrence edit successful when its linked note needs repair', async () => {
		const provider = new EditableInstanceProvider({ accountId: SESSION.accountId });
		const master = provider.seedEvent('primary', event('series', { recurrence: { frequency: 'daily', interval: 1 } }), { remoteId: 'edit-series' });
		const slot = { dateTime: '2026-09-22T09:00:00-05:00', timeZone: 'America/Bogota' };
		provider.instances = [{
			status: 'active', providerId: 'google', calendarId: 'primary', masterRemoteId: 'edit-series',
			instanceRemoteId: 'edit-instance', originalStartTime: slot, actualStart: slot,
			actualEnd: { dateTime: '2026-09-22T10:00:00-05:00', timeZone: 'America/Bogota' },
			event: { ...master, remoteId: 'edit-instance', recurrenceMasterId: 'edit-series', originalStartTime: slot,
				event: event('instance', { recurrence: undefined }) },
		}];
		const vault = new MemoryVault();
		const { service, repository, store } = makeService(provider, vault);
		await service.syncNow();
		const note = await repository.createForTarget(event('local-note'), {
			version: 1, providerId: 'google', accountId: SESSION.accountId, calendarId: 'primary',
			scope: 'occurrence', occurrence: { kind: 'recurrence', masterEventId: 'edit-series', originalStartTime: slot },
		}, { providerId: 'google', accountId: SESSION.accountId, calendarId: 'primary', remoteEventId: 'edit-series' },
		{ body: '\n# Kept while editing\n' });
		await service.syncNow();
		const occurrenceKey = Object.keys(store.state.remoteOccurrences)[0];
		const previous = store.state.remoteOccurrences[occurrenceKey];
		if (!previous.event) throw new Error('Expected occurrence event');
		vault.failNextProcess = true;
		const result = await service.updateCalendarOccurrence(occurrenceKey, { ...previous.event, title: 'Edited instance' });
		expect(result.localRepairPending).toBe(true);
		expect(provider.updateCalls).toBe(1);
		expect(provider.getEvent('primary', 'edit-series')?.event.title).toBe('series');
		expect(repository.getByUid(note.event.uid)?.event.title).toBe('instance');
		const restarted = makeService(provider, vault, store);
		await restarted.service.syncNow();
		expect(restarted.repository.getByUid(note.event.uid)?.event.title).toBe('Edited instance');
		expect(decodeCalendarEventNote(vault.files.get(note.path) ?? '').note?.body).toBe('\n# Kept while editing\n');
	});

	it('links a note only on request, mirrors remote canonical fields, and keeps note edits local', async () => {
		const body = '\n# my selected event\n';
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		provider.seedEvent('primary', event('google:primary:remote-2', { title: 'Google title' }), { remoteId: 'remote-2' });
		const vault = new MemoryVault();
		const { repository, service, store } = makeService(provider, vault, new MemoryStateStore(), 'import-only');
		await service.syncNow();
		const key = makeSyncStateKey('google', SESSION.accountId, 'primary', 'remote-2');
		expect(repository.list()).toHaveLength(0);

		const createdNote = await repository.create({ ...event('note-uid', { title: 'stale title' }) }, { body });
		const linked = await service.linkNote(key, createdNote.path, createdNote.event.uid);
		expect(linked.noteUid).toBe('note-uid');
		expect(linked.event.uid).toBe('google:primary:remote-2');
		expect(repository.getByUid('note-uid')?.event.title).toBe('Google title');
		await service.linkNote(key, createdNote.path, createdNote.event.uid);
		expect(repository.list()).toHaveLength(1);

		const remote = provider.getEvent('primary', 'remote-2');
		if (!remote) throw new Error('Expected the seeded provider event');
		await provider.updateEvent(SESSION, 'primary', 'remote-2', { ...remote.event, title: 'Updated on Google' }, remote.version);
		await service.syncNow();
		const mirrored = repository.getByUid('note-uid');
		expect(mirrored?.event.title).toBe('Updated on Google');
		expect(decodeCalendarEventNote(vault.files.get(createdNote.path) ?? '').note?.body).toBe(body);
		expect(store.state.remoteEvents[key]?.event.uid).toBe('google:primary:remote-2');
		expect(provider.getCallCount('updateEvent')).toBe(1);

		if (!mirrored) throw new Error('Expected the linked note');
		await repository.update(createdNote.path, { ...mirrored.event, title: 'Local-only edit' });
		await service.syncNow();
		expect(provider.getEvent('primary', 'remote-2')?.event.title).toBe('Updated on Google');
		expect(repository.getByUid('note-uid')?.event.title).toBe('Updated on Google');
	});

	it('recovers an existing note link from its provider reference when sync mappings are absent', async () => {
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		provider.seedEvent('primary', event('provider-event', { title: 'Google title' }), { remoteId: 'associated-remote' });
		const { repository, service } = makeService(provider, new MemoryVault(), new MemoryStateStore(), 'import-only');
		await repository.create(event('associated-note', { title: 'stale title' }), {
			association: {
				providerId: 'google',
				accountId: SESSION.accountId,
				calendarId: 'primary',
				remoteEventId: 'associated-remote',
			},
		});

		await service.syncNow();
		const key = makeSyncStateKey('google', SESSION.accountId, 'primary', 'associated-remote');
		expect(service.listCachedEvents().find(cached => cached.key === key)?.remoteEventId).toBe('associated-remote');
		expect(repository.getByUid('associated-note')?.target).toMatchObject({
			scope: 'occurrence', occurrence: { kind: 'event', eventId: 'associated-remote' },
		});
		expect(repository.getByUid('associated-note')?.event.title).toBe('Google title');
	});

	it('leaves an unverifiable legacy link intact when its targeted lookup is unavailable', async () => {
		const provider = new UnavailableLookupProvider({ accountId: SESSION.accountId });
		const vault = new MemoryVault();
		const { repository, service } = makeService(provider, vault, new MemoryStateStore(), 'import-only');
		const note = await repository.create(event('legacy-note'), {
			body: '\n# Local content\n',
			association: {
				providerId: 'google', accountId: SESSION.accountId, calendarId: 'primary',
				remoteEventId: 'unavailable-event',
			},
		});
		const result = await service.syncNow();
		expect(result.status).toBe('idle');
		expect(repository.getByUid('legacy-note')?.target).toBeUndefined();
		expect(decodeCalendarEventNote(vault.files.get(note.path) ?? '').note?.body).toBe('\n# Local content\n');
	});

	it('preserves a linked note on remote deletion and marks its status', async () => {
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		provider.seedEvent('primary', event('remote-uid'), { remoteId: 'remote-delete' });
		const vault = new MemoryVault();
		const { repository, service, store } = makeService(provider, vault, new MemoryStateStore(), 'import-only');
		await service.syncNow();
		const key = makeSyncStateKey('google', SESSION.accountId, 'primary', 'remote-delete');
		const note = await repository.create(event('kept-note'), { body: '# Keep this note' });
		await service.linkNote(key, note.path, note.event.uid);
		const remote = provider.getEvent('primary', 'remote-delete');
		await provider.deleteEvent(SESSION, 'primary', 'remote-delete', remote?.version);
		await service.syncNow();

		expect(store.state.remoteEvents[key]?.status).toBe('remote_deleted');
		expect(repository.getByUid('kept-note')?.status).toBe('remote_deleted');
		expect(vault.files.has(note.path)).toBe(true);
		expect(store.state.tombstones).toEqual({});

		provider.seedEvent('primary', event('remote-uid'), { remoteId: 'remote-delete' });
		await service.syncNow();
		expect(store.state.remoteEvents[key]?.status).toBe('synced');
		expect(repository.getByUid('kept-note')?.status).toBe('synced');
	});

	it('does not turn local note deletion into a provider deletion or remote tombstone', async () => {
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		provider.seedEvent('primary', event('remote-uid'), { remoteId: 'remote-note-delete' });
		const vault = new MemoryVault();
		const { repository, service, store } = makeService(provider, vault, new MemoryStateStore(), 'import-only');
		await service.syncNow();
		const key = makeSyncStateKey('google', SESSION.accountId, 'primary', 'remote-note-delete');
		const note = await repository.create(event('deleted-note'));
		await service.linkNote(key, note.path, note.event.uid);
		vault.files.delete(note.path);
		repository.notifyLocalDeletion(note.path);
		await service.syncNow();

		expect(provider.getEvent('primary', 'remote-note-delete')).toBeDefined();
		expect(provider.getCallCount('deleteEvent')).toBe(0);
		expect(store.state.remoteEvents[key]?.status).toBe('synced');
		expect(store.state.remoteEvents[key]).not.toHaveProperty('notePath');
		expect(store.state.remoteEvents[key]).not.toHaveProperty('noteUid');
		expect(store.state.tombstones).toEqual({});
	});

	it('forces a full window fetch when migrating state that only has an incremental cursor', async () => {
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		provider.seedEvent('primary', event('before-cursor'), { remoteId: 'before-cursor' });
		const initialPage = await provider.pullChanges({ session: SESSION, calendarId: 'primary', window: WINDOW });
		const store = new MemoryStateStore();
		const cursorKey = makeSyncStateKey('google', SESSION.accountId, 'primary');
		store.state.cursors[cursorKey] = initialPage.nextCursor ?? '';
		const { repository, service } = makeService(provider, new MemoryVault(), store, 'import-only');

		const result = await service.syncNow();
		expect(result.fullResync).toBe(true);
		expect(service.listCachedEvents()).toHaveLength(1);
		expect(repository.list()).toHaveLength(0);
		expect(store.state.eventCacheInitialized[cursorKey]).toBe(true);
	});

	it('keeps unbounded provider pulls inside the configured cache horizon and still applies deletions', async () => {
		const provider = new UnboundedPullProvider({ accountId: SESSION.accountId });
		provider.seedEvent('primary', event('inside-window'), { remoteId: 'inside-window' });
		provider.seedEvent('primary', event('outside-window', {
			start: '2024-12-30T09:00:00-05:00',
			end: '2024-12-30T10:00:00-05:00',
		}), { remoteId: 'outside-window' });
		const { service, store } = makeService(provider, new MemoryVault(), new MemoryStateStore(), 'import-only');

		const initial = await service.syncNow();
		const insideKey = makeSyncStateKey('google', SESSION.accountId, 'primary', 'inside-window');
		const outsideKey = makeSyncStateKey('google', SESSION.accountId, 'primary', 'outside-window');
		expect(initial.pulled).toBe(2);
		expect(service.listCachedEvents().map(cached => cached.remoteEventId)).toEqual(['inside-window']);
		expect(store.state.remoteEvents[outsideKey]).toBeUndefined();

		await provider.deleteEvent(SESSION, 'primary', 'inside-window');
		await service.syncNow();
		expect(store.state.remoteEvents[insideKey]?.status).toBe('remote_deleted');
	});

	it('recovers from a legacy Google cursor with one automatic full resync', async () => {
		const provider = new ExpiringCursorOnceProvider({ accountId: SESSION.accountId });
		provider.seedEvent('primary', event('recovered-event'), { remoteId: 'recovered-event' });
		const store = new MemoryStateStore();
		const cursorKey = makeSyncStateKey('google', SESSION.accountId, 'primary');
		store.state.cursors[cursorKey] = {
			providerId: 'google',
			accountId: SESSION.accountId,
			calendarId: 'primary',
			cursor: 'google-sync-v1:legacy-token',
			updatedAt: '2026-09-01T00:00:00.000Z',
		};
		store.state.eventCacheInitialized[cursorKey] = true;
		const { service, store: savedStore } = makeService(provider, new MemoryVault(), store, 'import-only');

		const result = await service.syncNow();
		const eventKey = makeSyncStateKey('google', SESSION.accountId, 'primary', 'recovered-event');
		expect(result.fullResync).toBe(true);
		expect(result.status).toBe('idle');
		expect(provider.seenCursors).toEqual(['google-sync-v1:legacy-token', undefined]);
		expect(savedStore.state.remoteEvents[eventKey]?.event.title).toBe('recovered-event');
		expect(savedStore.state.eventCacheInitialized[cursorKey]).toBe(true);
	});

	it('marks cached events absent from a completed full resync as remotely deleted', async () => {
		const provider = new HidingFullResyncProvider({ accountId: SESSION.accountId });
		provider.seedEvent('primary', event('stale-event'), { remoteId: 'stale-event' });
		const { service, store } = makeService(provider, new MemoryVault(), new MemoryStateStore(), 'import-only');
		await service.syncNow();
		const key = makeSyncStateKey('google', SESSION.accountId, 'primary', 'stale-event');
		expect(store.state.remoteEvents[key]?.status).toBe('synced');

		provider.hiddenRemoteId = 'stale-event';
		const result = await service.syncNow('full-resync');
		expect(result.fullResync).toBe(true);
		expect(store.state.remoteEvents[key]?.status).toBe('remote_deleted');
	});

	it('blocks provider event writes in import-only and dry-run modes', async () => {
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		const importOnly = makeService(provider, new MemoryVault(), new MemoryStateStore(), 'import-only');
		await expect(importOnly.service.createCalendarEvent(event('blocked'))).rejects.toThrow('unavailable in import-only mode');
		expect(provider.getCallCount('createEvent')).toBe(0);

		provider.seedEvent('primary', event('dry-run-event'), { remoteId: 'dry-run-event' });
		const dryRun = makeService(provider, new MemoryVault(), new MemoryStateStore(), 'dry-run');
		expect((await dryRun.service.syncNow()).status).toBe('dry-run');
		expect(dryRun.service.listCachedEvents()).toHaveLength(0);
		expect(dryRun.repository.list()).toHaveLength(0);
	});

	it('rejects edits and deletes for unsupported recurring events', async () => {
		const provider = new FakeCalendarProvider({ accountId: SESSION.accountId });
		provider.seedEvent('primary', event('recurring'), { remoteId: 'recurring', recurrence: 'unsupported' });
		const { service } = makeService(provider, new MemoryVault(), new MemoryStateStore(), 'bidirectional');
		await service.syncNow();
		const cached = service.listCachedEvents()[0];
		expect(cached.status).toBe('unsupported');
		await expect(service.updateCalendarEvent(cached.key, { ...cached.event, title: 'No edit' })).rejects.toThrow('Recurring Google Calendar events cannot be edited');
		await expect(service.deleteCalendarEvent(cached.key)).rejects.toThrow('Recurring Google Calendar events cannot be deleted');
		expect(provider.getCallCount('updateEvent')).toBe(0);
		expect(provider.getCallCount('deleteEvent')).toBe(0);
	});

	it('keeps a series guarded after later master updates until a full resync proves it clear', async () => {
		const provider = new ExceptionGuardProvider({ accountId: SESSION.accountId });
		const master = provider.seedEvent('primary', event('exception-series-event', {
			recurrence: { frequency: 'daily', interval: 1 },
		}), { remoteId: 'exception-series' });
		const { service, store } = makeService(provider, new MemoryVault(), new MemoryStateStore(), 'bidirectional');
		await service.syncNow();
		const key = makeSyncStateKey('google', SESSION.accountId, 'primary', 'exception-series');
		expect(store.state.remoteEvents[key]).toMatchObject({ status: 'unsupported', recurrenceHasExceptions: true });

		await provider.updateEvent(SESSION, 'primary', master.remoteId, {
			...master.event,
			title: 'Updated master title',
		}, master.version);
		await service.syncNow();
		expect(store.state.remoteEvents[key]).toMatchObject({
			status: 'unsupported', recurrenceStatus: 'unsupported', recurrenceHasExceptions: true,
			event: { title: 'Updated master title' },
		});
		await expect(service.updateCalendarEvent(key, { ...master.event, title: 'Blocked' })).rejects.toThrow('Recurring Google Calendar events cannot be edited');
		await service.syncNow('full-resync');
		expect(store.state.remoteEvents[key]).toMatchObject({ status: 'synced', recurrenceStatus: 'supported' });
		expect(store.state.remoteEvents[key]?.recurrenceHasExceptions).toBeUndefined();
	});
});
