import { requestUrl } from 'obsidian';
import { GoogleOAuthProvider, type GoogleCredentialStore } from './GoogleOAuthProvider';
import { NodeGoogleLoopbackListenerFactory, openGoogleAuthorizationInSystemBrowser } from './GoogleDesktopOAuth';
import type { ProviderHttpRequest, ProviderHttpResponse } from '../../providers/CalendarProvider';

export const obsidianHttpTransport = {
    request: async (req: ProviderHttpRequest): Promise<ProviderHttpResponse> => {
        const options: any = {
            url: req.url,
            method: req.method,
            headers: req.headers,
            throw: false,
        };
        if (req.body !== undefined) {
            options.body = req.body;
        }
        console.log('[Calendar Sync] HTTP Request:', options.method, options.url, 'Body:', options.body);
        const response = await requestUrl(options);
        console.log('[Calendar Sync] HTTP Response:', response.status, response.text);
        return {
            status: response.status,
            headers: response.headers,
            text: response.text,
            json: response.json,
        } as ProviderHttpResponse & { readonly json?: unknown; readonly text?: unknown };
    }
};

export function createGoogleOAuthProvider(clientId: string, clientSecret: string, credentialStore: GoogleCredentialStore): GoogleOAuthProvider {
    return new GoogleOAuthProvider({
        clientId,
        clientSecret,
        transport: obsidianHttpTransport,
        listenerFactory: new NodeGoogleLoopbackListenerFactory(),
        openExternal: openGoogleAuthorizationInSystemBrowser,
        credentialStore,
    });
}
