import { describe, expect, it } from 'vitest';
import { SyncQueue, type SyncQueueScheduler } from '../../../src/services/sync/engine';

class ManualScheduler implements SyncQueueScheduler {
	private nextId = 1;
	private readonly tasks = new Map<number, () => void>();

	setTimeout(callback: () => void): number {
		const id = this.nextId++;
		this.tasks.set(id, callback);
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.tasks.delete(handle as number);
	}

	runAll(): void {
		while (this.tasks.size > 0) {
			const [id, callback] = this.tasks.entries().next().value as [number, () => void];
			this.tasks.delete(id);
			callback();
		}
	}
}

describe('SyncQueue', () => {
	it('coalesces same-key debounced work and serializes different keys', async () => {
		const scheduler = new ManualScheduler();
		const queue = new SyncQueue(scheduler);
		const calls: string[] = [];

		const first = queue.enqueue('event', async () => {
			calls.push('latest');
			return 'done';
		}, { debounceMs: 50 });
		const second = queue.enqueue('event', async () => {
			calls.push('replaced');
			return 'replaced-result';
		}, { debounceMs: 50 });
		const other = queue.enqueue('other', async () => {
			calls.push('other');
			return 'other-result';
		}, { debounceMs: 50 });

		scheduler.runAll();
		await expect(first).resolves.toBe('replaced-result');
		await expect(second).resolves.toBe('replaced-result');
		await expect(other).resolves.toBe('other-result');
		await queue.flush();

		expect(calls).toEqual(['replaced', 'other']);
		expect(queue.isBusy).toBe(false);
	});

	it('retries only when requested and passes attempt numbers', async () => {
		const scheduler = new ManualScheduler();
		const queue = new SyncQueue(scheduler);
		const attempts: number[] = [];
		let count = 0;
		const result = queue.enqueue('retry', ({ attempt }) => {
			attempts.push(attempt);
			count += 1;
			if (count < 3) throw new Error('temporary');
			return 'ok';
		}, {
			maxAttempts: 3,
			retryDelayMs: () => 0,
			shouldRetry: () => true,
		});

		scheduler.runAll();
		await expect(result).resolves.toBe('ok');
		await queue.flush();
		expect(attempts).toEqual([1, 2, 3]);
	});

	it('rejects pending and running waiters on cancellation and can be reused', async () => {
		const scheduler = new ManualScheduler();
		const queue = new SyncQueue(scheduler);
		const running = queue.enqueue('running', ({ signal }) => new Promise<string>((resolve, reject) => {
			signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
			void resolve;
		}));
		const pending = queue.enqueue('pending', () => 'never');
		const flush = queue.flush();
		await Promise.resolve();
		queue.cancel('test cancellation');

		await expect(running).rejects.toMatchObject({ name: 'AbortError' });
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		await expect(flush).resolves.toBeUndefined();

		const reused = queue.enqueue('reused', () => 'after-cancel');
		await queue.flush();
		await expect(reused).resolves.toBe('after-cancel');
	});
});
