# Composer Cloud Media Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users browse and pick post media from their connected Dropbox, Google Drive, OneDrive, and Google Photos accounts inside the composer's Add-media dialog, importing each selection into our own storage.

**Architecture:** Backend adds a thin `media-sources` module that composes the existing provider services — it resolves a stored channel's access token server-side (refresh handled by `ChannelService.getAccessToken`), dispatches to the right provider by `platform`, and normalizes results into one `CloudMediaItem`/`CloudFolder` envelope; a second endpoint downloads a chosen file and re-uploads it to Cloudinary for a permanent URL. Frontend converts the Add-media dialog from tabs to a left source rail and adds cloud panes that show a Connect card when disconnected or a folder/album browser with multi-select when connected.

**Tech Stack:** NestJS + Drizzle + Jest (backend); Vite + React 19 + TanStack Query v5 + shadcn/ui + Vitest (frontend).

## Global Constraints

- shadcn/ui only for UI primitives; icons via `lucide-react`; brand logos reuse the existing `src/features/integrations/components/integration-logos.tsx` marks (`DropboxLogo`, `GoogleDriveLogo`, `OneDriveLogo`, `GooglePhotosLogo`). Theme tokens only — no hard-coded colors.
- Never re-author provider services (`DropboxService`, `GoogleDriveService`, `OneDriveService`, `GooglePhotosService`) or the Unsplash/Pexels services — compose them.
- Cloud access tokens NEVER reach the browser. Browse and import are always by `channelId`; the server resolves the token via `ChannelService.getAccessToken(channelId, workspaceId)`.
- Cloud file selection ALWAYS imports into our storage (Cloudinary) — never hotlink an expiring cloud URL into a draft.
- Do NOT modify Canva. Canva is a separate future effort.
- Do NOT add the cloud platforms to the frontend `SocialPlatform` union (avoids `Record<SocialPlatform,…>` cascade). Use a separate `CloudStoragePlatform` type + a `CLOUD_STORAGE_PLATFORMS` string set.
- Backend env keys already exist (`DROPBOX_*`, `ONEDRIVE_*`, `YOUTUBE_CLIENT_ID/SECRET` reused for Google, `CLOUDINARY_*`). No new keys.
- Cloud platform string values (must match backend `SUPPORTED_PLATFORMS` exactly): `dropbox`, `google_drive`, `onedrive`, `google_photos`.
- Backend-first, then frontend (repo rule). Both repos are on branch `feat/composer-cloud-sources`.
- Backend working tree has unrelated dirty files from parallel efforts — NEVER `git add -A`; stage only the exact files a task touches. Frontend `.env` is dirty — never stage it.

## Provider service reference (verified signatures — all list/get methods take `accessToken` first)

```
DropboxService  (src/channels/services/dropbox.service.ts)
  listMedia(t, {path?,limit?,cursor?}): Promise<DropboxListResponse{entries:DropboxEntry[],cursor,has_more}>
  listImages / listVideos: same shape
  listFolders(t, {path?,limit?,cursor?}): DropboxListResponse (entries are folders)
  searchFiles(t, query, {path?,maxResults?,cursor?}): Promise<{matches:DropboxEntry[],cursor?,has_more}>
  getTemporaryLink(t, path): Promise<string>
  downloadFile(t, path): Promise<Buffer>
  DropboxFile: {'.tag':'file', id, name, path_display, path_lower, size, media_info?{metadata{'.tag','dimensions?{width,height}',duration?}}}
  DropboxFolder: {'.tag':'folder', id, name, path_display}

GoogleDriveService (src/channels/services/google-drive.service.ts)
  listMedia/listImages/listVideos(t, {folderId?,query?,pageSize?,pageToken?}): Promise<DriveListResponse{files:DriveFile[],nextPageToken?}>
  listFolders(t, {parentId?,pageSize?,pageToken?}): Promise<{folders:DriveFolder[],nextPageToken?}>
  getFile(t, fileId): Promise<DriveFile>
  downloadFile(t, fileId): Promise<Buffer>
  DriveFile: {id, name, mimeType, thumbnailLink?, size?:string}
  DriveFolder: {id, name}

OneDriveService (src/channels/services/onedrive.service.ts)
  listMedia/listImages/listVideos(t, {folderId?,pageSize?,nextLink?}): Promise<OneDriveListResponse{items:OneDriveItem[],nextLink?}>
  listFolders(t, {parentId?,pageSize?,nextLink?}): OneDriveListResponse
  searchFiles(t, query, {pageSize?,nextLink?}): OneDriveListResponse
  getDownloadUrl(t, itemId): Promise<string>
  downloadFile(t, itemId): Promise<Buffer>
  OneDriveItem: {id, name, size?, file?{mimeType}, folder?{childCount}, image?{width,height}, video?{width,height,duration}, thumbnails?[], '@microsoft.graph.downloadUrl'?}

GooglePhotosService (src/channels/services/google-photos.service.ts)
  listMediaItems(t, {pageSize?,pageToken?,albumId?,filters?}): Promise<PhotosListResponse{mediaItems:PhotosMediaItem[],nextPageToken?}>
  listPhotos/listVideos(t, {pageSize?,pageToken?,albumId?}): PhotosListResponse
  listAlbums(t, {pageSize?,pageToken?}): Promise<PhotosAlbumsResponse{albums:PhotosAlbum[],nextPageToken?}>
  getMediaItem(t, mediaItemId): Promise<PhotosMediaItem>
  downloadMediaItem(...): Buffer   // used for import
  PhotosMediaItem: {id, baseUrl, mimeType, filename, mediaMetadata{width:string,height:string,video?}}
  PhotosAlbum: {id, title, mediaItemsCount?, coverPhotoBaseUrl?}

Token + storage:
  ChannelService.getAccessToken(channelId:number, workspaceId:string): Promise<string>   // refresh built in
  ChannelService.getChannelById(channelId:number, workspaceId:string): Promise<ChannelResponseDto>  // throws NotFound if not in workspace
  CloudinaryService.uploadFromBuffer(buffer:Buffer, {folder?,resourceType?:'image'|'video'|'auto'}): Promise<UploadResult{secureUrl,width?,height?,duration?,bytes,resourceType,publicId}>
```

---

## File Structure

