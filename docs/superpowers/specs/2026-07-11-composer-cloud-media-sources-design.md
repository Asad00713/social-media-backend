# Composer Cloud Media Sources — Design Spec

**Date:** 2026-07-11
**Branch:** `feat/composer-cloud-sources` (both repos), based off `feat/composer-stock-media`
**Status:** Approved design, pending implementation plan

---

## Goal

Let users pick post media from their connected cloud storage — **Dropbox, Google
Drive, OneDrive, Google Photos** — directly inside the composer's "Add media"
dialog. If a source isn't connected, show a professional connect card (logo +
name + Connect button) that runs OAuth inline. Once connected, browse
folders/media, multi-select, and add the chosen files to the draft.

This extends the existing stock-media picker (Unsplash/Pexels) which already
lives in the same dialog. **Canva is explicitly out of scope** for this effort
(different flow — design create/export, non-persisted tokens).

## Scope

**In scope:** Dropbox, Google Drive, OneDrive, Google Photos — connect + browse +
multi-select + import into our storage, in the composer; plus flipping the
Integrations page cards for these four from "coming soon" to real connect.

**Out of scope (separate efforts):** Canva; extra stock providers
(Pixabay/Giphy/Flickr/Coverr); disconnect/manage cloud channels UI; any change
to the already-shipped Unsplash/Pexels panes beyond moving them into the new
source-rail layout.

## Backend reality (verified 2026-07-11)

The cloud providers are **backend-ready**. Each has, via the generic channels
OAuth engine:

- OAuth initiate + callback (`src/channels/services/oauth.service.ts` configs;
  `POST /channels/workspaces/:wsId/oauth/initiate`, `GET
  /channels/oauth/:platform/callback`).
- A persisted connection row in `socialMediaChannels`
  (`src/drizzle/schema/channels.schema.ts`), platform ∈ {`dropbox`,
  `google_drive`, `onedrive`, `google_photos`}.
- A provider service with listing/search/download:
  - `DropboxService` (`src/channels/services/dropbox.service.ts`) — `listMedia`,
    `listImages`, `listVideos`, `listFolders`, `searchFiles`,
    `getTemporaryLink`, `downloadFile`, `getThumbnail`.
  - `GoogleDriveService` (`src/channels/services/google-drive.service.ts`) —
    `listMedia`, `listImages`, `listVideos`, `listFolders`, `getFile`.
  - `OneDriveService` (`src/channels/services/onedrive.service.ts`) —
    `listMedia`, `listImages`, `listVideos`, `listFolders`, `searchFiles`,
    `getDownloadUrl`.
  - `GooglePhotosService` (`src/channels/services/google-photos.service.ts`) —
    `listMediaItems`, `searchMediaItems`, `listPhotos`, `listVideos`,
    `listAlbums`, `getMediaItem`.
- Existing REST endpoints (`/channels/dropbox/media`, `/channels/onedrive/media`,
  etc.) and external doc `docs/cloud-storage-integrations.md`.

**The two gaps** that block a professional, secure UX (below) are the only
backend work in this effort. All provider logic is reused — nothing re-authored.

## Architecture

### Backend — two thin seams (new `media-sources` surface)

The existing browse REST endpoints take a **raw `accessToken` in the body** and
the existing download links **expire**. Neither is acceptable for a persistent,
secure picker. Add two endpoints that close those gaps by composing existing
services.

A new controller (a `media-sources` controller, registered under the channels
module so it can inject the provider services and the channel/token service)
exposes:

**Seam 1 — Browse by `channelId` (server-side token injection):**

```
POST /channels/workspaces/:wsId/media-sources/:channelId/browse
body: {
  kind: 'media' | 'images' | 'videos' | 'folders' | 'search',
  path?: string,        // folder path / id for tree navigation
  query?: string,       // for kind='search'
  cursor?: string,      // provider pagination token
  limit?: number,       // default 30
}
→ 200 { items: CloudMediaItem[], folders?: CloudFolder[], nextCursor?: string }
```

