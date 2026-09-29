import {
	authenticationError,
	authorizationError,
	ProviderCancelledError,
	ProviderError,
	throttlingError,
	transientError,
} from '../ProviderErrors';
import type {
	ProviderClock,
	ProviderHttpRequest,
	ProviderHttpResponse,
	ProviderSession,
} from '../CalendarProvider';

const GOOGLE_PROVIDER_ID = 'google' as const;
const DEFAULT_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const DEFAULT_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DEFAULT_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const DEFAULT_ACCOUNT_ENDPOINT = 'https://www.googleapis.com/calendar/v3/users/me/calendarList/primary';
const DEFAULT_SCOPE =
	'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const DEFAULT_TIMEOUT_MS = 120_000;

export interface GoogleOAuthCallback {
	readonly pathname: string;
	readonly state?: string;
	readonly code?: string;
	readonly error?: string;
	readonly errorDescription?: string;
}

export interface GoogleLoopbackListener {
	/** Exact redirect URI including the OS-assigned port. */
	readonly redirectUri: string;
	waitForCallback(signal?: AbortSignal): Promise<GoogleOAuthCallback>;
	close(): Promise<void> | void;
}

export interface GoogleLoopbackListenerFactory {
	listen(options: {
		readonly host: '127.0.0.1';
		readonly port: 0;
		readonly path: '/';
		readonly state: string;
	}): Promise<GoogleLoopbackListener>;
}

export interface GoogleCredentialStore {
	get(accountId: string): Promise<string | null>;
	set(accountId: string, refreshToken: string): Promise<void>;
	remove(accountId: string): Promise<void>;
}

export interface GoogleOAuthProviderOptions {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly transport: {
		request(request: ProviderHttpRequest): Promise<ProviderHttpResponse>;
	};
	readonly listenerFactory: GoogleLoopbackListenerFactory;
	readonly openExternal: (url: string) => Promise<void> | void;
	readonly credentialStore?: GoogleCredentialStore;
	readonly scope?: string;
	readonly timeoutMs?: number;
	readonly clock?: ProviderClock;
	readonly randomBytes?: (length: number) => Uint8Array;
	readonly digest?: (algorithm: 'SHA-256', data: Uint8Array) => Promise<ArrayBuffer>;
	readonly authorizationEndpoint?: string;
	readonly tokenEndpoint?: string;
	readonly revokeEndpoint?: string;
	readonly accountEndpoint?: string;
	/** Resolve a stable provider account identity after token exchange. */
	readonly resolveAccountId?: (
		accessToken: string,
		token: GoogleTokenResponse,
	) => Promise<string>;
	/** Synchronous fixture hook retained for deterministic tests. */
	readonly accountIdFromToken?: (token: GoogleTokenResponse) => string | undefined;
}

export interface GoogleTokenResponse {
	readonly access_token?: unknown;
	readonly expires_in?: unknown;
	readonly refresh_token?: unknown;
	readonly scope?: unknown;
	readonly token_type?: unknown;
	readonly account_id?: unknown;
	readonly sub?: unknown;
	readonly email?: unknown;
}

export interface GoogleAuthorizationResult {
	readonly accountId: string;
	readonly session: ProviderSession;
	readonly refreshToken?: string;
	readonly grantedScopes: readonly string[];
}

function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function isCredentialStoreFailure(error: unknown): boolean {
	return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'credential-storage-failed');
}

function readResponseBody(response: ProviderHttpResponse): unknown {
	if (response.body !== undefined) return response.body;
	const responseWithJson = response as ProviderHttpResponse & { readonly json?: unknown; readonly text?: unknown };
	if (responseWithJson.json !== undefined) return responseWithJson.json;
	if (typeof responseWithJson.text === 'string' && responseWithJson.text.length > 0) {
		try {
			return JSON.parse(responseWithJson.text);
		} catch (_error) {
			return undefined;
		}
	}
	return undefined;
}

function base64Url(bytes: Uint8Array): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
	let output = '';
	for (let index = 0; index < bytes.length; index += 3) {
		const first = bytes[index];
		const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
		const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
		output += alphabet[first >> 2];
		output += alphabet[((first & 3) << 4) | (second >> 4)];
		output += index + 1 < bytes.length ? alphabet[((second & 15) << 2) | (third >> 6)] : '=';
		output += index + 2 < bytes.length ? alphabet[third & 63] : '=';
	}
	return output.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function utf8(value: string): Uint8Array {
	const encoded = encodeURIComponent(value);
	const bytes: number[] = [];
	for (let index = 0; index < encoded.length; index += 1) {
		if (encoded[index] === '%') {
			bytes.push(Number.parseInt(encoded.slice(index + 1, index + 3), 16));
			index += 2;
		} else {
			bytes.push(encoded.charCodeAt(index));
		}
	}
	return new Uint8Array(bytes);
}