**Backend (`socialmedia-workspace/`):**
- `src/media-sources/media-sources.types.ts` — `CloudMediaItem`, `CloudFolder`, `CloudBrowseResult`, `CloudImportResult`, `CloudStoragePlatform`, `BrowseKind`.
- `src/media-sources/mappers/dropbox.mapper.ts`, `drive.mapper.ts`, `onedrive.mapper.ts`, `photos.mapper.ts` — normalize provider items → envelope.
- `src/media-sources/media-sources.service.ts` — `browse()` (dispatch + token) and `import()` (download → Cloudinary).
- `src/media-sources/dto/browse.dto.ts`, `dto/import.dto.ts` — request validation.
- `src/media-sources/media-sources.controller.ts` — the two routes under `channels/workspaces/:workspaceId/media-sources`.
- `src/media-sources/media-sources.module.ts` — imports `ChannelsModule` + `MediaModule`.
- `src/app.module.ts` — register `MediaSourcesModule`.
- Tests co-located: `*.spec.ts`.

**Frontend (`socialmedia-frontend/`):**
- `src/features/onboarding/constants.ts` — MODIFY: add `CLOUD_STORAGE_PLATFORMS`, extend `isComposablePlatform`.
- `src/features/composer/constants/cloud-sources.ts` — `CloudStoragePlatform`, `CLOUD_SOURCES` metadata (id, label, Logo, capabilities).
- `src/features/composer/api/cloud-media.api.ts` — types + `browse`/`import`/`initiateCloudOAuth` wrappers.
- `src/features/composer/hooks/use-cloud-sources.ts` — connection status per cloud platform.
- `src/features/composer/hooks/use-cloud-connect.ts` — connect via popup + initiate + invalidate.
- `src/features/composer/hooks/use-cloud-browse.ts` — infinite media query.
- `src/features/composer/hooks/use-cloud-folders.ts` — folders/albums query.
- `src/features/composer/hooks/use-cloud-import.ts` — import mutation → `DraftMediaItem`.
- `src/features/composer/components/media-picker/cloud-tile.tsx`, `cloud-browser.tsx`, `cloud-connect-card.tsx`, `cloud-source-pane.tsx`, `source-rail.tsx`.
- `src/features/composer/components/media-picker/media-picker-dialog.tsx` — MODIFY: tabs → rail.
- `src/features/integrations/constants/integrations-catalog.ts` + `components/integrations-grid.tsx` — MODIFY: real Connect for the 4 cloud cards.

---

## BACKEND

### Task B1: Envelope types + per-provider mappers

**Files:**
- Create: `src/media-sources/media-sources.types.ts`
- Create: `src/media-sources/mappers/dropbox.mapper.ts`, `drive.mapper.ts`, `onedrive.mapper.ts`, `photos.mapper.ts`
- Test: `src/media-sources/mappers/mappers.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CloudStoragePlatform = 'dropbox' | 'google_drive' | 'onedrive' | 'google_photos';
  export type BrowseKind = 'media' | 'images' | 'videos' | 'folders' | 'search';
  export interface CloudMediaItem {
    id: string;            // provider file/media id (Dropbox: path_lower; Drive/OneDrive/Photos: id)
    kind: 'image' | 'video';
    name: string;
    thumbnailUrl: string;  // best available preview; may be a provider URL for display only
    width?: number;
    height?: number;
    durationSec?: number;
    sizeBytes?: number;
  }
  export interface CloudFolder { id: string; name: string; path: string }  // Photos: path = albumId
  export interface CloudBrowseResult { items: CloudMediaItem[]; folders: CloudFolder[]; nextCursor?: string }
  export interface CloudImportResult { url: string; type: 'image' | 'video'; width?: number; height?: number; durationSec?: number; sizeBytes: number }
  ```
- Consumes: provider interfaces (`DropboxEntry`, `DriveFile`, `OneDriveItem`, `PhotosMediaItem`, and the folder/album shapes) imported from each provider service file.

Each mapper exports:
- `mapDropboxItem(e: DropboxFile): CloudMediaItem`, `mapDropboxFolder(f: DropboxFolder): CloudFolder`
- `mapDriveItem(f: DriveFile): CloudMediaItem`, `mapDriveFolder(f: DriveFolder): CloudFolder`
- `mapOneDriveItem(i: OneDriveItem): CloudMediaItem`, `mapOneDriveFolder(i: OneDriveItem): CloudFolder`
- `mapPhotosItem(m: PhotosMediaItem): CloudMediaItem`, `mapPhotosAlbum(a: PhotosAlbum): CloudFolder`

Mapping rules (kind detection):
- Dropbox: `kind = e.media_info?.metadata['.tag'] === 'video' ? 'video' : 'image'`; `id = e.path_lower`; `thumbnailUrl = ''` (Dropbox needs a separate thumbnail fetch — leave empty, the browser falls back to a placeholder); width/height from `media_info.metadata.dimensions`; `durationSec = metadata.duration ? metadata.duration/1000 : undefined`; `sizeBytes = e.size`.
- Drive: `kind = f.mimeType.startsWith('video/') ? 'video' : 'image'`; `id = f.id`; `thumbnailUrl = f.thumbnailLink ?? ''`; `sizeBytes = f.size ? Number(f.size) : undefined`.
- OneDrive: `kind = i.video ? 'video' : 'image'`; `id = i.id`; `thumbnailUrl = i.thumbnails?.[0]?.large?.url ?? ''`; width/height/duration from `i.image`/`i.video` (`durationSec = i.video ? i.video.duration/1000 : undefined`); `sizeBytes = i.size`.
- Photos: `kind = m.mediaMetadata.video ? 'video' : 'image'`; `id = m.id`; `thumbnailUrl = `${m.baseUrl}=w400-h400``; width/height `Number(m.mediaMetadata.width|height)`.

- [ ] **Step 1: Write the failing test** (`src/media-sources/mappers/mappers.spec.ts`)

