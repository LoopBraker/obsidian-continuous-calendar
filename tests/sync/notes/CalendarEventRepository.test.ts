import { describe, expect, it } from 'vitest';

import {
	decodeCalendarEventNote,
	encodeCalendarEventNote,
	parseFrontmatter,
} from '../../../src/services/sync/notes/FrontmatterEventCodec';
import {
	CalendarEventRepository,
	type CalendarEventVault,
	type CalendarVaultFileLike,
} from '../../../src/services/sync/notes/CalendarEventRepository';

const event = {
	uid: 'event-1',
	title: 'Project review',
	start: '2026-09-22T09:00:00-05:00',
	end: '2026-09-22T10:00:00-05:00',
	allDay: false,
	timezone: 'America/Bogota',
	location: 'Room 1',
	description: 'Discuss the release.',
};

class MemoryVault implements CalendarEventVault {
	readonly files = new Map<string, string>();
	createCalls: string[] = [];
	processCalls: string[] = [];
	renameCalls: Array<[string, string]> = [];

	constructor(initial: Record<string, string> = {}) {
		for (const [path, content] of Object.entries(initial)) this.files.set(path, content);
	}

	getMarkdownFiles(): readonly CalendarVaultFileLike[] {
		return Array.from(this.files.keys()).map(path => ({ path }));
	}

	read(file: CalendarVaultFileLike): Promise<string> {
		const path = typeof file === 'string' ? file : file.path;
		const content = this.files.get(path);
		if (content === undefined) return Promise.reject(new Error(`Missing ${path}`));
		return Promise.resolve(content);
	}

	create(path: string, content: string): Promise<CalendarVaultFileLike> {
		if (this.files.has(path)) return Promise.reject(new Error(`Already exists: ${path}`));
		this.files.set(path, content);
		this.createCalls.push(path);
		return Promise.resolve({ path });
	}

	processFrontMatter(file: CalendarVaultFileLike, processor: (frontmatter: Record<string, unknown>) => void): void {
		const path = typeof file === 'string' ? file : file.path;
		const content = this.files.get(path);
		if (content === undefined) throw new Error(`Missing ${path}`);
		const parsed = parseFrontmatter(content);
		const frontmatter = { ...parsed.frontmatter };
		processor(frontmatter);
		const decoded = decodeCalendarEventNote(`---\n${Object.entries(frontmatter)
			.map(([key, value]) => `${key}: ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`)
			.join('\n')}\n---\n${parsed.body}`);
		if (!decoded.note) throw new Error('Mock frontmatter was not a valid event');
		this.files.set(path, encodeCalendarEventNote(decoded.note.event, { body: parsed.body, unknownFrontmatter: frontmatter }));
		this.processCalls.push(path);
	}

	rename(file: CalendarVaultFileLike, newPath: string): void {
		const path = typeof file === 'string' ? file : file.path;
		if (this.files.has(newPath)) throw new Error(`Already exists: ${newPath}`);
		const content = this.files.get(path);
		if (content === undefined) throw new Error(`Missing ${path}`);
		this.files.delete(path);
		this.files.set(newPath, content);
		this.renameCalls.push([path, newPath]);
	}
}

