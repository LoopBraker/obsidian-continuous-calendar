# Calendar sync feasibility — Gate 1

**Status:** Proposed for root acceptance
**Reviewed:** 2026-09-20
**Scope:** Desktop OAuth, credential persistence, HTTP transport, and mobile compatibility for the implementation described in `SYNC_IMPLEMENTATION_PLAN.md`.

This is a decision record, not provider implementation. Facts marked **Verified** are taken from the linked primary documentation or the current repository. Items marked **Recommendation** are design choices for this plugin. Items marked **Unknown** require a runtime or provider-account smoke test before the corresponding implementation package is accepted.

## Decision summary

Gate 1 is feasible with the following boundaries:

| Area | Gate 1 decision | Status before implementation |
| --- | --- | --- |
| OAuth callback | Use an external system browser and a short-lived loopback HTTP listener. Generate an ephemeral port, bind only to loopback, require PKCE and `state`, accept one matching callback, then close the listener. | **Accepted design; runtime smoke test required** |
| Google desktop client | Use a Google OAuth client whose application type is **Desktop app** and the loopback redirect form `http://127.0.0.1:<ephemeral-port>`. Use the public client ID; do not treat a desktop client secret as a secret. | **Accepted for the first provider** |
| Microsoft desktop client | Later use an Entra public-client registration with the system-browser redirect `http://localhost` and dynamic port. Resolve the `localhost` versus `127.0.0.1` choice in a live registration/callback test before implementation. | **Design accepted; provider setup deferred** |
| Persistent credentials | Prefer Obsidian `app.secretStorage` when present. It is the host-supported abstraction and avoids plaintext `data.json`; its underlying OS store is intentionally opaque. Treat direct Electron `safeStorage` as a conditional fallback only after a supported-runtime smoke test. | **Accepted with feature detection** |
| No secure store | Use a session-only credential store. Keep refresh and access tokens in memory and require authorization again after restart. Never put a refresh token in frontmatter, logs, diagnostics, or ordinary plugin data. | **Accepted** |
| HTTP | Wrap Obsidian `requestUrl` in one transport adapter. Serialize request bodies explicitly, pass headers explicitly, set `throw: false`, and make ETags, pagination, and non-2xx responses provider-adapter concerns. | **Accepted design** |
| Mobile | Keep `isDesktopOnly: false` for the existing local calendar. Do not load Node/Electron modules or expose sync/auth controls on mobile. Mobile OAuth/background sync is out of scope. | **Accepted design; mobile load test required** |