```ts
import { mapDropboxItem } from './dropbox.mapper';
import { mapDriveItem } from './drive.mapper';
import { mapOneDriveItem } from './onedrive.mapper';
import { mapPhotosItem, mapPhotosAlbum } from './photos.mapper';

describe('cloud mappers', () => {
  it('maps a Dropbox video with dimensions + duration', () => {
    const item = mapDropboxItem({
      '.tag': 'file', id: 'id:1', name: 'clip.mp4', path_display: '/clip.mp4', path_lower: '/clip.mp4',
      size: 2048, is_downloadable: true, client_modified: '', server_modified: '', rev: 'r',
      media_info: { metadata: { '.tag': 'video', dimensions: { width: 1920, height: 1080 }, duration: 5000 } },
    } as any);
    expect(item).toEqual({ id: '/clip.mp4', kind: 'video', name: 'clip.mp4', thumbnailUrl: '', width: 1920, height: 1080, durationSec: 5, sizeBytes: 2048 });
  });

  it('maps a Drive image', () => {
    const item = mapDriveItem({ id: 'd1', name: 'p.jpg', mimeType: 'image/jpeg', thumbnailLink: 'http://t/p', size: '999' } as any);
    expect(item).toEqual({ id: 'd1', kind: 'image', name: 'p.jpg', thumbnailUrl: 'http://t/p', width: undefined, height: undefined, durationSec: undefined, sizeBytes: 999 });
  });

  it('maps a OneDrive video with duration in ms → seconds', () => {
    const item = mapOneDriveItem({ id: 'o1', name: 'v.mp4', size: 10, video: { width: 640, height: 480, duration: 3000 }, thumbnails: [{ large: { url: 'http://t/o' } }] } as any);
    expect(item).toEqual({ id: 'o1', kind: 'video', name: 'v.mp4', thumbnailUrl: 'http://t/o', width: 640, height: 480, durationSec: 3, sizeBytes: 10 });
  });

  it('maps a Photos item with sized thumbnail url', () => {
    const item = mapPhotosItem({ id: 'g1', baseUrl: 'http://b/g', mimeType: 'image/jpeg', filename: 'g.jpg', mediaMetadata: { creationTime: '', width: '800', height: '600' } } as any);
    expect(item).toEqual({ id: 'g1', kind: 'image', name: 'g.jpg', thumbnailUrl: 'http://b/g=w400-h400', width: 800, height: 600, durationSec: undefined, sizeBytes: undefined });
  });

  it('maps a Photos album to a CloudFolder', () => {
    const f = mapPhotosAlbum({ id: 'a1', title: 'Trip', productUrl: '', mediaItemsCount: '12' } as any);
    expect(f).toEqual({ id: 'a1', name: 'Trip', path: 'a1' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd socialmedia-workspace && npx jest src/media-sources/mappers/mappers.spec.ts` → FAIL (modules not found).

- [ ] **Step 3: Create `media-sources.types.ts`** with the interfaces above.

- [ ] **Step 4: Create the four mapper files.** Example `dropbox.mapper.ts`:

```ts
import type { DropboxFile, DropboxFolder } from '../../channels/services/dropbox.service';
import type { CloudMediaItem, CloudFolder } from '../media-sources.types';

export function mapDropboxItem(e: DropboxFile): CloudMediaItem {
  const meta = e.media_info?.metadata;
  const isVideo = meta?.['.tag'] === 'video';
  return {
    id: e.path_lower,
    kind: isVideo ? 'video' : 'image',
    name: e.name,
    thumbnailUrl: '',
    width: meta?.dimensions?.width,
    height: meta?.dimensions?.height,
    durationSec: meta?.duration != null ? meta.duration / 1000 : undefined,
    sizeBytes: e.size,
  };
}

export function mapDropboxFolder(f: DropboxFolder): CloudFolder {
  return { id: f.path_lower, name: f.name, path: f.path_lower };
}
```

Write `drive.mapper.ts`, `onedrive.mapper.ts`, `photos.mapper.ts` following the mapping rules above. For OneDrive `thumbnailUrl`, read `i.thumbnails?.[0]?.large?.url ?? ''` (guard the optional chain). For Photos `mapPhotosAlbum`, `path = a.id`.

