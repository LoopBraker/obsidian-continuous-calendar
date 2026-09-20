/**
 * Redaction helpers shared by plugin-data and sync-state persistence.  These
 * functions intentionally operate on untrusted values and never stringify an
 * arbitrary error/object before removing credential-shaped fields.
 */

export interface SanitizedSyncError {
	readonly code?: string;
	readonly status?: number;
	readonly message: string;
	readonly at?: string;
	readonly retryable?: boolean;
}

const SECRET_KEY_PATTERN = /(?:access|refresh)[_-]?(?:token|credential)|(?:client|api)[_-]?secret|(?:^|[_-])secret(?:$|[_-])|credential|password|authorization|code[_-]?verifier|private[_-]?key|(?:^|[_-])token(?:$|[_-])|token$/i;

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
	/\bBearer\s+[A-Za-z0-9._~+\-/]+=*/gi,
	/((?:access|refresh)[_-]?token|client[_-]?secret|code[_-]?verifier)\s*[=:]\s*[^\s,&}]+/gi,
	/((?:access|refresh)[_-]?token|client[_-]?secret|code[_-]?verifier)\s*%3D\s*[^&\s]+/gi,
	/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
	/\b(?:ya29\.|1\/\/)[A-Za-z0-9._~+\-/=]+/g,
];

function redactString(value: string): string {
	let redacted = value;
	for (const pattern of SECRET_VALUE_PATTERNS) {
		redacted = redacted.replace(pattern, match => {
			const separator = match.indexOf('=') >= 0 ? '=' : ':';
			if (/^Bearer\s/i.test(match)) return 'Bearer [REDACTED]';
			if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(match)) return '[REDACTED]';
			if (/^(?:ya29\.|1\/\/)/i.test(match)) return '[REDACTED]';
			const key = match.split(/[=:]/, 1)[0].trim();
			return `${key}${separator}[REDACTED]`;
		});
	}
	return redacted.length > 1024 ? `${redacted.slice(0, 1024)}…` : redacted;
}

/**
 * Deeply copy JSON-like ordinary plugin data while dropping fields whose
 * names can carry credentials.  Allowed strings are deliberately returned
 * byte-for-byte unchanged: cursors, delta links, JWT-shaped opaque values,
 * event descriptions, and provider text are domain data, not diagnostics.
 * Undefined/function/symbol values are omitted like JSON persistence would.
 */
export function stripCredentialFields(value: unknown, keyHint?: string): unknown {
	if (keyHint !== undefined && SECRET_KEY_PATTERN.test(keyHint)) return undefined;
	if (typeof value === 'string') return value;
	if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
	if (Array.isArray(value)) {
		return value
			.map(item => stripCredentialFields(item))
			.filter(item => item !== undefined);
	}
	if (typeof value !== 'object') return undefined;

	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (SECRET_KEY_PATTERN.test(key)) continue;
		const redacted = stripCredentialFields(item, key);
		if (redacted !== undefined) result[key] = redacted;
	}
	return result;
}

/** Backwards-compatible name for structured persistence sanitization. */
export const redactSecrets = stripCredentialFields;

/** Return an error-safe, bounded representation suitable for sync state. */
export function sanitizeSyncError(error: unknown, at?: string): SanitizedSyncError {
	let code: string | undefined;
	let status: number | undefined;
	let retryable: boolean | undefined;
	let message: string;

	if (error instanceof Error) {
		message = error.message;
		const candidate = error as Error & {
			code?: unknown;
			status?: unknown;
			retryable?: unknown;
		};
		if (typeof candidate.code === 'string') code = redactString(candidate.code).slice(0, 128);
		if (typeof candidate.status === 'number' && Number.isFinite(candidate.status)) status = candidate.status;
		if (typeof candidate.retryable === 'boolean') retryable = candidate.retryable;
	} else if (typeof error === 'string') {
		message = error;
	} else if (error && typeof error === 'object') {
		const candidate = error as Record<string, unknown>;
		message = typeof candidate.message === 'string' ? candidate.message : 'Synchronization failed';
		if (typeof candidate.code === 'string') code = redactString(candidate.code).slice(0, 128);
		if (typeof candidate.status === 'number' && Number.isFinite(candidate.status)) status = candidate.status;
		if (typeof candidate.retryable === 'boolean') retryable = candidate.retryable;
	} else {
		message = 'Synchronization failed';
	}

	const result: SanitizedSyncError = {
		message: redactString(message),
	};
	if (code !== undefined) (result as { code?: string }).code = code;
	if (status !== undefined) (result as { status?: number }).status = status;
	if (retryable !== undefined) (result as { retryable?: boolean }).retryable = retryable;
	if (at !== undefined && !SECRET_KEY_PATTERN.test(at)) (result as { at?: string }).at = redactString(at);
	return result;
}

/** Naming aliases for callers that use the shorter redaction terminology. */
export const sanitizeError = sanitizeSyncError;
export const redactError = sanitizeSyncError;

/** Useful in tests and diagnostics without exposing any original values. */
export function containsCredentialFields(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(item => containsCredentialFields(item));
	if (!value || typeof value !== 'object') return false;
	return Object.entries(value as Record<string, unknown>).some(([key, item]) =>
		SECRET_KEY_PATTERN.test(key) || containsCredentialFields(item),
	);
}
