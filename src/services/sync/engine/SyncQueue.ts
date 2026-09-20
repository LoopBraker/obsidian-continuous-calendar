/** A deterministic clock boundary used by queue debounce and retry tests. */
export interface SyncQueueScheduler {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

const defaultScheduler: SyncQueueScheduler = {
	setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
	clearTimeout: handle => globalThis.clearTimeout(handle as number),
};

export interface SyncQueueTaskContext {
	readonly signal: AbortSignal;
	readonly attempt: number;
}

export interface SyncQueueRetryOptions {
	readonly maxAttempts?: number;
	readonly baseDelayMs?: number;
	readonly maxDelayMs?: number;
	readonly shouldRetry?: (error: unknown, attempt: number) => boolean;
	readonly retryDelayMs?: (error: unknown, attempt: number) => number;
}

export interface SyncQueueEnqueueOptions extends SyncQueueRetryOptions {
	readonly debounceMs?: number;
	readonly signal?: AbortSignal;
}

interface QueueWaiter<T> {
	readonly resolve: (value: T) => void;
	readonly reject: (error: unknown) => void;
	settled?: boolean;
	cleanup?: () => void;
}

interface QueueEntry<T> {
	readonly key: string;
	work: (context: SyncQueueTaskContext) => Promise<T> | T;
	options: SyncQueueEnqueueOptions;
	waiters: QueueWaiter<T>[];
	timer?: unknown;
	started: boolean;
	settled?: boolean;
}

function abortError(reason?: unknown): Error {
	if (reason instanceof Error) return reason;
	const error = new Error(reason === undefined ? 'Sync queue cancelled' : String(reason));
	error.name = 'AbortError';
	return error;
}

function defaultRetryDelay(error: unknown, attempt: number, options: SyncQueueRetryOptions): number {
	const providerDelay =
		typeof error === 'object' && error !== null && 'retryAfterMs' in error &&
		typeof (error as { retryAfterMs?: unknown }).retryAfterMs === 'number'
			? (error as { retryAfterMs: number }).retryAfterMs
			: undefined;
	const base = Math.max(0, options.baseDelayMs ?? 250);
	const max = Math.max(base, options.maxDelayMs ?? 30_000);
	const exponential = Math.min(max, base * Math.pow(2, Math.max(0, attempt - 1)));
	return Math.min(max, Math.max(0, providerDelay ?? exponential));
}

/**
 * Serialized, keyed, debounced work queue. Calls for the same key coalesce
 * while waiting for their debounce window; different keys still execute in a
 * single FIFO chain so provider writes cannot overlap.
 */
export class SyncQueue {
	private readonly pending = new Map<string, QueueEntry<unknown>>();
	private readonly active = new Set<QueueEntry<unknown>>();
	private readonly scheduler: SyncQueueScheduler;
	private serial: Promise<void> = Promise.resolve();
	private running = 0;
	private controller = new AbortController();

	constructor(scheduler: SyncQueueScheduler = defaultScheduler) {
		this.scheduler = scheduler;
	}

	get pendingKeys(): readonly string[] {
		return Array.from(this.pending.keys());
	}

	get isBusy(): boolean {
		return this.running > 0 || this.pending.size > 0;
	}

	enqueue<T>(
		key: string,
		work: (context: SyncQueueTaskContext) => Promise<T> | T,
		options: SyncQueueEnqueueOptions = {},
	): Promise<T> {
		if (options.signal?.aborted) return Promise.reject(abortError(options.signal.reason));
		if (this.controller.signal.aborted) this.controller = new AbortController();

		return new Promise<T>((resolve, reject) => {
			const existing = this.pending.get(key) as QueueEntry<T> | undefined;
			const waiter: QueueWaiter<T> = { resolve, reject };
			if (existing && !existing.started) {
				if (existing.timer !== undefined) this.scheduler.clearTimeout(existing.timer);
				existing.work = work;
				existing.options = options;
				this.addWaiter(existing, waiter, options.signal);
				this.schedule(existing);
				return;
			}

			const entry: QueueEntry<T> = {
				key,
				work,
				options,
				waiters: [],
				started: false,
			};
			this.addWaiter(entry, waiter, options.signal);
			this.pending.set(key, entry as QueueEntry<unknown>);
			this.schedule(entry);
		});
	}

	/** Force all currently debounced work to run and wait for queue idle. */
	async flush(): Promise<void> {
		while (this.pending.size > 0 || this.running > 0) {
			for (const entry of Array.from(this.pending.values())) {
				if (!entry.started) this.launch(entry);
			}
			await this.serial;
		}
	}

