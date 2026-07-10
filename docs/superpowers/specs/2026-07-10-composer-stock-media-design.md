# Composer Stock Media Picker — Design Spec

**Date:** 2026-07-10
**Branch:** `feat/composer-stock-media` (both repos: `socialmedia-workspace`, `socialmedia-frontend`)
**Status:** Approved design — ready for implementation plan

## Goal

Let users search and attach free stock **images and videos** directly inside the
post composer, from **Unsplash** and **Pexels**, through a professional
multi-source media picker. This is **Phase 1** of a larger media-integrations
effort; cloud storage (Google Drive, OneDrive, Dropbox, Google Photos, Canva)
and additional stock providers (Pixabay, Flickr, Coverr, Giphy) are explicitly
**out of scope** here and handled in later phases.

## Scope decomposition (context)

The full "integrations in composer" idea splits into three independent efforts.
This spec is **only the first**:

| Phase | Effort | Status |
|-------|--------|--------|
| **1 (this spec)** | Stock picker: Unsplash + Pexels (API-key, no OAuth) | designed |
| 2 | Cloud storage OAuth connect flows (Integrations page) + their pickers | deferred |
| 3 | New stock backends: Pixabay, Flickr, Coverr, Giphy | deferred |

## Backend reality (verified 2026-07-10)

- **Unsplash** — `src/channels/services/unsplash.service.ts`, routes under
  `/channels/unsplash/*`, env `UNSPLASH_ACCESS_KEY`. Returns an Unsplash-flavored
  shape (`urls.thumb`, `user.{name,username}`, `links.download_location`).
- **Pexels** — own module `src/pexels/` (`pexels.controller.ts`,
  `pexels.service.ts`, `pexels.module.ts`), routes under `/pexels/*`, env
  `PEXELS_API_KEY`. Returns a Pexels-flavored shape (`src.medium`,
  `photographer`, `photographer_url`, video `video_files[]`).
- **No common envelope exists** across providers. **No unified media endpoint**
  exists. Both services already normalize *within* their own provider schema.

## Compliance requirements (verified against provider guidelines)

These are **mandatory**, not optional, and drive the architecture:

- **Unsplash** ([API guidelines](https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines)):
  1. **Hotlink** the URLs returned under `photo.urls` — do **not** re-host/cache
     copies on our own CDN.
  2. On selection ("something similar to a download"), send a request to
     `photo.links.download_location` — a required event ping.
  3. **Attribute** the photographer + Unsplash with a link back, using
     `?utm_source=<app>&utm_medium=referral` UTM params.
