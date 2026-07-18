# Google Drive → Picker + `drive.file` Migration — Design Spec

**Date:** 2026-07-16
**Branch:** `feat/drive-picker-migration` (both repos), based off `main`
**Status:** Approved design, pending implementation plan

---

## Goal

Move the Google Drive media source off the **restricted** `drive.readonly` scope
and onto **`drive.file` + the Google Picker**, so the app never requests a
restricted Drive scope and therefore never needs a **CASA** security assessment.

Drive's file browsing moves from our custom cloud-browser to **Google's own
Picker dialog** (the same one used by Gmail "Insert from Drive"). Import into the
draft is unchanged: the Picker returns file IDs, and our server downloads them
with its own token and copies them into our storage.

## Why this matters

`drive.readonly` is a **restricted** scope. Restricted scopes require Google
verification **plus an annual CASA security assessment** — a recurring cost and
audit burden. `drive.file` is classified **non-sensitive**: no CASA, only basic
verification. Google explicitly recommends `drive.file` + Picker for apps that
would otherwise ship their own file browser.

Sources (verified 2026-07-16):
- [Choose Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Google Picker overview](https://developers.google.com/workspace/drive/picker/guides/overview)

## Scope

**In scope:**
- Drive OAuth scope `drive.readonly` → `drive.file`.
- Composer Drive pane → Google Picker (replaces our custom browser **for Drive only**).
- Import path retained; Drive-specific dead browse code removed.
- Remove the chatbot's `search_google_drive` tool (it cannot work under `drive.file`).

**Out of scope (separate efforts):**
- **Maestro Drive Picker action-tool** — Maestro has no action-tool
  infrastructure yet; building it here would merge two unrelated efforts.
  Follow-up branch.
- **Google Photos** — left exactly as-is by explicit decision (its
  `photoslibrary.readonly` scope is dead since 2025-03-31 but will be revisited
  when Photos work resumes).
- **Dropbox / OneDrive** — untouched; they keep the custom cloud-browser.
- Reconnect banner / DB migration (see Rollout — not needed at current scale).

## Decisions locked (with the user)

1. **Path A — CASA-free.** The chatbot's *autonomous* Drive search is given up.
   No Google scope permits arbitrary-Drive search without being restricted, so
   autonomous search and CASA-free are mutually exclusive. Search survives
   **inside the Picker**, which has its own search box.
2. **Two-token model.** Our stored Drive token never reaches the browser. The
   browser obtains its own short-lived `drive.file` token **directly from
   Google** (GIS), used only to render the Picker, never stored by us.
3. **Google's own Picker dialog** is acceptable, including the visual
   inconsistency: Drive looks like Google's UI, while Dropbox/OneDrive/Photos
   keep our custom browser.
4. **Chatbot Picker-action is a follow-up**, not part of this effort.

## Current reality (verified 2026-07-16)

- `src/drizzle/schema/channels.schema.ts:594` — `google_drive.oauthScopes` is
  exactly `['https://www.googleapis.com/auth/drive.readonly']`. **One scope; no
  unused "extra" scopes exist to trim.**
- `src/media-sources/media-sources.service.ts`
  - `browseDrive()` lists all Drive files via `GoogleDriveService` — requires
    `drive.readonly`. This path dies.
  - `downloadBuffer()` → `drive.downloadFile(token, fileId)` — **survives**
    under `drive.file` for picked files.
- `src/channels/services/google-drive.service.ts` — `listFiles`, `listImages`,
  `listVideos`, `listMedia`, `listFolders` become unreachable for Drive.
  `downloadFile`, `getFile`, `getUserInfo`, `verifyAccess` stay.
- `about.get` (used by `getUserInfo` for the connected account name) **accepts
  `drive.file`** — verified against the
  [about.get reference](https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get).
  Connect flow's account naming is safe.
- Chatbot Drive wiring lives in exactly three places:
  - `src/chatbot/tools/cloud-storage.tools.ts:65` — the `search_google_drive` tool.
  - `src/chatbot/tools/tool-registry.service.ts:140` — its progress label.
  - `src/chatbot/services/agent.service.ts:652` — its result → media handling.
  - `src/chatbot/services/context-builder.service.ts:95` only categorizes Drive
    as an integration; it claims no search capability and **needs no change**.

## Architecture — the two-token model

Google Picker cannot run without an OAuth token **in the browser**; there is no
server-only Picker. The project rule ("cloud tokens never reach the browser") is
honored by never exposing *our* token:

| Token | Lives | Scope | Purpose |
|---|---|---|---|
| **Server token** (refresh + access) | Server only, as today | `drive.file` | Download picked files during import |
| **Picker token** | Browser memory, ephemeral | `drive.file` | Render the Picker only |

The Picker token is minted **by Google directly to the browser** via Google
Identity Services. It never passes through our backend and is never persisted.
Its blast radius is limited to files the user themselves picks.

**Why the server token can read picked files:** picking a file in the Picker
grants `drive.file` access for that file to the **OAuth client**, for that user.
Since the browser (GIS) and the server use the **same client ID and same Google
account**, the server's own token can then download it.

## Data flow

```
User clicks "Open Google Drive" in the composer
  → browser gets an ephemeral drive.file token from Google (GIS), login_hint = connected account
  → Google Picker opens (Google-hosted; its own search / folders / multi-select)
  → user picks files
  → browser sends ONLY the file IDs to our backend
  → POST /channels/workspaces/:wsId/media-sources/:channelId/import  { fileId, kind }
  → server downloads each file with its own stored drive.file token
  → uploads to our storage (Cloudinary) → permanent URL
  → items added to the composer draft
```

No file bytes, no hotlinks, and no expiring provider URLs reach the draft — the
same guarantee the existing cloud sources already provide.

## Component design

### 1. Connect flow

Scope swap only: `channels.schema.ts:594` → `['https://www.googleapis.com/auth/drive.file']`.

Everything else is unchanged — server-side offline OAuth, refresh token stored
server-side, `about.get` for the account name. No new connect UI.

### 2. Composer Drive pane

Today `cloud-source-pane` renders `connected ? <CloudBrowser/> : <CloudConnectCard/>`.

Drive gains a third shape. A per-provider capability flag — `usesPicker: true` on
the Drive entry of `CloudSourceMeta` in
`src/features/composer/constants/cloud-sources.ts` — makes the pane render a
**Picker launch surface** instead of `CloudBrowser`: an explanatory line plus an
**"Open Google Drive"** button. Clicking it acquires the GIS token, opens the
Picker, and on pick runs the existing multi-import + "Add N items" path.

`CloudBrowser` itself is **not modified** — Dropbox/OneDrive/Photos keep using it
untouched.

### 3. Import path

Unchanged endpoint, unchanged contract, unchanged storage behavior.

**Removed as dead code:** the `google_drive` branch of `browseDrive()`; Drive's
`listFiles` / `listImages` / `listVideos` / `listMedia` / `listFolders`; and
`src/media-sources/mappers/drive.mapper.ts` (`mapDriveItem`, `mapDriveFolder`).
A `browse` call naming a `google_drive` channel returns **400 — "Google Drive
uses the Google Picker"**, rather than silently returning empty results.

### 4. Chatbot

`search_google_drive` is **removed**, not left to fail: under `drive.file` it
would 403 at runtime, and a broken tool is worse than an absent one. Removal
touches the three sites listed in *Current reality*. Dropbox / OneDrive / Photos
tools are untouched.

Until the follow-up action-tool ships, Maestro simply has no Drive tool; Drive
media is added from the composer.

## Rollout

**No DB migration, no reconnect banner.** OAuth scopes are not granted
retroactively — existing Drive connections keep their old `drive.readonly` grant
until reconnected. Because the Google OAuth client is still in **Testing mode**,
the only Drive connections that exist are the developer's own test accounts.

**Action:** manually disconnect → reconnect Drive after deploy, so no
`drive.readonly` grant remains anywhere.

If real users existed, this would instead require a forced-reconnect flow; that
is deliberately not built (YAGNI at current scale).

## Prerequisites (Google Cloud Console — manual, not code)

1. OAuth consent screen: **remove** `drive.readonly`, **add** `drive.file`.
2. **Enable the Google Picker API.**
3. Create an **API key** for the Picker, restricted by HTTP referrer to the app's origins.

**New frontend env vars** (both public by design):
- `VITE_GOOGLE_CLIENT_ID` — OAuth client ID, for GIS.
- `VITE_GOOGLE_PICKER_API_KEY` — Picker API key.

The Picker also needs the Google Cloud **project number** as its `appId`.

## Risks and edge cases

**Account mismatch (the important one).** The user connects Drive as account A
but is signed into the Picker as account B: they pick B's files, our server's
token (A's) has no grant for them, and import fails.

Mitigation, both layers:
- Pass **`login_hint` = the connected account's email** to GIS so the Picker
  defaults to the right account.
- On import, a Drive `404`/`403` returns a specific, actionable error —
  *"Choose files from your connected Google Drive account (A)."* — never a bare
  500.

**Picker script loading.** The Picker loads Google-hosted scripts
(`apis.google.com`). If a Content-Security-Policy is in force on the frontend it
must allow them; verify during implementation.

## Testing

**Backend** (`socialmedia-workspace`):
- Update `media-sources.service.browse.spec.ts` — Drive browse now rejects with 400.
- Keep `media-sources.service.import.spec.ts` Drive coverage green (import is unchanged).
- Update chatbot tool tests/registry expectations for the removed Drive tool.
- `npm run build` and `npm run test` must pass.

**Frontend** (`socialmedia-frontend`): the repo runs **Vitest** (`npm run test` →
`vitest run`). There is no `@testing-library/react`; existing specs render via
`renderToStaticMarkup` against a pre-seeded `QueryClient` — follow that harness
rather than adding a testing dependency.
- Extend `use-cloud-sources.spec.ts` (connected account email) and
  `cloud-source-pane.spec.tsx` (a connected Drive renders the Picker launch
  surface, not the browser). Unit-test the Picker-document mapper.
- The Picker integration module itself is not unit-tested: it is entirely
  browser-global side effects (script injection, Google's `gapi`/GIS
  singletons), so a test could only assert against a hand-built mock of Google's
  SDK. Its behavior is covered by the manual smoke below.
- `npm run test`, `npm run build` and `npm run lint` must pass.
- **Manual smoke (required):** connect Drive → open Picker → search inside it →
  pick multiple files → confirm they import and land in the draft as permanent
  URLs; then repeat picking a *different* Google account to confirm the
  account-mismatch error is friendly.

## Follow-ups (explicitly deferred)

- **Maestro Drive Picker action-tool** — needs Maestro action-tool infrastructure first.
- **Google Photos** — dead `photoslibrary.readonly`; revisit with Photos Picker API.
- **Standard Google verification** — brand verification, privacy policy, and a
  demo video per remaining sensitive scope (Calendar, YouTube, business.manage).
  This migration removes the *restricted*/CASA tier for Drive; it does not remove
  ordinary verification for the rest.
