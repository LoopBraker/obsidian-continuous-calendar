import { describe, expect, it } from 'vitest';

import {
	canonicalCalendarEventJson,
	createCalendarEventSnapshot,
	hashCalendarEvent,
	serializeCalendarEvent,
	stableHash,
	stableSerialize,
} from '../../../src/services/sync/model/CalendarEventHash';
import { normalizeCalendarEvent } from '../../../src/services/sync/model/CalendarEventValidation';

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

describe('calendar event serialization and hashing', () => {
	it('sorts object keys recursively for stable generic serialization', () => {
		expect(stableSerialize({ b: 2, nested: { z: true, a: 'x' }, a: 1 })).toBe(
			'{"a":1,"b":2,"nested":{"a":"x","z":true}}',
		);
		expect(stableHash('same input')).toBe(stableHash('same input'));
	});

	it('uses canonical field order and ignores unknown input properties', () => {
		const reordered = {
			description: event.description,
			allDay: event.allDay,
			end: event.end,
			start: event.start,
			timezone: event.timezone,
			title: event.title,
			location: event.location,
			uid: event.uid,
			providerExtension: { arbitrary: true },
		};

		expect(serializeCalendarEvent(event)).toBe(canonicalCalendarEventJson(reordered));
		expect(hashCalendarEvent(event)).toBe(hashCalendarEvent(reordered));
		expect(serializeCalendarEvent(event)).toBe(
		'{"uid":"event-1","title":"Project review","start":"2026-09-22T09:00:00-05:00","end":"2026-09-22T10:00:00-05:00","allDay":false,"timezone":"America/Bogota","location":"Room 1","description":"Discuss the release."}',
	);
	});

	it('changes when a canonical field changes and records a snapshot hash', () => {
		expect(hashCalendarEvent(event)).not.toBe(
			hashCalendarEvent({ ...event, description: 'A different description.' }),
		);

		const snapshot = createCalendarEventSnapshot(event, '2026-09-22T15:00:00Z');
		expect(snapshot.event).toEqual(event);
		expect(snapshot.hash).toBe(hashCalendarEvent(event));
		expect(snapshot.capturedAt).toBe('2026-09-22T15:00:00Z');
	});

	it('preserves provider-visible description whitespace in normalization and hashing', () => {
		const description = '\n  First line\nSecond line  \n';
		const withDescription = { ...event, description };
		const normalized = normalizeCalendarEvent(withDescription);

		expect(normalized.description).toBe(description);
		expect(serializeCalendarEvent(withDescription)).toContain(JSON.stringify(description));
		expect(hashCalendarEvent(withDescription)).not.toBe(
			hashCalendarEvent({ ...event, description: description.trim() }),
		);
	});
});