The result is a **conditional go decision**: the architecture and provider configuration are sufficiently specified to proceed to root review, but no OAuth or credential code should be accepted until the smoke tests in [Acceptance gates](#acceptance-gates) pass on the supported desktop runtime(s). A desktop-only implementation that silently fails on one OS, stores a token in plaintext, or opens an embedded browser does not pass Gate 1.

## 1. System-browser PKCE and loopback callback

### Verified facts

* [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252) defines native applications as public clients: they cannot keep a client secret, must use an external user agent for authorization, and must use PKCE. Its loopback pattern uses a local HTTP listener on an ephemeral port and a loopback address; the listener should be closed after the response.
* Google explicitly says installed applications should open the system browser and use a local redirect. Its [native-app OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app) recommends the loopback IP mechanism for macOS, Linux, and Windows desktop apps, with a **Desktop app** client type. Google documents `http://127.0.0.1:<port>` and `http://[::1]:<port>` forms and deprecates the loopback option for mobile client types.
* Electron's [`shell.openExternal`](https://www.electronjs.org/docs/latest/api/shell) asks the operating system to open a URL using its default external handler. Electron documents the module as a main-process API and allows it in a non-sandboxed renderer. The public Obsidian API type definitions do not expose an `openExternal` helper; Obsidian's [submission requirements](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins) say Node/Electron APIs are desktop-only.
* Node's [HTTP server API](https://nodejs.org/api/http.html) can bind a server to a requested port. Port `0` asks the OS to select an available ephemeral port. Binding the server to `127.0.0.1` keeps it off network interfaces; the implementation must not bind `0.0.0.0`.

### Recommendation: callback sequence

Implement a small desktop-only callback adapter with this sequence:

1. Generate a fresh high-entropy `state` and PKCE `code_verifier` for every authorization attempt. Use the S256 challenge. The verifier must be 43–128 unreserved characters for Google; a 64-byte random value encoded as base64url without padding is a suitable common choice.
2. Start the listener **before** opening the browser. Bind the IPv4 loopback address and port `0`; construct the provider-specific redirect from the actual assigned port.
3. Accept only one request for the expected path (the root path for the initial Google and Microsoft forms below). Parse the query, require exactly the saved `state`, and accept either a `code` or a provider error. Reject a missing/mismatched state, an unexpected path, a second callback, or a callback after timeout.
4. Return a small success/failure HTML response that tells the user to return to Obsidian. Do not include tokens, authorization codes, or the full authorization URL in the response or logs. Close the listener immediately after the first valid response; also close it on cancel, timeout, plugin unload, and exchange failure.
5. Exchange the code over HTTPS with the same redirect URI and the saved verifier. Keep the access token in memory and send it only in an `Authorization` header. Persist only the refresh credential through the credential policy in [Credential storage](#3-credential-storage).
6. Call `shell.openExternal` only with an authorization URL assembled from fixed provider endpoints and encoded values. Do not pass a URL supplied by a note, frontmatter value, or remote response.

### Runtime qualification (Unknown)

Electron documents `shell.openExternal` and Node's HTTP server, but Obsidian does not promise that every Electron main-process API is callable directly from a plugin renderer. The plugin must feature-detect the desktop path and run a no-token smoke test on each supported Obsidian desktop version. The smoke test must establish that:

* a dynamically loaded `electron.shell.openExternal` reaches the user's default browser rather than an Obsidian embedded view;
* a dynamically loaded Node HTTP listener can bind `127.0.0.1` and report its actual port;
* the callback is delivered to the listener on macOS, Windows, and Linux; and
* cancellation, timeout, browser denial, occupied-port recovery, and a second authorization attempt leave no listener behind.

If either Electron access or the listener is unavailable, fail closed with a clear “desktop OAuth is unavailable” status. Do not fall back to an embedded WebView, OOB copy/paste, a custom URI scheme, or a remote relay.

## 2. PKCE callback security and provider-neutral shape

The canonical OAuth layer should expose provider-neutral state, while each adapter owns endpoint and scope details:

```text
authorize()
  -> create state + verifier
  -> listen on 127.0.0.1:0
  -> build redirect URI from actual port
  -> open system browser
  -> validate one callback
  -> exchange code with verifier
  -> return account identity + in-memory access token + refresh credential
```

The callback adapter should not know calendar event fields. It should return structured outcomes such as `authorized`, `denied`, `timed_out`, `invalid_state`, and `transport_error`, with provider error details redacted from normal logs. A provider adapter may retain the opaque redirect and account identifiers needed for token refresh, but the sync engine must not receive OAuth wire payloads.

## 3. Credential storage

### Preferred host abstraction: Obsidian SecretStorage

**Verified:** Obsidian's [SecretStorage guide](https://docs.obsidian.md/plugins/guides/secret-storage) describes a host API for API keys and tokens that keeps the secret out of plaintext `data.json`; the secret is held in local storage associated with the vault, while plugin settings retain only a secret name. The current public API defines `app.secretStorage.setSecret(id, secret)`, `getSecret(id)`, and `listSecrets()`. Secret IDs are restricted to lowercase alphanumeric characters with optional dashes. `App.secretStorage` and `SecretStorage` are annotated as available since Obsidian API 1.11.4 in the [official API definitions](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts).

**Recommendation:** use SecretStorage as the primary persistent store when `app.secretStorage` exists. Derive a stable legal ID, for example `continuous-calendar-google-<lowercase-hex-account-hash>`, rather than using an email address containing `@` or other unsupported characters. Keep nonsecret account/provider/calendar bindings in ordinary sync state, but never put the refresh value itself there.

The repository manifest currently declares `minAppVersion: 0.15.0`. Do not assume SecretStorage exists at that minimum. Either feature-detect it at runtime or raise the minimum only through the root plan's normal review. The package's compile-time `obsidian` type version and the user's installed Obsidian runtime must also be checked together.

**Important limit:** Obsidian documents the abstraction and vault-local behavior, not the exact OS keychain/database implementation. We must not describe SecretStorage as a macOS Keychain, Windows DPAPI, or Linux Secret Service guarantee. The exact host behavior is intentionally treated as opaque.

### Electron `safeStorage`: exact platform semantics, conditional plugin fallback

**Verified:** Electron's [`safeStorage` documentation](https://www.electronjs.org/docs/latest/api/safe-storage) defines encryption APIs and the platform backends below. The availability check must run after the app is ready. Electron currently recommends `isAsyncEncryptionAvailable()`, `encryptStringAsync()`, and `decryptStringAsync()` where available; the synchronous methods can block and may be deprecated in a future release. `encryptString` returns a `Buffer`; the corresponding decrypt call consumes that buffer. The async decrypt result can report that a value should be re-encrypted after key rotation. Never call Linux `setUsePlainTextEncryption(true)` for a refresh credential.

| OS | Electron's documented backend and protection | Gate implication |
| --- | --- | --- |
| macOS | The app's encryption key is stored for the app in Keychain Access in a way intended to prevent other applications from loading it without user override; content is protected from other users and same-user apps under that model. Code signing is important for stable keychain behavior; unsigned/ad-hoc builds can prompt again after updates. | Do not test only an unsigned development build and generalize to production. Verify signed/released behavior. |
| Windows | Windows DPAPI protects against other users on the same machine, but not against other applications running as the same user. | Treat same-user malware/processes as in scope for the threat model; encryption is not an application-isolation boundary. |
| Linux | The selected backend can be KWallet, KWallet5/6, GNOME libsecret, or an async portal/secret-service provider depending on Electron version and desktop environment. If no OS secret store is available, `getSelectedStorageBackend()` can report `basic_text`; Electron documents that this fallback uses a hardcoded plaintext password and is not OS protection. | Accept only a recognized OS backend. If the result is `basic_text`, unavailable, or unknown, use the session-only store. |

The implementation must not claim that `safeStorage` works merely because Electron documents it: the documentation labels the API as **Process: Main**, and an Obsidian plugin normally runs in a renderer. Direct access from this plugin therefore remains **Unknown** until a desktop smoke test verifies the exact bundled Electron/Obsidian runtime. If direct access is confirmed, use the async API when available, call `isEncryptionAvailable()` (and on Linux inspect `getSelectedStorageBackend()`), and reject `basic_text`. Do not store a refresh token in ordinary `Plugin.saveData()` as a “safeStorage fallback” without a separate reviewed storage design; this record's fallback is session-only.

### Session-only fallback

The fallback is deliberately simple and safe:

* Store refresh and access tokens only in a credential-store object held in memory for the current Obsidian process.
* Keep access tokens memory-only even when persistent SecretStorage is available.
* After restart, return `null` for the refresh credential and require the user to authorize again.
* Do not write the token to frontmatter, Markdown, `data.json`, local storage, logs, error objects, telemetry, or diagnostic exports.
* Surface the persistence mode as `secure` versus `session-only` so the UI can tell the user why a restart requires authorization.

This behavior satisfies the plan's rule that refresh tokens never appear in ordinary plugin state and gives a usable current-session path on systems without a trustworthy secure store.

## 4. Obsidian `requestUrl` transport contract

### Verified API surface

The current public [Obsidian API definition](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts) declares:

```ts
requestUrl(request: RequestUrlParam | string): RequestUrlResponsePromise;

interface RequestUrlParam {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean; // defaults to true for status >= 400
}

interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: any;
  text: string;
}
```

The promise also exposes promise-valued `json`, `text`, and `arrayBuffer` accessors. The API accepts a string URL shorthand or the parameter object. It does not document object-to-JSON serialization, automatic pagination, ETag handling, retries, or provider-specific error conversion.

### Transport rules

**Recommendation:** implement one small injectable wrapper and make provider adapters consume its structured response. The wrapper should:

* serialize JSON explicitly with `JSON.stringify` and set `contentType: application/json`; encode OAuth token requests as an explicit `application/x-www-form-urlencoded` string;
* pass `Authorization`, `Accept`, `If-Match`, and `If-None-Match` through `headers` as needed; never put access or refresh tokens in a URL;
* set `throw: false` for provider calls so adapters can inspect 304, 404, 409, 410, 412, 429, and other responses. A network failure before an HTTP response may still reject the promise and must be classified separately;
* read header names case-insensitively because the type is a generic record; preserve opaque ETag/version values exactly;
* parse JSON only after checking the status and content type, with a text fallback for HTML or empty error bodies; redact `Authorization`, token bodies, and authorization codes from errors;
* follow pagination only in the adapter with a page/byte/time limit and cancellation. `requestUrl` does not make a page loop safe automatically.

### Provider-specific version and cursor behavior

* Google event resources expose an ETag and Google documents conditional requests in [version resources](https://developers.google.com/calendar/api/guides/version-resources): send `If-Match` for a write against an expected version, treat a stale precondition as a conflict (HTTP 412), and use `If-None-Match` only where a conditional read is useful. Google incremental event listing returns a `nextPageToken` for pages and a `nextSyncToken` when the full page sequence is complete; follow pages before saving the final sync token. An invalid/expired sync token can require a full sync (HTTP 410), per the [Calendar API error guide](https://developers.google.com/calendar/api/guides/errors).
* Microsoft Graph returns `@odata.nextLink` while more pages remain and `@odata.deltaLink` when a delta sequence is complete. The [delta-query documentation](https://learn.microsoft.com/en-us/graph/delta-query-events) says these are opaque full URLs: follow the exact URL and persist the full final delta link; do not reconstruct or decode its token. Graph event responses include `@odata.etag` and a `changeKey`; preserve either as an opaque provider version until conditional-write behavior is verified against the live API.
* A provider adapter owns the mapping from its wire cursor/version to the plan's `nextCursor` and `version`. The canonical engine must never parse a Google page token or Graph delta URL.

## 5. Google Calendar desktop setup (first provider)

### Cloud configuration

1. Create or select a Google Cloud project and enable the [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com). Google documents API enablement and credential creation in the [installed-app OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app).
2. Configure the OAuth consent screen. Use an **External** user type unless this is intentionally restricted to a Workspace organization, and add test users while the app is in testing. Google may require verification for a public app requesting sensitive scopes; this is an account/console gate, not something the plugin can bypass.
3. Create an OAuth client ID with application type **Desktop app**. The desktop client is a public client. Treat any downloaded client secret as nonsecret configuration; do not depend on it for security or ask users to paste one into a vault.
4. Use the loopback redirect form `http://127.0.0.1:<ephemeral-port>` exactly as documented for desktop installed apps. Do not hard-code a port or use a web-client redirect. The listener obtains the port at runtime and the same URI is sent in both the authorization and token requests.

### Authorization and token exchange

Use these endpoints and parameters:

| Request | Exact value/requirement |
| --- | --- |
| Authorization endpoint | `https://accounts.google.com/o/oauth2/v2/auth` |
| Required query | `client_id`, `redirect_uri`, `response_type=code`, and a space-delimited `scope` |
| First milestone scopes | `https://www.googleapis.com/auth/calendar.events` (view/edit events) plus `https://www.googleapis.com/auth/calendar.calendarlist.readonly` when the UI lists calendars for selection. If the first UI hard-codes `primary`, the calendar-list scope can be omitted. Do not request the broader `calendar` scope without a separately recorded reason. |
| PKCE/CSRF | `code_challenge=<base64url(SHA-256(verifier))>`, `code_challenge_method=S256`, and random `state` |
| Offline refresh | Request `access_type=offline`; still handle a missing refresh token and reauthorization. Google currently says installed-app exchanges return refresh tokens, while its refresh section describes offline access as the way to refresh without the user present. |
| Token endpoint | `https://oauth2.googleapis.com/token` |
| Code exchange body | Form-encoded `client_id`, `code`, `code_verifier`, `grant_type=authorization_code`, and the identical `redirect_uri`; `client_secret` is optional for a desktop public client |
| Refresh body | Form-encoded `client_id`, `refresh_token`, and `grant_type=refresh_token` (plus an optional client secret only if the provider's current client configuration requires it) |

The Google guide also says to check the granted `scope` in the token response and ignore unrecognized response fields. Store the refresh token through the credential policy above; keep access-token expiry and token type in memory. Use the `Authorization: Bearer` header for Calendar API calls.

### Google-specific acceptance questions

* Verify that the generated Desktop client accepts the dynamic loopback URI and that root-path callbacks work as documented. A `redirect_uri_mismatch` is a configuration failure, not a reason to weaken callback validation.
* Verify the two narrow scopes needed for the planned calendar picker: `calendar.events` and `calendar.calendarlist.readonly`. If the first UI uses only the `primary` calendar, verify that the list scope is omitted rather than silently requesting `calendar`.
* Verify first authorization, restart/refresh using the persistent store, expired/revoked refresh behavior, user denial, and a 412 ETag conflict with a test calendar. Never use a production calendar for destructive tests.

## 6. Microsoft public-client setup (later provider)

### Entra app registration

Microsoft's [desktop-app configuration guide](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration) treats desktop applications as public clients. For the later provider:

1. Register an app in Microsoft Entra ID. Select supported account types deliberately: organizational accounts only, or organizational plus personal Microsoft accounts if the product intends to support both.
2. In **Authentication**, add the **Mobile and desktop applications** platform. For a system-browser flow, register the exact `http://localhost` redirect form shown by the guide. Use one fixed path (the root path for the initial adapter); Microsoft ignores the port for localhost matching, so the listener can still select a dynamic port.
3. Under advanced authentication settings, enable **Allow public client flows**. Do not create or ship a client secret for this desktop plugin.
4. Use the authority matching the account choice: `https://login.microsoftonline.com/common/` for both work/school and personal accounts, `organizations` for work/school, or `consumers` for personal accounts. Microsoft documents these choices in its [client-application configuration guide](https://learn.microsoft.com/en-us/entra/identity-platform/msal-client-application-configuration).

The Microsoft desktop guide also lists `msal<client_id>://auth` for Node.js/Electron applications using a protocol handler. That is not the initial choice here: a plugin does not own a reliably registered OS protocol handler, while loopback is available through the same callback adapter as Google.

### OAuth and Graph permissions

Use Microsoft's [authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow) with PKCE:

| Request | Exact value/requirement |
| --- | --- |
| Authorization endpoint | `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize` where `{tenant}` matches the authority/account policy |
| Token endpoint | `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` |
| Redirect | `http://localhost:<dynamic-port>` using the registered localhost form; send the identical URI to both endpoints |
| Query/body | `client_id`, `response_type=code`, space-delimited `scope`, `redirect_uri`, `code_challenge`, `code_challenge_method=S256`, and `state`; exchange with `grant_type=authorization_code` and `code_verifier` |
| Initial delegated scopes | `offline_access Calendars.ReadWrite`; add `openid profile` only if the UI needs identity claims |
| Calendar API | Microsoft Graph v1.0, with `Calendars.ReadWrite` delegated permission for event create/read/update/delete |

### Localhost/IP discrepancy (explicit unresolved item)

The desktop-app configuration guide documents `http://localhost` for the system-browser redirect. Microsoft's [reply-URL guidance](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url) recommends an IP literal such as `127.0.0.1` over `localhost` where possible, but says an HTTP `127.0.0.1` redirect may need an app-manifest edit rather than the portal's normal UI; IPv6 loopback is not supported there. It also says a no-path localhost URI is returned with a trailing slash, so the callback must accept `/` while the token request reuses the exact URI sent in the authorization request. The initial decision is therefore:

* register and test the portal-supported `http://localhost` form;
* bind the listener only to loopback and verify how the supported desktop OS resolves `localhost`;
* if the test requires `127.0.0.1`, make that an explicit app-registration/manifest change and update this record before Microsoft code is accepted; never silently accept both hosts or register multiple near-duplicate URIs.

This is the only unresolved redirect choice for the later provider. It does not block the Google first milestone.

### Graph paging and versions

For event changes, initialize the bounded horizon with `GET /v1.0/me/calendarView/delta?startDateTime=...&endDateTime=...`, then follow the exact opaque `@odata.nextLink` until `@odata.deltaLink`, and persist the complete delta URL. Subsequent links encode the original window; do not rebuild them. A delta token can expire and require a full resynchronization; preserve that provider-specific recovery as an adapter error/result. Keep `@odata.etag` and/or `changeKey` as opaque versions. The current Microsoft event/update documentation does not establish a provider-neutral conditional-write contract equivalent to Google's documented `If-Match` behavior; verify the live Graph `PATCH`/conflict response before enabling automatic expected-version writes.

## 7. Mobile and manifest behavior

**Verified:** Obsidian's [mobile development guide](https://docs.obsidian.md/Plugins/Getting%20started/Mobile%20development) says Node.js and Electron APIs are not available on mobile and can crash the app. The [manifest reference](https://docs.obsidian.md/Reference/Manifest) uses `isDesktopOnly` for plugins that require those APIs. Obsidian's [plugin self-critique guidance](https://docs.obsidian.md/oo/plugin) also recommends avoiding top-level Node imports and gating desktop-only code behind `Platform.isDesktopApp`.

**Recommendation:** retain the current `isDesktopOnly: false` because local calendar rendering is intended to continue on mobile. The sync package must:

* import only Obsidian/browser-safe code at module scope;
* dynamically load Node/Electron callback and storage adapters only after a desktop check;
* hide sync settings/commands and never invoke OAuth, token refresh, or provider requests on mobile;
* avoid persisting any provider secret on mobile; and
* leave existing local indexing, note parsing, and calendar views unchanged.

`requestUrl` may be present on mobile, but that does not make this feature mobile-supported. Mobile OAuth and background sync are explicitly deferred in the implementation plan. A mobile smoke test must confirm the plugin still loads and local interactions still work when the desktop adapter is unavailable.

## 8. Acceptance gates

Gate 1 is ready for root acceptance when this record is reviewed and the following evidence is attached to the implementation handoff:

### Desktop callback

* [ ] macOS, Windows, and Linux supported Obsidian builds can launch the default external browser through the chosen desktop adapter.
* [ ] The listener binds `127.0.0.1` on an OS-assigned port, accepts one callback, validates exact state and redirect path, and closes on every exit path.
* [ ] PKCE S256 verifier/challenge, state mismatch, denial, timeout, cancellation, and browser error paths are covered without token/code logging.
* [ ] No embedded browser, OOB copy/paste, custom URI scheme, remote relay, or non-loopback listener is used.

### Credential policy

* [ ] `app.secretStorage` feature detection and legal stable IDs are tested on the minimum supported Obsidian runtime.
* [ ] If direct `safeStorage` is retained as a fallback, its actual plugin access is tested on macOS, Windows, and Linux; Linux `basic_text` is rejected; key rotation/decryption errors fail closed.
* [ ] When neither secure path is available, session-only behavior is visible and restart requires authorization.
* [ ] A repository search/test confirms refresh tokens never enter frontmatter, ordinary `saveData`, logs, diagnostics, or error messages.

### HTTP/provider fixtures

* [ ] `requestUrl` tests cover JSON and form bodies, request headers, response headers/ETags, empty and non-JSON errors, `throw: false`, 304/404/410/412/429, cancellation, and bounded page loops.
* [ ] Google fixtures cover page tokens, final sync token, ETag conditional writes, and invalid-sync-token recovery.
* [ ] Microsoft fixtures cover opaque next/delta links and version fields; live conditional-write behavior remains disabled until verified.

### Provider accounts and mobile

* [ ] A non-production Google Desktop client and test account complete authorize, refresh, revoke, denial, and selected-calendar checks with only the approved scope(s).
* [ ] Microsoft app registration, public-client setting, `http://localhost` callback, authority/account policy, and delegated scopes are tested before Microsoft implementation begins.
* [ ] Mobile plugin load and local calendar behavior pass with no desktop adapter import or network call.

## 9. Evidence and limitations

### Static evidence inspected

* `manifest.json` currently has `isDesktopOnly: false` and `minAppVersion: 0.15.0`; this supports the mobile-compatibility boundary but does not provide a SecretStorage version guarantee.
* `SYNC_IMPLEMENTATION_PLAN.md` defines desktop-only sync, memory-only access tokens, secure refresh-token handling, local operation, and deferred mobile OAuth. This record does not change that plan.
* The official Obsidian API definitions document `requestUrl`, `Platform` flags, and SecretStorage; the official Electron documentation documents `shell.openExternal` and `safeStorage` platform behavior.

### Not verified in this work package

* The exact Electron version bundled by every supported Obsidian desktop release, and whether that version exposes `safeStorage`/`shell.openExternal` directly to a plugin renderer.
* Windows and Linux live callback and secure-store behavior; this workstation does not provide cross-OS validation.
* A real Google Cloud OAuth client, consent-screen verification status, or test account.
* Microsoft Entra redirect registration and Graph conditional-write semantics.
* Any network or Obsidian runtime behavior through the UI. This is a documentation-only Gate 1 package; no production code was changed.

These are normal external/runtime gates, not reasons to relax the security boundaries above.

## Primary sources

* [RFC 8252 — OAuth 2.0 for Native Apps](https://www.rfc-editor.org/rfc/rfc8252)
* [Google OAuth 2.0 for iOS and Desktop Apps](https://developers.google.com/identity/protocols/oauth2/native-app)
* [Google Calendar API authorization](https://developers.google.com/workspace/calendar/api/auth), [event listing](https://developers.google.com/calendar/api/v3/reference/events/list), [version resources](https://developers.google.com/calendar/api/guides/version-resources), and [errors](https://developers.google.com/calendar/api/guides/errors)
* [Microsoft desktop-app configuration](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration), [client application configuration](https://learn.microsoft.com/en-us/entra/identity-platform/msal-client-application-configuration), [authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [reply URL guidance](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url), [Graph permissions](https://learn.microsoft.com/en-us/graph/permissions-reference), and [event delta queries](https://learn.microsoft.com/en-us/graph/delta-query-events)
* [Electron `shell`](https://www.electronjs.org/docs/latest/api/shell) and [`safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage)
* [Obsidian SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage), [requestUrl API reference](https://docs.obsidian.md/Reference/TypeScript%20API/requestUrl), [mobile development](https://docs.obsidian.md/Plugins/Getting%20started/Mobile%20development), [manifest reference](https://docs.obsidian.md/Reference/Manifest), and [official API definitions](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
* [Node.js HTTP API](https://nodejs.org/api/http.html)
