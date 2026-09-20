import type { ProviderId } from './CalendarProvider';

export type ProviderErrorCategory =
	| 'authentication'
	| 'authorization'
	| 'throttling'
	| 'transient'
	| 'permanent'
	| 'conflict'
	| 'cursor-expired'
	| 'unsupported'
	| 'cancelled';

export interface ProviderErrorOptions {
	readonly category: ProviderErrorCategory;
	readonly code?: string;
	readonly providerId?: ProviderId;
	readonly status?: number;
	readonly retryAfterMs?: number;
	readonly retryAt?: number | string;
	readonly operation?: string;
	readonly details?: Readonly<Record<string, unknown>>;
	readonly cause?: unknown;
}

/**
 * Categorized, secret-safe provider failure. Adapters should put response
 * identifiers in `details`, never access/refresh tokens or authorization
 * headers. The sync engine can use `category` and retry metadata without
 * understanding provider-specific status codes.
 */
export class ProviderError extends Error {
	readonly category: ProviderErrorCategory;
	readonly code: string;
	readonly providerId?: ProviderId;
	readonly status?: number;
	readonly retryAfterMs?: number;
	readonly retryAt?: number | string;
	readonly operation?: string;
	readonly details?: Readonly<Record<string, unknown>>;
	readonly cause?: unknown;

	constructor(message: string, options: ProviderErrorOptions) {
		super(message);
		this.name = 'ProviderError';
		this.category = options.category;
		this.code = options.code ?? options.category;
		this.providerId = options.providerId;
		this.status = options.status;
		this.retryAfterMs = options.retryAfterMs;
		this.retryAt = options.retryAt;
		this.operation = options.operation;
		this.details = options.details;
		this.cause = options.cause;
		Object.setPrototypeOf(this, ProviderError.prototype);
	}

	get retryable(): boolean {
		return this.category === 'throttling' || this.category === 'transient';
	}

	/** A log-safe structured representation (without causes or credentials). */
	toJSON(): Readonly<Record<string, unknown>> {
		return {
			name: this.name,
			category: this.category,
			code: this.code,
			providerId: this.providerId,
			status: this.status,
			retryAfterMs: this.retryAfterMs,
			retryAt: this.retryAt,
			operation: this.operation,
			message: this.message,
		};
	}
}

/** Cancellation has a stable AbortError name for callers using AbortSignal. */
export class ProviderCancelledError extends ProviderError {
	constructor(message = 'Provider operation was cancelled', providerId?: ProviderId) {
		super(message, { category: 'cancelled', code: 'aborted', providerId });
		this.name = 'AbortError';
		Object.setPrototypeOf(this, ProviderCancelledError.prototype);
	}
}

export function isProviderError(value: unknown): value is ProviderError {
	return value instanceof ProviderError;
}

export function isProviderCancelledError(value: unknown): value is ProviderCancelledError {
	return value instanceof ProviderCancelledError;
}

export function providerError(message: string, options: ProviderErrorOptions): ProviderError {
	return new ProviderError(message, options);
}

export function authenticationError(
	message = 'Provider authentication failed',
	options: Omit<ProviderErrorOptions, 'category'> = {},
): ProviderError {
	return new ProviderError(message, { ...options, category: 'authentication' });
}

export function authorizationError(
	message = 'Provider authorization failed',
	options: Omit<ProviderErrorOptions, 'category'> = {},
): ProviderError {
	return new ProviderError(message, { ...options, category: 'authorization' });
}

export function throttlingError(
	message = 'Provider rate limit exceeded',
	retryAfterMs?: number,
	options: Omit<ProviderErrorOptions, 'category' | 'retryAfterMs'> = {},
): ProviderError {
	return new ProviderError(message, {
		...options,
		category: 'throttling',
		retryAfterMs,
	});
}

export function transientError(
	message = 'Temporary provider failure',
	options: Omit<ProviderErrorOptions, 'category'> = {},
): ProviderError {
	return new ProviderError(message, { ...options, category: 'transient' });
}

export function permanentError(
	message = 'Permanent provider failure',
	options: Omit<ProviderErrorOptions, 'category'> = {},
): ProviderError {
	return new ProviderError(message, { ...options, category: 'permanent' });
}

export function conflictError(
	message = 'Provider version conflict',
	options: Omit<ProviderErrorOptions, 'category'> = {},
): ProviderError {
	return new ProviderError(message, { ...options, category: 'conflict' });
}

export function cursorExpiredError(
	message = 'Provider change cursor expired',
	options: Omit<ProviderErrorOptions, 'category'> = {},
): ProviderError {
	return new ProviderError(message, { ...options, category: 'cursor-expired' });
}

export function unsupportedError(
	message = 'Provider operation is unsupported',
	options: Omit<ProviderErrorOptions, 'category'> = {},
): ProviderError {
	return new ProviderError(message, { ...options, category: 'unsupported' });
}

export function cancelledError(
	message = 'Provider operation was cancelled',
	providerId?: ProviderId,
): ProviderCancelledError {
	return new ProviderCancelledError(message, providerId);
}