- [ ] **Step 5: Run test to verify it passes** — `npx jest src/media-sources/mappers/mappers.spec.ts` → PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/media-sources/media-sources.types.ts src/media-sources/mappers/*.mapper.ts src/media-sources/mappers/mappers.spec.ts
git commit -m "feat(media-sources): cloud envelope types + per-provider mappers"
```

---

### Task B2: MediaSourcesService.browse() — dispatch + token injection

**Files:**
- Create: `src/media-sources/media-sources.service.ts`
- Test: `src/media-sources/media-sources.service.browse.spec.ts`

**Interfaces:**
- Consumes: `ChannelService.getAccessToken`, `ChannelService.getChannelById`, the four provider services, the mappers, envelope types.
- Produces:
  ```ts
  browse(workspaceId: string, channelId: number, args: { kind: BrowseKind; path?: string; query?: string; cursor?: string; limit?: number }): Promise<CloudBrowseResult>
  ```

Behavior:
1. `const channel = await this.channelService.getChannelById(channelId, workspaceId)` (throws `NotFoundException` if not in workspace — this is our ownership check).
2. `const platform = channel.platform as CloudStoragePlatform`. If `platform` not one of the four cloud platforms → `throw new BadRequestException('Channel is not a cloud storage source')`.
3. `const token = await this.channelService.getAccessToken(channelId, workspaceId)`.
4. Dispatch on `platform` + `args.kind`, call the provider method, map results into `CloudBrowseResult`. Pagination token field differs per provider — normalize into `nextCursor`:
   - Dropbox: `cursor`/`has_more` → `nextCursor = has_more ? cursor : undefined`.
   - Drive/Photos: `nextPageToken` → `nextCursor`.
   - OneDrive: `nextLink` → `nextCursor`.
5. For `kind==='folders'`: return `{ items: [], folders: mapped, nextCursor }`. For media kinds: `{ items: mapped, folders: [], nextCursor }`. For `kind==='search'`: use the provider's search method (Dropbox `searchFiles`, OneDrive `searchFiles`, Drive `listMedia` with `query`, Photos → treat as `listMediaItems` with no text filter and ignore `query`).

- [ ] **Step 1: Write the failing test** (`media-sources.service.browse.spec.ts`) — use `Test.createTestingModule` with mocked providers:

```ts
import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { MediaSourcesService } from './media-sources.service';
import { ChannelService } from '../channels/services/channel.service';
import { DropboxService } from '../channels/services/dropbox.service';
import { GoogleDriveService } from '../channels/services/google-drive.service';
import { OneDriveService } from '../channels/services/onedrive.service';
import { GooglePhotosService } from '../channels/services/google-photos.service';
import { CloudinaryService } from '../media/cloudinary.service';

const channelService = {
  getChannelById: jest.fn(),
  getAccessToken: jest.fn().mockResolvedValue('TKN'),
};
const dropbox = { listMedia: jest.fn(), searchFiles: jest.fn(), listFolders: jest.fn(), downloadFile: jest.fn() };
const drive = { listMedia: jest.fn(), listFolders: jest.fn(), downloadFile: jest.fn() };
const onedrive = { listMedia: jest.fn(), searchFiles: jest.fn(), listFolders: jest.fn(), downloadFile: jest.fn() };
const photos = { listMediaItems: jest.fn(), listAlbums: jest.fn(), downloadMediaItem: jest.fn() };
const cloudinary = { uploadFromBuffer: jest.fn() };

async function build() {
  const mod = await Test.createTestingModule({
    providers: [
      MediaSourcesService,
      { provide: ChannelService, useValue: channelService },
      { provide: DropboxService, useValue: dropbox },
      { provide: GoogleDriveService, useValue: drive },
      { provide: OneDriveService, useValue: onedrive },
      { provide: GooglePhotosService, useValue: photos },
      { provide: CloudinaryService, useValue: cloudinary },
    ],
  }).compile();
  return mod.get(MediaSourcesService);
}

beforeEach(() => jest.clearAllMocks());

it('browse(media) on dropbox resolves token by channelId and maps entries', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'dropbox' });
  dropbox.listMedia.mockResolvedValue({
    entries: [{ '.tag': 'file', id: 'i', name: 'a.jpg', path_lower: '/a.jpg', path_display: '/a.jpg', size: 10, media_info: { metadata: { '.tag': 'photo' } } }],
    cursor: 'C', has_more: true,
  });
  const svc = await build();
  const res = await svc.browse('ws', 5, { kind: 'media' });
  expect(channelService.getAccessToken).toHaveBeenCalledWith(5, 'ws');
  expect(dropbox.listMedia).toHaveBeenCalledWith('TKN', { path: undefined, limit: undefined, cursor: undefined });
  expect(res.items[0]).toMatchObject({ id: '/a.jpg', kind: 'image', name: 'a.jpg' });
  expect(res.nextCursor).toBe('C');
});

it('rejects a non-cloud channel', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'twitter' });
  const svc = await build();
  await expect(svc.browse('ws', 1, { kind: 'media' })).rejects.toBeInstanceOf(BadRequestException);
});
```

- [ ] **Step 2: Run to verify it fails** — `npx jest src/media-sources/media-sources.service.browse.spec.ts` → FAIL.

- [ ] **Step 3: Implement `MediaSourcesService`** (constructor injects the six services). Implement `browse()` per the dispatch table. Sketch:

```ts
@Injectable()
export class MediaSourcesService {
  constructor(
    private readonly channelService: ChannelService,
    private readonly dropbox: DropboxService,
    private readonly drive: GoogleDriveService,
    private readonly onedrive: OneDriveService,
    private readonly photos: GooglePhotosService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  private readonly CLOUD = new Set<CloudStoragePlatform>(['dropbox', 'google_drive', 'onedrive', 'google_photos']);

  async browse(workspaceId: string, channelId: number, a: { kind: BrowseKind; path?: string; query?: string; cursor?: string; limit?: number }): Promise<CloudBrowseResult> {
    const channel = await this.channelService.getChannelById(channelId, workspaceId);
    const platform = channel.platform as CloudStoragePlatform;
    if (!this.CLOUD.has(platform)) throw new BadRequestException('Channel is not a cloud storage source');
    const token = await this.channelService.getAccessToken(channelId, workspaceId);
    switch (platform) {
      case 'dropbox': return this.browseDropbox(token, a);
      case 'google_drive': return this.browseDrive(token, a);
      case 'onedrive': return this.browseOneDrive(token, a);
      case 'google_photos': return this.browsePhotos(token, a);
    }
  }
  // private browseDropbox/… map results + normalize nextCursor
}
```

Implement each `browse<Provider>` private method. For folders kind, call `listFolders`/`listAlbums`. For search kind, call `searchFiles` (Dropbox/OneDrive) with `a.query`, Drive `listMedia({query})`, Photos `listMediaItems`.

- [ ] **Step 4: Run to verify it passes** — `npx jest src/media-sources/media-sources.service.browse.spec.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/media-sources/media-sources.service.ts src/media-sources/media-sources.service.browse.spec.ts
git commit -m "feat(media-sources): browse() with token injection + platform dispatch"
```

---

### Task B3: MediaSourcesService.import() — download → Cloudinary → permanent URL

**Files:**
- Modify: `src/media-sources/media-sources.service.ts`
- Test: `src/media-sources/media-sources.service.import.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  import(workspaceId: string, channelId: number, args: { fileId: string; kind: 'image' | 'video' }): Promise<CloudImportResult>
  ```

Behavior:
1. `getChannelById` (ownership) + validate cloud platform (reuse the guard).
2. `token = getAccessToken(channelId, workspaceId)`.
3. Download a Buffer via the provider's buffer method: Dropbox `downloadFile(token, fileId)`, Drive `downloadFile(token, fileId)`, OneDrive `downloadFile(token, fileId)`, Photos `downloadMediaItem` (fetch its bytes; if `downloadMediaItem` needs the media item, first `getMediaItem(token, fileId)` then download). `fileId` is the `CloudMediaItem.id` (Dropbox path_lower, others id).
4. `const up = await this.cloudinary.uploadFromBuffer(buffer, { folder: 'composer/cloud', resourceType: args.kind })`.
5. Return `{ url: up.secureUrl, type: args.kind, width: up.width, height: up.height, durationSec: up.duration, sizeBytes: up.bytes }`.

- [ ] **Step 1: Write the failing test**

```ts
it('import downloads provider buffer and uploads to cloudinary', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'dropbox' });
  dropbox.downloadFile.mockResolvedValue(Buffer.from('x'));
  cloudinary.uploadFromBuffer.mockResolvedValue({ secureUrl: 'https://cdn/x.jpg', width: 800, height: 600, duration: undefined, bytes: 1234, resourceType: 'image', publicId: 'p' });
  const svc = await build();
  const res = await svc.import('ws', 5, { fileId: '/x.jpg', kind: 'image' });
  expect(dropbox.downloadFile).toHaveBeenCalledWith('TKN', '/x.jpg');
  expect(cloudinary.uploadFromBuffer).toHaveBeenCalledWith(expect.any(Buffer), { folder: 'composer/cloud', resourceType: 'image' });
  expect(res).toEqual({ url: 'https://cdn/x.jpg', type: 'image', width: 800, height: 600, durationSec: undefined, sizeBytes: 1234 });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx jest src/media-sources/media-sources.service.import.spec.ts` → FAIL.
- [ ] **Step 3: Implement `import()`** with a private `downloadBuffer(platform, token, fileId)` dispatcher.
- [ ] **Step 4: Run to verify it passes** — PASS.
- [ ] **Step 5: Commit**

```bash
git add src/media-sources/media-sources.service.ts src/media-sources/media-sources.service.import.spec.ts
git commit -m "feat(media-sources): import() downloads provider file → Cloudinary permanent url"
```

---

### Task B4: DTOs + controller + module wiring

**Files:**
- Create: `src/media-sources/dto/browse.dto.ts`, `src/media-sources/dto/import.dto.ts`
- Create: `src/media-sources/media-sources.controller.ts`
- Create: `src/media-sources/media-sources.module.ts`
- Modify: `src/app.module.ts` (register `MediaSourcesModule`)
- Test: `src/media-sources/media-sources.controller.spec.ts`

**DTOs** (class-validator, mirroring `FetchPagesDto` conventions):

```ts
// browse.dto.ts
export class BrowseSourceDto {
  @IsIn(['media', 'images', 'videos', 'folders', 'search']) kind: BrowseKind;
  @IsOptional() @IsString() path?: string;
  @IsOptional() @IsString() query?: string;
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100) limit?: number;
}
// import.dto.ts
export class ImportSourceDto {
  @IsString() @MinLength(1) fileId: string;
  @IsIn(['image', 'video']) kind: 'image' | 'video';
}
```

**Controller** (`@Controller('channels/workspaces/:workspaceId/media-sources')`, `@UseGuards(JwtAuthGuard)`, `@HttpCode(200)` on both POSTs — they read/act, return 200):

```ts
@Controller('channels/workspaces/:workspaceId/media-sources')
@UseGuards(JwtAuthGuard)
export class MediaSourcesController {
  constructor(private readonly service: MediaSourcesService) {}

  @Post(':channelId/browse')
  @HttpCode(HttpStatus.OK)
  browse(@Param('workspaceId') ws: string, @Param('channelId') channelId: string, @Body() dto: BrowseSourceDto) {
    return this.service.browse(ws, parseInt(channelId, 10), dto);
  }

  @Post(':channelId/import')
  @HttpCode(HttpStatus.OK)
  import(@Param('workspaceId') ws: string, @Param('channelId') channelId: string, @Body() dto: ImportSourceDto) {
    return this.service.import(ws, parseInt(channelId, 10), dto);
  }
}
```

**Module:**

```ts
@Module({
  imports: [ChannelsModule, MediaModule],
  controllers: [MediaSourcesController],
  providers: [MediaSourcesService],
})
export class MediaSourcesModule {}
```

(`ChannelsModule` exports the four provider services + `ChannelService`; `MediaModule` exports `CloudinaryService`. Confirm both are exported before relying on injection.)

- [ ] **Step 1: Write the failing controller test** — verify the controller delegates to the service:

```ts
it('browse route delegates to service with parsed channelId', async () => {
  const service = { browse: jest.fn().mockResolvedValue({ items: [], folders: [] }), import: jest.fn() };
  const mod = await Test.createTestingModule({
    controllers: [MediaSourcesController],
    providers: [{ provide: MediaSourcesService, useValue: service }],
  }).overrideGuard(JwtAuthGuard).useValue({ canActivate: () => true }).compile();
  const ctrl = mod.get(MediaSourcesController);
  await ctrl.browse('ws', '7', { kind: 'media' } as any);
  expect(service.browse).toHaveBeenCalledWith('ws', 7, { kind: 'media' });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL.
- [ ] **Step 3: Create DTOs, controller, module; register `MediaSourcesModule` in `app.module.ts` imports.**
- [ ] **Step 4: Run to verify it passes** — PASS.
- [ ] **Step 5: Verify the whole backend compiles** — `npm run build` → success (0 errors).
- [ ] **Step 6: Commit**

```bash
git add src/media-sources/dto src/media-sources/media-sources.controller.ts src/media-sources/media-sources.module.ts src/media-sources/media-sources.controller.spec.ts src/app.module.ts
git commit -m "feat(media-sources): browse+import DTOs, controller, module wiring"
```

---

## FRONTEND

### Task F1: `isComposablePlatform` leak fix (foundational)

**Files:**
- Modify: `src/features/onboarding/constants.ts`
- Test: `src/features/onboarding/constants.spec.ts` (create if absent)

**Interfaces:**
- Produces: `CLOUD_STORAGE_PLATFORMS: Set<string>` and an updated `isComposablePlatform(platform: string): boolean` that excludes messaging AND cloud storage.

- [ ] **Step 1: Write the failing test**

```ts
import { isComposablePlatform, CLOUD_STORAGE_PLATFORMS } from './constants';
describe('isComposablePlatform', () => {
  it('includes social platforms', () => {
    expect(isComposablePlatform('twitter')).toBe(true);
    expect(isComposablePlatform('instagram')).toBe(true);
  });
  it('excludes messaging platforms', () => {
    for (const p of ['slack', 'telegram', 'discord', 'whatsapp']) expect(isComposablePlatform(p)).toBe(false);
  });
  it('excludes cloud storage platforms', () => {
    for (const p of ['dropbox', 'google_drive', 'onedrive', 'google_photos']) expect(isComposablePlatform(p)).toBe(false);
    expect(CLOUD_STORAGE_PLATFORMS.has('dropbox')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd socialmedia-frontend && npx vitest run src/features/onboarding/constants.spec.ts` → FAIL.

- [ ] **Step 3: Implement.** In `constants.ts`, after `MESSAGING_PLATFORMS`:

```ts
/** Cloud storage sources — connected as channels but never publishable targets. */
export const CLOUD_STORAGE_PLATFORMS = new Set<string>([
  'dropbox', 'google_drive', 'onedrive', 'google_photos',
])

