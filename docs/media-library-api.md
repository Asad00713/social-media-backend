# Media Library API Documentation

Base URL: `/workspaces/:workspaceId/media-library` (the upload routes live under `/media`, see [Uploads](#uploads-media)).

Every endpoint needs JWT authentication via the `Authorization: Bearer <token>` header. The one exception is the folder zip download, which takes a signed ticket instead (see [Folder zip download](#folder-zip-download)).

The request and response shapes follow the Library API contract (frontend repo, `docs/superpowers/specs/2026-10-31-library-api-contract.md`). The TypeScript copies live in `src/media-library/dto/contract.ts`. If a shape needs to change, the contract changes first.

- All times are ISO 8601 UTC strings. Sizes are bytes as JSON numbers.
- Path ids are UUIDs.
- `src/media-library/contract-routes.spec.ts` checks that each route below exists once, on the right controller, with the capability shown.

---

## Table of Contents

1. [Access](#access)
2. [Shared types](#shared-types)
3. [Stats](#stats)
4. [Categories (folders)](#categories-folders)
5. [Media Items](#media-items-images-videos-gifs-documents)
6. [Templates](#templates)
7. [Text Snippets](#text-snippets)
8. [Saved Links](#saved-links)
9. [Bulk actions](#bulk-actions)
10. [Recycle Bin](#recycle-bin)
11. [Uploads (`/media`)](#uploads-media)
12. [Posts: `libraryItemId`](#posts-libraryitemid)
13. [Error responses](#error-responses)
14. [Owner scripts](#owner-scripts)
15. [Deploy notes](#deploy-notes)

---

## Access

Every workspace route sits behind `JwtAuthGuard` + `WorkspaceRoleGuard` and declares one capability:

| Capability | Routes |
| --- | --- |
| `posts:draft` | everything not listed below |
| `posts:publish` | `DELETE items/:itemId/permanent`, `DELETE templates/:templateId/permanent`, `DELETE snippets/:snippetId/permanent`, `DELETE links/:linkId/permanent`, `POST recycle-bin/delete`, `POST recycle-bin/empty`, and `POST items/bulk` with `action: "permanentDelete"` (the route itself is `posts:draft`; the handler checks `posts:publish` for that action) |
| none (ticket) | `GET categories/:categoryId/zip` |

The `/media` upload routes are behind `JwtAuthGuard` and check `posts:draft` on the body's `workspaceId` (`WorkspaceAccessService.assertCan`).

Denials differ by route family:
- **Workspace routes** (`/workspaces/:workspaceId/media-library/…`): a caller who is not a member of the workspace, or whose role lacks the capability, gets `403` from `WorkspaceRoleGuard`.
- **`/media` upload routes**: the same caller gets `404` (`assertCan` does not reveal whether the workspace exists).

---

## Shared types

```ts
type FolderKind = 'media' | 'template' | 'text_snippet' | 'link'
type MediaType = 'image' | 'video' | 'gif' | 'document'
type SnippetType = 'caption' | 'hashtags' | 'cta' | 'signature' | 'other'
type BinKind = 'media' | 'template' | 'snippet' | 'link'
type Ratio = '1:1' | '4:5' | '9:16' | '16:9'
type MediaSort = 'newest' | 'oldest' | 'most_used' | 'recently_used' | 'name' | 'size'
type StorageProvider = 'cloudinary' | 'r2'

interface UserRef { id: string; name: string; avatarUrl: string | null }

interface Page<T> { items: T[]; total: number; limit: number; offset: number }
```

### Legacy names still accepted

The old composer picker, Maestro and the chatbot still send the old names, so the server keeps accepting them. When a request sends both, the contract name wins. New clients send only the contract names.

| Legacy | Contract |
| --- | --- |
| items `isStarred` | `starred` |
| items `sortBy` / `sortOrder` | `sort` |
| items `isDeleted` | the Bin (`GET recycle-bin`) |
| snippets `snippetType` (query) | `type` |
| snippet type `bio` | `signature` |
| folder types `image`, `video`, `gif`, `document` | `media` |
| bin `type` | `kind` |

---

## Stats

```
GET /workspaces/:workspaceId/media-library/stats          posts:draft
```

**Response:** `200 OK`, a `LibraryStats`:

```ts
interface LibraryStats {
  storage: {
    used: number                // all media_items.file_size, Bin included
    limit: number               // effective: storage_bytes_limit + extra_storage_purchased
    percent: number             // 0-100, one decimal
    level: 'ok' | 'almost_full' | 'full'   // almost_full at >= 90%, full at >= 100%
    byType: { images: number; videos: number; docs: number }   // bytes, not deleted
  }
  unused: { count: number; bytes: number }   // not deleted, never used
  bin: { count: number; bytes: number }      // all four kinds; bytes from media only
  counts: {
    media: { all: number; images: number; videos: number; docs: number }
    templates: { all: number; post: number; story: number; reel: number; carousel: number }
    snippets: { all: number; caption: number; hashtags: number; cta: number; signature: number }
    links: number
    folders: { media: number; template: number; text_snippet: number; link: number }
  }
}
```

Storage per plan (per workspace): FREE 500 MB (`524288000`), BASIC 2 GB (`2147483648`), PRO 10 GB (`10737418240`), MAX 25 GB (`26843545600`).

**Which plan counts:** the workspace owner's plan while their subscription is `active` or `trialing`; anything else (no subscription, another status, an unknown plan code) is FREE. Migration 0054's backfill of `workspace_usage.storage_bytes_limit` and `StorageQuotaService`'s fallback both apply this one rule.

The effective limit is the workspace's `workspace_usage` row, `storage_bytes_limit + extra_storage_purchased` (bought add-ons). Billing sync writes the row; a workspace without one falls back to its owner's plan by the rule above.

---

## Categories (folders)

A folder holds one kind of thing. The four kinds are `media`, `template`, `text_snippet` and `link`. The old per-asset-type folders (`image`, `video`, `gif`, `document`) were merged into `media` by migration 0054; same-named folders got a suffix (" (Images)", " (GIFs)", " (Videos)", " (Docs)") and kept their ids.

An item can be filed only into a folder of its own kind. Filing into a folder of another kind is a `400`.

### Create Category

```
POST /workspaces/:workspaceId/media-library/categories          posts:draft
```

```json
{
  "name": "Marketing Images",
  "description": "Images for marketing campaigns",
  "type": "media",
  "color": "#FF5733",
  "icon": "folder"
}
```

| Field       | Type   | Required | Description |
| ----------- | ------ | -------- | ----------- |
| name        | string | Yes      | Folder name (max 100 chars) |
| description | string | No       | |
| type        | `FolderKind` | Yes | `image`/`video`/`gif`/`document` are accepted and stored as `media` |
| color       | string | No       | max 20 chars |
| icon        | string | No       | max 50 chars |

**Response:** `201 Created`, the folder.

### Get All Categories

```
GET /workspaces/:workspaceId/media-library/categories          posts:draft
```

| Parameter | Type | Description |
| --------- | ---- | ----------- |
| type      | `FolderKind` | Only folders of this kind (legacy media types map to `media`) |
| withStats | `true` | Add `stats` to each folder |
| search    | string | `ilike` on the folder name |

**Response:** `200 OK`, `MediaCategory[]`. With `withStats=true` each folder adds:

```ts
stats: { itemCount: number; bytes: number; covers: string[] }   // covers: up to 4 thumbnail URLs, newest first
```

### Get Categories Grouped by Kind

```
GET /workspaces/:workspaceId/media-library/categories/grouped          posts:draft
```

**Response:** `200 OK`. Keyed by folder kind (no longer by asset type):

```json
{ "media": [], "template": [], "text_snippet": [], "link": [] }
```

### Get, Update, Delete, Reorder

```
GET    /workspaces/:workspaceId/media-library/categories/:categoryId          posts:draft
PUT    /workspaces/:workspaceId/media-library/categories/:categoryId          posts:draft
DELETE /workspaces/:workspaceId/media-library/categories/:categoryId          posts:draft
POST   /workspaces/:workspaceId/media-library/categories/reorder              posts:draft
```

`PUT` takes any of `name`, `description`, `color`, `icon`, `displayOrder`, `type` (a `FolderKind`). `reorder` takes `{ "type": FolderKind, "categoryIds": ["uuid", ...] }`.

### Folder zip download

The access token lives in memory, so a plain link can't carry it. A download takes two steps.

**Step 1: ticket**

```
POST /workspaces/:workspaceId/media-library/categories/:categoryId/zip-ticket          posts:draft
```

**Response:** `200 OK`

```json
{
  "url": "https://api.example.com/workspaces/<ws>/media-library/categories/<id>/zip?ticket=<signed>",
  "expiresAt": "2026-11-01T10:05:00.000Z"
}
```

- The ticket is HMAC-signed with `LIBRARY_ZIP_TICKET_SECRET`. It names the workspace, the folder and the user, and expires after 5 minutes.
- `404` when the folder is not in this workspace, `400` when it is not a media folder, `413 {code:'ZIP_TOO_LARGE', message}` when the folder's files add up to more than 2 GB.
- `503` when `LIBRARY_ZIP_TICKET_SECRET` is unset or shorter than 32 characters, or `API_PUBLIC_URL` is unset.

**Step 2: download**

```
GET /workspaces/:workspaceId/media-library/categories/:categoryId/zip?ticket=<signed>          no bearer token
```

- Streams `application/zip` with `Content-Disposition: attachment`. The frontend sets `window.location` (or a hidden `<a download>`) to the ticket URL.
- `401 {code:'INVALID_TICKET', message}` for a missing, bad or expired ticket, a ticket for another workspace or folder, or a user who has lost `posts:draft` since the ticket was made.
- The folder is re-checked when the download starts, so a valid ticket can still get:
  - `404` if the folder was deleted after the ticket was issued;
  - `400` if it is no longer a media folder;
  - `413 ZIP_TOO_LARGE` if it has grown past 2 GB.
- Files that can't be fetched are listed in a `_skipped.txt` entry inside the zip.
- This is the only workspace route without `WorkspaceRoleGuard`. It is on `LibraryZipController` and listed in `OPEN_ROUTES` (`src/workspace-members/open-workspace-routes.ts`) with the reason.

---

## Media Items (Images, Videos, GIFs, Documents)

### The `MediaItem` shape

```ts
interface MediaItem {
  id: string
  workspaceId: string
  uploadedById: string | null
  categoryId: string | null
  type: MediaType
  name: string
  description: string | null
  fileUrl: string
  thumbnailUrl: string | null
  mimeType: string | null
  fileSize: number | null        // the size the server read from the store
  width: number | null
  height: number | null
  duration: number | null        // whole seconds
  cloudinaryPublicId: string | null
  cloudinaryAssetId: string | null
  tags: string[]
  isStarred: boolean
  usageCount: number             // number of posts that use the item
  lastUsedAt: string | null
  isDeleted: boolean
  deletedAt: string | null
  deletedById: string | null
  createdAt: string
  updatedAt: string
  // added by the redesign
  altText: string | null
  storageProvider: StorageProvider
  pageCount: number | null       // PDFs
  uploadedBy: UserRef | null     // joined
  category: MediaCategory | null // joined
}
```

`usageCount` counts posts (see [Posts](#posts-libraryitemid)); the posts trigger from migration 0055 keeps it current.

### Create Media Item (register a direct upload)

```
POST /workspaces/:workspaceId/media-library/items          posts:draft
```

Registers a file the client uploaded directly (R2 presign, or a signed Cloudinary upload).

```json
{
  "type": "image",
  "name": "Product Banner",
  "fileUrl": "https://res.cloudinary.com/<cloud>/image/upload/v1/library/<ws>/<uuid>.png",
  "cloudinaryPublicId": "library/<ws>/<uuid>",
  "width": 1200,
  "height": 628,
  "categoryId": "uuid",
  "tags": ["summer"],
  "altText": "A red banner"
}
```

Fields: `type` (required), `name` (required, max 255), `fileUrl` (required), `description`, `thumbnailUrl`, `mimeType`, `width`, `height`, `duration`, `cloudinaryPublicId`, `cloudinaryAssetId`, `categoryId` (a media folder), `tags`, `altText`, `pageCount`. `fileSize` is still accepted but never used.

- The file must be one this workspace stored: a Cloudinary public id under `library/<ws>/`, or an R2 key under this workspace. Anything else is a `400`.
- `thumbnailUrl` is `null` (or left out), or a video poster this workspace stored with `upload/file` and `purpose: 'thumbnail'`: the plain Cloudinary URL of a public id under `library-thumbs/<ws>/`. Anything else (another URL, another workspace's poster, a Library upload, an R2 URL, a URL with transformations) is a `400`.
- The server reads the real size from the store. If it cannot, the save is refused:
  - `400 {code:'UPLOAD_NOT_FINISHED', message}`: the object is not there yet.
  - `503 {code:'SIZE_UNAVAILABLE', message}`: provider error. Retryable.

  The client retries either a few times with backoff before failing the row.
- Over the limit: `413 STORAGE_FULL`. The file, and the poster sent as `thumbnailUrl`, are each deleted from storage only when no Library row (as its file or its thumbnail) and no post, campaign slot, evergreen entry or template references it. If that check itself fails, the file is kept.
- Saving the same stored object twice returns the first row.

**Response:** `201 Created`, the `MediaItem`.

### Get All Media Items

```
GET /workspaces/:workspaceId/media-library/items          posts:draft
```

All parameters are optional and combine with AND.

| Parameter   | Type | Default | Meaning |
| ----------- | ---- | ------- | ------- |
| type        | `MediaType` or `images` | | `images` = image + gif |
| categoryId  | uuid | | |
| search      | string | | `ilike` on name |
| tags        | comma list | | the item has every tag listed |
| starred     | `true` | | |
| neverUsed   | `true` | | the same reference test as `/usage`, with zero hits |
| gifOnly     | `true` | | |
| ratio       | `Ratio` | | matched from width/height with a tolerance |
| addedSince  | ISO date | | `created_at >=` |
| uploadedBy  | uuid | | |
| sort        | `MediaSort` | `newest` | `oldest` = `created_at ASC, id ASC`; `most_used` = `usage_count`; `recently_used` = `last_used_at DESC NULLS LAST`; `size` = largest first |
| limit       | 1-100 | 50 | |
| offset      | int | 0 | |

Legacy: `isStarred`, `sortBy` (`createdAt`/`name`/`usageCount`/`lastUsedAt`), `sortOrder`, `isDeleted`.

**Response:** `200 OK`, `Page<MediaItem>`.

### Get Recent / Single Media Item

```
GET /workspaces/:workspaceId/media-library/items/recent?limit=20          posts:draft
GET /workspaces/:workspaceId/media-library/items/:itemId                  posts:draft
```

### Update Media Item

```
PUT /workspaces/:workspaceId/media-library/items/:itemId          posts:draft
```

Any of `name`, `description`, `categoryId` (a media folder, or `null` to unfile), `tags`, `isStarred`, `altText` (`null` clears it). An over-limit workspace can still edit, bin, restore and move items.

**Response:** `200 OK`, the `MediaItem` (with `category` and `uploadedBy`).

### Record use

```
POST /workspaces/:workspaceId/media-library/items/:itemId/use          posts:draft
```

Sets `last_used_at` only. It no longer touches `usage_count`, which counts posts. **Response:** the `MediaItem`.

### Usage ("Used in")

```
GET /workspaces/:workspaceId/media-library/items/:itemId/usage          posts:draft
```

```ts
interface UsageEntry {
  kind: 'post' | 'campaign_slot'
  id: string
  campaignId: string | null     // the slot's campaign, so a campaign_slot row can link; null for posts
  title: string                 // the post's first line, or the campaign name
  platform: string              // e.g. 'instagram'
  date: string                  // scheduled or published time
  status: 'draft' | 'scheduled' | 'published' | 'failed'
}
// response
{ items: UsageEntry[]; total: number }   // newest first, items capped at 20; total counts all
```

Sources:
- posts of this workspace that reference the item by `libraryItemId` or by URL;
- campaign slots not yet turned into a post;
- evergreen entries (reported as `campaign_slot`; a retired entry shows as `draft`).

`404` for an item outside the workspace.

### Alt text suggestion

```
POST /workspaces/:workspaceId/media-library/items/:itemId/alt-text          posts:draft
```

**Response:** `200 OK`, `{ "altText": "..." }`. Nothing is saved; the client saves it with `PUT items/:itemId`.

- `422 {code:'NOT_AN_IMAGE', message}` for videos and documents.
- `402 {code:'AI_TOKENS_EXHAUSTED', message}` when the workspace is out of AI tokens. The route maps the AI token check's 403/400 to this body.

### Delete, Restore, Delete forever

```
DELETE /workspaces/:workspaceId/media-library/items/:itemId                posts:draft    (to the Bin)
POST   /workspaces/:workspaceId/media-library/items/:itemId/restore        posts:draft
DELETE /workspaces/:workspaceId/media-library/items/:itemId/permanent      posts:publish
```

`DELETE items/:itemId` and `restore` respond with the `MediaItem`.

`permanent` works only on a binned item. A live item is a `404` ("Item not found in recycle bin"). The file is deleted from storage unless another row (any workspace, as its file or its thumbnail) or a post, campaign slot, evergreen entry or template of the workspace still uses it; the row goes either way. A template keeps the bytes only: it does not make the item "used" (`usageCount`, `/usage` and `neverUsed` count posts, campaign slots and evergreen entries). Once the row is gone, a video's poster (under `library-thumbs/<ws>/`) is deleted by the same rule; if that check fails, the poster is kept. When storage refuses the delete, the route returns `502` and the row stays, so the user can retry. Response: `{ "success": true, "message": "Media item permanently deleted" }`.

### Bulk

```
POST /workspaces/:workspaceId/media-library/items/bulk          posts:draft (permanentDelete: posts:publish)
```

See [Bulk actions](#bulk-actions).

---

## Templates

Templates are reusable post structures with placeholders and media slots.

```
POST   /workspaces/:workspaceId/media-library/templates                          posts:draft
GET    /workspaces/:workspaceId/media-library/templates                          posts:draft
POST   /workspaces/:workspaceId/media-library/templates/bulk                     posts:draft
GET    /workspaces/:workspaceId/media-library/templates/:templateId              posts:draft
PUT    /workspaces/:workspaceId/media-library/templates/:templateId              posts:draft
POST   /workspaces/:workspaceId/media-library/templates/:templateId/clone        posts:draft
DELETE /workspaces/:workspaceId/media-library/templates/:templateId              posts:draft    (to the Bin)
POST   /workspaces/:workspaceId/media-library/templates/:templateId/restore      posts:draft
DELETE /workspaces/:workspaceId/media-library/templates/:templateId/permanent    posts:publish
POST   /workspaces/:workspaceId/media-library/templates/:templateId/use          posts:draft
```

### Create Template

```json
{
  "name": "Product Launch Template",
  "description": "Template for product launches",
  "templateType": "post",
  "platforms": ["instagram", "facebook"],
  "content": {
    "text": "Introducing {{product_name}}! {{description}}",
    "mediaSlots": [
      { "id": "main-image", "label": "Product Image", "required": true, "acceptedTypes": ["image"] }
    ],
    "hashtags": ["newproduct", "launch"],
    "defaultCaption": "Check out our latest!"
  },
  "thumbnailUrl": "https://...",
  "categoryId": "uuid",
  "tags": ["product", "launch"]
}
```

| Field        | Type     | Required | Description |
| ------------ | -------- | -------- | ----------- |
| name         | string   | Yes      | max 255 chars |
| description  | string   | No       | |
| templateType | enum     | Yes      | `post`, `story`, `reel`, `carousel` |
| platforms    | string[] | No       | |
| content      | object   | Yes      | `text`, `mediaSlots`, `media`, `hashtags`, `defaultCaption` |
| thumbnailUrl | string   | No       | |
| categoryId   | uuid     | No       | a `template` folder |
| tags         | string[] | No       | |

Each `content.media[]` entry is `{ id, type: 'image' | 'video' | 'gif', url, thumbnailUrl?, width?, height?, durationSec?, sizeBytes?, libraryItemId? }`. `libraryItemId` (a uuid) names the Library item the attachment came from; it is stored as sent and comes back on every read. A media entry's `url`, or the template's `thumbnailUrl`, keeps that file's bytes when its Library item is deleted forever (see [Delete, Restore, Delete forever](#delete-restore-delete-forever)).

`PUT` takes the same fields, all optional, plus `isStarred`. `clone` takes an optional `{ "name": "..." }`.

### Get All Templates

| Parameter    | Type | Default | Description |
| ------------ | ---- | ------- | ----------- |
| templateType | enum | | `post`, `story`, `reel`, `carousel` |
| categoryId   | uuid | | |
| platform     | string | | |
| starred      | `true` | | (legacy `isStarred` also accepted) |
| search       | string | | name, description |
| sort         | `newest` \| `oldest` \| `most_used` \| `recently_used` \| `name` | `newest` | `oldest` = `created_at ASC, id ASC` |
| limit        | 1-100 | 50 | |
| offset       | int | 0 | |

**Response:** `200 OK`, `Page<Template>`.

`usageCount` on templates counts picks: `POST templates/:id/use` adds one and sets `last_used_at`.

`permanent` works only on a binned template; a live one is a `404`. Response: `{ "success": true, "message": "Template permanently deleted" }`.

---

## Text Snippets

Reusable text: captions, hashtags, CTAs, signatures.

```
POST   /workspaces/:workspaceId/media-library/snippets                         posts:draft
GET    /workspaces/:workspaceId/media-library/snippets                         posts:draft
POST   /workspaces/:workspaceId/media-library/snippets/bulk                    posts:draft
GET    /workspaces/:workspaceId/media-library/snippets/:snippetId              posts:draft
PUT    /workspaces/:workspaceId/media-library/snippets/:snippetId              posts:draft
DELETE /workspaces/:workspaceId/media-library/snippets/:snippetId              posts:draft    (to the Bin)
POST   /workspaces/:workspaceId/media-library/snippets/:snippetId/restore      posts:draft
DELETE /workspaces/:workspaceId/media-library/snippets/:snippetId/permanent    posts:publish
POST   /workspaces/:workspaceId/media-library/snippets/:snippetId/use          posts:draft
```

### Create Text Snippet

```json
{
  "name": "Summer Sale Caption",
  "snippetType": "caption",
  "content": "Summer is here! Enjoy 20% off all items with code SUMMER20",
  "categoryId": "uuid",
  "tags": ["summer", "sale"]
}
```

| Field       | Type     | Required | Description |
| ----------- | -------- | -------- | ----------- |
| name        | string   | Yes      | max 255 chars |
| snippetType | `SnippetType` | Yes | `bio` is accepted and stored as `signature` |
| content     | string   | Yes      | |
| categoryId  | uuid     | No       | a `text_snippet` folder |
| tags        | string[] | No       | |

`PUT` takes the same fields, all optional, plus `isStarred`.

### Get All Text Snippets

| Parameter  | Type | Default | Description |
| ---------- | ---- | ------- | ----------- |
| type       | `SnippetType` | | (legacy `snippetType` also accepted; `type` wins) |
| categoryId | uuid | | |
| starred    | `true` | | (legacy `isStarred` also accepted) |
| search     | string | | name, content |
| sort       | `newest` \| `oldest` \| `most_used` \| `recently_used` \| `name` | `newest` | `oldest` = `created_at ASC, id ASC` |
| limit      | 1-100 | 50 | |
| offset     | int | 0 | |

**Response:** `200 OK`, `Page<TextSnippet>`.

- `usageCount` counts posts whose text contains the snippet's text, kept by the posts trigger (0055). A snippet whose fill-ins were filled in is undercounted; that is accepted.
- `POST snippets/:id/use` only sets `last_used_at`.
- `permanent` works only on a binned snippet; a live one is a `404`.

---

## Saved Links

Store and organize URLs, with automatic preview fetching.

```
POST   /workspaces/:workspaceId/media-library/links                             posts:draft
GET    /workspaces/:workspaceId/media-library/links                             posts:draft
POST   /workspaces/:workspaceId/media-library/links/bulk                        posts:draft
GET    /workspaces/:workspaceId/media-library/links/:linkId                     posts:draft
PUT    /workspaces/:workspaceId/media-library/links/:linkId                     posts:draft
POST   /workspaces/:workspaceId/media-library/links/:linkId/refresh-preview     posts:draft
DELETE /workspaces/:workspaceId/media-library/links/:linkId                     posts:draft    (to the Bin)
POST   /workspaces/:workspaceId/media-library/links/:linkId/restore             posts:draft
DELETE /workspaces/:workspaceId/media-library/links/:linkId/permanent           posts:publish
POST   /workspaces/:workspaceId/media-library/links/:linkId/use                 posts:draft
```

### Create Saved Link

```json
{
  "name": "Company Blog",
  "url": "https://blog.example.com",
  "description": "Our company blog",
  "categoryId": "uuid",
  "tags": ["blog"],
  "utm": { "source": "instagram", "medium": "social", "campaign": "spring" }
}
```

| Field       | Type     | Required | Description |
| ----------- | -------- | -------- | ----------- |
| name        | string   | Yes      | max 255 chars |
| url         | string   | Yes      | valid URL |
| description | string   | No       | |
| categoryId  | uuid     | No       | a `link` folder |
| tags        | string[] | No       | |
| utm         | object   | No       | `{ source?, medium?, campaign?, term?, content? }` |

`PUT` takes the same fields, all optional, plus `isStarred`; `utm: null` clears it. Changing `url` re-fetches the preview.

The server fetches Open Graph metadata and the site's favicon. `SavedLink` gains:

```ts
utm: { source?: string; medium?: string; campaign?: string; term?: string; content?: string } | null
previewFaviconUrl: string | null
```

### Get All Saved Links

| Parameter  | Type | Default | Description |
| ---------- | ---- | ------- | ----------- |
| categoryId | uuid | | |
| isStarred  | boolean | | |
| search     | string | | `ilike` on url, title (the fetched preview title), name and description |
| sort       | `newest` \| `oldest` \| `most_used` \| `name` | `newest` | `oldest` = `created_at ASC, id ASC` |
| limit      | 1-100 | 50 | |
| offset     | int | 0 | |

**Response:** `200 OK`, `Page<SavedLink>`.

- `usageCount` counts posts that contain the link's URL, kept by the posts trigger (0055).
- `POST links/:id/use` only sets `last_used_at`.
- `permanent` works only on a binned link; a live one is a `404`.
- A link's display name is its `name`, else its preview title, else its URL (blank or whitespace-only counts as empty). The `name` sort orders by it.

---

## Bulk actions

```
POST items/bulk       posts:draft (permanentDelete: posts:publish)
POST templates/bulk   posts:draft
POST snippets/bulk    posts:draft
POST links/bulk       posts:draft
```

**Request body**

```ts
{
  ids?: string[]                       // at most 500
  selectAll?: { filter: <the list's GET query> }
  action: 'delete' | 'star' | 'unstar' | 'move'
        // items also: 'restore' | 'permanentDelete'
  categoryId?: string | null           // move only
}
```

**Response:** `200 OK`, `{ "affectedCount": number }`. The old `success`/`message` keys are gone.

Rules (every bulk endpoint):
- Send exactly one of `ids` and `selectAll`. Both, or neither, is a `400`.
- `ids` holds at most 500 entries per request. A client acting on more splits them into requests of 500 and sums `affectedCount`.
- A repeated id counts once. An id outside the workspace is a `400` ("Some items not found").
- `selectAll` runs the action on every row the list's filter matches, the same `WHERE` as the `GET`.
- `move` with `categoryId: null` takes the rows out of their folder. `move` into a folder of another kind is a `400`.
- The action decides which rows it touches, never the filter. `restore` and `permanentDelete` (items only) act on binned rows; everything else acts on live rows. A `selectAll` `restore` or `permanentDelete` is a `400`; use the Bin for those.

---

## Recycle Bin

Deleted media items, templates, snippets and links go to one Bin. A row is purged 30 days after it was deleted. The retention is one constant (`lib/bin-retention.ts`): the Bin's `purgeAt` and every kind's daily cleanup use it.

### List

```
GET /workspaces/:workspaceId/media-library/recycle-bin          posts:draft
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| kind      | `BinKind` | all | |
| sort      | `deleted` \| `name` \| `size` | `deleted` | newest deletion, name A-Z, largest first |
| limit     | 1-100 | 50 | |
| offset    | int | 0 | |

A binned link's `name` follows the same rule (name, else preview title, else URL), and `sort=name` orders by it.

Legacy `type` (`image|video|gif|document` → media, narrowed to that type; `template`; `text_snippet` → snippet; `link`) is accepted; an explicit `kind` wins.

**Response:** `200 OK`

```ts
interface BinRow {
  kind: BinKind
  id: string
  name: string
  thumbnailUrl: string | null
  type: string                  // 'image' | 'video' | 'gif' | 'document' | 'template' | 'snippet' | 'link'
  sizeBytes: number | null      // media only
  deletedAt: string
  deletedBy: UserRef | null
  purgeAt: string               // deletedAt + 30 days
}
// response
Page<BinRow> & { countsByKind: Record<BinKind, number> }
```

A legacy row with no `deleted_at` uses `updated_at`, both for `deletedAt` and for the cleanup.

### Restore

```
POST /workspaces/:workspaceId/media-library/recycle-bin/restore          posts:draft
```

Body: `{ "items": [{ "kind": "media", "id": "uuid" }, ...] }`, 1 to 500 entries. **Response:** `{ "restored": number }`.

### Delete forever

```
POST /workspaces/:workspaceId/media-library/recycle-bin/delete          posts:publish
```

Same body as restore, 1 to 500 entries. **Response:** `{ "deleted": number }`. Only binned rows are purged. Media files follow the same keep-if-used rule as `items/:id/permanent`.

### Empty

```
POST /workspaces/:workspaceId/media-library/recycle-bin/empty          posts:publish
```

**Response:** `{ "deleted": number }`.

### Automatic cleanup

A scheduled job runs daily at 3:00 AM and purges every row (all four kinds) binned more than 30 days ago. Each kind runs on its own: if one kind's purge fails (storage down for media, say), the job logs it and still purges the other three.

---

## Uploads (`/media`)

These routes moved from `MediaController` to `LibraryUploadController`; the paths are unchanged. Each is behind `JwtAuthGuard` and checks `posts:draft` on `workspaceId`. A caller who is not a member of that workspace, or lacks `posts:draft`, gets `404` (not `403`).

| Route | Change |
| --- | --- |
| `POST /media/upload/file` (multipart) | requires `workspaceId`; accepts `categoryId`, `tags` (comma list), `purpose` |
| `POST /media/upload/url` | requires `workspaceId`; accepts `categoryId`, `tags` |
| `POST /media/upload/base64` | requires `workspaceId`; accepts `categoryId`, `tags` |
| `POST /media/signed-upload-params` | takes `{ workspaceId, bytes }`; returns `publicId` and `overwrite` |
| `POST /media/r2/presign-composer-video` | checks `sizeBytes` against the limit |

### Server uploads (`upload/file`, `upload/url`, `upload/base64`)

- Each checks storage and returns `413 STORAGE_FULL` when the upload would go over.
- The server chooses the storage location (`library/<ws>/<uuid>`). A client `publicId` or `folder` is accepted but ignored.
- Each creates the Library item and returns it as `libraryItem: MediaItem` beside today's fields:

```json
{
  "message": "Media uploaded successfully",
  "publicId": "library/<ws>/<uuid>",
  "url": "http://...",
  "secureUrl": "https://...",
  "format": "png",
  "resourceType": "image",
  "bytes": 245000,
  "width": 1200,
  "height": 628,
  "libraryItem": { "id": "uuid", "...": "MediaItem" }
}
```

- `upload/file` accepts `purpose: 'library' | 'thumbnail'` (default `library`). A `thumbnail` (a video's poster frame) still needs `workspaceId`, `posts:draft` and a storage check, but:
  - it is stored under `library-thumbs/<ws>/<uuid>`, always as Cloudinary resource type `image` (a client `resourceType` is ignored);
  - it may be at most 10 MB; a larger one is refused with a plain `413` (Nest's default body, no `code`) before any storage check or upload;
  - it creates no Library row and returns `libraryItem: null`;
  - it ignores `categoryId` and `tags`;
  - a poster can never be registered as a Library item.
- If the provider reports that the target already existed, the route returns `409 {code:'UPLOAD_CONFLICT', message}`, and nothing is saved or deleted.
- If saving the row fails after the bytes were stored (anything but a 413), the fresh upload is deleted again, unless something references it.

### Signed direct upload (Cloudinary)

```
POST /media/signed-upload-params
{ "workspaceId": "uuid", "bytes": 245000 }
```

The server checks `bytes` against the limit (`413 STORAGE_FULL`), then signs an explicit `public_id` (`library/<ws>/<uuid>`) and `overwrite: false`. One signature yields one asset in either Cloudinary folder mode.

```json
{
  "signature": "...",
  "timestamp": 1761990000,
  "cloudName": "...",
  "apiKey": "...",
  "publicId": "library/<ws>/<uuid>",
  "overwrite": false,
  "uploadUrl": "https://api.cloudinary.com/v1_1/<cloud>/auto/upload"
}
```

The response field `publicId` maps to Cloudinary's form field `public_id`. The client posts `public_id`, `overwrite` and the signed `timestamp` unchanged, and adds no other signed parameter (no `folder`); anything extra breaks the signature. A client `folder` in the request is ignored. After the upload, the client registers the file with `POST items` (see [Create Media Item](#create-media-item-register-a-direct-upload)).

### R2 presign (composer videos)

`POST /media/r2/presign-composer-video` takes `{ workspaceId, contentType, sizeBytes, filename? }` as before and now returns `413 STORAGE_FULL` when `sizeBytes` would go over. After the upload, the client registers the file with `POST items`.

### Imports

The Canva import (`POST /canva/composer/workspaces/:workspaceId/import`) and the media-source import (`POST /channels/workspaces/:workspaceId/media-sources/:channelId/import`, for Drive, Dropbox, OneDrive and Photos) check storage, create the Library item, and return it as `libraryItem: MediaItem` beside today's fields.

Stock picks (Pexels, Unsplash and the like) hotlink the provider. They are not uploads, do not become Library items and carry no `libraryItemId`.

---

## Posts: `libraryItemId`

Each entry in `posts.media_items` (and in `platform_content.*.mediaItems`) accepts `libraryItemId?: string` (a uuid). The composer sends it whenever the file is a Library item.

An item counts as used by a post when:
- the post's media references it by `libraryItemId`; or
- the post's media (base or any platform override) uses its URL.

Campaign slots not yet turned into a post and evergreen entries count the same way, within their own workspace. Migration 0055 adds the generated columns, the GIN indexes and the trigger that keeps `usage_count` on items, snippets and links current. The trigger fires on post writes only, so the Library recounts one row itself, with the trigger's own test, when it saves a new link or snippet, changes a link's URL or a snippet's content, or registers a media item for a URL posts already use. The response carries the recounted `usageCount`.

---

## Error responses

Library-specific error bodies:

| Status | Body | From |
| --- | --- | --- |
| 400 | `{ code: 'UPLOAD_NOT_FINISHED', message }` | `POST items`: the object is not in storage yet |
| 401 | `{ code: 'INVALID_TICKET', message }` | zip download |
| 402 | `{ code: 'AI_TOKENS_EXHAUSTED', message }` | `POST items/:id/alt-text` |
| 409 | `{ code: 'UPLOAD_CONFLICT', message }` | server uploads, when the target already existed |
| 413 | `{ code: 'STORAGE_FULL', message, used, limit }` | every upload entry point, `POST items`, imports |
| 413 | `{ code: 'ZIP_TOO_LARGE', message }` | `POST categories/:id/zip-ticket` (over 2 GB) |
| 422 | `{ code: 'NOT_AN_IMAGE', message }` | `POST items/:id/alt-text` |
| 503 | `{ code: 'SIZE_UNAVAILABLE', message }` | `POST items`: provider error, retryable |

Everything else uses Nest's default shape:

```json
{ "statusCode": 400, "message": ["name must be a string"], "error": "Bad Request" }
```

`401` (no or bad token); `403` (not a member, or missing capability, on workspace routes); `404` (not found, and on the `/media` upload routes also not a member or missing capability); `500`.

---

## Owner scripts

Two one-off scripts. Run each after the deploy that ships migrations 0054 and 0055, from a shell with the production `DATABASE_URL` and the storage credentials. Both are idempotent.

```bash
npm run build
npm run library:backfill-refs -- --i-know-this-is-production
npm run library:backfill-sizes -- --dry-run --i-know-this-is-production
npm run library:backfill-sizes -- --i-know-this-is-production
```

Both refuse to run against a non-local database without `--i-know-this-is-production`.

- **`library:backfill-refs`** stamps `libraryItemId` on the base `media_items` of posts written before the Library tracked usage by id.
  - An entry that already has an id, or whose URL matches no item of the post's workspace, is left alone.
  - When several items share a URL, the live one created first wins; a deleted item wins only if nothing live matches.
  - Platform overrides are not touched; they already count by URL. `updated_at` is not touched either.
- **`library:backfill-sizes`** fills `media_items.file_size` where it is NULL, by asking the store that holds the bytes (R2 HEAD, Cloudinary admin API).
  - A row whose size cannot be found stays NULL (it counts as 0) and is listed in the failed ids.
  - Cloudinary's admin API is rate-limited, so the script caps its Cloudinary calls per run. Run it again later to pick up the skipped rows. R2 rows are not capped.
  - `--dry-run` reports what it would fill and writes nothing.

---

## Deploy notes

1. **Release rule (B12).** The backend and the frontend deploy together. The backend never deploys alone: the new response shapes (bulk `{affectedCount}`, the unified Bin, `categories/grouped` keyed by folder kind, upload `libraryItem`, the 413 bodies) ship with the frontend that reads them. One break is hard, not cosmetic. `POST items` now refuses any `thumbnailUrl` that is not this workspace's `library-thumbs/<ws>/` poster. The current main frontend's upload dialog (`use-upload-queue.ts`) calls `POST items` a second time after `upload/file`, sending the image's own URL or a Cloudinary video thumbnail. Against the new backend, every image, GIF and video upload from that old dialog fails with 400, even though the item was created, and a retry uploads a duplicate. So the frontend must be live first, or at the same moment. A browser tab still running the old bundle hits this until it reloads.
2. **Pre-deploy check: the hand-applied campaign tables.** No migration creates `campaign_slot_content`, `campaign_evergreen_posts` or `campaign_evergreen_categories`; prod got them by hand. The Library reads all three, so before deploying the owner runs this read-only query in the Railway prod console:

   ```sql
   SELECT to_regclass('public.campaign_slot_content')         AS slot_content,
          to_regclass('public.campaign_evergreen_posts')      AS evergreen_posts,
          to_regclass('public.campaign_evergreen_categories') AS evergreen_categories;
   ```

   Every column must name its table. A `NULL` means the table is missing, and then:
   - **`campaign_slot_content` or `campaign_evergreen_posts` missing:** every query built on the shared reference test fails with "relation does not exist" (a `500`): `GET items?neverUsed=true`, `GET items/:id/usage`, `GET stats`, delete forever (`items/:id/permanent`, bulk `permanentDelete`, `recycle-bin/delete`, `recycle-bin/empty`) and the daily retention purge for media. The discard guard on a refused `POST items` fails closed, so the file is kept. 0055 still applies; it only skips the slot index.
   - **`campaign_evergreen_categories` missing:** `GET items/:id/usage` fails with a `500` (it joins the category for the evergreen rows). The rest works.

   Do not deploy until all three exist. Create a missing one from the SQL prod was given by hand (`drizzle/manual/2026-08-18-evergreen-recycling-tables.sql` for the evergreen pair; `campaign_slot_content` has no file in this repo, so copy its definition from prod), never from a guessed schema. No migration adds them on purpose: a guessed `CREATE TABLE IF NOT EXISTS` could drift from the real tables.
3. **Migration 0055 deploy gate.** 0055 adds generated columns to `posts`, which rewrites the table under ACCESS EXCLUSIVE; reads and writes on posts wait for the rewrite and the GIN builds. Before deploying, the owner runs these read-only queries in the Railway prod console:

   ```sql
   SELECT count(*), pg_size_pretty(pg_total_relation_size('posts')) FROM posts;
   ```

   - **Under 100,000 rows AND under 500 MB:** deploy without timing. The rewrite plus the index builds is expected well under 30 s.
   - **At or over either number:** first time 0055 on a restored copy of prod. If it holds the lock longer than 30 s, deploy in a low-traffic window.

   The link and snippet recount (0055 section 7) also runs under that lock:

   ```sql
   SELECT count(*) FROM saved_links;
   SELECT count(*) FROM text_snippets;
   -- the exact work: (link + snippet) x post pairs, summed per workspace
   SELECT coalesce(sum(p.n * (coalesce(l.n, 0) + coalesce(s.n, 0))), 0) AS pairs
     FROM (SELECT workspace_id, count(*) AS n FROM posts GROUP BY 1) p
     LEFT JOIN (SELECT workspace_id, count(*) AS n FROM saved_links GROUP BY 1) l USING (workspace_id)
     LEFT JOIN (SELECT workspace_id, count(*) AS n FROM text_snippets GROUP BY 1) s USING (workspace_id);
   ```

   - **posts under 100,000 AND pairs under 2,000,000:** deploy without timing. (links + snippets) x posts is an upper bound on pairs, so when that product is under 2,000,000 the pair query is not needed.
   - **At or over:** time 0055 on a restored copy of prod, as above.

   0054 builds three indexes on `media_items` (`file_url` hash, `thumbnail_url` hash, `cloudinary_public_id` btree) inside its lock. Check `media_items`' row count first if it has grown by orders of magnitude.
4. **Set `LIBRARY_ZIP_TICKET_SECRET` on Railway** (at least 32 characters; `openssl rand -hex 32`). `API_PUBLIC_URL` must be set too. Without both, `POST …/zip-ticket` returns `503`.
5. **After the deploy, run `library:backfill-refs`, then `library:backfill-sizes`** (see [Owner scripts](#owner-scripts)).
6. **Deploy window: legacy folder kinds.** Until the old instance is gone, it can still create `image` / `video` / `gif` / `document` folders (and `bio` snippets) after 0054 merged them. Once the rollout is complete, run this one-off in the Railway prod console. It does what 0054 section 6 did for the stragglers, suffixing a name only where it would collide, and a second run changes nothing:

   ```sql
   WITH legacy AS (
     SELECT id, workspace_id, name,
            CASE type
              WHEN 'image' THEN ' (Images)'
              WHEN 'gif' THEN ' (GIFs)'
              WHEN 'video' THEN ' (Videos)'
              ELSE ' (Docs)'
            END AS suffix
       FROM media_categories
      WHERE type IN ('image', 'gif', 'video', 'document')
   )
   UPDATE media_categories c
      SET type = 'media',
          name = CASE
                   WHEN EXISTS (SELECT 1 FROM media_categories m
                                 WHERE m.workspace_id = l.workspace_id
                                   AND m.name = l.name
                                   AND m.id <> l.id
                                   AND m.type IN ('media', 'image', 'gif', 'video', 'document'))
                   THEN left(l.name, 100 - length(l.suffix)) || l.suffix
                   ELSE l.name
                 END
     FROM legacy l
    WHERE c.id = l.id;

   UPDATE text_snippets SET snippet_type = 'signature' WHERE snippet_type = 'bio';
   ```

   It is SQL for the owner to run once, not a migration.
7. **The retention cron runs on every replica.** The daily 3:00 AM purge has no single-runner lock, so each replica runs it. That is harmless: every kind's purge is idempotent, and a second runner finds nothing left to delete. A single-runner lock is the later fix.
