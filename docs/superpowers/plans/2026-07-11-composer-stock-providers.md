# Composer Stock Providers — Pixabay, Giphy, Coverr, Flickr

> **Status:** ✅ DONE (autonomous build; user away, gave standing approval to
> integrate all four without gating). Backend: `tsc` clean + 37/37 stock-media
> tests pass. Frontend: production build green. All changes in the WORKING TREE,
> uncommitted (see commit plan at bottom). Branch: `feat/composer-cloud-sources`
> (both repos) — see "Branching decision" below.
>
> **Still needs (manual, user):** free API keys per provider (see "Manual steps"),
> and for OneDrive an Azure Portal redirect-URI + Graph-permission registration.

**Goal:** Add four more free stock-media sources to the composer's Add-media
dialog, alongside the existing Unsplash + Pexels, reusing the `stock-media`
backend module and the `StockBrowser` frontend pane.

**Architecture:** The backend already has a `stock-media` module that composes
provider services (`UnsplashService`, `PexelsService`) behind a normalized
`StockMediaItem` envelope + per-provider mappers, exposed at
`GET /media/stock/search`. We extend that module with four more provider
services + mappers and widen the `StockProvider` union. The frontend already has
a generic `StockBrowser` (search + type toggle + infinite masonry) driven by a
`provider` prop; we make its provider-specific bits data-driven via a new
`STOCK_SOURCES` capability descriptor and add the four sources to the rail.

## Branching decision (documented, user was away)

These providers extend the same composer media-picker infra that lives only on
`feat/composer-cloud-sources` (not merged). Creating a separate branch would NOT
isolate anything — the shared working tree already carries the uncommitted
cloud-sources fixes (OneDrive, Google Photos disable, Drive thumbnail). So the
work continues on `feat/composer-cloud-sources`. User may re-split on return.

## Global constraints