Behavior: load the channel row (assert workspace ownership), get a **valid**
access token — refreshing via the stored refresh token if expired — then
dispatch on `channel.platform` to the matching provider service method. The
frontend never sees a token.

**Seam 2 — Import a selected file into our storage (permanent URL):**

```
POST /channels/workspaces/:wsId/media-sources/:channelId/import
body: { fileId: string, kind: 'image' | 'video' }
→ 200 { url, width?, height?, durationSec?, sizeBytes }   // permanent, in R2/Cloudinary
```

Behavior: download the file from the provider (existing download/temp-link
methods) and upload it into our media storage (existing R2/Cloudinary upload
util), returning the shape a `DraftMediaItem` needs. This is required because
cloud temp links expire — a scheduled post published later must reference a
permanent URL, not a cloud link.

**Normalized envelope** (mirrors the stock-media approach): a `CloudMediaItem`
type — `{ id, kind: 'image'|'video', name, thumbnailUrl, width?, height?,
durationSec?, sizeBytes? }` — and `CloudFolder` — `{ id, name, path }` — so all
four providers map into one shape the frontend renders uniformly. Per-provider
mappers convert the provider's native item into this envelope.

Guards: `JwtAuthGuard` + workspace-ownership check on every route. Canva
untouched.

**Per-provider capability differences (the envelope must not assume uniformity):**

- **Google Photos** has **no folder tree** — it has **albums** and a flat media
  stream. For Photos, `kind='folders'` returns albums and `path` selects an
  album id; there is **no text search** (only type/date filters), so the
  `cloud-browser` hides the search box for Photos and shows albums instead of a
  breadcrumb.
- **Dropbox / OneDrive** have real folder trees + text search (breadcrumb +
  search box shown).
- **Google Drive** has folders + query search.
- The frontend reads a small per-provider capability descriptor
  (`hasFolders`, `hasSearch`, `browseUnit: 'folder' | 'album'`) so
  `cloud-browser` renders the right controls without per-provider branching
  scattered through the component.

### Frontend — source rail dialog

Convert the Add-media dialog from horizontal tabs to a **left source rail**
(vertical list) + right content pane, so it scales to 7 sources cleanly.

```
features/composer/components/media-picker/
  media-picker-dialog.tsx      # MODIFY: tabs → source rail + content region
  source-rail.tsx              # NEW: vertical source list (Upload, Unsplash, Pexels, + 4 cloud)
  cloud-source-pane.tsx        # NEW: connected? → CloudBrowser : CloudConnectCard
  cloud-connect-card.tsx       # NEW: logo + name + professional Connect button (disconnected)
  cloud-browser.tsx            # NEW: breadcrumb + search + type toggle + infinite media grid + multi-select footer
  cloud-tile.tsx               # NEW: selectable tile w/ checkbox overlay (image/video)
features/composer/hooks/
  use-cloud-sources.ts         # NEW: per-provider connection status (derived from channels list)
  use-cloud-browse.ts          # NEW: useInfiniteQuery over the browse endpoint
  use-cloud-import.ts          # NEW: mutation over the import endpoint → DraftMediaItem
features/composer/api/
  cloud-media.api.ts           # NEW: typed browse + import wrappers, CloudMediaItem/CloudFolder types
features/integrations/
  constants/integrations-catalog.ts + card component   # MODIFY: flip the 4 cloud cards to real connect
```

**Reused:** `features/channels/utils/oauth-popup.ts` (`openOAuthPopup`),
`features/channels/hooks/use-channel-connect.ts` (connect via popup +
`initiate`), the `/channels/connect/success|error` landing routes, and
`stock-browser.tsx`'s structural patterns (search box, stable JS-masonry,
IntersectionObserver infinite scroll) as a template for `cloud-browser.tsx`.

### The `isComposablePlatform` leak fix