function encodeForm(values: Readonly<Record<string, string>>): string {
	return Object.keys(values)
		.map(key => `${encodeURIComponent(key)}=${encodeURIComponent(values[key])}`)
		.join('&');
}

function parseGrantedScopes(value: unknown): readonly string[] {
	return typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : [];
}

function parseExpiry(value: unknown, now: number): string | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
	return new Date(now + value * 1000).toISOString();
}

function readHeader(headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	const expected = name.toLowerCase();
	const key = Object.keys(headers).find(header => header.toLowerCase() === expected);
	return key === undefined ? undefined : headers[key];
}

function parseRetryAfter(headers: Readonly<Record<string, string>> | undefined, now: number): number | undefined {
	const value = readHeader(headers, 'retry-after');
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function makeAbortError(providerMessage: string): ProviderCancelledError {
	return new ProviderCancelledError(providerMessage, GOOGLE_PROVIDER_ID);
}

/**
 * Google desktop OAuth orchestration. Every browser, loopback, randomness,
 * digest, clock, and HTTP operation is injected so this module remains
 * testable and does not import Node/Electron APIs on mobile.
 */
export class GoogleOAuthProvider {
	private readonly clientId: string;
	private readonly clientSecret: string;
	private readonly transport: GoogleOAuthProviderOptions['transport'];
	private readonly listenerFactory: GoogleLoopbackListenerFactory;
	private readonly openExternal: GoogleOAuthProviderOptions['openExternal'];
	private readonly credentialStore?: GoogleCredentialStore;
	private readonly scope: string;
	private readonly timeoutMs: number;
	private readonly clock: ProviderClock;
	private readonly randomBytes: (length: number) => Uint8Array;
	private readonly digest?: GoogleOAuthProviderOptions['digest'];
	private readonly authorizationEndpoint: string;
	private readonly tokenEndpoint: string;
	private readonly revokeEndpoint: string;
	private readonly accountEndpoint: string;
	private readonly resolveAccountId?: GoogleOAuthProviderOptions['resolveAccountId'];
	private readonly accountIdFromToken?: GoogleOAuthProviderOptions['accountIdFromToken'];
	private readonly grantedScopesByAccount = new Map<string, readonly string[]>();

	constructor(options: GoogleOAuthProviderOptions) {
		if (!options.clientId.trim()) throw new Error('Google OAuth client ID is required');
		if (!options.clientSecret.trim()) throw new Error('Google OAuth client secret is required');
		this.clientId = options.clientId;
		this.clientSecret = options.clientSecret;
		this.transport = options.transport;
		this.listenerFactory = options.listenerFactory;
		this.openExternal = options.openExternal;
		this.credentialStore = options.credentialStore;
		this.scope = options.scope ?? DEFAULT_SCOPE;
		this.timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
		this.clock = options.clock ?? { now: () => Date.now() };
		this.randomBytes = options.randomBytes ?? (length => {
			if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
				throw new Error('Secure random values are unavailable');
			}
			return crypto.getRandomValues(new Uint8Array(length));
		});
		this.digest = options.digest;
		this.authorizationEndpoint = options.authorizationEndpoint ?? DEFAULT_AUTHORIZATION_ENDPOINT;
		this.tokenEndpoint = options.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT;
		this.revokeEndpoint = options.revokeEndpoint ?? DEFAULT_REVOKE_ENDPOINT;
		this.accountEndpoint = options.accountEndpoint ?? DEFAULT_ACCOUNT_ENDPOINT;
		this.resolveAccountId = options.resolveAccountId;
		this.accountIdFromToken = options.accountIdFromToken;
	}

	async authorize(signal?: AbortSignal, loginHint?: string): Promise<GoogleAuthorizationResult> {
		if (signal?.aborted) throw makeAbortError('Google authorization was cancelled');
		let state: string;
		let verifier: string;
		try {
			state = base64Url(this.randomBytes(32));
			verifier = base64Url(this.randomBytes(64));
		} catch (_error) {
			throw authenticationError('Google OAuth randomness is unavailable', {
				providerId: GOOGLE_PROVIDER_ID,
				code: 'randomness-unavailable',
			});
		}
		const challenge = await this.pkceChallenge(verifier);
		let listener: GoogleLoopbackListener | undefined;
		try {
			listener = await this.listenerFactory.listen({ host: '127.0.0.1', port: 0, path: '/', state });
			const redirectUri = listener.redirectUri;
			const authorizationUrl = this.authorizationUrl(redirectUri, state, challenge, loginHint);
			await this.openExternal(authorizationUrl);
			const callback = await this.waitForCallback(listener, signal);
			this.validateCallback(callback, redirectUri, state);
			await listener.close();
			listener = undefined;
			const token = await this.exchangeCode(callback.code as string, verifier, redirectUri, signal);
			const connection = await this.connectionFromToken(token, undefined, undefined, signal);
			if (connection.refreshToken && this.credentialStore) {
				await this.credentialStore.set(connection.accountId, connection.refreshToken);
			} else if (this.credentialStore) {
				// Google can omit refresh_token after a prior consent grant. Reuse a
				// previously persisted token for this account, but never report a new
				// connection as successful when no restart-safe credential exists.
				const savedCredential = await this.credentialStore.get(connection.accountId);
				if (!savedCredential) {
					throw authenticationError(
						'Google did not provide a refresh credential. Revoke this app in your Google Account permissions, then connect again.',
						{ providerId: GOOGLE_PROVIDER_ID, code: 'missing-refresh-token' },
					);
				}
				return { ...connection, refreshToken: savedCredential };
			}
			return connection;
		} catch (error) {
			if (error instanceof ProviderError || isCredentialStoreFailure(error)) throw error;
			if (signal?.aborted) throw makeAbortError('Google authorization was cancelled');
			throw transientError('Google authorization failed', {
				providerId: GOOGLE_PROVIDER_ID,
				code: 'authorization-failed',
			});
		} finally {
			if (listener) await listener.close();
		}
	}

	async refresh(accountId: string, refreshToken?: string, signal?: AbortSignal): Promise<GoogleAuthorizationResult> {
		if (signal?.aborted) throw makeAbortError('Google token refresh was cancelled');
		const credential = refreshToken ?? (await this.credentialStore?.get(accountId));
		if (!credential) {
			throw authenticationError('Google refresh credential is unavailable', {
				providerId: GOOGLE_PROVIDER_ID,
				code: 'missing-refresh-token',
			});
		}
		const token = await this.tokenRequest(
			{
				client_id: this.clientId,
				client_secret: this.clientSecret,
				refresh_token: credential,
				grant_type: 'refresh_token',
			},
			'refresh-token',
			signal,
		);
		const connection = await this.connectionFromToken(token, accountId, credential, signal);
		if (connection.refreshToken && this.credentialStore) {
			await this.credentialStore.set(connection.accountId, connection.refreshToken);
		}
		return connection;
	}

	async reconnect(signal?: AbortSignal, loginHint?: string): Promise<GoogleAuthorizationResult> {
		return this.authorize(signal, loginHint);
	}

	async revoke(accountId: string, refreshToken?: string, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw makeAbortError('Google token revocation was cancelled');
		const credential = refreshToken ?? (await this.credentialStore?.get(accountId));
		if (!credential) {
			if (this.credentialStore) await this.credentialStore.remove(accountId);
			return;
		}
		const response = await this.requestTokenEndpoint(
			this.revokeEndpoint,
			encodeForm({ token: credential }),
			'revoke-token',
			signal,
		);
		if (response.status < 200 || response.status >= 300) {
			throw this.oauthError(response, 'revoke-token');
		}
		if (this.credentialStore) await this.credentialStore.remove(accountId);
	}

	private authorizationUrl(redirectUri: string, state: string, challenge: string, loginHint?: string): string {
		const query: Record<string, string> = {
			client_id: this.clientId,
			redirect_uri: redirectUri,
			response_type: 'code',
			scope: this.scope,
			access_type: 'offline',
			prompt: 'consent',
			code_challenge: challenge,
			code_challenge_method: 'S256',
			state,
		};
		if (loginHint) query.login_hint = loginHint;
		return `${this.authorizationEndpoint}?${Object.keys(query)
			.map(key => `${encodeURIComponent(key)}=${encodeURIComponent(query[key])}`)
			.join('&')}`;
	}

	private async pkceChallenge(verifier: string): Promise<string> {
		const bytes = utf8(verifier);
		let digest: ArrayBuffer;
		try {
			digest = this.digest
				? await this.digest('SHA-256', bytes)
				: await crypto.subtle.digest('SHA-256', bytes);
		} catch (_error) {
			throw authenticationError('Google OAuth PKCE digest is unavailable', {
				providerId: GOOGLE_PROVIDER_ID,
				code: 'pkce-unavailable',
			});
		}
		return base64Url(new Uint8Array(digest));
	}

	private async waitForCallback(
		listener: GoogleLoopbackListener,
		signal?: AbortSignal,
	): Promise<GoogleOAuthCallback> {
		if (signal?.aborted) throw makeAbortError('Google OAuth callback was cancelled');
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		let abortHandler: (() => void) | undefined;
		const timeout = new Promise<GoogleOAuthCallback>((_resolve, reject) => {
			timeoutHandle = setTimeout(() => {
				reject(
					authenticationError('Google OAuth callback timed out', {
						providerId: GOOGLE_PROVIDER_ID,
						code: 'callback-timeout',
					}),
				);
			}, this.timeoutMs);
		});
		const aborted = new Promise<GoogleOAuthCallback>((_resolve, reject) => {
			if (!signal) return;
			abortHandler = () => reject(makeAbortError('Google OAuth callback was cancelled'));
			signal.addEventListener('abort', abortHandler, { once: true });
		});
		try {
			return await Promise.race([listener.waitForCallback(signal), timeout, aborted]);
		} finally {
			if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
			if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
		}
	}

	private validateCallback(callback: GoogleOAuthCallback, redirectUri: string, expectedState: string): void {
		let expectedPath = '/';
		try {
			expectedPath = new URL(redirectUri).pathname;
		} catch (_error) {
			throw authenticationError('Google OAuth redirect URI is invalid', {
				providerId: GOOGLE_PROVIDER_ID,
				code: 'invalid-redirect-uri',
			});
		}
		if (callback.pathname !== expectedPath) {
			throw authenticationError('Google OAuth callback path is invalid', {
				providerId: GOOGLE_PROVIDER_ID,
				code: 'invalid-callback-path',
			});
		}
		if (callback.state !== expectedState) {
			throw authenticationError('Google OAuth callback state is invalid', {
				providerId: GOOGLE_PROVIDER_ID,
				code: 'invalid-state',
			});
		}
		if (callback.error) {
			throw authorizationError('Google authorization was denied', {
				providerId: GOOGLE_PROVIDER_ID,
				code: callback.error === 'access_denied' ? 'access-denied' : 'authorization-error',
			});
		}
		if (!callback.code) {
			throw authenticationError('Google OAuth callback did not include a code', {
				providerId: GOOGLE_PROVIDER_ID,
				code: 'missing-authorization-code',
			});
		}
	}

	private async exchangeCode(
		code: string,
		verifier: string,
		redirectUri?: string,
		signal?: AbortSignal,
	): Promise<GoogleTokenResponse> {
		// The listener is closed before exchange. The redirect URI is retained by
		// the caller in normal operation; this guard keeps malformed test doubles
		// from ever sending an empty redirect value to Google.
		if (!redirectUri) {
			throw authenticationError('Google OAuth redirect URI was lost before exchange', {
				providerId: GOOGLE_PROVIDER_ID,
				code: 'missing-redirect-uri',
			});
		}
		return this.tokenRequest(
			{
				client_id: this.clientId,
				client_secret: this.clientSecret,
				code,
				code_verifier: verifier,
				grant_type: 'authorization_code',
				redirect_uri: redirectUri,
			},
			'authorization-code',
			signal,
		);
	}

	private async connectionFromToken(
		token: GoogleTokenResponse,
		accountId: string | undefined,
		priorRefreshToken?: string,
		signal?: AbortSignal,
	): Promise<GoogleAuthorizationResult> {
		const accessToken = asNonEmptyString(token.access_token);
		if (!accessToken) {
			throw authenticationError('Google token response did not include an access token', {
				providerId: GOOGLE_PROVIDER_ID,
				code: 'missing-access-token',
			});
		}
		const refreshToken = asNonEmptyString(token.refresh_token) ?? priorRefreshToken;
		const resolvedAccountId = asNonEmptyString(accountId ?? this.accountIdFromToken?.(token));
		const identifiedAccountId =
			resolvedAccountId ??
			(this.resolveAccountId
				? asNonEmptyString(await this.resolveAccountId(accessToken, token))
				: await this.fetchAccountId(accessToken, signal));
		if (!identifiedAccountId) {
			throw authenticationError('Google token response did not identify an account', {
				providerId: GOOGLE_PROVIDER_ID,
				code: 'account-identity-unavailable',
			});
		}
		const returnedScopes = parseGrantedScopes(token.scope);
		const requiredScopes = parseGrantedScopes(this.scope);
		const grantedScopes =
			returnedScopes.length > 0
				? returnedScopes
				: this.grantedScopesByAccount.get(identifiedAccountId) ?? requiredScopes;
		const missingScopes = requiredScopes.filter(scope => !grantedScopes.includes(scope));
		if (missingScopes.length > 0) {
			throw authorizationError('Google OAuth did not grant the required calendar scopes', {
				providerId: GOOGLE_PROVIDER_ID,
				code: 'missing-required-scope',
				details: { missingScopes },
			});
		}
		this.grantedScopesByAccount.set(identifiedAccountId, grantedScopes);
		const session: ProviderSession = {
			providerId: GOOGLE_PROVIDER_ID,
			accountId: identifiedAccountId,
			accessToken,
			expiresAt: parseExpiry(token.expires_in, this.clock.now()),
		};
		return {
			accountId: identifiedAccountId,
			session,
			refreshToken,
			grantedScopes,
		};
	}

	private async fetchAccountId(accessToken: string, signal?: AbortSignal): Promise<string | undefined> {
		if (signal?.aborted) throw makeAbortError('Google account discovery was cancelled');
		let response: ProviderHttpResponse;
		try {
			response = await this.transport.request({
				method: 'GET',
				url: this.accountEndpoint,
				headers: {
					Accept: 'application/json',
					Authorization: `Bearer ${accessToken}`,
				},
				signal,
			});
		} catch (_error) {
			if (signal?.aborted) throw makeAbortError('Google account discovery was cancelled');
			throw transientError('Google account discovery failed before an HTTP response', {
				providerId: GOOGLE_PROVIDER_ID,
				operation: 'account-identity',
			});
		}
		if (response.status < 200 || response.status >= 300) {
			throw this.oauthError(response, 'account-identity');
		}
		const body = readResponseBody(response);
		return asNonEmptyString(
			typeof body === 'object' && body !== null && !Array.isArray(body)
				? (body as Readonly<Record<string, unknown>>).id
				: undefined,
		);
	}

	private async tokenRequest(
		values: Readonly<Record<string, string>>,
		operation: string,
		signal?: AbortSignal,
	): Promise<GoogleTokenResponse> {
		const response = await this.requestTokenEndpoint(
			this.tokenEndpoint,
			encodeForm(values),
			operation,
			signal,
		);
		if (response.status < 200 || response.status >= 300) throw this.oauthError(response, operation);
		const body = readResponseBody(response);
		if (typeof body !== 'object' || body === null || Array.isArray(body)) {
			throw authenticationError('Google token response was invalid', {
				providerId: GOOGLE_PROVIDER_ID,
				code: 'invalid-token-response',
			});
		}
		return body as GoogleTokenResponse;
	}

	private async requestTokenEndpoint(
		url: string,
		body: string,
		operation: string,
		signal?: AbortSignal,
	): Promise<ProviderHttpResponse> {
		if (signal?.aborted) throw makeAbortError('Google OAuth operation was cancelled');
		const request: ProviderHttpRequest = {
			method: 'POST',
			url,
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body,
			signal,
		};
		try {
			return await this.transport.request(request);
		} catch (_error) {
			if (signal?.aborted) throw makeAbortError('Google OAuth operation was cancelled');
			throw transientError('Google OAuth request failed before an HTTP response', {
				providerId: GOOGLE_PROVIDER_ID,
				operation,
			});
		}
	}

	private oauthError(response: ProviderHttpResponse, operation: string): ProviderError {
		const base = {
			providerId: GOOGLE_PROVIDER_ID,
			status: response.status,
			operation,
		};
		if (response.status === 400 || response.status === 401) {
			return authenticationError('Google OAuth authentication failed', { ...base, code: `http-${response.status}` });
		}
		if (response.status === 403) {
			return authorizationError('Google OAuth authorization failed', { ...base, code: 'http-403' });
		}
		if (response.status === 429) {
			return throttlingError('Google OAuth rate limit exceeded', parseRetryAfter(response.headers, this.clock.now()), {
				...base,
				code: 'http-429',
			});
		}
		return response.status >= 500
			? transientError('Google OAuth service is temporarily unavailable', { ...base, code: `http-${response.status}` })
			: authenticationError('Google OAuth request was rejected', { ...base, code: `http-${response.status}` });
	}
}
