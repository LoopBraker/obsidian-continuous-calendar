# Client ID Distribution Model

**Status:** Decided (2026-09-20)

## The Problem
For Google Calendar synchronization, the plugin must identify itself to the Google Calendar API via an OAuth Client ID. Hardcoding an official production Client ID and Client Secret into an open-source repository or distributing it loosely is generally unsafe and violates Google's API service terms.

## The Decision
To ensure security and maintain a clean open-source model:
1. **No committed credentials**: We will **never** invent or commit an OAuth client ID, client secret, or any other credentials into this repository.
2. **User-provided testing ID**: For testing and validation (and potentially for final use if users prefer to manage their own Google Cloud Project), the plugin uses an explicitly labeled user/developer-supplied Client ID. 
3. **Settings configuration**: The client ID will be configured via the Obsidian plugin settings UI (as a non-secret configuration string). 

## Implementation Details
Users must create a Google Cloud Project, enable the Google Calendar API, and configure an OAuth 2.0 Client ID for a "Desktop app" (or similar PKCE/loopback flow). The user will then paste this Client ID into the plugin's Sync Settings tab to authenticate.
