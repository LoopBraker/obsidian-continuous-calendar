import { describe, expect, it, vi } from 'vitest';

describe('sync test harness', () => {
	it('runs a deterministic mocked-provider smoke test', async () => {
		const provider = {
			pullChanges: vi.fn().mockResolvedValue({
				changes: [],
				hasMore: false,
				nextCursor: undefined,
			}),
		};

		const page = await provider.pullChanges({
			calendarId: 'primary',
			window: {
				from: '2026-01-01T00:00:00Z',
				to: '2026-01-02T00:00:00Z',
			},
		});

		expect(page).toEqual({
			changes: [],
			hasMore: false,
			nextCursor: undefined,
		});
		expect(provider.pullChanges).toHaveBeenCalledOnce();
	});
});