/** True when a platform is a composable publishing target (not messaging or cloud storage). */
export function isComposablePlatform(platform: string): boolean {
  return !MESSAGING_PLATFORMS.has(platform as SocialPlatform) && !CLOUD_STORAGE_PLATFORMS.has(platform)
}
```

(The two existing callers pass `c.platform`; widening the param to `string` keeps them compiling and lets runtime cloud strings be excluded.)

- [ ] **Step 4: Run to verify it passes** — PASS.
- [ ] **Step 5: Commit**

```bash
git add src/features/onboarding/constants.ts src/features/onboarding/constants.spec.ts
git commit -m "fix(composer): exclude cloud-storage platforms from publishing selector"
```

---

### Task F2: cloud source metadata + API module

**Files:**
- Create: `src/features/composer/constants/cloud-sources.ts`
- Create: `src/features/composer/api/cloud-media.api.ts`

**Interfaces:**
- Produces:
  ```ts
  // cloud-sources.ts
  export type CloudStoragePlatform = 'dropbox' | 'google_drive' | 'onedrive' | 'google_photos'
  export interface CloudSourceMeta {
    platform: CloudStoragePlatform
    label: string
    Logo: ComponentType<{ className?: string }>
    hasFolders: boolean
    hasSearch: boolean
    browseUnit: 'folder' | 'album'
  }
  export const CLOUD_SOURCES: CloudSourceMeta[]  // Dropbox, Google Drive, OneDrive, Google Photos
  // cloud-media.api.ts
  export interface CloudMediaItem { id; kind:'image'|'video'; name; thumbnailUrl; width?; height?; durationSec?; sizeBytes? }
  export interface CloudFolder { id; name; path }
  export interface CloudBrowseResult { items: CloudMediaItem[]; folders: CloudFolder[]; nextCursor?: string }
  export interface CloudImportResult { url; type:'image'|'video'; width?; height?; durationSec?; sizeBytes }
  export const cloudMediaApi: {
    browse(workspaceId, channelId, body): Promise<CloudBrowseResult>
    import(workspaceId, channelId, body): Promise<CloudImportResult>
    initiateOAuth(workspaceId, platform): Promise<{ authorizationUrl: string }>
  }
  ```

Capabilities: Dropbox `{hasFolders:true, hasSearch:true, browseUnit:'folder'}`; Google Drive `{true,true,'folder'}`; OneDrive `{true,true,'folder'}`; Google Photos `{hasFolders:true, hasSearch:false, browseUnit:'album'}`.

Logos: import `DropboxLogo, GoogleDriveLogo, OneDriveLogo, GooglePhotosLogo` from `@/features/integrations/components/integration-logos`.

- [ ] **Step 1** (no separate test — this is typed config + thin wrappers; covered by hook tests in F3). Create `cloud-sources.ts` with the `CLOUD_SOURCES` array.

- [ ] **Step 2: Create `cloud-media.api.ts`:**

```ts
import { apiClient } from '@/lib/api'
import type { CloudStoragePlatform } from '../constants/cloud-sources'
// ...types above...
export const cloudMediaApi = {
  browse: (workspaceId: string, channelId: number, body: { kind: string; path?: string; query?: string; cursor?: string; limit?: number }) =>
    apiClient.post<CloudBrowseResult>(`/channels/workspaces/${workspaceId}/media-sources/${channelId}/browse`, body),
  import: (workspaceId: string, channelId: number, body: { fileId: string; kind: 'image' | 'video' }) =>
    apiClient.post<CloudImportResult>(`/channels/workspaces/${workspaceId}/media-sources/${channelId}/import`, body),
  initiateOAuth: (workspaceId: string, platform: CloudStoragePlatform) =>
    apiClient.post<{ authorizationUrl: string; state: string; expiresAt: string }>(`/channels/workspaces/${workspaceId}/oauth/initiate`, { platform }),
}
```

- [ ] **Step 3: Verify it typechecks** — `npx tsc -b --noEmit` (or `npm run build`) → no errors in these files.
- [ ] **Step 4: Commit**

```bash
git add src/features/composer/constants/cloud-sources.ts src/features/composer/api/cloud-media.api.ts
git commit -m "feat(composer): cloud source metadata + browse/import/oauth api"
```

---

### Task F3: cloud hooks (sources, browse, folders, import)

**Files:**
- Create: `src/features/composer/hooks/use-cloud-sources.ts`, `use-cloud-browse.ts`, `use-cloud-folders.ts`, `use-cloud-import.ts`
- Test: `src/features/composer/hooks/use-cloud-import.spec.ts`, `use-cloud-sources.spec.ts`

**Interfaces:**
- `useCloudSources(workspaceId): { statusOf(platform): { channelId: number; connected: boolean } | null; isLoading }` — reads `channelsApi.list(workspaceId)` under key `queryKeys.channels.list(workspaceId)`, filters rows where `CLOUD_STORAGE_PLATFORMS.has(c.platform)`, maps platform → `{ channelId: c.id, connected: c.connectionStatus === 'connected' && c.isActive }`.
- `useCloudBrowse(workspaceId, channelId, { kind, path, query })` — `useInfiniteQuery`, key `['cloud-media', workspaceId, channelId, kind, path ?? '', query ?? '']`, `queryFn: ({pageParam}) => cloudMediaApi.browse(workspaceId, channelId, { kind, path, query, cursor: pageParam })`, `initialPageParam: undefined as string | undefined`, `getNextPageParam: (last) => last.nextCursor`, `enabled: Boolean(workspaceId && channelId)`, `placeholderData: keepPreviousData`, `staleTime: 5*60*1000`, `retry: 1`.
- `useCloudFolders(workspaceId, channelId, { path })` — `useQuery`, key `['cloud-folders', workspaceId, channelId, path ?? '']`, `queryFn: () => cloudMediaApi.browse(workspaceId, channelId, { kind: 'folders', path })`, returns `folders`.
- `useCloudImport(workspaceId, channelId)` — `useMutation`, `mutationFn: (item: CloudMediaItem) => cloudMediaApi.import(workspaceId, channelId, { fileId: item.id, kind: item.kind })`, `select`/map result → `DraftMediaItem` in the caller (or expose a helper `toDraftMediaItem(item, imported): DraftMediaItem`).

`toDraftMediaItem` (put in `src/features/composer/lib/cloud-media-item.ts`, tested):

```ts
export function toDraftMediaItem(source: CloudMediaItem, imported: CloudImportResult): DraftMediaItem {
  return {
    id: `cloud:${source.id}`,
    type: imported.type,
    url: imported.url,
    width: imported.width ?? source.width,
    height: imported.height ?? source.height,
    durationSec: imported.durationSec ?? source.durationSec,
    sizeBytes: imported.sizeBytes,
    // no attribution — cloud files are the user's own
  }
}
```

- [ ] **Step 1: Write the failing test** for `toDraftMediaItem` (`src/features/composer/lib/cloud-media-item.spec.ts`):

```ts
import { toDraftMediaItem } from './cloud-media-item'
it('builds a DraftMediaItem from a cloud source + import result', () => {
  const d = toDraftMediaItem(
    { id: '/a.jpg', kind: 'image', name: 'a', thumbnailUrl: '', width: 10, height: 20 },
    { url: 'https://cdn/a.jpg', type: 'image', width: 100, height: 200, sizeBytes: 5 },
  )
  expect(d).toEqual({ id: 'cloud:/a.jpg', type: 'image', url: 'https://cdn/a.jpg', width: 100, height: 200, durationSec: undefined, sizeBytes: 5 })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/features/composer/lib/cloud-media-item.spec.ts` → FAIL.
- [ ] **Step 3: Implement `cloud-media-item.ts` + the four hooks.** Reuse `use-stock-search.ts` patterns for the infinite query.
- [ ] **Step 4: Run to verify it passes** — PASS. Also add `use-cloud-sources.spec.ts` asserting `statusOf('dropbox')` returns the channel when the mocked list contains a connected dropbox row (mock `channelsApi.list`, wrap in a `QueryClientProvider`).
- [ ] **Step 5: Commit**

```bash
git add src/features/composer/hooks/use-cloud-*.ts src/features/composer/lib/cloud-media-item.ts src/features/composer/lib/cloud-media-item.spec.ts src/features/composer/hooks/use-cloud-*.spec.ts
git commit -m "feat(composer): cloud sources/browse/folders/import hooks"
```

---

### Task F4: cloud connect hook + connect card

**Files:**
- Create: `src/features/composer/hooks/use-cloud-connect.ts`
- Create: `src/features/composer/components/media-picker/cloud-connect-card.tsx`

**Interfaces:**
- `useCloudConnect(workspaceId): { connect(platform: CloudStoragePlatform): void; pendingPlatform: CloudStoragePlatform | null }` — reuses `openOAuthPopup` (`@/features/channels/utils/oauth-popup`) and `cloudMediaApi.initiateOAuth`; on `popup.onClose`, `queryClient.invalidateQueries({ queryKey: queryKeys.channels.list(workspaceId) })` so `useCloudSources` refetches and the pane flips to the browser.

```ts
export function useCloudConnect(workspaceId: string) {
  const qc = useQueryClient()
  const [pendingPlatform, setPending] = useState<CloudStoragePlatform | null>(null)
  function connect(platform: CloudStoragePlatform) {
    const popup = openOAuthPopup()
    if (popup.blocked) { toast.error('Popup blocked — allow popups to connect.'); return }
    setPending(platform)
    popup.onClose(() => {
      setPending(null)
      qc.invalidateQueries({ queryKey: queryKeys.channels.list(workspaceId) })
    })
    cloudMediaApi.initiateOAuth(workspaceId, platform).then(
      ({ authorizationUrl }) => popup.navigate(authorizationUrl),
      () => { popup.close(); setPending(null); toast.error('Could not start connection.') },
    )
  }
  return { connect, pendingPlatform }
}
```

- `CloudConnectCard({ meta, connecting, onConnect })` — empty-state style: large `meta.Logo`, `meta.label`, a muted line ("Connect your {label} to browse and add files."), and a shadcn `Button` "Connect {label}" with a `Loader2` spinner + disabled while `connecting`.

- [ ] **Step 1** (component + hook are UI/integration — no unit test required per repo norms; covered by F6 render test). Implement `use-cloud-connect.ts`.
- [ ] **Step 2: Implement `cloud-connect-card.tsx`** using shadcn `Button`, `lucide-react` `Loader2`. Spacing: `flex h-full flex-col items-center justify-center gap-4 p-8 text-center`.
- [ ] **Step 3: Verify build** — `npm run build` passes.
- [ ] **Step 4: Commit**

```bash
git add src/features/composer/hooks/use-cloud-connect.ts src/features/composer/components/media-picker/cloud-connect-card.tsx
git commit -m "feat(composer): cloud connect hook + connect card"
```

---

### Task F5: cloud tile + cloud browser (multi-select)

**Files:**
- Create: `src/features/composer/components/media-picker/cloud-tile.tsx`
- Create: `src/features/composer/components/media-picker/cloud-browser.tsx`

**Interfaces:**
- Consumes: `useCloudBrowse`, `useCloudFolders`, `useCloudImport`, `CloudSourceMeta`, `CloudMediaItem`, `toDraftMediaItem`.
- `CloudTile({ item, selected, onToggle, disabled })` — selectable tile (root `<button>` toggles selection), `<img src={item.thumbnailUrl || FALLBACK}>`, a checkbox overlay (visual, `Check` icon in a rounded box when `selected`), `PlayCircle` badge when `kind==='video'`. When `item.thumbnailUrl===''` (Dropbox), show a muted placeholder with the file name.
- `CloudBrowser({ workspaceId, channelId, meta, onAdd })` where `onAdd(items: DraftMediaItem[]): void`:
  - State: `path` (folder navigation; root `''`), `breadcrumb: CloudFolder[]`, `query`, `type: 'image'|'video'|'all'`, `selected: Map<string, CloudMediaItem>`.
  - Controls: search `Input` (only if `meta.hasSearch`); folder/album chips from `useCloudFolders` (label by `meta.browseUnit`); for `browseUnit:'folder'` show a breadcrumb, for `'album'` a flat album selector.
  - Media grid: reuse the `stock-browser.tsx` JS round-robin masonry + IntersectionObserver infinite scroll (copy that structure) over `useCloudBrowse` items. `kind` passed to browse derives from `type` (`'media'|'images'|'videos'`); `query` drives `kind:'search'` when non-empty and `meta.hasSearch`.
  - Footer: when `selected.size > 0`, a sticky bar with a shadcn `Button` "Add {n} item(s)" → on click, `useCloudImport` each selected item in parallel, map via `toDraftMediaItem`, call `onAdd(results)`. Per-tile spinner while importing; button shows `Loader2` and disables. On any import error, `toast.error` and keep the selection.
  - States: skeleton while first page loads; empty ("No media in this folder"); error with Retry; token/401 error → message "Reconnect this source" (surfaced from `ApiError.status === 401`).

- [ ] **Step 1: Implement `cloud-tile.tsx`.** Use `cn`, shadcn tokens; checkbox overlay via `absolute` positioned `Check` in a `size-5 rounded-md` box that is filled `bg-primary text-primary-foreground` when selected, else `border bg-background/70`.
- [ ] **Step 2: Implement `cloud-browser.tsx`** copying the masonry + infinite-scroll scaffolding from `stock-browser.tsx` (lines 26–216 structure), swapping the data source to `useCloudBrowse` and the tile to `CloudTile`, and adding the folder/breadcrumb + multi-select footer.
- [ ] **Step 3: Verify build** — `npm run build` passes.
- [ ] **Step 4: Commit**

```bash
git add src/features/composer/components/media-picker/cloud-tile.tsx src/features/composer/components/media-picker/cloud-browser.tsx
git commit -m "feat(composer): cloud file browser with folders/albums + multi-select import"
```

---

### Task F6: source rail + dialog conversion

**Files:**
- Create: `src/features/composer/components/media-picker/source-rail.tsx`
- Create: `src/features/composer/components/media-picker/cloud-source-pane.tsx`
- Modify: `src/features/composer/components/media-picker/media-picker-dialog.tsx`
- Test: `src/features/composer/components/media-picker/cloud-source-pane.spec.tsx`

**Interfaces:**
- `SourceRail({ active, onSelect })` — vertical list; two groups: static (`upload`, `unsplash`, `pexels`) and "Cloud" (`CLOUD_SOURCES`). Each item: `Logo` + label, active state via shadcn tokens (`bg-accent text-accent-foreground`). `active: SourceId`, `SourceId = 'upload' | 'unsplash' | 'pexels' | CloudStoragePlatform`.
- `CloudSourcePane({ workspaceId, meta, onAdd })` — reads `useCloudSources`; if `statusOf(meta.platform)?.connected` → `<CloudBrowser channelId=… onAdd=… />`, else `<CloudConnectCard onConnect={() => connect(meta.platform)} connecting={pendingPlatform===meta.platform} />` via `useCloudConnect`.
- `media-picker-dialog.tsx` — replace `<Tabs>` with a `flex` row: `<SourceRail>` (fixed width `w-44`, `border-r`) + a content region that switches on `active`. Keep `Upload`/`Unsplash`/`Pexels` panes (`UploadPane`, `StockBrowser`). Cloud sources render `<CloudSourcePane>`. Preserve the header, the credit checkbox footer (only relevant to stock — keep it visible only when `active` is `unsplash`/`pexels`), and `handleStockSelect`. Cloud `onAdd(items)` loops `onAddMedia` for each item then `onOpenChange(false)`.

- [ ] **Step 1: Write the failing test** (`cloud-source-pane.spec.tsx`): mock `useCloudSources` to report disconnected → asserts the Connect button renders; mock connected → asserts the browser (search input / grid) renders. Use `@testing-library/react` + a `QueryClientProvider`.
- [ ] **Step 2: Run to verify it fails** — FAIL (components not present).
- [ ] **Step 3: Implement `source-rail.tsx`, `cloud-source-pane.tsx`, and convert `media-picker-dialog.tsx`.** Keep `SourceId` union local to the dialog/rail.
- [ ] **Step 4: Run to verify it passes** — PASS. Then `npm run build` passes.
- [ ] **Step 5: Commit**

```bash
git add src/features/composer/components/media-picker/source-rail.tsx src/features/composer/components/media-picker/cloud-source-pane.tsx src/features/composer/components/media-picker/media-picker-dialog.tsx src/features/composer/components/media-picker/cloud-source-pane.spec.tsx
git commit -m "feat(composer): left source rail + cloud panes in add-media dialog"
```

---

### Task F7: Integrations page — real Connect for the 4 cloud cards

**Files:**
- Modify: `src/features/integrations/constants/integrations-catalog.ts` (drop `comingSoon` on the 4 cloud entries, add an optional `connectPlatform?: CloudStoragePlatform`)
- Modify: `src/features/integrations/components/integrations-grid.tsx` (render a Connect button when `connectPlatform` is set)

**Interfaces:**
- Add to `IntegrationApp`: `connectPlatform?: CloudStoragePlatform`. Set it on `dropbox`, `google-drive`, `onedrive`, `google-photos`; set `comingSoon: false` for those four.
- In `IntegrationCard`, when `app.connectPlatform`, render a shadcn `Button` "Connect" that calls `useCloudConnect(workspaceId).connect(app.connectPlatform)` and shows connected state from `useCloudSources` (a `Badge` "Connected" when `statusOf(platform)?.connected`). Needs `workspaceId` — read via the existing `useWorkspaceId()` hook (used elsewhere in the app).

- [ ] **Step 1: Implement the catalog + card changes.** (UI wiring — no unit test; the connect hook is covered structurally by F4/F6.)
- [ ] **Step 2: Verify build** — `npm run build` passes; manually confirm the 4 cards now show Connect / Connected instead of "Soon".
- [ ] **Step 3: Commit**

```bash
git add src/features/integrations/constants/integrations-catalog.ts src/features/integrations/components/integrations-grid.tsx
git commit -m "feat(integrations): real connect for Dropbox/Drive/OneDrive/Photos"
```

---

## Testing summary

- **Backend:** mappers (B1), browse dispatch + token injection (B2), import pipeline (B3), controller delegation (B4). Run `npx jest src/media-sources` → all green; `npm run build` → 0 errors.
- **Frontend:** `isComposablePlatform` exclusion (F1), `toDraftMediaItem` + `useCloudSources` (F3), `CloudSourcePane` connected/disconnected render (F6). Run `npx vitest run src/features/composer src/features/onboarding` → green; `npm run build` → 0 errors.

## Out of scope (do not implement)

- Canva (design create/export, token persistence) — separate effort.
- Extra stock providers (Pixabay/Giphy/Flickr/Coverr).
- Disconnect/manage cloud channels UI (settings) — a later effort.
- Server-side workspace-membership guard hardening (the existing `getChannelById` workspace filter is the ownership boundary this plan relies on; a broader authz guard is tracked separately).
