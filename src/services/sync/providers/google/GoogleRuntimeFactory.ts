import type { SecretValueStore } from '../../state/CredentialStore';
import type { CalendarProvider, ProviderSession } from '../../providers/CalendarProvider';
import type { GoogleAuthorizationResult, GoogleCredentialStore } from './GoogleOAuthProvider';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a client secret from older plugin data before the safe migration strips it. */
export function extractLegacyGoogleClientSecret(raw: unknown): { clientId: string; secret: string } | undefined {
	if (!isRecord(raw)) return undefined;
	const settings = isRecord(raw.settings) ? raw.settings : raw;
	const sync = isRecord(settings.sync)
		? settings.sync
		: isRecord(settings.syncSettings)
			? settings.syncSettings
			: isRecord(settings.syncConfig)
				? settings.syncConfig
				: settings;
	const clientId = typeof sync.googleClientId === 'string' ? sync.googleClientId.trim() : '';
	const secret = typeof sync.googleClientSecret === 'string' ? sync.googleClientSecret.trim() : '';
	return clientId && secret ? { clientId, secret } : undefined;
}

export function googleClientSecretKey(clientId: string): string {
	return `google-client-secret:${clientId}`;
}

/** Move a legacy plugin setting into SecretStorage before sanitized data is saved. */
export async function migrateLegacyGoogleClientSecret(
	raw: unknown,
	secretStore: SecretValueStore,
): Promise<{ clientId: string; secret: string } | undefined> {
	const legacy = extractLegacyGoogleClientSecret(raw);
	if (!legacy) return undefined;
	await secretStore.set(googleClientSecretKey(legacy.clientId), legacy.secret);
	return legacy;
}

export class MissingGoogleClientSecretError extends Error {
	readonly code = 'google-client-secret-missing';

	constructor() {
		super('Google Client Secret is missing. Enter it in settings to restore sync after restart.');
		this.name = 'MissingGoogleClientSecretError';
	}
}

/** Read the saved OAuth secret before constructing the authenticated runtime. */
export async function createGoogleRuntimeWithStoredSecret<T>(options: {
	readonly clientId: string;
	readonly secretStore: SecretValueStore;
	readonly construct: (clientSecret: string) => Promise<T> | T;
}): Promise<T> {
	const clientSecret = await options.secretStore.get(googleClientSecretKey(options.clientId));
	if (!clientSecret) throw new MissingGoogleClientSecretError();
	return options.construct(clientSecret);
}

/** Restore credentials, refresh the Google session, and construct the calendar provider. */
export async function createGoogleAuthenticatedRuntime(options: {
	readonly clientId: string;
	readonly accountId: string;
	readonly secretStore: SecretValueStore;
	readonly credentialStore: GoogleCredentialStore;
	readonly createOAuthProvider: (
		clientId: string,
		clientSecret: string,
		credentialStore: GoogleCredentialStore,
	) => Pick<{ refresh(accountId: string): Promise<GoogleAuthorizationResult> }, 'refresh'>;
	readonly createCalendarProvider: () => CalendarProvider;
}): Promise<{ provider: CalendarProvider; session: ProviderSession }> {
	return createGoogleRuntimeWithStoredSecret({
		clientId: options.clientId,
		secretStore: options.secretStore,
		construct: async clientSecret => {
			const oauthProvider = options.createOAuthProvider(
				options.clientId,
				clientSecret,
				options.credentialStore,
			);
			const result = await oauthProvider.refresh(options.accountId);
			return { provider: options.createCalendarProvider(), session: result.session };
		},
	});
}