describe('FrontmatterEventCodec', () => {
	it('parses only an explicit boolean calendar_event marker and preserves the body', () => {
		const body = '\n# local notes\n\nDo not rewrite this.\n';
		const marked = decodeCalendarEventNote(
			`---\ncalendar_event: true\ncalendar_uid: event-1\ncalendar_title: Project review\ndateStart: 2026-09-22T09:00:00-05:00\ndateEnd: 2026-09-22T10:00:00-05:00\ncalendar_all_day: false\ncalendar_timezone: America/Bogota\ncalendar_location: Room 1\ncalendar_description: Discuss the release.\ncustom_field: retained\n---\n${body}`,
		);
		const unmarked = decodeCalendarEventNote(`---\ncalendar_event: false\nfoo: bar\n---\n${body}`);

		expect(marked.marked).toBe(true);
		expect(marked.note?.event).toEqual(event);
		expect(marked.note?.body).toBe(body);
		expect(marked.note?.frontmatter.custom_field).toBe('retained');
		expect(unmarked.marked).toBe(false);
		expect(unmarked.note).toBeUndefined();
	});

	it('round-trips canonical fields and provider status without dropping unknown fields', () => {
		const content = encodeCalendarEventNote(event, {
			body: 'body bytes',
			status: 'synced',
			association: {
				providerId: 'google',
				accountId: 'account',
				calendarId: 'primary',
				remoteEventId: 'remote',
				version: 'etag-secret',
			},
			unknownFrontmatter: { custom: 'keep me' },
		});
		const decoded = decodeCalendarEventNote(content);

		expect(decoded.note?.event).toEqual(event);
		expect(decoded.note?.status).toBe('synced');
		expect(decoded.note?.association?.reference).toEqual({
			providerId: 'google',
			accountId: 'account',
			calendarId: 'primary',
			remoteEventId: 'remote',
		});
		expect(decoded.parsed.frontmatter.calendar_sync).not.toHaveProperty('error');
		expect(decoded.parsed.frontmatter.calendar_sync).not.toHaveProperty('google.version');
		expect(decoded.note?.frontmatter.custom).toBe('keep me');
		expect(decoded.note?.body).toBe('body bytes');
	});

	it('preserves literal block descriptions, indentation, and YAML chomping indicators', () => {
		const base = (indicator: string, lines: string) => decodeCalendarEventNote(
			`---\ncalendar_event: true\ncalendar_uid: event-1\ncalendar_title: Project review\ndateStart: 2026-09-22T09:00:00-05:00\ndateEnd: 2026-09-22T10:00:00-05:00\ncalendar_all_day: false\ncalendar_timezone: America/Bogota\ncalendar_description: ${indicator}\n${lines}\ncalendar_location: Room 1\n---\nbody`,
		);

		const clipped = base('|', '  First line\n    indented line');
		const stripped = base('|-', '  First line\n    indented line');
		const kept = base('|+', '  First line\n    indented line\n\n');

		expect(clipped.note?.event.description).toBe('First line\n  indented line\n');
		expect(stripped.note?.event.description).toBe('First line\n  indented line');
		expect(kept.note?.event.description).toBe('First line\n  indented line\n\n\n');
	});

	it('folds ordinary lines while retaining folded chomping semantics', () => {
		const make = (indicator: string) => decodeCalendarEventNote(
			`---\ncalendar_event: true\ncalendar_uid: event-1\ncalendar_title: Project review\ndateStart: 2026-09-22T09:00:00-05:00\ndateEnd: 2026-09-22T10:00:00-05:00\ncalendar_all_day: false\ncalendar_timezone: America/Bogota\ncalendar_description: ${indicator}\n  First line\n  Second line\n\ncalendar_location: Room 1\n---\nbody`,
		);

		expect(make('>').note?.event.description).toBe('First line Second line\n');
		expect(make('>-').note?.event.description).toBe('First line Second line');
	});
});

