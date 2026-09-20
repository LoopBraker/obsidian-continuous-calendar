import type { IncomingMessage, Server, ServerResponse } from 'http';
import type { AddressInfo } from 'net';

import { authenticationError, ProviderCancelledError } from '../ProviderErrors';
import type {
	GoogleLoopbackListener,
	GoogleLoopbackListenerFactory,
	GoogleOAuthCallback,
} from './GoogleOAuthProvider';

type NodeHttpModule = typeof import('http');
type ElectronModule = {
	readonly shell?: { openExternal(url: string): Promise<void> };
};

function runtimeRequire(moduleId: string): unknown {
	if (typeof require !== 'function') {
		throw authenticationError('Desktop OAuth runtime modules are unavailable', {
			providerId: 'google',
			code: 'desktop-runtime-unavailable',
		});
	}
	// Obsidian documents runtime require for desktop-only Electron/Node APIs.
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	return require(moduleId) as unknown;
}

function send(response: ServerResponse, status: number, message: string): void {
	response.statusCode = status;
	response.setHeader('Content-Type', 'text/html; charset=utf-8');
	response.setHeader('Cache-Control', 'no-store');
	response.end(`<!doctype html><meta charset="utf-8"><title>Continuous Calendar</title><p>${message}</p>`);
}

function callbackFromRequest(
	request: IncomingMessage,
	response: ServerResponse,
	redirectUri: string,
	expectedPath: string,
	expectedState: string,
): GoogleOAuthCallback | undefined {
	if (request.method !== 'GET' || !request.url) {
		send(response, 405, 'Unsupported callback request.');
		return undefined;
	}
	let url: URL;
	try {
		url = new URL(request.url, redirectUri);
	} catch (_error) {
		send(response, 400, 'Invalid callback request.');
		return undefined;
	}
	if (url.pathname !== expectedPath) {
		send(response, 404, 'Unknown callback path.');
		return undefined;
	}
	const state = url.searchParams.get('state') ?? undefined;
	if (state !== expectedState) {
		send(response, 400, 'The authorization state did not match. Return to Obsidian and try again.');
		return undefined;
	}
	const code = url.searchParams.get('code') ?? undefined;
	const error = url.searchParams.get('error') ?? undefined;
	if (!code && !error) {
		send(response, 400, 'The authorization response was incomplete.');
		return undefined;
	}
	send(response, 200, 'Authorization received. You can close this window and return to Obsidian.');
	return {
		pathname: url.pathname,
		state,
		code,
		error,
		errorDescription: url.searchParams.get('error_description') ?? undefined,
	};
}

class NodeGoogleLoopbackListener implements GoogleLoopbackListener {
	readonly redirectUri: string;
	private closed = false;
	private readonly callback: Promise<GoogleOAuthCallback>;
	private rejectCallback?: (error: unknown) => void;

	constructor(
		private readonly server: Server,
		redirectUri: string,
		expectedPath: string,
		expectedState: string,
	) {
		this.redirectUri = redirectUri;
		this.callback = new Promise<GoogleOAuthCallback>((resolve, reject) => {
			this.rejectCallback = reject;
			server.on('request', (request, response) => {
				if (this.closed) {
					send(response, 410, 'This authorization callback is no longer active.');
					return;
				}
				const result = callbackFromRequest(request, response, redirectUri, expectedPath, expectedState);
				if (result) resolve(result);
			});
			server.once('error', reject);
		});
	}

	waitForCallback(signal?: AbortSignal): Promise<GoogleOAuthCallback> {
		if (signal?.aborted) {
			return Promise.reject(new ProviderCancelledError('Google OAuth callback was cancelled', 'google'));
		}
		return this.callback;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.rejectCallback?.(new ProviderCancelledError('Google OAuth callback listener closed', 'google'));
		await new Promise<void>((resolve, reject) => {
			this.server.close(error => error ? reject(error) : resolve());
		});
	}
}

/** Desktop-only factory. Node is loaded only when OAuth is explicitly started. */
export class NodeGoogleLoopbackListenerFactory implements GoogleLoopbackListenerFactory {
	constructor(private readonly loadHttp: () => NodeHttpModule = () => runtimeRequire('http') as NodeHttpModule) {}

	async listen(options: {
		readonly host: '127.0.0.1';
		readonly port: 0;
		readonly path: '/';
		readonly state: string;
	}): Promise<GoogleLoopbackListener> {
		const http = this.loadHttp();
		const server = http.createServer();
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(options.port, options.host, () => resolve());
		});
		const address = server.address();
		if (!address || typeof address === 'string') {
			server.close();
			throw authenticationError('Google OAuth callback listener did not obtain a loopback port', {
				providerId: 'google',
				code: 'loopback-address-unavailable',
			});
		}
		const port = (address as AddressInfo).port;
		return new NodeGoogleLoopbackListener(
			server,
			`http://${options.host}:${port}${options.path}`,
			options.path,
			options.state,
		);
	}
}

/** Open only Google's fixed HTTPS authorization origin in the system browser. */
export async function openGoogleAuthorizationInSystemBrowser(
	url: string,
	loadElectron: () => ElectronModule = () => runtimeRequire('electron') as ElectronModule,
): Promise<void> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch (_error) {
		throw authenticationError('Google authorization URL is invalid', {
			providerId: 'google',
			code: 'invalid-authorization-url',
		});
	}
	if (parsed.protocol !== 'https:' || parsed.hostname !== 'accounts.google.com') {
		throw authenticationError('Google authorization URL origin is not allowed', {
			providerId: 'google',
			code: 'untrusted-authorization-origin',
		});
	}
	const shell = loadElectron().shell;
	if (!shell?.openExternal) {
		throw authenticationError('The system browser is unavailable in this Obsidian runtime', {
			providerId: 'google',
			code: 'system-browser-unavailable',
		});
	}
	await shell.openExternal(parsed.toString());
}