- **Pexels** ([license/terms](https://help.pexels.com/hc/en-us/sections/360007339013-License-Terms-and-Conditions)):
  attribution is **required when used via the API** — "Photo by <name> on Pexels"
  linking to the photo page, plus a "Photos provided by Pexels" credit.

Consequence: assets are **hotlinked, never re-hosted**; the download-trigger runs
**server-side** (keeps the API key off the client); attribution metadata is
**stored on the media item and always displayed in-app**.

## Rate limits

- Pexels: 200 req/hour, 20k/month (default).
- Unsplash: 50 req/hour (demo) until production approval.

Mitigation: **debounce search (400 ms)** on the frontend; paginate; no
speculative prefetch. Production key upgrades are a later ops task.

---

## Architecture

A thin **backend gateway** wraps the two existing provider services behind one
normalized contract; the **frontend composer** gains an "Add media" dialog with
source tabs that consumes that contract and produces the composer's existing
`DraftMediaItem`.

```
Composer "Add media" dialog
  └─ Upload tab   → existing upload flow (unchanged)
  └─ Unsplash tab ─┐
  └─ Pexels tab  ──┤→ GET /media/stock/search (normalized)  → grid
                   └→ on select: POST /media/stock/track (Unsplash only)
                                 + build DraftMediaItem (hotlink + attribution)
```

---

## Backend design (`socialmedia-workspace`)

New module `src/stock-media/` that **reuses** the existing provider services
(does not re-implement provider HTTP calls):

- `stock-media.module.ts` — imports `PexelsModule` (exports `PexelsService`) and
  gains access to `UnsplashService` (export it from `ChannelsModule`, or if that
  introduces a heavy/circular import, wrap the two provider calls in a small
  self-contained client — implementer's call, flagged in the plan).
- `stock-media.controller.ts` — `@Controller('media/stock')`, `JwtAuthGuard`.
  No `:workspaceId` — stock content is global and keys are server-side.
- `stock-media.service.ts` — delegates to the provider services and maps each
  result into the normalized envelope via pure mapper functions.
- `mappers/` — `unsplash.mapper.ts`, `pexels.mapper.ts` (pure, unit-tested).
- `dto/` — query + response DTOs with `class-validator`.

### Normalized envelope

```ts
export type StockProvider = 'unsplash' | 'pexels';
export type StockMediaType = 'image' | 'video';

export interface StockMediaItem {
  provider: StockProvider;
  providerId: string;
  type: StockMediaType;
  previewUrl: string;          // grid thumbnail (hotlink)
  fullUrl: string;             // URL embedded into the post (hotlink)
  width: number;
  height: number;
  durationSec?: number;        // video only
  authorName: string;
  authorUrl: string;           // photographer profile, with UTM (Unsplash)
  providerUrl: string;         // photo page / Unsplash link, with UTM
  downloadTriggerUrl?: string; // Unsplash download_location; absent for Pexels
}
```

### Endpoints

```
GET /media/stock/search
    ?provider=unsplash|pexels
    &type=image|video
    &q=<string>            (required, non-empty)
    &page=<int>=1
    &perPage=<int>=24 (max 50)
→ 200 { items: StockMediaItem[]; page: number; hasMore: boolean }
```
- Validation: `provider` and `type` must be supported by that provider — Unsplash
  has **no video**; requesting `provider=unsplash&type=video` → 400 with a clear
  message.
- Errors: provider 429 → surface `429` with a retry hint; provider/network
  failure → `502`; both mapped to a stable error body.

```
POST /media/stock/track
    body { downloadTriggerUrl: string }
→ 204
```
- Fires the Unsplash download event **server-side** (adds the client_id / key).
- Validates the URL host is `api.unsplash.com` (fail-closed) so the endpoint
  can't be used as an open proxy. No-op / 204 for anything else.

### Backend tests (Jest)

- `unsplash.mapper.spec.ts` — Unsplash photo JSON → `StockMediaItem`: correct
  hotlink URLs, UTM params on `authorUrl`/`providerUrl`, `downloadTriggerUrl`
  populated, `type: 'image'`.
- `pexels.mapper.spec.ts` — Pexels photo **and** video JSON → `StockMediaItem`:
  `photographer`→`authorName`, correct `src`/`video_files` selection,
  `durationSec` for video, `downloadTriggerUrl` absent.
- `stock-media.service.spec.ts` — delegates to the right provider per `provider`;
  `unsplash + video` rejected; `hasMore` derived correctly.
- `stock-media.controller.spec.ts` — search happy path; bad provider/type → 400;
  `track` validates host and returns 204.
- Gate: `npm run test -- stock-media`, `npm run build`.

---

## Frontend design (`socialmedia-frontend`)

### Integration seam

The composer attaches media through a single contract: `EditorCard`'s
`onAddMedia(item: DraftMediaItem)` (`src/features/composer/components/editor-card.tsx`).
Anything producing a `DraftMediaItem` plugs in. The new picker uses exactly this
seam — no changes to publish/draft payloads.

### `DraftMediaItem` extension (backward compatible)

In `src/features/composer/types/draft.types.ts`, add an **optional** field:

```ts
interface DraftMediaAttribution {
  provider: string;      // 'unsplash' | 'pexels'
  authorName: string;
  authorUrl: string;
  providerUrl: string;
}

interface DraftMediaItem {
  // ...existing fields unchanged...
  attribution?: DraftMediaAttribution;
}
```

Existing uploads leave `attribution` undefined — nothing breaks. The publish
payload already serializes `DraftMediaItem`; attribution rides along so the
backend/publishers can use it later (Phase-2 concern; not required now).

### New components — `src/features/composer/components/media-picker/`

- `media-picker-dialog.tsx` — shadcn `Dialog` + `Tabs`: **Upload · Unsplash ·
  Pexels**. The "Upload" tab hosts the existing file-upload path so the picker
  becomes the single "Add media" entry point. Opened from a button in
  `EditorCard`'s action bar (replaces the standalone `MediaButton` trigger; the
  underlying upload logic is reused, not rewritten).
- `stock-browser.tsx` — per-provider pane: debounced search `Input`, an
  image/video segmented toggle (video hidden for Unsplash), results grid, and a
  "Load more" button driving pagination. Loading/empty/error states below.
- `stock-tile.tsx` — thumbnail (`previewUrl`) with an attribution overlay
  ("© <author> · <Provider>") and select action. On select it fires the compliance
  steps below.
- `stock-attribution.tsx` — small reusable credit line/overlay (also used by the
  composer thumbnail).

### New hooks / api

- `src/features/composer/api/stock-media.api.ts` — `apiClient` wrappers:
  `searchStock(params)`, `trackDownload(downloadTriggerUrl)`.
- `src/features/composer/hooks/use-stock-search.ts` — React Query, key
  `['stock', provider, type, q, page]`, `keepPreviousData`, `enabled: q.length > 0`.
- `src/features/composer/hooks/use-track-download.ts` — mutation for the Unsplash
  ping.

### On-select flow

1. If `item.downloadTriggerUrl` present → `trackDownload(item.downloadTriggerUrl)`
   (fire-and-forget; failure must not block attach).
2. Fill `sizeBytes` + confirm `width/height` by reusing the composer's existing
   `probeFileSize` / `probeImage` / `probeVideo` helpers on `fullUrl` (needed by
   `platform-validation.ts`).
3. Build `DraftMediaItem`:
   ```ts
   {
     id: `${item.provider}:${item.providerId}`,
     type: item.type,                    // 'image' | 'video'
     url: item.fullUrl,                  // hotlink
     width: item.width, height: item.height,
     durationSec: item.durationSec,
     sizeBytes,                          // from probe
     attribution: { provider, authorName, authorUrl, providerUrl },
   }
   ```
4. `onAddMedia(item)` → dialog closes.

### Attribution display

- **In-app (always):** `MediaThumbnail`
  (`src/features/composer/components/media-thumbnail.tsx`) shows the attribution
  overlay when `attribution` is set. The picker grid shows it on each `stock-tile`.
- **In the published post (opt-in):** a checkbox in the dialog, "Add photo credit
  to caption", **default off**. When on, appends "Photo by <author> on
  <Provider>" to the draft caption on attach. Default off so we never silently
  mutate the user's caption; surfaced so compliance-conscious users can enable it.

### States (Code Quality Rule 4)

- Loading → skeleton grid (shadcn `Skeleton`).
- Empty (no query) → prompt "Search Unsplash/Pexels for photos".
- Empty (no results) → icon + "No results for '<q>'".
- Error → inline message + Retry; 429 → "Too many searches — try again in a
  moment."
- Search debounced 400 ms; select disabled while probing.

### shadcn usage

All primitives already installed: `dialog`, `tabs`, `input`, `button`, `badge`,
`skeleton`, `scroll-area`, `separator`, `tooltip`. No new installs expected;
if a segmented toggle is wanted, confirm via the shadcn MCP before adding.

### Frontend tests

Vitest is configured (`npm run test`). Cover the pure pieces:
`buildDraftMediaItem` mapping (envelope → `DraftMediaItem`, id format, attribution
carried), and the caption-credit append helper. Gate: `npm run build`.

---

## Out of scope (do not build here)

- Cloud storage providers (Drive/OneDrive/Dropbox/Photos/Canva) and their
  OAuth connect flows on the Integrations page (all currently "SOON").
- Pixabay, Flickr, Coverr, Giphy (no backend exists).
- Re-hosting stock assets to our CDN (violates Unsplash guidelines).
- The mock media-library page (`src/features/media-library/`) — untouched;
  its `MediaSource` types may be referenced but not rewired.
- Backend/publisher use of `attribution` at publish time.

## Success criteria

1. In the composer, "Add media" opens a dialog with Upload · Unsplash · Pexels.
2. Searching returns a normalized grid; Unsplash shows images only, Pexels shows
   images and videos.
3. Selecting attaches a hotlinked `DraftMediaItem` with attribution; Unsplash
   selections fire the server-side download trigger.
4. Attribution is visible on the composer thumbnail; optional caption credit works.
5. `npm run build` passes both repos; `npm run test -- stock-media` passes backend.