- **shadcn/ui only** for UI primitives; icons via `lucide-react`; brand logos as
  inline single-path SVGs matching `stock-source-logos.tsx` convention; theme
  tokens only (no hard-coded colors except a brand mark's own fill).
- **Never re-author** `UnsplashService` / `PexelsService` or the existing
  Unsplash/Pexels panes beyond making provider-specific bits data-driven.
- Reuse the existing `StockMediaItem` envelope shape (do not fork it).
- API keys are read server-side via `ConfigService`; **tokens/keys never reach
  the browser** (same as Unsplash/Pexels — browse always via our endpoint).
- Stock media is **hotlinked** in this design (previewUrl/fullUrl are provider
  CDN URLs), matching Unsplash/Pexels. See Coverr caveat below.
- Each new provider service handles a **missing API key** gracefully (throws a
  clear `BadRequestException`, never leaks the key).

## Capability matrix

| Provider | image | video | search | no-query feed | attribution | key env |
|----------|:-----:|:-----:|:------:|---------------|-------------|---------|
| Pixabay  |  ✅   |  ✅   |   ✅   | popular (`order=popular`, no `q`) | optional (show author) | `PIXABAY_API_KEY` |
| Giphy    |  ✅ (GIF) | ❌ | ✅ | trending      | **required** ("GIPHY") | `GIPHY_API_KEY` |
| Coverr   |  ❌   |  ✅   |   ✅   | featured/popular | required ("Coverr") | `COVERR_API_KEY` |
| Flickr   |  ✅   |  ❌   |   ✅   | interestingness | required (CC-BY author) | `FLICKR_API_KEY` |

## Per-provider API contracts (researched 2026-07-11)

### Pixabay — `PIXABAY_API_KEY`
- **Images:** `GET https://pixabay.com/api/?key=KEY&q=&image_type=photo&page=&per_page=&safesearch=true`
  - `per_page` 3–200 (use requested perPage, clamp 3–200); `page` 1-based.
  - no `q` (curated feed) → send `order=popular` with empty/omitted `q`.
  - Hit fields → `StockMediaItem`: `id`→providerId, `previewURL`/`webformatURL`→previewUrl,
    `largeImageURL`→fullUrl, `imageWidth`/`imageHeight`→width/height, `user`→authorName,
    `pageURL`→providerUrl+authorUrl, `type:'image'`.
  - `totalHits` capped at 500 → `hasMore = page*per_page < min(totalHits,500)`.
- **Videos:** `GET https://pixabay.com/api/videos/?key=KEY&q=&page=&per_page=`
  - Hit `videos.large.url` (fallback `.medium.url`)→fullUrl; `videos.medium.url`→previewUrl
    (Pixabay video thumbnails: `https://i.vimeocdn.com/video/{picture_id}_295x166.jpg`
    from `picture_id` — if `picture_id` present build the thumb, else use a video
    poster; keep simple: previewUrl = a still if available else the medium mp4 poster).
  - `videos.large.width/height`→width/height; `duration`→durationSec; `type:'video'`.
- Attribution: not legally required; still populate authorName + pageURL.

### Giphy — `GIPHY_API_KEY`
- **Search:** `GET https://api.giphy.com/v1/gifs/search?api_key=KEY&q=&limit=&offset=&rating=pg-13`
- **Trending (no q):** `GET https://api.giphy.com/v1/gifs/trending?api_key=KEY&limit=&offset=&rating=pg-13`
- Pagination is offset-based: `offset = (page-1)*perPage`, `limit = perPage`.
  `hasMore` from `pagination.total_count > offset+limit` (fallback: returned count === limit).
- Data fields → `StockMediaItem`: `id`→providerId, `images.fixed_width.url`→previewUrl,
  `images.original.url` (the .gif)→fullUrl, `images.original.width/height`→width/height,
  `user?.display_name`||`username`||'GIPHY'→authorName, `user?.profile_url`||`url`→authorUrl,
  `url`→providerUrl, `type:'image'` (GIF is posted as an image/gif).
- **Attribution required:** provider label must read "GIPHY". (Text attribution is
  acceptable for v1; official mark is a later polish.)

### Coverr — `COVERR_API_KEY`
- **Search:** `GET https://api.coverr.co/videos?query=&page=&page_size=&urls=true`
  (auth: `Authorization: Bearer KEY` header OR `api_key` query — use header).
- **No query (featured):** same endpoint without `query` (default sort), `urls=true`.
- `urls=true` is REQUIRED or the response omits playable URLs.
- Response: `{ page, pages, page_size, total, hits: [...] }` (confirm field names at
  runtime; map defensively). Video fields → `StockMediaItem`:
  `id`→providerId, `urls.mp4` (or `urls.mp4_download`)→fullUrl,
  `urls.poster`/`thumbnail`→previewUrl, `max_width`/`max_height` or `info.width/height`→
  width/height, `duration`→durationSec, `title`→authorName ('Coverr'),
  `https://coverr.co/videos/{id}`→providerUrl, `type:'video'`.
- `hasMore = page < pages`.
- **⚠️ KNOWN LIMITATION:** Coverr `urls.mp4` are **signed JWT URLs tied to the API
  key and time-limited**. Hotlinking them into a scheduled post that publishes
  later WILL break when the signature expires. v1 hotlinks for consistency; a
  follow-up should IMPORT Coverr selections into our storage (R2/Cloudinary) like
  the cloud-media import seam. Flag this to the user. Attribution: "Coverr" required.

### Flickr — `FLICKR_API_KEY`
- **Search:** `GET https://api.flickr.com/services/rest/?method=flickr.photos.search`
  `&api_key=KEY&text=&license=4,5,7,9,10&sort=relevance&content_type=1&media=photos`
  `&extras=url_l,url_m,owner_name,license&per_page=&page=&format=json&nojsoncallback=1`
- **No query (interestingness):** same call with `sort=interestingness-desc` and
  omit `text` if the API accepts it; if empty `text` is rejected, fall back to
  `method=flickr.interestingness.getList` (still pass `extras`; note its results
  are NOT license-filtered, so prefer the empty-text search first).
- **License filter is MANDATORY** (commercial-safe): `4` (CC BY), `5` (CC BY-SA),
  `7` (No known copyright), `9` (CC0 Public Domain), `10` (Public Domain Mark).
  Exclude NC (1,2,3) and ND (6) to be safe for commercial social use.
- Photo fields → `StockMediaItem`: `id`→providerId, `url_l`||`url_m`→fullUrl,
  `url_m`→previewUrl (fallback url_l), `width_l`/`height_l` (or url_m dims)→width/height,
  `ownername`→authorName, `https://www.flickr.com/photos/{owner}/{id}`→providerUrl+authorUrl,
  `type:'image'`. Skip hits missing a usable url_l/url_m.
- **Attribution required** (CC-BY): show author + Flickr link.

## Backend tasks (socialmedia-workspace)

Files (all under `src/stock-media/` unless noted):
- **Modify** `stock-media.types.ts`: widen `StockProvider` to
  `'unsplash' | 'pexels' | 'pixabay' | 'giphy' | 'coverr' | 'flickr'`.
- **Modify** `dto/search-stock.dto.ts`: `@IsIn([...all six])` for `provider`.
- **Create** `providers/pixabay.service.ts`, `providers/giphy.service.ts`,
  `providers/coverr.service.ts`, `providers/flickr.service.ts` — each `@Injectable`,
  reads its key via `ConfigService`, exposes typed search + no-query methods
  returning provider-native shapes (mirror `PexelsService` structure). Missing
  key → `BadRequestException('<Provider> is not configured')`.
- **Create** `mappers/pixabay.mapper.ts` (image+video), `mappers/giphy.mapper.ts`,
  `mappers/coverr.mapper.ts`, `mappers/flickr.mapper.ts` → `StockMediaItem`.
- **Modify** `stock-media.service.ts`: inject the 4 services; extend `search()` and
  `curated()` with per-provider branches; extend the video-support guard
  (no-video: unsplash, flickr, giphy; no-image: coverr — reject unsupported
  provider×type with `BadRequestException`).
- **Modify** `stock-media.module.ts`: add the 4 services to `providers`.
- **Tests** (`*.spec.ts` co-located): one mapper spec per provider (native→envelope,
  incl. video vs image where relevant, and Flickr URL construction + license note);
  a `stock-media.service` spec branch per provider (dispatch to right method).
- **Docs/env:** add `PIXABAY_API_KEY`, `GIPHY_API_KEY`, `COVERR_API_KEY`,
  `FLICKR_API_KEY` to `.env.example` with a one-line "get key at …" comment.

## Frontend tasks (socialmedia-frontend)

Files under `src/features/composer/`:
- **Modify** `api/stock-media.api.ts`: widen `StockProvider` union (match backend).
- **Create** `constants/stock-sources.ts`: `StockSourceMeta`
  `{ provider, label, Logo, supportsImage, supportsVideo }` + `STOCK_SOURCES` array
  (unsplash: image-only; pexels: image+video; pixabay: image+video; giphy: image-only;
  coverr: video-only; flickr: image-only). This is the single source of truth the
  rail, dialog, and browser read.
- **Modify** `components/media-picker/stock-source-logos.tsx`: add `PixabayLogo`,
  `GiphyLogo`, `CoverrLogo`, `FlickrLogo` (inline brand SVGs).
- **Modify** `components/media-picker/source-rail.tsx`: build the stock rail group
  from `STOCK_SOURCES` (a "Stock" group above "Cloud"); keep Upload separate.
  Widen `SourceId` to include the new providers.
- **Modify** `components/media-picker/stock-browser.tsx`: replace the
  `provider === 'unsplash'|'pexels'` hard-coding with a `STOCK_SOURCES` lookup —
  show the Photos/Videos toggle only when `supportsImage && supportsVideo`, else
  force the single supported type; drive the search placeholder/label from the
  source's `label`.
- **Modify** `components/media-picker/stock-attribution.tsx`: extend `LABEL` map
  with pixabay/giphy/coverr/flickr (Giphy → "GIPHY", Coverr → "Coverr", etc.).
- **Modify** `components/media-picker/media-picker-dialog.tsx`: derive `isStockSource`
  and the `<StockBrowser>` render from `STOCK_SOURCES` membership (not the two
  hard-coded ids); generalize the credit-checkbox label.
- **Tests:** extend/keep `stock-media-item` tests as needed; add a small
  `stock-sources` capability test if useful.

## Manual steps for the user (post-merge, to actually work end-to-end)

Each provider needs a free API key added to the backend `.env`:
- **Pixabay:** https://pixabay.com/api/docs/ (free key on account page) → `PIXABAY_API_KEY`
- **Giphy:** https://developers.giphy.com/ (create app) → `GIPHY_API_KEY`
- **Coverr:** https://coverr.co/developers (instant key) → `COVERR_API_KEY`
- **Flickr:** https://www.flickr.com/services/apps/create/apply/ → `FLICKR_API_KEY`

Without a key, that source's pane shows a clean "not configured / try later" empty
state (never a crash). Others keep working.

## Also pending on this branch (separate, already done in working tree, uncommitted)

- OneDrive OAuth fix (Live Connect → Azure AD v2 / Graph): `oauth.service.ts` (clean)
  + `channels.schema.ts` onedrive scopes (⚠️ this file also carries an unrelated
  foreign whatsapp reformat — do NOT `git add` it wholesale; use patch-staging).
  Needs Azure Portal: register redirect URI + delegated Graph perms
  (`Files.Read`, `offline_access`, `User.Read`); existing OneDrive channels reconnect.
- Google Photos disabled (dead `photoslibrary.readonly` scope): frontend
  `cloud-sources.ts` + `integrations-catalog.ts`. Re-enable needs Picker API (separate effort).
- Google Drive thumbnail resolution bump: `media-sources/mappers/drive.mapper.ts`.
