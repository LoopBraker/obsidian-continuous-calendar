import { describe, expect, it } from 'vitest';

import type {
	ProviderHttpRequest,
	ProviderHttpResponse,
	ProviderHttpTransport,
} from '../../../../src/services/sync/providers/CalendarProvider';
import { ProviderError } from '../../../../src/services/sync/providers/ProviderErrors';
import { createCredentialStore } from '../../../../src/services/sync/state/CredentialStore';
import {
	GoogleOAuthProvider,
	type GoogleCredentialStore,
	type GoogleLoopbackListener,
} from '../../../../src/services/sync/providers/google/GoogleOAuthProvider';

const REQUIRED_SCOPES =
	'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly';

class QueueTransport implements ProviderHttpTransport {
	readonly requests: ProviderHttpRequest[] = [];
	readonly responses: Array<ProviderHttpResponse | Error>;

	constructor(...responses: Array<ProviderHttpResponse | Error>) {
		this.responses = responses;
	}

	async request(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
		this.requests.push(request);
		const response = this.responses.shift();
		if (!response) throw new Error('Unexpected request');
		if (response instanceof Error) throw response;
		return response;
	}
}

class MemoryCredentials implements GoogleCredentialStore {
	readonly values = new Map<string, string>();
	readonly setCalls: Array<[string, string]> = [];
	readonly removeCalls: string[] = [];

	async get(accountId: string): Promise<string | null> {
		return this.values.get(accountId) ?? null;
	}

	async set(accountId: string, refreshToken: string): Promise<void> {
		this.setCalls.push([accountId, refreshToken]);
		this.values.set(accountId, refreshToken);
	}

	async remove(accountId: string): Promise<void> {
		this.removeCalls.push(accountId);
		this.values.delete(accountId);
	}
}

function tokenResponse(overrides: Record<string, unknown> = {}): ProviderHttpResponse {
	return {
		status: 200,
		body: {
			access_token: 'access-secret',
			refresh_token: 'refresh-secret',
			expires_in: 3600,
			scope: REQUIRED_SCOPES,
			token_type: 'Bearer',
			...overrides,
		},
	};
}

function makeOAuth(options: {
	transport: QueueTransport;
	listener?: GoogleLoopbackListener;
	openExternal?: (url: string) => void | Promise<void>;
	credentials?: GoogleCredentialStore;
	timeoutMs?: number;
	scope?: string;
}) {
	let lastUrl = '';
	let closeCount = 0;
	const listener = options.listener ?? {
		redirectUri: 'http://127.0.0.1:43123/',
		async waitForCallback() {
			const state = new URL(lastUrl).searchParams.get('state') as string;
			return { pathname: '/', state, code: 'authorization-secret' };
		},
		close() { closeCount += 1; },
	};
	const provider = new GoogleOAuthProvider({
		clientId: 'desktop-client-id',
		clientSecret: 'desktop-client-secret',
		transport: options.transport,
		listenerFactory: { async listen() { return listener; } },
		openExternal: async url => {
			lastUrl = url;
			await options.openExternal?.(url);
		},
		credentialStore: options.credentials,
		timeoutMs: options.timeoutMs,
		scope: options.scope,
		clock: { now: () => Date.parse('2026-09-20T12:00:00Z') },
		randomBytes: length => new Uint8Array(length).fill(length),
		digest: async () => new Uint8Array([1, 2, 3, 4]).buffer,
		resolveAccountId: async accessToken => {
			expect(accessToken).toBe('access-secret');
			return 'account-1';
		},
	});
	return { provider, listener, getLastUrl: () => lastUrl, getCloseCount: () => closeCount };
}

async function providerError(promise: Promise<unknown>): Promise<ProviderError> {
	try {
		await promise;
		throw new Error('Expected provider error');
	} catch (error) {
		expect(error).toBeInstanceOf(ProviderError);
		return error as ProviderError;
	}
}