describe('CalendarEventRepository', () => {
	it('exposes explicit trash only when the vault can move files to trash', async () => {
		const withoutTrash = new CalendarEventRepository(new MemoryVault(), { folder: 'Events' });
		expect(withoutTrash.trash).toBeUndefined();

		const vault = new MemoryVault({
			'Events/Trash.md': encodeCalendarEventNote(event, { body: 'local body' }),
		});
		let trashedPath: string | undefined;
		const trashVault: CalendarEventVault = {
			getMarkdownFiles: () => vault.getMarkdownFiles(),
			read: file => vault.read(file),
			create: (path, content) => vault.create(path, content),
			processFrontMatter: (file, processor) => vault.processFrontMatter(file, processor),
			rename: (file, path) => vault.rename(file, path),
			trash: file => {
				trashedPath = typeof file === 'string' ? file : file.path;
				vault.files.delete(trashedPath);
			},
		};
		const repository = new CalendarEventRepository(trashVault, { folder: 'Events' });
		await repository.reload();
		await repository.trash?.('event-1');
		expect(trashedPath).toBe('Events/Trash.md');
		expect(repository.getByUid('event-1')).toBeUndefined();
	});

	it('creates, reads, reloads, and collision-suffixes notes with immutable generated IDs', async () => {
		const vault = new MemoryVault({ 'Events/Project review.md': '# existing unmarked note\n' });
		const repository = new CalendarEventRepository(vault, {
			folder: 'Events',
			uuidFactory: () => 'generated-uid',
		});

		const created = await repository.create({ ...event, uid: undefined });
		expect(created.event.uid).toBe('generated-uid');
		expect(created.path).toBe('Events/Project review (2).md');
		expect(vault.createCalls).toEqual(['Events/Project review (2).md']);
		expect(await repository.read(created.path)).toMatchObject({ event: { uid: 'generated-uid' } });

		const reloaded = await repository.reload();
		expect(reloaded.errors).toEqual([]);
		expect(repository.getByUid('generated-uid')?.path).toBe(created.path);
	});

	it('updates only frontmatter, preserving unknown fields and exact body bytes', async () => {
		const body = '\r\n# local body\r\n\r\n- [ ] local checkbox\r\n';
		const vault = new MemoryVault({
			'Events/Project review.md': encodeCalendarEventNote(event, {
				body,
				unknownFrontmatter: { custom_field: 'keep me' },
			}),
		});
		const repository = new CalendarEventRepository(vault, { folder: 'Events' });
		await repository.reload();

		await repository.update('Events/Project review.md', { title: 'Architecture review' });
		const stored = await vault.read('Events/Project review.md');
		const decoded = decodeCalendarEventNote(stored);
		expect(vault.createCalls).toEqual([]);
		expect(vault.processCalls).toEqual(['Events/Project review.md']);
		expect(decoded.note?.event.title).toBe('Architecture review');
		expect(decoded.note?.frontmatter.custom_field).toBe('keep me');
		expect(decoded.note?.body).toBe(body);
	});

	it('renames locally while retaining UID and changing no remote-facing operation', async () => {
		const vault = new MemoryVault({ 'Events/Project review.md': encodeCalendarEventNote(event, { body: 'body' }) });
		const repository = new CalendarEventRepository(vault, { folder: 'Events' });
		await repository.reload();

		const renamed = await repository.rename('Events/Project review.md', 'Events/Renamed review.md');
		expect(renamed.event.uid).toBe(event.uid);
		expect(repository.getByUid(event.uid)?.path).toBe('Events/Renamed review.md');
		expect(vault.renameCalls).toEqual([['Events/Project review.md', 'Events/Renamed review.md']]);
		expect(vault.processCalls).toEqual([]);
	});

	it('reports duplicate UIDs deterministically and keeps the first path indexed', async () => {
		const duplicate = { ...event, title: 'Second title' };
		const vault = new MemoryVault({
			'Events/a.md': encodeCalendarEventNote(event),
			'Events/b.md': encodeCalendarEventNote(duplicate),
		});
		const repository = new CalendarEventRepository(vault, { folder: 'Events' });

		const result = await repository.reload();
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].code).toBe('duplicate-uid');
		expect(result.errors[0].message).toContain('Events/b.md');
		expect(repository.getByUid(event.uid)?.path).toBe('Events/a.md');
	});

	it('rejects explicit path collisions while auto-suffixing implicit filenames', async () => {
		const vault = new MemoryVault({
			'Events/existing.md': encodeCalendarEventNote(event),
			'Events/Project review.md': '# unrelated note\n',
		});
		const repository = new CalendarEventRepository(vault, {
			folder: 'Events',
			uuidFactory: () => 'event-2',
		});
		await repository.reload();

		await expect(repository.create({ ...event, uid: 'event-2' }, { path: 'Events/existing.md' })).rejects.toMatchObject({
			code: 'duplicate-path',
			message: 'Calendar event path collision at "Events/existing.md"',
		});
		const created = await repository.create({ ...event, uid: 'event-2' });
		expect(created.path).toBe('Events/Project review (2).md');
	});

	it('rejects rename collisions before calling the vault rename operation', async () => {
		const vault = new MemoryVault({
			'Events/one.md': encodeCalendarEventNote(event),
			'Events/two.md': encodeCalendarEventNote({ ...event, uid: 'event-2', title: 'Other' }),
		});
		const repository = new CalendarEventRepository(vault, { folder: 'Events' });
		await repository.reload();

		await expect(repository.rename('Events/one.md', 'Events/two.md')).rejects.toMatchObject({
			code: 'duplicate-path',
		});
		expect(vault.renameCalls).toEqual([]);
	});

	it('emits local deletion before removing the UID/path mapping', async () => {
		const vault = new MemoryVault({ 'Events/event.md': encodeCalendarEventNote(event) });
		const repository = new CalendarEventRepository(vault, { folder: 'Events' });
		await repository.reload();
		let observedDuringCallback: string | undefined;
		const deletions: string[] = [];
		repository.onLocalDeletion(deletion => {
			deletions.push(deletion.uid);
			observedDuringCallback = repository.index.getPath(deletion.uid);
		});
		vault.files.delete('Events/event.md');

		const result = await repository.reload();
		expect(result.deleted).toHaveLength(1);
		expect(deletions).toEqual([event.uid]);
		expect(observedDuringCallback).toBe('Events/event.md');
		expect(repository.getByUid(event.uid)).toBeUndefined();
	});

	it('marks remote deletion, unsupported, and error without deleting the note', async () => {
		const vault = new MemoryVault({ 'Events/event.md': encodeCalendarEventNote(event, { body: 'keep' }) });
		const repository = new CalendarEventRepository(vault, { folder: 'Events' });
		await repository.reload();

		await repository.markRemoteDeleted(event.uid);
		expect(repository.getByUid(event.uid)?.status).toBe('remote_deleted');
		await repository.markUnsupported(event.uid);
		expect(repository.getByUid(event.uid)?.status).toBe('unsupported');
		await repository.markError(event.uid);
		expect(repository.getByUid(event.uid)?.status).toBe('error');
		expect(vault.files.has('Events/event.md')).toBe(true);
		expect(decodeCalendarEventNote(await vault.read('Events/event.md')).note?.body).toBe('keep');
	});
});