	/** Abort pending and running work. The queue can be reused afterwards. */
	cancel(reason?: unknown): void {
		const error = abortError(reason);
		for (const entry of this.pending.values()) {
			if (entry.timer !== undefined) this.scheduler.clearTimeout(entry.timer);
			this.settleError(entry, error);
		}
		this.pending.clear();
		for (const entry of this.active) {
			entry.settled = true;
			this.settleError(entry, error);
		}
		this.controller.abort(error);
		this.controller = new AbortController();
	}

	private schedule<T>(entry: QueueEntry<T>): void {
		const debounceMs = Math.max(0, entry.options.debounceMs ?? 0);
		entry.timer = this.scheduler.setTimeout(() => this.launch(entry), debounceMs);
	}

	private launch<T>(entry: QueueEntry<T>): void {
		if (entry.started || this.pending.get(entry.key) !== entry) return;
		entry.started = true;
		if (entry.timer !== undefined) this.scheduler.clearTimeout(entry.timer);
		this.pending.delete(entry.key);
		this.active.add(entry as QueueEntry<unknown>);
		this.serial = this.serial.then(() => this.execute(entry));
	}

	private async execute<T>(entry: QueueEntry<T>): Promise<void> {
		this.running += 1;
		const maxAttempts = Math.max(1, Math.floor(entry.options.maxAttempts ?? 1));
		const controller = this.controller;
		try {
			for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
				try {
					if (controller.signal.aborted) throw abortError(controller.signal.reason);
					const value = await entry.work({ signal: controller.signal, attempt });
					this.settleValue(entry, value);
					return;
				} catch (error) {
					if (controller.signal.aborted) {
						this.settleError(entry, abortError(controller.signal.reason));
						return;
					}
					const retryable =
						attempt < maxAttempts &&
						(entry.options.shouldRetry?.(error, attempt) ?? false);
					if (!retryable) {
						this.settleError(entry, error);
						return;
					}
					const delay = Math.max(
						0,
						entry.options.retryDelayMs?.(error, attempt) ??
							defaultRetryDelay(error, attempt, entry.options),
					);
					if (delay > 0) {
						try {
							await this.delay(delay, controller.signal);
						} catch (delayError) {
							this.settleError(entry, delayError);
							return;
						}
					}
				}
			}
		} catch (error) {
			this.settleError(entry, error);
		} finally {
			this.running -= 1;
			this.active.delete(entry as QueueEntry<unknown>);
		}
	}

	private settleValue<T>(entry: QueueEntry<T>, value: T): void {
		if (entry.settled) return;
		entry.settled = true;
		for (const waiter of entry.waiters) {
			waiter.cleanup?.();
			if (waiter.settled) continue;
			waiter.settled = true;
			waiter.resolve(value);
		}
	}

	private settleError<T>(entry: QueueEntry<T>, error: unknown): void {
		if (entry.settled && entry.waiters.length === 0) return;
		entry.settled = true;
		for (const waiter of entry.waiters) {
			waiter.cleanup?.();
			if (waiter.settled) continue;
			waiter.settled = true;
			waiter.reject(error);
		}
		entry.waiters = [];
	}

	private addWaiter<T>(entry: QueueEntry<T>, waiter: QueueWaiter<T>, signal?: AbortSignal): void {
		entry.waiters.push(waiter);
		if (!signal) return;
		const onAbort = () => {
			if (waiter.settled) return;
			waiter.settled = true;
			waiter.cleanup?.();
			waiter.reject(abortError(signal.reason));
			if (!entry.started && entry.waiters.every(item => item.settled)) {
				if (entry.timer !== undefined) this.scheduler.clearTimeout(entry.timer);
				if (this.pending.get(entry.key) === entry) this.pending.delete(entry.key);
				entry.settled = true;
			}
		};
		waiter.cleanup = () => signal.removeEventListener('abort', onAbort);
		signal.addEventListener('abort', onAbort, { once: true });
		if (signal.aborted) onAbort();
	}

	private delay(delayMs: number, signal: AbortSignal): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			if (signal.aborted) {
				reject(abortError(signal.reason));
				return;
			}
			const onAbort = () => {
				this.scheduler.clearTimeout(timer);
				signal.removeEventListener('abort', onAbort);
				reject(abortError(signal.reason));
			};
			const timer = this.scheduler.setTimeout(() => {
				signal.removeEventListener('abort', onAbort);
				resolve();
			}, delayMs);
			signal.addEventListener('abort', onAbort, { once: true });
		});
	}
}

export const SerializedSyncQueue = SyncQueue;