describe('GoogleOAuthProvider', () => {
	it('performs external-browser PKCE, reuses the exact redirect, and stores refresh credentials', async () => {
		const transport = new QueueTransport(tokenResponse());
		const credentials = new MemoryCredentials();
		const harness = makeOAuth({ transport, credentials });
		const result = await harness.provider.authorize(undefined, 'person@example.com');

		const authorizationUrl = new URL(harness.getLastUrl());
		expect(authorizationUrl.origin + authorizationUrl.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
		expect(authorizationUrl.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:43123/');
		expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
		expect(authorizationUrl.searchParams.get('code_challenge')).toBe('AQIDBA');
		expect(authorizationUrl.searchParams.get('state')).toHaveLength(43);
		expect(authorizationUrl.searchParams.get('access_type')).toBe('offline');
		expect(authorizationUrl.searchParams.get('prompt')).toBe('consent');
		expect(authorizationUrl.searchParams.get('scope')).toBe(REQUIRED_SCOPES);
		expect(authorizationUrl.searchParams.get('login_hint')).toBe('person@example.com');

		const tokenRequest = transport.requests[0];
		expect(tokenRequest.url).toBe('https://oauth2.googleapis.com/token');
		expect(tokenRequest.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
		const body = new URLSearchParams(tokenRequest.body);
		expect(body.get('code')).toBe('authorization-secret');
		expect(body.get('redirect_uri')).toBe('http://127.0.0.1:43123/');
		expect(body.get('code_verifier')).toHaveLength(86);
		expect(result).toMatchObject({
			accountId: 'account-1',
			session: { providerId: 'google', accountId: 'account-1', accessToken: 'access-secret' },
			refreshToken: 'refresh-secret',
		});
		expect(result.session.expiresAt).toBe('2026-09-20T13:00:00.000Z');
		expect(credentials.setCalls).toEqual([['account-1', 'refresh-secret']]);
		expect(harness.getCloseCount()).toBe(1);
	});

	it('refuses to finish a first connection without a stored refresh credential', async () => {
		const credentials = new MemoryCredentials();
		const harness = makeOAuth({
			transport: new QueueTransport(tokenResponse({ refresh_token: undefined })),
			credentials,
		});

		const error = await providerError(harness.provider.authorize());
		expect(error).toMatchObject({ category: 'authentication', code: 'missing-refresh-token' });
		expect(credentials.values.size).toBe(0);
	});

	it('refreshes from SecretStorage after recreating the credential store', async () => {
		const persistedValues = new Map<string, string>();
		const secretStorage = {
			getSecret: (id: string) => persistedValues.get(id) ?? null,
			setSecret: (id: string, value: string) => { persistedValues.set(id, value); },
		};
		const firstProcessStore = createCredentialStore({ secretStorage });
		await firstProcessStore.set('google', 'account-1', 'persisted-refresh');

		const restartedStore = createCredentialStore({ secretStorage });
		const credentials: GoogleCredentialStore = {
			async get(accountId) {
				return (await restartedStore.get('google', accountId))?.refreshToken ?? null;
			},
			async set(accountId, refreshToken) {
				await restartedStore.set('google', accountId, refreshToken);
			},
			async remove(accountId) {
				await restartedStore.remove('google', accountId);
			},
		};
		const transport = new QueueTransport(tokenResponse({ refresh_token: undefined }));
		const { provider } = makeOAuth({ transport, credentials });
		const refreshed = await provider.refresh('account-1');

		expect(new URLSearchParams(transport.requests[0].body).get('refresh_token')).toBe('persisted-refresh');
		expect(refreshed.session.accountId).toBe('account-1');
		expect(await restartedStore.get('google', 'account-1')).toEqual({ refreshToken: 'persisted-refresh' });
	});

	it('discovers the account from the primary calendar when token fields omit identity', async () => {
		let authorizationUrl = '';
		const transport = new QueueTransport(tokenResponse(), { status: 200, body: { id: 'stable-account-id' } });
		const listener: GoogleLoopbackListener = {
			redirectUri: 'http://127.0.0.1:43123/',
			async waitForCallback() {
				return {
					pathname: '/',
					state: new URL(authorizationUrl).searchParams.get('state') as string,
					code: 'authorization-code',
				};
			},
			close() {},
		};
		const provider = new GoogleOAuthProvider({
			clientId: 'desktop-client-id',
			clientSecret: 'desktop-client-secret',
			transport,
			listenerFactory: { async listen() { return listener; } },
			openExternal: url => { authorizationUrl = url; },
			randomBytes: length => new Uint8Array(length).fill(1),
			digest: async () => new Uint8Array([1, 2, 3]).buffer,
		});
		const result = await provider.authorize();
		expect(result.accountId).toBe('stable-account-id');
		expect(transport.requests[1]).toMatchObject({
			method: 'GET',
			url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList/primary',
			headers: { Authorization: 'Bearer access-secret' },
		});
	});

	it('rejects mismatched state before token exchange and closes the listener', async () => {
		let closed = 0;
		const listener: GoogleLoopbackListener = {
			redirectUri: 'http://127.0.0.1:43123/',
			async waitForCallback() { return { pathname: '/', state: 'wrong', code: 'secret-code' }; },
			close() { closed += 1; },
		};
		const transport = new QueueTransport(tokenResponse());
		const { provider } = makeOAuth({ transport, listener });
		const error = await providerError(provider.authorize());
		expect(error).toMatchObject({ category: 'authentication', code: 'invalid-state' });
		expect(transport.requests).toHaveLength(0);
		expect(closed).toBe(1);
		expect(JSON.stringify(error)).not.toContain('secret-code');
	});

	it('rejects the wrong callback path and provider denial without exposing details', async () => {
		const wrongPath: GoogleLoopbackListener = {
			redirectUri: 'http://127.0.0.1:43123/',
			async waitForCallback() { return { pathname: '/wrong', state: 'unused', code: 'code' }; },
			close() {},
		};
		const pathError = await providerError(makeOAuth({
			transport: new QueueTransport(tokenResponse()),
			listener: wrongPath,
		}).provider.authorize());
		expect(pathError.code).toBe('invalid-callback-path');

		let url = '';
		const denied: GoogleLoopbackListener = {
			redirectUri: 'http://127.0.0.1:43123/',
			async waitForCallback() {
				return { pathname: '/', state: new URL(url).searchParams.get('state') as string, error: 'access_denied', errorDescription: 'token=secret' };
			},
			close() {},
		};
		const denialHarness = makeOAuth({
			transport: new QueueTransport(tokenResponse()),
			listener: denied,
			openExternal: value => { url = value; },
		});
		const denial = await providerError(denialHarness.provider.authorize());
		expect(denial).toMatchObject({ category: 'authorization', code: 'access-denied' });
		expect(JSON.stringify(denial)).not.toContain('token=secret');
	});

	it('cancels and times out while always closing the loopback listener', async () => {
		let cancelledClosed = 0;
		const never: GoogleLoopbackListener = {
			redirectUri: 'http://127.0.0.1:43123/',
			waitForCallback() { return new Promise(() => undefined); },
			close() { cancelledClosed += 1; },
		};
		const cancelHarness = makeOAuth({ transport: new QueueTransport(), listener: never });
		const controller = new AbortController();
		const pending = cancelHarness.provider.authorize(controller.signal);
		await Promise.resolve();
		controller.abort();
		const cancelled = await providerError(pending);
		expect(cancelled).toMatchObject({ category: 'cancelled', name: 'AbortError' });
		expect(cancelledClosed).toBe(1);

		let timeoutClosed = 0;
		const timeoutListener = { ...never, close() { timeoutClosed += 1; } };
		const timeout = await providerError(makeOAuth({
			transport: new QueueTransport(), listener: timeoutListener, timeoutMs: 1,
		}).provider.authorize());
		expect(timeout).toMatchObject({ category: 'authentication', code: 'callback-timeout' });
		expect(timeoutClosed).toBe(1);
	});

	it('validates granted scopes before persisting credentials', async () => {
		const credentials = new MemoryCredentials();
		const harness = makeOAuth({
			transport: new QueueTransport(tokenResponse({ scope: 'https://www.googleapis.com/auth/calendar.events' })),
			credentials,
		});
		const error = await providerError(harness.provider.authorize());
		expect(error).toMatchObject({ category: 'authorization', code: 'missing-required-scope' });
		expect(credentials.setCalls).toHaveLength(0);
	});

	it('accepts an omitted scope per OAuth semantics and refreshes stored credentials', async () => {
		const credentials = new MemoryCredentials();
		credentials.values.set('account-1', 'old-refresh');
		const transport = new QueueTransport(tokenResponse({ scope: undefined, refresh_token: 'rotated-refresh' }));
		const { provider } = makeOAuth({ transport, credentials });
		const result = await provider.refresh('account-1');
		expect(result.grantedScopes).toEqual(REQUIRED_SCOPES.split(' '));
		expect(new URLSearchParams(transport.requests[0].body).get('refresh_token')).toBe('old-refresh');
		expect(credentials.values.get('account-1')).toBe('rotated-refresh');
	});

	it('revokes credentials and only removes storage after provider confirmation', async () => {
		const credentials = new MemoryCredentials();
		credentials.values.set('account-1', 'refresh-secret');
		const transport = new QueueTransport({ status: 200 });
		const { provider } = makeOAuth({ transport, credentials });
		await provider.revoke('account-1');
		expect(transport.requests[0].url).toBe('https://oauth2.googleapis.com/revoke');
		expect(new URLSearchParams(transport.requests[0].body).get('token')).toBe('refresh-secret');
		expect(credentials.removeCalls).toEqual(['account-1']);

		credentials.values.set('account-1', 'refresh-secret');
		const failed = makeOAuth({ transport: new QueueTransport({ status: 500 }), credentials }).provider;
		const error = await providerError(failed.revoke('account-1'));
		expect(error.category).toBe('transient');
		expect(credentials.values.get('account-1')).toBe('refresh-secret');
	});

	it('categorizes OAuth throttling and transport failures without leaking request secrets', async () => {
		const throttled = makeOAuth({
			transport: new QueueTransport({ status: 429, headers: { 'retry-after': '3' }, body: { error: 'refresh-secret' } }),
		}).provider;
		const throttleError = await providerError(throttled.refresh('account-1', 'refresh-secret'));
		expect(throttleError).toMatchObject({ category: 'throttling', retryAfterMs: 3_000 });
		expect(JSON.stringify(throttleError)).not.toContain('refresh-secret');

		const offline = makeOAuth({ transport: new QueueTransport(new Error('access-secret')) }).provider;
		const offlineError = await providerError(offline.refresh('account-1', 'refresh-secret'));
		expect(offlineError.category).toBe('transient');
		expect(offlineError.message).not.toContain('access-secret');
	});
});