`isComposablePlatform()` (`src/features/onboarding/constants.ts`) is a
**blocklist** (`MESSAGING_PLATFORMS`), allow-by-default. Adding the cloud
platforms to the `SocialPlatform` union would make them pass this filter and
**leak into the composer's publishing-channel selector and the posts channel
filter** (both call `isComposablePlatform`). Fix by making the intent explicit:
introduce a `CLOUD_STORAGE_PLATFORMS` set and exclude it alongside
`MESSAGING_PLATFORMS` (equivalently, invert to an allowlist of publishable
platforms). Cloud connections are surfaced only through the new
`use-cloud-sources` hook, never as publishable channels.

## Data flow

1. User opens Add-media → picks a cloud source in the rail.
2. `cloud-source-pane` checks connection via `use-cloud-sources` (reads the
   channels list, filtered to the cloud platform).
3. **Disconnected** → `cloud-connect-card`: large logo + name + "Connect to X"
   button → `openOAuthPopup` + channel `initiate`. On popup close, invalidate the
   channels query; pane re-renders into the browser. No page reload.
4. **Connected** → `cloud-browser`: root folder breadcrumb, search box,
   Photos/Videos toggle, infinite-scroll media grid (stable masonry). Each tile
   carries a selection checkbox.
5. **Multi-select** → footer shows **"Add N items"**. Click → each selected file
   goes through `use-cloud-import` (backend copies cloud → permanent URL) → each
   becomes a `DraftMediaItem` handed to `onAddMedia`; dialog closes. Per-tile
   loading + button spinner during import.

## States (professional polish — every source pane)

- **Loading:** connection-check skeleton; browse skeleton (masonry); per-tile +
  button spinner during import.
- **Not connected:** logo + name + Connect CTA (empty-state style).
- **Empty folder:** icon + "No media in this folder".
- **Error:** token-refresh failure → "Reconnect" CTA; browse failure → Retry;
  import failure → toast, selection preserved (not lost).
- **Disabled / keyboard:** checkboxes keyboard-navigable, `Esc` closes the
  dialog, focus rings preserved (shadcn defaults).

## Error handling

- Browse endpoint: 401/token-refresh-fail → structured error the pane maps to a
  "Reconnect" state; upstream provider 429/5xx → surfaced as a retryable error.
- Import endpoint: provider download failure or storage-upload failure → 502-ish
  error; frontend toasts and keeps the selection so the user can retry.
- Workspace ownership mismatch → 403.

## Testing

**Backend:**
- Browse: unit test with a mock provider service + a fake expired token →
  asserts refresh is invoked and the correct provider method is dispatched by
  platform.
- Import: unit test cloud-download → storage-upload pipeline returns the
  permanent-URL shape.
- Guards: JWT + workspace ownership on both routes.

**Frontend:**
- `use-cloud-browse` pagination (append, stable order) and `use-cloud-import` →
  `DraftMediaItem` shape.
- `isComposablePlatform` allowlist: cloud + messaging excluded, social included.
- `cloud-connect-card` renders the CTA when disconnected; `cloud-browser`
  renders when connected (mock query).

## Global constraints

- shadcn/ui only for UI primitives; icons via `lucide-react`; brand logos as
  inline SVG / `public/` images (matching `platform-logos.tsx` /
  `stock-source-logos.tsx`). Theme tokens only.
- Never re-author provider services (Dropbox/Drive/OneDrive/Photos) or the
  Unsplash/Pexels services — compose them.
- Cloud tokens never reach the browser. Browse/import always by `channelId`.
- Cloud file selection always imports to our storage — never hotlink an
  expiring cloud URL into a draft.
- Backend `.env` keys already exist (`DROPBOX_*`, `ONEDRIVE_*`,
  `YOUTUBE_CLIENT_ID/SECRET` reused for Google). Document any new key in
  `.env.example`.
- Do not modify Canva.
