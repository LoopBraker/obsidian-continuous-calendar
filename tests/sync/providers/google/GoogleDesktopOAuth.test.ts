import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import type { ServerResponse } from 'http';

import { ProviderError } from '../../../../src/services/sync/providers/ProviderErrors';
import {
	NodeGoogleLoopbackListenerFactory,
	openGoogleAuthorizationInSystemBrowser,
} from '../../../../src/services/sync/providers/google/GoogleDesktopOAuth';

async function providerError(promise: Promise<unknown>): Promise<ProviderError> {
	try {
		await promise;
		throw new Error('Expected provider error');
	} catch (error) {
		expect(error).toBeInstanceOf(ProviderError);
		return error as ProviderError;
	}
}

describe('Google desktop OAuth boundaries', () => {
	it('binds an ephemeral IPv4 loopback listener and accepts only the expected path and state', async () => {
		class FakeServer extends EventEmitter {
			listenOptions?: { port: number; host: string };
			listen(port: number, host: string, callback: () => void): this {
				this.listenOptions = { port, host };
				callback();
				return this;
			}
			address() { return { address: '127.0.0.1', family: 'IPv4', port: 43123 }; }
			close(callback?: (error?: Error) => void): this { callback?.(); return this; }
		}
		class FakeResponse {
			statusCode = 0;
			readonly headers: Record<string, string> = {};
			body = '';
			setHeader(name: string, value: string): void { this.headers[name] = value; }
			end(body: string): void { this.body = body; }
		}
		const server = new FakeServer();
		const listener = await new NodeGoogleLoopbackListenerFactory(() => ({
			createServer: () => server,
		}) as never).listen({
			host: '127.0.0.1',
			port: 0,
			path: '/',
			state: 'expected-state',
		});
		try {
			const redirect = new URL(listener.redirectUri);
			expect(redirect.hostname).toBe('127.0.0.1');
			expect(redirect.port).toBe('43123');
			expect(server.listenOptions).toEqual({ port: 0, host: '127.0.0.1' });

			const wrongPath = new FakeResponse();
			server.emit('request', { method: 'GET', url: '/wrong?state=expected-state&code=code' }, wrongPath as unknown as ServerResponse);
			expect(wrongPath.statusCode).toBe(404);
			const wrongState = new FakeResponse();
			server.emit('request', { method: 'GET', url: '/?state=wrong&code=secret-code' }, wrongState as unknown as ServerResponse);
			expect(wrongState.statusCode).toBe(400);

			const pending = listener.waitForCallback();
			const accepted = new FakeResponse();
			server.emit('request', { method: 'GET', url: '/?state=expected-state&code=authorization-code' }, accepted as unknown as ServerResponse);
			expect(accepted.statusCode).toBe(200);
			expect(await pending).toEqual({
				pathname: '/',
				state: 'expected-state',
				code: 'authorization-code',
				error: undefined,
				errorDescription: undefined,
			});
		} finally {
			await listener.close();
		}
	});

	it('opens only the fixed Google HTTPS authorization origin', async () => {
		const opened: string[] = [];
		await openGoogleAuthorizationInSystemBrowser(
			'https://accounts.google.com/o/oauth2/v2/auth?client_id=test',
			() => ({ shell: { async openExternal(url: string) { opened.push(url); } } }),
		);
		expect(opened).toEqual(['https://accounts.google.com/o/oauth2/v2/auth?client_id=test']);

		const untrusted = await providerError(openGoogleAuthorizationInSystemBrowser(
			'https://example.com/oauth?code=secret',
			() => ({ shell: { async openExternal() {} } }),
		));
		expect(untrusted.code).toBe('untrusted-authorization-origin');
		expect(JSON.stringify(untrusted)).not.toContain('secret');
	});

	it('fails closed when the desktop browser bridge is unavailable', async () => {
		const error = await providerError(openGoogleAuthorizationInSystemBrowser(
			'https://accounts.google.com/o/oauth2/v2/auth',
			() => ({}),
		));
		expect(error).toMatchObject({ category: 'authentication', code: 'system-browser-unavailable' });
	});
});
