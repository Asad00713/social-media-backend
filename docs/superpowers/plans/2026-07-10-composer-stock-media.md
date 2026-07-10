# Composer Stock Media Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users search Unsplash + Pexels and attach stock images/videos inside the post composer through a professional multi-source picker.

**Architecture:** A thin backend gateway (`/media/stock/*`) wraps the existing `UnsplashService` and `PexelsService`, normalizing both into one `StockMediaItem` envelope. The composer gains an "Add media" dialog (Upload · Unsplash · Pexels tabs) that consumes the gateway and produces the composer's existing `DraftMediaItem`, hotlinking provider URLs and carrying attribution.

**Tech Stack:** Backend NestJS + Jest (TDD). Frontend Vite + React 19 + TypeScript + shadcn/ui + TanStack Query + Vitest.

## Global Constraints

- **Hotlink, never re-host.** Stock asset URLs go into the post as-is; do not download/cache them to our CDN. (Unsplash guideline.)
- **Server-side download trigger.** Unsplash's `download_location` ping runs on the backend so the API key never reaches the client.
- **Attribution is mandatory and always displayed in-app.** Every stock item carries `authorName`, `authorUrl`, `providerUrl`; Unsplash links use `?utm_source=schedura&utm_medium=referral`.
- **Unsplash has no video.** `provider=unsplash & type=video` must be rejected with a 400.
- **shadcn-only UI.** Only components from `src/components/ui/`; theme tokens (`text-muted-foreground`, `bg-muted`, `border-border`); lucide icons; no hard-coded colors.
- **Backend base:** branch `feat/composer-stock-media` off `origin/main` (already created). **Frontend base:** same branch name off `origin/main` (already created).
- **`DraftMediaItem.attribution` is optional** — existing uploads must keep working with it undefined.
- **Backend gates:** `npm run test -- stock-media` and `npm run build`. **Frontend gate:** `npm run build` (+ `npm run test` for the pure mappers).
- **Env:** reuse existing `UNSPLASH_ACCESS_KEY` and `PEXELS_API_KEY`; no new env vars.

---

# PART A — BACKEND (`socialmedia-workspace`)

Existing services this plan reuses (do **not** re-implement provider HTTP calls):

- `src/channels/services/unsplash.service.ts` — `UnsplashService`
  - `searchPhotos(query, page=1, perPage=20, orientation?, color?) → Promise<{ total, totalPages, results: UnsplashPhoto[] }>`
  - `trackDownload(downloadLocation: string) → Promise<void>` (already appends `client_id`, never throws)
  - `UnsplashPhoto`: `{ id, width, height, urls:{raw,full,regular,small,thumb}, links:{self,html,download,downloadLocation}, user:{id,username,name,profileUrl,profileImage} }`
- `src/pexels/pexels.service.ts` — `PexelsService`
  - `searchPhotos({query,page,perPage,...}) → Promise<PexelsSearchResult<PexelsPhoto>>`
  - `searchVideos({query,page,perPage,...}) → Promise<PexelsSearchResult<PexelsVideo>>`
  - `PexelsSearchResult<T>`: `{ items:T[], totalResults, page, perPage, nextPage:string|null, prevPage:string|null }`
  - `PexelsPhoto`: `{ id:number, width, height, url, photographer, photographerUrl, src:{original,large2x,large,medium,small,portrait,landscape,tiny}, alt }`
  - `PexelsVideo`: `{ id:number, width, height, url, image, duration, user:{id,name,url}, videoFiles:[{id,quality,fileType,width,height,fps,link}], videoPictures:[...] }`

Both services are stateless (`@Injectable`, read only `process.env`), so `StockMediaModule` registers them directly in its own `providers` array — **no import of `ChannelsModule` or `PexelsModule`** (avoids coupling to the large channels module).

---

### Task A1: Envelope types + provider mappers (pure, unit-tested)

**Files:**
- Create: `src/stock-media/stock-media.types.ts`
- Create: `src/stock-media/mappers/unsplash.mapper.ts`
- Create: `src/stock-media/mappers/pexels.mapper.ts`
- Test: `src/stock-media/mappers/unsplash.mapper.spec.ts`
- Test: `src/stock-media/mappers/pexels.mapper.spec.ts`

**Interfaces:**
- Consumes: `UnsplashPhoto` (from `../../channels/services/unsplash.service`), `PexelsPhoto` + `PexelsVideo` (from `../../pexels/pexels.service`).
- Produces:
  - `StockProvider = 'unsplash' | 'pexels'`, `StockMediaType = 'image' | 'video'`, `interface StockMediaItem` (see code).
  - `mapUnsplashPhoto(photo: UnsplashPhoto): StockMediaItem`
  - `mapPexelsPhoto(photo: PexelsPhoto): StockMediaItem`
  - `mapPexelsVideo(video: PexelsVideo): StockMediaItem`

- [ ] **Step 1: Write the envelope types**

Create `src/stock-media/stock-media.types.ts`:

```ts
export type StockProvider = 'unsplash' | 'pexels';
export type StockMediaType = 'image' | 'video';

export interface StockMediaItem {
  provider: StockProvider;
  providerId: string;
  type: StockMediaType;
  previewUrl: string; // grid thumbnail (hotlink)
  fullUrl: string; // URL embedded into the post (hotlink)
  width: number;
  height: number;
  durationSec?: number; // video only
  authorName: string;
  authorUrl: string; // photographer profile (UTM for Unsplash)
  providerUrl: string; // photo page / Unsplash link (UTM for Unsplash)
  downloadTriggerUrl?: string; // Unsplash download_location; absent for Pexels
}

export interface StockSearchResponse {
  items: StockMediaItem[];
  page: number;
  hasMore: boolean;
}
```

- [ ] **Step 2: Write the failing Unsplash mapper test**

Create `src/stock-media/mappers/unsplash.mapper.spec.ts`:

```ts
import { mapUnsplashPhoto } from './unsplash.mapper';
import type { UnsplashPhoto } from '../../channels/services/unsplash.service';

const photo: UnsplashPhoto = {
  id: 'abc123',
  width: 4000,
  height: 3000,
  color: '#fff',
  blurHash: 'L00',
  description: null,
  altDescription: 'a cat',
  urls: {
    raw: 'https://images.unsplash.com/raw',
    full: 'https://images.unsplash.com/full',
    regular: 'https://images.unsplash.com/regular',
    small: 'https://images.unsplash.com/small',
    thumb: 'https://images.unsplash.com/thumb',
  },
  links: {
    self: 'https://api.unsplash.com/photos/abc123',
    html: 'https://unsplash.com/photos/abc123',
    download: 'https://unsplash.com/photos/abc123/download',
    downloadLocation: 'https://api.unsplash.com/photos/abc123/download?ixid=xy',
  },
  user: {
    id: 'u1',
    username: 'janedoe',
    name: 'Jane Doe',
    profileUrl: 'https://unsplash.com/@janedoe',
    profileImage: 'https://images.unsplash.com/profile',
  },
};

describe('mapUnsplashPhoto', () => {
  it('maps to the normalized envelope as an image', () => {
    const item = mapUnsplashPhoto(photo);
    expect(item.provider).toBe('unsplash');
    expect(item.providerId).toBe('abc123');
    expect(item.type).toBe('image');
    expect(item.previewUrl).toBe('https://images.unsplash.com/small');
    expect(item.fullUrl).toBe('https://images.unsplash.com/regular');
    expect(item.width).toBe(4000);
    expect(item.height).toBe(3000);
    expect(item.authorName).toBe('Jane Doe');
    expect(item.downloadTriggerUrl).toBe(
      'https://api.unsplash.com/photos/abc123/download?ixid=xy',
    );
  });

  it('appends UTM params to author + provider links', () => {
    const item = mapUnsplashPhoto(photo);
    expect(item.authorUrl).toBe(
      'https://unsplash.com/@janedoe?utm_source=schedura&utm_medium=referral',
    );
    expect(item.providerUrl).toBe(
      'https://unsplash.com/photos/abc123?utm_source=schedura&utm_medium=referral',
    );
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test -- unsplash.mapper`
Expected: FAIL — `Cannot find module './unsplash.mapper'`.

- [ ] **Step 4: Implement the Unsplash mapper**

Create `src/stock-media/mappers/unsplash.mapper.ts`:

```ts
import type { UnsplashPhoto } from '../../channels/services/unsplash.service';
import type { StockMediaItem } from '../stock-media.types';

const UTM = 'utm_source=schedura&utm_medium=referral';

/** Append Unsplash-required UTM params, preserving any existing query string. */
export function withUtm(url: string): string {
  return url.includes('?') ? `${url}&${UTM}` : `${url}?${UTM}`;
}

export function mapUnsplashPhoto(photo: UnsplashPhoto): StockMediaItem {
  return {
    provider: 'unsplash',
    providerId: photo.id,
    type: 'image',
    previewUrl: photo.urls.small,
    fullUrl: photo.urls.regular,
    width: photo.width,
    height: photo.height,
    authorName: photo.user.name,
    authorUrl: withUtm(photo.user.profileUrl),
    providerUrl: withUtm(photo.links.html),
    downloadTriggerUrl: photo.links.downloadLocation,
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -- unsplash.mapper`
Expected: PASS (both tests).

- [ ] **Step 6: Write the failing Pexels mapper test**

Create `src/stock-media/mappers/pexels.mapper.spec.ts`:

```ts
import { mapPexelsPhoto, mapPexelsVideo, pickVideoFile } from './pexels.mapper';
import type { PexelsPhoto, PexelsVideo } from '../../pexels/pexels.service';

const photo: PexelsPhoto = {
  id: 12345,
  width: 5000,
  height: 3333,
  url: 'https://www.pexels.com/photo/12345/',
  photographer: 'John Roe',
  photographerUrl: 'https://www.pexels.com/@johnroe',
  photographerId: 99,
  avgColor: '#222',
  src: {
    original: 'https://images.pexels.com/original.jpg',
    large2x: 'https://images.pexels.com/large2x.jpg',
    large: 'https://images.pexels.com/large.jpg',
    medium: 'https://images.pexels.com/medium.jpg',
    small: 'https://images.pexels.com/small.jpg',
    portrait: 'https://images.pexels.com/portrait.jpg',
    landscape: 'https://images.pexels.com/landscape.jpg',
    tiny: 'https://images.pexels.com/tiny.jpg',
  },
  alt: 'a mountain',
};

const video: PexelsVideo = {
  id: 6789,
  width: 1920,
  height: 1080,
  url: 'https://www.pexels.com/video/6789/',
  image: 'https://images.pexels.com/video-thumb.jpg',
  duration: 15,
  user: { id: 7, name: 'Cara Coe', url: 'https://www.pexels.com/@caracoe' },
  videoFiles: [
    { id: 1, quality: 'sd', fileType: 'video/mp4', width: 640, height: 360, fps: 30, link: 'https://player.vimeo.com/sd.mp4' },
    { id: 2, quality: 'hd', fileType: 'video/mp4', width: 1920, height: 1080, fps: 30, link: 'https://player.vimeo.com/hd.mp4' },
  ],
  videoPictures: [],
};

describe('mapPexelsPhoto', () => {
  it('maps to the normalized envelope as an image', () => {
    const item = mapPexelsPhoto(photo);
    expect(item.provider).toBe('pexels');
    expect(item.providerId).toBe('12345');
    expect(item.type).toBe('image');
    expect(item.previewUrl).toBe('https://images.pexels.com/medium.jpg');
    expect(item.fullUrl).toBe('https://images.pexels.com/large2x.jpg');
    expect(item.authorName).toBe('John Roe');
    expect(item.authorUrl).toBe('https://www.pexels.com/@johnroe');
    expect(item.providerUrl).toBe('https://www.pexels.com/photo/12345/');
    expect(item.downloadTriggerUrl).toBeUndefined();
  });
});

describe('pickVideoFile', () => {
  it('prefers an hd mp4 file', () => {
    expect(pickVideoFile(video.videoFiles).link).toBe('https://player.vimeo.com/hd.mp4');
  });
  it('falls back to the first file when no hd mp4', () => {
    const files = [video.videoFiles[0]];
    expect(pickVideoFile(files).link).toBe('https://player.vimeo.com/sd.mp4');
  });
});

describe('mapPexelsVideo', () => {
  it('maps to the normalized envelope as a video', () => {
    const item = mapPexelsVideo(video);
    expect(item.provider).toBe('pexels');
    expect(item.providerId).toBe('6789');
    expect(item.type).toBe('video');
    expect(item.previewUrl).toBe('https://images.pexels.com/video-thumb.jpg');
    expect(item.fullUrl).toBe('https://player.vimeo.com/hd.mp4');
    expect(item.durationSec).toBe(15);
    expect(item.authorName).toBe('Cara Coe');
    expect(item.authorUrl).toBe('https://www.pexels.com/@caracoe');
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npm run test -- pexels.mapper`
Expected: FAIL — `Cannot find module './pexels.mapper'`.

- [ ] **Step 8: Implement the Pexels mappers**

Create `src/stock-media/mappers/pexels.mapper.ts`:

```ts
import type { PexelsPhoto, PexelsVideo } from '../../pexels/pexels.service';
import type { StockMediaItem } from '../stock-media.types';

type PexelsVideoFile = PexelsVideo['videoFiles'][number];

/** Choose the best playable file: prefer an hd mp4, then any mp4, then the first. */
export function pickVideoFile(files: PexelsVideoFile[]): PexelsVideoFile {
  const mp4s = files.filter((f) => f.fileType === 'video/mp4');
  const hd = mp4s.find((f) => f.quality === 'hd');
  return hd ?? mp4s[0] ?? files[0];
}

export function mapPexelsPhoto(photo: PexelsPhoto): StockMediaItem {
  return {
    provider: 'pexels',
    providerId: String(photo.id),
    type: 'image',
    previewUrl: photo.src.medium,
    fullUrl: photo.src.large2x,
    width: photo.width,
    height: photo.height,
    authorName: photo.photographer,
    authorUrl: photo.photographerUrl,
    providerUrl: photo.url,
  };
}

export function mapPexelsVideo(video: PexelsVideo): StockMediaItem {
  const file = pickVideoFile(video.videoFiles);
  return {
    provider: 'pexels',
    providerId: String(video.id),
    type: 'video',
    previewUrl: video.image,
    fullUrl: file.link,
    width: video.width,
    height: video.height,
    durationSec: video.duration,
    authorName: video.user.name,
    authorUrl: video.user.url,
    providerUrl: video.url,
  };
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npm run test -- pexels.mapper`
Expected: PASS (all describe blocks).

- [ ] **Step 10: Commit**

```bash
git add src/stock-media/stock-media.types.ts src/stock-media/mappers
git commit -m "feat(stock-media): normalized envelope + Unsplash/Pexels mappers"
```

---

### Task A2: StockMediaService + module wiring

**Files:**
- Create: `src/stock-media/stock-media.service.ts`
- Create: `src/stock-media/stock-media.module.ts`
- Test: `src/stock-media/stock-media.service.spec.ts`
- Modify: `src/app.module.ts` (register `StockMediaModule` in `imports`)

**Interfaces:**
- Consumes: `UnsplashService`, `PexelsService`, the three mappers, `StockMediaItem`/`StockSearchResponse`.
- Produces:
  - `interface StockSearchParams { provider: StockProvider; type: StockMediaType; q: string; page: number; perPage: number; }`
  - `StockMediaService.search(params: StockSearchParams): Promise<StockSearchResponse>`
  - `StockMediaService.track(downloadTriggerUrl: string): Promise<void>`

- [ ] **Step 1: Write the failing service test**

Create `src/stock-media/stock-media.service.spec.ts`:

```ts
import { BadRequestException } from '@nestjs/common';
import { StockMediaService } from './stock-media.service';

function makeService(overrides: {
  unsplash?: Partial<Record<string, jest.Mock>>;
  pexels?: Partial<Record<string, jest.Mock>>;
} = {}) {
  const unsplash = {
    searchPhotos: jest.fn(),
    trackDownload: jest.fn().mockResolvedValue(undefined),
    ...overrides.unsplash,
  };
  const pexels = {
    searchPhotos: jest.fn(),
    searchVideos: jest.fn(),
    ...overrides.pexels,
  };
  const service = new StockMediaService(unsplash as any, pexels as any);
  return { service, unsplash, pexels };
}

const unsplashResult = {
  total: 100,
  totalPages: 5,
  results: [
    {
      id: 'a1', width: 10, height: 10, color: '', blurHash: '', description: null, altDescription: null,
      urls: { raw: 'r', full: 'f', regular: 'reg', small: 'sm', thumb: 'th' },
      links: { self: 's', html: 'https://unsplash.com/photos/a1', download: 'd', downloadLocation: 'https://api.unsplash.com/photos/a1/download' },
      user: { id: 'u', username: 'x', name: 'X', profileUrl: 'https://unsplash.com/@x', profileImage: '' },
    },
  ],
};

describe('StockMediaService.search', () => {
  it('rejects unsplash + video', async () => {
    const { service } = makeService();
    await expect(
      service.search({ provider: 'unsplash', type: 'video', q: 'cats', page: 1, perPage: 24 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps unsplash images and derives hasMore from totalPages', async () => {
    const { service, unsplash } = makeService({
      unsplash: { searchPhotos: jest.fn().mockResolvedValue(unsplashResult) },
    });
    const res = await service.search({ provider: 'unsplash', type: 'image', q: 'cats', page: 1, perPage: 24 });
    expect(unsplash.searchPhotos).toHaveBeenCalledWith('cats', 1, 24);
    expect(res.items).toHaveLength(1);
    expect(res.items[0].provider).toBe('unsplash');
    expect(res.hasMore).toBe(true); // page 1 < totalPages 5
  });

  it('derives hasMore=false on the last unsplash page', async () => {
    const { service } = makeService({
      unsplash: { searchPhotos: jest.fn().mockResolvedValue({ ...unsplashResult, totalPages: 1 }) },
    });
    const res = await service.search({ provider: 'unsplash', type: 'image', q: 'cats', page: 1, perPage: 24 });
    expect(res.hasMore).toBe(false);
  });

  it('maps pexels photos and derives hasMore from nextPage', async () => {
    const { service, pexels } = makeService({
      pexels: {
        searchPhotos: jest.fn().mockResolvedValue({
          items: [{ id: 1, width: 1, height: 1, url: 'u', photographer: 'P', photographerUrl: 'pu', photographerId: 1, avgColor: '', src: { original: 'o', large2x: 'l2', large: 'l', medium: 'm', small: 's', portrait: 'p', landscape: 'ld', tiny: 't' }, alt: '' }],
          totalResults: 30, page: 1, perPage: 24, nextPage: 'https://api.pexels.com/next', prevPage: null,
        }),
      },
    });
    const res = await service.search({ provider: 'pexels', type: 'image', q: 'cats', page: 1, perPage: 24 });
    expect(pexels.searchPhotos).toHaveBeenCalledWith({ query: 'cats', page: 1, perPage: 24 });
    expect(res.items[0].provider).toBe('pexels');
    expect(res.hasMore).toBe(true);
  });

  it('maps pexels videos', async () => {
    const { service, pexels } = makeService({
      pexels: {
        searchVideos: jest.fn().mockResolvedValue({
          items: [{ id: 2, width: 2, height: 2, url: 'vu', image: 'img', duration: 5, user: { id: 1, name: 'V', url: 'vurl' }, videoFiles: [{ id: 1, quality: 'hd', fileType: 'video/mp4', width: 2, height: 2, fps: 30, link: 'link.mp4' }], videoPictures: [] }],
          totalResults: 5, page: 1, perPage: 24, nextPage: null, prevPage: null,
        }),
      },
    });
    const res = await service.search({ provider: 'pexels', type: 'video', q: 'cats', page: 1, perPage: 24 });
    expect(pexels.searchVideos).toHaveBeenCalledWith({ query: 'cats', page: 1, perPage: 24 });
    expect(res.items[0].type).toBe('video');
    expect(res.hasMore).toBe(false);
  });
});

describe('StockMediaService.track', () => {
  it('delegates unsplash download-location hosts to the unsplash service', async () => {
    const { service, unsplash } = makeService();
    await service.track('https://api.unsplash.com/photos/a1/download?ixid=1');
    expect(unsplash.trackDownload).toHaveBeenCalledWith('https://api.unsplash.com/photos/a1/download?ixid=1');
  });

  it('ignores non-unsplash hosts (fail-closed, no throw)', async () => {
    const { service, unsplash } = makeService();
    await service.track('https://evil.example.com/track');
    expect(unsplash.trackDownload).not.toHaveBeenCalled();
  });

  it('ignores malformed urls without throwing', async () => {
    const { service, unsplash } = makeService();
    await service.track('not a url');
    expect(unsplash.trackDownload).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- stock-media.service`
Expected: FAIL — `Cannot find module './stock-media.service'`.

- [ ] **Step 3: Implement the service**

Create `src/stock-media/stock-media.service.ts`:

```ts
import { BadRequestException, Injectable } from '@nestjs/common';
import { UnsplashService } from '../channels/services/unsplash.service';
import { PexelsService } from '../pexels/pexels.service';
import { mapUnsplashPhoto } from './mappers/unsplash.mapper';
import { mapPexelsPhoto, mapPexelsVideo } from './mappers/pexels.mapper';
import type {
  StockMediaItem,
  StockMediaType,
  StockProvider,
  StockSearchResponse,
} from './stock-media.types';

export interface StockSearchParams {
  provider: StockProvider;
  type: StockMediaType;
  q: string;
  page: number;
  perPage: number;
}

@Injectable()
export class StockMediaService {
  constructor(
    private readonly unsplash: UnsplashService,
    private readonly pexels: PexelsService,
  ) {}

  async search(params: StockSearchParams): Promise<StockSearchResponse> {
    const { provider, type, q, page, perPage } = params;

    if (provider === 'unsplash') {
      if (type === 'video') {
        throw new BadRequestException('Unsplash does not support video search.');
      }
      const result = await this.unsplash.searchPhotos(q, page, perPage);
      return {
        items: result.results.map(mapUnsplashPhoto),
        page,
        hasMore: page < result.totalPages,
      };
    }

    // provider === 'pexels'
    if (type === 'video') {
      const result = await this.pexels.searchVideos({ query: q, page, perPage });
      return this.fromPexels(result.items.map(mapPexelsVideo), page, result.nextPage);
    }
    const result = await this.pexels.searchPhotos({ query: q, page, perPage });
    return this.fromPexels(result.items.map(mapPexelsPhoto), page, result.nextPage);
  }

  private fromPexels(
    items: StockMediaItem[],
    page: number,
    nextPage: string | null,
  ): StockSearchResponse {
    return { items, page, hasMore: Boolean(nextPage) };
  }

  /**
   * Fire Unsplash's required download event server-side. Fail-closed: only
   * genuine `api.unsplash.com` download-location URLs are forwarded, so the
   * endpoint can't be turned into an open request proxy. Never throws — the
   * ping is best-effort and must not block the user's attach action.
   */
  async track(downloadTriggerUrl: string): Promise<void> {
    let host: string;
    try {
      host = new URL(downloadTriggerUrl).host;
    } catch {
      return;
    }
    if (host !== 'api.unsplash.com') return;
    await this.unsplash.trackDownload(downloadTriggerUrl);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- stock-media.service`
Expected: PASS (all tests).

- [ ] **Step 5: Create the module**

Create `src/stock-media/stock-media.module.ts` (controller added in Task A3; both provider services are stateless env-readers, registered directly to avoid importing their heavy home modules):

```ts
import { Module } from '@nestjs/common';
import { UnsplashService } from '../channels/services/unsplash.service';
import { PexelsService } from '../pexels/pexels.service';
import { StockMediaService } from './stock-media.service';

@Module({
  providers: [StockMediaService, UnsplashService, PexelsService],
  exports: [StockMediaService],
})
export class StockMediaModule {}
```

- [ ] **Step 6: Register the module in AppModule**

In `src/app.module.ts`, add `StockMediaModule` to the `imports` array (place it near the other feature modules; match existing import style):

```ts
import { StockMediaModule } from './stock-media/stock-media.module';
// ...
  imports: [
    // ...existing modules...
    StockMediaModule,
  ],
```

- [ ] **Step 7: Verify the build**

Run: `npm run build`
Expected: PASS (no TS errors).

- [ ] **Step 8: Commit**

```bash
git add src/stock-media/stock-media.service.ts src/stock-media/stock-media.module.ts src/stock-media/stock-media.service.spec.ts src/app.module.ts
git commit -m "feat(stock-media): search/track service + module wiring"
```

---

### Task A3: StockMediaController (HTTP endpoints)

**Files:**
- Create: `src/stock-media/dto/search-stock.dto.ts`
- Create: `src/stock-media/dto/track-download.dto.ts`
- Create: `src/stock-media/stock-media.controller.ts`
- Test: `src/stock-media/stock-media.controller.spec.ts`
- Modify: `src/stock-media/stock-media.module.ts` (add `controllers`)

**Interfaces:**
- Consumes: `StockMediaService.search`, `StockMediaService.track`.
- Produces HTTP routes (base `@Controller('media/stock')`, `JwtAuthGuard`):
  - `GET /media/stock/search?provider&type&q&page&perPage → StockSearchResponse`
  - `POST /media/stock/track  { downloadTriggerUrl } → 204`

**Note on the guard:** import `JwtAuthGuard` from the same path the other authenticated controllers use (e.g. the WhatsApp embedded-signup-config endpoint added on `main`). Grep `src/channels/channels.controller.ts` for `JwtAuthGuard` to copy its import path — do not guess.

- [ ] **Step 1: Write the DTOs**

Create `src/stock-media/dto/search-stock.dto.ts`:

```ts
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import type { StockMediaType, StockProvider } from '../stock-media.types';

export class SearchStockDto {
  @IsIn(['unsplash', 'pexels'])
  provider: StockProvider;

  @IsIn(['image', 'video'])
  type: StockMediaType;

  @IsString()
  @MinLength(1)
  q: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  perPage?: number;
}
```

Create `src/stock-media/dto/track-download.dto.ts`:

```ts
import { IsUrl } from 'class-validator';

export class TrackDownloadDto {
  @IsUrl({ require_protocol: true })
  downloadTriggerUrl: string;
}
```

- [ ] **Step 2: Write the failing controller test**

Create `src/stock-media/stock-media.controller.spec.ts`:

```ts
import { StockMediaController } from './stock-media.controller';

describe('StockMediaController', () => {
  const service = { search: jest.fn(), track: jest.fn().mockResolvedValue(undefined) };
  const controller = new StockMediaController(service as any);

  afterEach(() => jest.clearAllMocks());

  it('passes search params through with defaults applied', async () => {
    service.search.mockResolvedValue({ items: [], page: 1, hasMore: false });
    await controller.search({ provider: 'unsplash', type: 'image', q: 'cats' } as any);
    expect(service.search).toHaveBeenCalledWith({
      provider: 'unsplash', type: 'image', q: 'cats', page: 1, perPage: 24,
    });
  });

  it('honours explicit page/perPage', async () => {
    service.search.mockResolvedValue({ items: [], page: 3, hasMore: true });
    await controller.search({ provider: 'pexels', type: 'video', q: 'sea', page: 3, perPage: 40 } as any);
    expect(service.search).toHaveBeenCalledWith({
      provider: 'pexels', type: 'video', q: 'sea', page: 3, perPage: 40,
    });
  });

  it('delegates track to the service', async () => {
    await controller.track({ downloadTriggerUrl: 'https://api.unsplash.com/x/download' } as any);
    expect(service.track).toHaveBeenCalledWith('https://api.unsplash.com/x/download');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test -- stock-media.controller`
Expected: FAIL — `Cannot find module './stock-media.controller'`.

- [ ] **Step 4: Implement the controller**

Create `src/stock-media/stock-media.controller.ts` (fix the `JwtAuthGuard` import path per the note above):

```ts
import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SearchStockDto } from './dto/search-stock.dto';
import { TrackDownloadDto } from './dto/track-download.dto';
import { StockMediaService } from './stock-media.service';
import type { StockSearchResponse } from './stock-media.types';

const DEFAULT_PER_PAGE = 24;

@Controller('media/stock')
@UseGuards(JwtAuthGuard)
export class StockMediaController {
  constructor(private readonly stockMedia: StockMediaService) {}

  @Get('search')
  search(@Query() dto: SearchStockDto): Promise<StockSearchResponse> {
    return this.stockMedia.search({
      provider: dto.provider,
      type: dto.type,
      q: dto.q,
      page: dto.page ?? 1,
      perPage: dto.perPage ?? DEFAULT_PER_PAGE,
    });
  }

  @Post('track')
  @HttpCode(204)
  track(@Body() dto: TrackDownloadDto): Promise<void> {
    return this.stockMedia.track(dto.downloadTriggerUrl);
  }
}
```

- [ ] **Step 5: Register the controller in the module**

Edit `src/stock-media/stock-media.module.ts` to add `controllers`:

```ts
import { Module } from '@nestjs/common';
import { UnsplashService } from '../channels/services/unsplash.service';
import { PexelsService } from '../pexels/pexels.service';
import { StockMediaController } from './stock-media.controller';
import { StockMediaService } from './stock-media.service';

@Module({
  controllers: [StockMediaController],
  providers: [StockMediaService, UnsplashService, PexelsService],
  exports: [StockMediaService],
})
export class StockMediaModule {}
```

- [ ] **Step 6: Run the test + build**

Run: `npm run test -- stock-media`
Expected: PASS (mappers + service + controller).
Run: `npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/stock-media/dto src/stock-media/stock-media.controller.ts src/stock-media/stock-media.controller.spec.ts src/stock-media/stock-media.module.ts
git commit -m "feat(stock-media): GET /media/stock/search + POST /media/stock/track"
```

---

# PART B — FRONTEND (`socialmedia-frontend`)

The composer attaches media through one seam: `EditorCard`'s `onAddMedia(item: DraftMediaItem)` (`src/features/composer/components/editor-card.tsx:36`, action bar lines 99–129). `DraftMediaItem` lives at `src/features/composer/types/draft.types.ts:27-36`. The apiClient is `src/lib/api.ts` (`apiClient.get/post`). React Query is used throughout.

---

### Task B1: Extract client-side media probes into a shared module

**Why:** `probeImage`, `probeVideo`, `probeFileSize`, `detectMediaType`, `genId` are currently **module-private** inside `media-url-button.tsx` (lines 31–93). The stock picker's on-select needs them. Extract with **no behavior change**.

**Files:**
- Create: `src/features/composer/lib/media-probe.ts`
- Modify: `src/features/composer/components/media-url-button.tsx` (import from the new module; delete the local copies)

- [ ] **Step 1: Create the shared module**

Create `src/features/composer/lib/media-probe.ts` — move the five helpers verbatim from `media-url-button.tsx:31-93`, exported:

```ts
/** Detect media kind from a URL's file extension (query/fragment stripped). */
export function detectMediaType(url: string): 'image' | 'video' | 'gif' {
  const path = url.split('?')[0].split('#')[0].toLowerCase()
  if (/\.gif$/.test(path)) return 'gif'
  if (/\.(mp4|mov|webm|m4v|avi)$/.test(path)) return 'video'
  return 'image'
}

/** Stable unique id for a client-built media item. */
export function genId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `url-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** Probe an image URL's natural dimensions client-side. null on load failure. */
export function probeImage(
  url: string,
): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => resolve(null)
    img.src = url
  })
}

/** Probe a video URL's dimensions + duration via a hidden <video>. */
export function probeVideo(url: string): Promise<{
  width: number
  height: number
  durationSec: number
} | null> {
  return new Promise((resolve) => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.muted = true
    v.onloadedmetadata = () =>
      resolve({
        width: v.videoWidth,
        height: v.videoHeight,
        durationSec: Number.isFinite(v.duration) ? v.duration : 0,
      })
    v.onerror = () => resolve(null)
    v.src = url
  })
}

/** Read file size via a HEAD request's Content-Length. 0 if CORS-blocked. */
export async function probeFileSize(url: string): Promise<number> {
  try {
    const res = await fetch(url, { method: 'HEAD' })
    if (!res.ok) return 0
    const len = res.headers.get('content-length')
    return len ? Number(len) : 0
  } catch {
    return 0
  }
}
```

- [ ] **Step 2: Update `media-url-button.tsx` to import them**

In `src/features/composer/components/media-url-button.tsx`: delete the local `detectMediaType`, `genId`, `probeImage`, `probeVideo`, `probeFileSize` (lines ~31–93 and the `// 5. Helpers` block) and add to the local-imports section:

```ts
import {
  detectMediaType,
  genId,
  probeFileSize,
  probeImage,
  probeVideo,
} from '../lib/media-probe'
```

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: PASS. `media-url-button` behaves identically (paste-URL flow unchanged).

- [ ] **Step 4: Commit**

```bash
git add src/features/composer/lib/media-probe.ts src/features/composer/components/media-url-button.tsx
git commit -m "refactor(composer): extract media probes into shared lib/media-probe"
```

---

### Task B2: DraftMediaItem attribution + stock-media API client + hooks

**Files:**
- Modify: `src/features/composer/types/draft.types.ts` (add `DraftMediaAttribution` + optional `attribution`)
- Create: `src/features/composer/api/stock-media.api.ts`
- Create: `src/features/composer/hooks/use-stock-search.ts`
- Create: `src/features/composer/hooks/use-track-download.ts`

**Interfaces:**
- Produces:
  - `interface DraftMediaAttribution { provider: string; authorName: string; authorUrl: string; providerUrl: string }`
  - `DraftMediaItem.attribution?: DraftMediaAttribution`
  - `StockMediaItem` (frontend mirror), `StockProvider`, `StockMediaType`, `StockSearchResponse`
  - `stockMediaApi.search(params)`, `stockMediaApi.trackDownload(url)`
  - `useStockSearch({ provider, type, q, page })`, `useTrackDownload()`

- [ ] **Step 1: Extend `DraftMediaItem`**

In `src/features/composer/types/draft.types.ts`, replace the `DraftMediaItem` interface (lines 27–36) with:

```ts
export interface DraftMediaAttribution {
  provider: string // 'unsplash' | 'pexels'
  authorName: string
  authorUrl: string
  providerUrl: string
}

export interface DraftMediaItem {
  id: string
  type: 'image' | 'video' | 'gif'
  url: string
  width?: number
  height?: number
  durationSec?: number
  sizeBytes: number
  altText?: string
  /** Present for stock media (Unsplash/Pexels); undefined for uploads/URLs. */
  attribution?: DraftMediaAttribution
}
```

- [ ] **Step 2: Create the API client**

Create `src/features/composer/api/stock-media.api.ts` (mirror of the backend envelope):

```ts
import { apiClient } from '@/lib/api'

export type StockProvider = 'unsplash' | 'pexels'
export type StockMediaType = 'image' | 'video'

export interface StockMediaItem {
  provider: StockProvider
  providerId: string
  type: StockMediaType
  previewUrl: string
  fullUrl: string
  width: number
  height: number
  durationSec?: number
  authorName: string
  authorUrl: string
  providerUrl: string
  downloadTriggerUrl?: string
}

export interface StockSearchResponse {
  items: StockMediaItem[]
  page: number
  hasMore: boolean
}

export interface StockSearchParams {
  provider: StockProvider
  type: StockMediaType
  q: string
  page: number
}

export const stockMediaApi = {
  search(params: StockSearchParams): Promise<StockSearchResponse> {
    const qs = new URLSearchParams({
      provider: params.provider,
      type: params.type,
      q: params.q,
      page: String(params.page),
    })
    return apiClient.get<StockSearchResponse>(`/media/stock/search?${qs.toString()}`)
  },

  trackDownload(downloadTriggerUrl: string): Promise<void> {
    return apiClient.post<void>('/media/stock/track', { downloadTriggerUrl })
  },
}
```

> If `apiClient.get`/`.post` signatures differ from `<T>(path, body?)`, match the exact idiom used by a neighbouring file such as `src/features/composer/api/composer.api.ts`.

- [ ] **Step 3: Create the search hook**

Create `src/features/composer/hooks/use-stock-search.ts`:

```ts
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { stockMediaApi, type StockMediaType, type StockProvider } from '../api/stock-media.api'

interface UseStockSearchArgs {
  provider: StockProvider
  type: StockMediaType
  q: string
  page: number
}

export function useStockSearch({ provider, type, q, page }: UseStockSearchArgs) {
  const query = q.trim()
  return useQuery({
    queryKey: ['stock-media', provider, type, query, page],
    queryFn: () => stockMediaApi.search({ provider, type, q: query, page }),
    enabled: query.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  })
}
```

- [ ] **Step 4: Create the track-download hook**

Create `src/features/composer/hooks/use-track-download.ts`:

```ts
import { useMutation } from '@tanstack/react-query'
import { stockMediaApi } from '../api/stock-media.api'

/** Fire Unsplash's required download ping. Best-effort — errors are swallowed
 *  so a failed ping never blocks attaching the media. */
export function useTrackDownload() {
  return useMutation({
    mutationFn: (downloadTriggerUrl: string) =>
      stockMediaApi.trackDownload(downloadTriggerUrl),
    onError: () => {
      /* non-critical: ignore */
    },
  })
}
```

- [ ] **Step 5: Verify the build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/composer/types/draft.types.ts src/features/composer/api/stock-media.api.ts src/features/composer/hooks/use-stock-search.ts src/features/composer/hooks/use-track-download.ts
git commit -m "feat(composer): stock-media api client, hooks, DraftMediaItem attribution"
```

---

### Task B3: `buildDraftMediaItem` + caption-credit helpers (pure, unit-tested)

**Files:**
- Create: `src/features/composer/lib/stock-media-item.ts`
- Test: `src/features/composer/lib/stock-media-item.test.ts`

**Interfaces:**
- Consumes: `StockMediaItem` (from `../api/stock-media.api`), `DraftMediaItem` (from `../types/draft.types`).
- Produces:
  - `buildDraftMediaItem(stock: StockMediaItem, probed: { width?: number; height?: number; durationSec?: number; sizeBytes: number }): DraftMediaItem`
  - `formatCaptionCredit(stock: StockMediaItem): string`
  - `appendCaptionCredit(caption: string, credit: string): string`

- [ ] **Step 1: Write the failing test**

Create `src/features/composer/lib/stock-media-item.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { appendCaptionCredit, buildDraftMediaItem, formatCaptionCredit } from './stock-media-item'
import type { StockMediaItem } from '../api/stock-media.api'

const stock: StockMediaItem = {
  provider: 'unsplash',
  providerId: 'abc',
  type: 'image',
  previewUrl: 'https://img/small',
  fullUrl: 'https://img/regular',
  width: 4000,
  height: 3000,
  authorName: 'Jane Doe',
  authorUrl: 'https://unsplash.com/@janedoe?utm_source=schedura&utm_medium=referral',
  providerUrl: 'https://unsplash.com/photos/abc?utm_source=schedura&utm_medium=referral',
  downloadTriggerUrl: 'https://api.unsplash.com/photos/abc/download',
}

describe('buildDraftMediaItem', () => {
  it('builds a DraftMediaItem with a provider-prefixed id, hotlink url, and attribution', () => {
    const item = buildDraftMediaItem(stock, { width: 4000, height: 3000, sizeBytes: 123 })
    expect(item.id).toBe('unsplash:abc')
    expect(item.type).toBe('image')
    expect(item.url).toBe('https://img/regular')
    expect(item.sizeBytes).toBe(123)
    expect(item.attribution).toEqual({
      provider: 'unsplash',
      authorName: 'Jane Doe',
      authorUrl: stock.authorUrl,
      providerUrl: stock.providerUrl,
    })
  })

  it('prefers stock dimensions and carries durationSec for video', () => {
    const video: StockMediaItem = { ...stock, provider: 'pexels', type: 'video', durationSec: 12 }
    const item = buildDraftMediaItem(video, { sizeBytes: 0, durationSec: 12 })
    expect(item.type).toBe('video')
    expect(item.durationSec).toBe(12)
    expect(item.width).toBe(4000) // from stock, probe omitted
  })
})

describe('formatCaptionCredit', () => {
  it('formats an Unsplash credit line', () => {
    expect(formatCaptionCredit(stock)).toBe('Photo by Jane Doe on Unsplash')
  })
  it('formats a Pexels video credit line', () => {
    const v: StockMediaItem = { ...stock, provider: 'pexels', type: 'video', authorName: 'Cara Coe' }
    expect(formatCaptionCredit(v)).toBe('Video by Cara Coe on Pexels')
  })
})

describe('appendCaptionCredit', () => {
  it('appends with a blank line when caption non-empty', () => {
    expect(appendCaptionCredit('Hello', 'Photo by X on Unsplash')).toBe('Hello\n\nPhoto by X on Unsplash')
  })
  it('returns just the credit when caption empty', () => {
    expect(appendCaptionCredit('', 'Photo by X on Unsplash')).toBe('Photo by X on Unsplash')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- stock-media-item`
Expected: FAIL — cannot resolve `./stock-media-item`.

- [ ] **Step 3: Implement the helpers**

Create `src/features/composer/lib/stock-media-item.ts`:

```ts
import type { StockMediaItem } from '../api/stock-media.api'
import type { DraftMediaItem } from '../types/draft.types'

interface ProbeResult {
  width?: number
  height?: number
  durationSec?: number
  sizeBytes: number
}

/** Convert a normalized stock item + client-probed metadata into the composer's
 *  DraftMediaItem. The provider URL is hotlinked as-is (never re-hosted). */
export function buildDraftMediaItem(
  stock: StockMediaItem,
  probed: ProbeResult,
): DraftMediaItem {
  return {
    id: `${stock.provider}:${stock.providerId}`,
    type: stock.type,
    url: stock.fullUrl,
    width: stock.width ?? probed.width,
    height: stock.height ?? probed.height,
    durationSec: stock.durationSec ?? probed.durationSec,
    sizeBytes: probed.sizeBytes,
    attribution: {
      provider: stock.provider,
      authorName: stock.authorName,
      authorUrl: stock.authorUrl,
      providerUrl: stock.providerUrl,
    },
  }
}

const PROVIDER_LABEL: Record<string, string> = {
  unsplash: 'Unsplash',
  pexels: 'Pexels',
}

/** "Photo by <author> on <Provider>" / "Video by …" for optional caption credit. */
export function formatCaptionCredit(stock: StockMediaItem): string {
  const noun = stock.type === 'video' ? 'Video' : 'Photo'
  const provider = PROVIDER_LABEL[stock.provider] ?? stock.provider
  return `${noun} by ${stock.authorName} on ${provider}`
}

export function appendCaptionCredit(caption: string, credit: string): string {
  return caption.trim().length > 0 ? `${caption}\n\n${credit}` : credit
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- stock-media-item`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/composer/lib/stock-media-item.ts src/features/composer/lib/stock-media-item.test.ts
git commit -m "feat(composer): buildDraftMediaItem + caption-credit helpers"
```

---

### Task B4: Stock attribution badge + stock tile + stock browser

**Files:**
- Create: `src/features/composer/components/media-picker/stock-attribution.tsx`
- Create: `src/features/composer/components/media-picker/stock-tile.tsx`
- Create: `src/features/composer/components/media-picker/stock-browser.tsx`

**Interfaces:**
- Consumes: `useStockSearch`, `useTrackDownload`, `buildDraftMediaItem`, `probeImage`/`probeVideo`/`probeFileSize`, `StockMediaItem`, `DraftMediaItem`.
- Produces:
  - `StockAttribution({ authorName, authorUrl, providerUrl, provider })`
  - `StockTile({ item, onSelect, disabled })`
  - `StockBrowser({ provider, onSelect })` where `onSelect(item: DraftMediaItem)` and `StockBrowserProps.provider: StockProvider`

Requirements (shadcn-only, theme tokens, lucide icons; every async surface gets loading/empty/error states):

- [ ] **Step 1: Attribution badge**

Create `src/features/composer/components/media-picker/stock-attribution.tsx`:

```tsx
// External
import { ExternalLink } from 'lucide-react'

interface StockAttributionProps {
  authorName: string
  authorUrl: string
  providerUrl: string
  provider: string
  className?: string
}

const LABEL: Record<string, string> = { unsplash: 'Unsplash', pexels: 'Pexels' }

export function StockAttribution({
  authorName,
  authorUrl,
  providerUrl,
  provider,
  className,
}: StockAttributionProps) {
  const providerLabel = LABEL[provider] ?? provider
  return (
    <span className={className}>
      <a
        href={authorUrl}
        target="_blank"
        rel="noreferrer"
        className="underline-offset-2 hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {authorName}
      </a>
      {' · '}
      <a
        href={providerUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {providerLabel}
        <ExternalLink className="size-3" />
      </a>
    </span>
  )
}
```

- [ ] **Step 2: Stock tile**

Create `src/features/composer/components/media-picker/stock-tile.tsx`. A button-wrapped thumbnail with a hover attribution overlay; a `PlayCircle` badge for video:

```tsx
// External
import { PlayCircle } from 'lucide-react'
// Internal
import { cn } from '@/lib/utils'
// Local
import { StockAttribution } from './stock-attribution'
import type { StockMediaItem } from '../../api/stock-media.api'

interface StockTileProps {
  item: StockMediaItem
  onSelect: (item: StockMediaItem) => void
  disabled?: boolean
}

export function StockTile({ item, onSelect, disabled }: StockTileProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(item)}
      disabled={disabled}
      className={cn(
        'group relative block w-full overflow-hidden rounded-md border border-border bg-muted/40',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        disabled && 'pointer-events-none opacity-50',
      )}
      style={{ aspectRatio: `${item.width} / ${item.height}` }}
    >
      <img
        src={item.previewUrl}
        alt={item.authorName}
        loading="lazy"
        className="h-full w-full object-cover transition-transform group-hover:scale-105"
      />
      {item.type === 'video' && (
        <PlayCircle className="absolute right-1.5 top-1.5 size-5 text-white drop-shadow" />
      )}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent p-1.5 text-left text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100">
        <StockAttribution
          className="pointer-events-auto"
          authorName={item.authorName}
          authorUrl={item.authorUrl}
          providerUrl={item.providerUrl}
          provider={item.provider}
        />
      </span>
    </button>
  )
}
```

> The gradient overlay uses `black/70` for legibility over arbitrary photos — this is an image scrim, not themeable chrome, so a literal black is acceptable here. All other surfaces use theme tokens.

- [ ] **Step 3: Stock browser (search + type toggle + grid + states)**

Create `src/features/composer/components/media-picker/stock-browser.tsx`:

```tsx
// External
import { useEffect, useMemo, useState } from 'react'
import { ImageOff, Loader2, Search } from 'lucide-react'
// Internal
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
// Local
import { StockTile } from './stock-tile'
import { useStockSearch } from '../../hooks/use-stock-search'
import { useTrackDownload } from '../../hooks/use-track-download'
import { buildDraftMediaItem } from '../../lib/stock-media-item'
import { probeFileSize, probeImage, probeVideo } from '../../lib/media-probe'
import type { StockMediaItem, StockMediaType, StockProvider } from '../../api/stock-media.api'
import type { DraftMediaItem } from '../../types/draft.types'

interface StockBrowserProps {
  provider: StockProvider
  onSelect: (item: DraftMediaItem, stock: StockMediaItem) => void
}

const DEBOUNCE_MS = 400

export function StockBrowser({ provider, onSelect }: StockBrowserProps) {
  const [term, setTerm] = useState('')
  const [debounced, setDebounced] = useState('')
  const [type, setType] = useState<StockMediaType>('image')
  const [page, setPage] = useState(1)
  const [selecting, setSelecting] = useState(false)

  // Unsplash has no video — force image.
  const effectiveType: StockMediaType = provider === 'unsplash' ? 'image' : type

  useEffect(() => {
    const id = setTimeout(() => setDebounced(term), DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [term])

  // New search term / type resets pagination.
  useEffect(() => setPage(1), [debounced, effectiveType, provider])

  const { data, isFetching, isError, error, refetch } = useStockSearch({
    provider,
    type: effectiveType,
    q: debounced,
    page,
  })

  const items = data?.items ?? []
  const isRateLimited = useMemo(
    () => (error as { status?: number } | null)?.status === 429,
    [error],
  )

  async function handleSelect(stock: StockMediaItem) {
    setSelecting(true)
    try {
      let width: number | undefined
      let height: number | undefined
      let durationSec: number | undefined
      if (stock.type === 'video') {
        const meta = await probeVideo(stock.fullUrl)
        if (meta) ({ width, height, durationSec } = meta)
      } else {
        const dims = await probeImage(stock.fullUrl)
        if (dims) ({ width, height } = dims)
      }
      const sizeBytes = await probeFileSize(stock.fullUrl)
      const item = buildDraftMediaItem(stock, { width, height, durationSec, sizeBytes })
      onSelect(item, stock)
    } finally {
      setSelecting(false)
    }
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Search + type toggle */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder={`Search ${provider === 'unsplash' ? 'Unsplash' : 'Pexels'}…`}
            className="pl-8"
            autoFocus
          />
        </div>
        {provider === 'pexels' && (
          <div className="flex shrink-0 gap-1">
            {(['image', 'video'] as StockMediaType[]).map((t) => (
              <Button
                key={t}
                type="button"
                size="sm"
                variant={type === t ? 'default' : 'outline'}
                onClick={() => setType(t)}
              >
                {t === 'image' ? 'Photos' : 'Videos'}
              </Button>
            ))}
          </div>
        )}
      </div>

      {/* Results area */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {debounced.trim().length === 0 ? (
          <EmptyState icon={<Search className="size-8" />} title="Search for stock media"
            hint={`Type a keyword to search ${provider === 'unsplash' ? 'Unsplash' : 'Pexels'}.`} />
        ) : isError ? (
          <EmptyState
            icon={<ImageOff className="size-8" />}
            title={isRateLimited ? 'Too many searches' : 'Search failed'}
            hint={isRateLimited ? 'Please try again in a moment.' : 'Something went wrong.'}
            action={<Button size="sm" variant="outline" onClick={() => refetch()}>Retry</Button>}
          />
        ) : isFetching && items.length === 0 ? (
          <div className="columns-2 gap-2 sm:columns-3 [&>*]:mb-2">
            {Array.from({ length: 9 }).map((_, i) => (
              <Skeleton key={i} className="h-32 w-full rounded-md" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={<ImageOff className="size-8" />} title={`No results for “${debounced}”`}
            hint="Try a different keyword." />
        ) : (
          <>
            <div className="columns-2 gap-2 sm:columns-3 [&>*]:mb-2 [&>*]:break-inside-avoid">
              {items.map((it) => (
                <StockTile key={`${it.provider}:${it.providerId}`} item={it} onSelect={handleSelect} disabled={selecting} />
              ))}
            </div>
            {data?.hasMore && (
              <div className="mt-3 flex justify-center">
                <Button type="button" variant="outline" size="sm" disabled={isFetching}
                  onClick={() => setPage((p) => p + 1)}>
                  {isFetching ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

interface EmptyStateProps {
  icon: React.ReactNode
  title: string
  hint: string
  action?: React.ReactNode
}

function EmptyState({ icon, title, hint, action }: EmptyStateProps) {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 py-10 text-center text-muted-foreground">
      {icon}
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="text-xs">{hint}</p>
      {action}
    </div>
  )
}
```

> Pagination note: "Load more" replaces the page's results with the next page (React Query keyed by `page`, `keepPreviousData`). Accumulating infinite-scroll is deliberately **out of scope** for Phase 1 — a documented, intentional limitation, not an oversight.

- [ ] **Step 4: Verify the build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/composer/components/media-picker
git commit -m "feat(composer): stock browser, tile, and attribution components"
```

---

### Task B5: Media picker dialog (tabs) + wire into the composer

**Files:**
- Create: `src/features/composer/components/media-picker/upload-pane.tsx`
- Create: `src/features/composer/components/media-picker/media-picker-dialog.tsx`
- Modify: `src/features/composer/components/editor-card.tsx` (replace the standalone `MediaButton` trigger with the dialog; `AddMediaTile` opens the dialog; append-caption wiring)
- Modify: `src/features/composer/components/media-thumbnail.tsx` (attribution overlay when `item.attribution` set)

**Interfaces:**
- Consumes: `StockBrowser`, `uploadMediaFile` (`../../api/media-upload.api`), `useUploadTracker`, `useTrackDownload`, `formatCaptionCredit`/`appendCaptionCredit`, `DraftMediaItem`, `StockMediaItem`.
- Produces:
  - `MediaPickerDialog({ open, onOpenChange, workspaceId, onAddMedia, onAppendCaption })`
  - `UploadPane({ workspaceId, onUploaded })`

- [ ] **Step 1: Upload pane (reuses the existing upload path)**

Create `src/features/composer/components/media-picker/upload-pane.tsx`. Reuse `uploadMediaFile` from `../../api/media-upload.api` and the `useUploadTracker` wrapper (same contract `MediaButton` uses today), producing a `DraftMediaItem`:

```tsx
// External
import { useRef, useState } from 'react'
import { Loader2, UploadCloud } from 'lucide-react'
import { toast } from 'sonner'
// Internal
import { Button } from '@/components/ui/button'
// Local
import { useUploadTracker } from '../../lib/upload-tracker'
import { uploadMediaFile } from '../../api/media-upload.api'
import { genId } from '../../lib/media-probe'
import type { DraftMediaItem } from '../../types/draft.types'

interface UploadPaneProps {
  workspaceId?: string
  onUploaded: (item: DraftMediaItem) => void
}

export function UploadPane({ workspaceId, onUploaded }: UploadPaneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const { beginUpload } = useUploadTracker()

  async function handleFile(file: File) {
    setBusy(true)
    const endUpload = beginUpload()
    try {
      const uploaded = await uploadMediaFile(file, workspaceId)
      const item: DraftMediaItem = {
        id: uploaded.publicId || genId(),
        type: uploaded.resourceType === 'video' ? 'video' : 'image',
        url: uploaded.secureUrl,
        width: uploaded.width,
        height: uploaded.height,
        durationSec: uploaded.duration,
        sizeBytes: uploaded.bytes ?? 0,
      }
      onUploaded(item)
      toast.success('Media uploaded')
    } catch {
      toast.error('Upload failed')
    } finally {
      setBusy(false)
      endUpload()
    }
  }

  return (
    <div className="flex h-full min-h-52 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border p-8 text-center">
      <UploadCloud className="size-8 text-muted-foreground" />
      <div>
        <p className="text-sm font-medium">Upload from your device</p>
        <p className="text-xs text-muted-foreground">Images or MP4 video</p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/mp4"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) handleFile(f)
          e.target.value = ''
        }}
      />
      <Button type="button" size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
        Choose file
      </Button>
    </div>
  )
}
```

> Confirm `uploadMediaFile`'s return field names against `src/features/composer/api/media-upload.api.ts` (`UploadedMedia`: `secureUrl`, `publicId`, `resourceType`, `width`, `height`, `duration`, `bytes`). If a name differs, match the source — this pane must not diverge from how `MediaButton` maps the same result.

- [ ] **Step 2: The dialog with source tabs**

Create `src/features/composer/components/media-picker/media-picker-dialog.tsx`:

```tsx
// External
import { useState } from 'react'
// Internal
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
// Local
import { UploadPane } from './upload-pane'
import { StockBrowser } from './stock-browser'
import { useTrackDownload } from '../../hooks/use-track-download'
import { appendCaptionCredit, formatCaptionCredit } from '../../lib/stock-media-item'
import type { DraftMediaItem } from '../../types/draft.types'
import type { StockMediaItem } from '../../api/stock-media.api'

interface MediaPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId?: string
  onAddMedia: (item: DraftMediaItem) => void
  onAppendCaption: (creditLine: string) => void
}

export function MediaPickerDialog({
  open,
  onOpenChange,
  workspaceId,
  onAddMedia,
  onAppendCaption,
}: MediaPickerDialogProps) {
  const [addCredit, setAddCredit] = useState(false)
  const track = useTrackDownload()

  function handleUploaded(item: DraftMediaItem) {
    onAddMedia(item)
    onOpenChange(false)
  }

  function handleStockSelect(item: DraftMediaItem, stock: StockMediaItem) {
    if (stock.downloadTriggerUrl) track.mutate(stock.downloadTriggerUrl)
    onAddMedia(item)
    if (addCredit) onAppendCaption(appendCaptionCredit('', formatCaptionCredit(stock)))
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] max-w-3xl flex-col gap-4">
        <DialogHeader>
          <DialogTitle>Add media</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="upload" className="flex min-h-0 flex-1 flex-col">
          <TabsList>
            <TabsTrigger value="upload">Upload</TabsTrigger>
            <TabsTrigger value="unsplash">Unsplash</TabsTrigger>
            <TabsTrigger value="pexels">Pexels</TabsTrigger>
          </TabsList>

          <TabsContent value="upload" className="min-h-0 flex-1">
            <UploadPane workspaceId={workspaceId} onUploaded={handleUploaded} />
          </TabsContent>
          <TabsContent value="unsplash" className="min-h-0 flex-1">
            <StockBrowser provider="unsplash" onSelect={handleStockSelect} />
          </TabsContent>
          <TabsContent value="pexels" className="min-h-0 flex-1">
            <StockBrowser provider="pexels" onSelect={handleStockSelect} />
          </TabsContent>
        </Tabs>

        <div className="flex items-center gap-2 border-t border-border pt-3">
          <Checkbox id="add-credit" checked={addCredit}
            onCheckedChange={(v) => setAddCredit(v === true)} />
          <Label htmlFor="add-credit" className="text-xs font-normal text-muted-foreground">
            Add photo credit to caption (recommended for Unsplash)
          </Label>
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

> `Checkbox` is already installed (`src/components/ui/checkbox.tsx`). Do not add it. If its `onCheckedChange` value type differs (base-ui vs radix idiom), match the existing checkbox usage in the repo.

- [ ] **Step 3: Wire the dialog into `EditorCard`**

In `src/features/composer/components/editor-card.tsx`:

1. Add a new prop for caption append and workspace id to `EditorCardProps`:

```ts
interface EditorCardProps {
  // ...existing...
  workspaceId?: string
  onAppendCaption?: (creditLine: string) => void
}
```

2. Add dialog state + open handler inside the component:

```ts
const [pickerOpen, setPickerOpen] = useState(false)
```

3. Replace the `<MediaButton onUploaded={onAddMedia} />` in the action bar (line 108) with a dialog trigger button, and make `AddMediaTile` open the dialog too. Keep `MediaUrlButton` and `EmojiButton`. Add near the top of the JSX return an "Add media" button:

```tsx
import { ImagePlus } from 'lucide-react'
// ...action bar, replacing <MediaButton .../>:
<Button
  type="button"
  variant="ghost"
  size="icon"
  className="size-8 text-muted-foreground hover:text-foreground"
  aria-label="Add media"
  title="Add media"
  onClick={() => setPickerOpen(true)}
>
  <ImagePlus className="size-4" />
</Button>
```

4. Change `AddMediaTile` to open the dialog instead of uploading directly:

```tsx
<AddMediaTile onClick={() => setPickerOpen(true)} />
```

(Update `AddMediaTile`'s props: add an optional `onClick?: () => void`; when provided, the tile calls it instead of opening the file input. Keep the existing `onUploaded` path working for callers that still pass it. See `src/features/composer/components/add-media-tile.tsx`.)

5. Render the dialog once, before `</Card>`:

```tsx
<MediaPickerDialog
  open={pickerOpen}
  onOpenChange={setPickerOpen}
  workspaceId={workspaceId}
  onAddMedia={onAddMedia}
  onAppendCaption={(credit) => onAppendCaption?.(credit)}
/>
```

6. Remove the now-unused `MediaButton` import if no longer referenced.

- [ ] **Step 4: Thread `workspaceId` + `onAppendCaption` from the tabs to `EditorCard`**

`EditorCard` is rendered by `OriginalTab` (`src/features/composer/components/original-tab.tsx`) and `PlatformTab` (`src/features/composer/components/platform-tab.tsx`). Pass `workspaceId` (already available in the composer page / tabs — trace from `composer-page.tsx`) and an `onAppendCaption` that appends to the tab's text via its existing `onChange`/text setter:

```tsx
// In OriginalTab, where <EditorCard ... /> is rendered:
<EditorCard
  // ...existing props...
  workspaceId={workspaceId}
  onAppendCaption={(credit) =>
    onChange(appendCaptionCredit(value, credit))
  }
/>
```

Import `appendCaptionCredit` from `../lib/stock-media-item`. In `PlatformTab`, wire the same using its effective text value + change handler. If `workspaceId` isn't already a prop of these tabs, add it and pass it down from `ComposerPageContent` (it holds `workspaceId`).

> `onAppendCaption` receives the fully-formatted credit line; the tab decides how to merge it into its own text (base vs per-platform), so the append logic stays with whoever owns the caption state.

- [ ] **Step 5: Attribution overlay on the composer thumbnail**

In `src/features/composer/components/media-thumbnail.tsx`, when `item.attribution` is set, render a small always-visible credit chip in a corner using `StockAttribution` (or a compact static line). Keep it unobtrusive (`text-[10px]`, `bg-black/60`, bottom-left):

```tsx
import { StockAttribution } from './media-picker/stock-attribution'
// ...inside the thumbnail, after the img/video:
{item.attribution && (
  <span className="pointer-events-auto absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 py-0.5 text-[10px] text-white">
    <StockAttribution
      authorName={item.attribution.authorName}
      authorUrl={item.attribution.authorUrl}
      providerUrl={item.attribution.providerUrl}
      provider={item.attribution.provider}
    />
  </span>
)}
```

(Confirm `MediaThumbnail`'s root is `relative`; if not, add `relative` to it so the absolute overlay anchors correctly.)

- [ ] **Step 6: Verify the build + full test run**

Run: `npm run build`
Expected: PASS.
Run: `npm run test`
Expected: PASS (stock-media-item + any existing suites).

- [ ] **Step 7: Commit**

```bash
git add src/features/composer/components/media-picker/upload-pane.tsx src/features/composer/components/media-picker/media-picker-dialog.tsx src/features/composer/components/editor-card.tsx src/features/composer/components/add-media-tile.tsx src/features/composer/components/media-thumbnail.tsx src/features/composer/components/original-tab.tsx src/features/composer/components/platform-tab.tsx
git commit -m "feat(composer): add-media dialog with Upload/Unsplash/Pexels tabs + attribution"
```

---

## Manual verification (after all tasks)

1. `npm run dev` (frontend) + backend running with `UNSPLASH_ACCESS_KEY` and `PEXELS_API_KEY` set.
2. Open the composer → click "Add media" → dialog opens on the Upload tab.
3. Unsplash tab → search "mountains" → grid of images; no video toggle shown.
4. Pexels tab → toggle Photos/Videos → search → results; videos show a play badge.
5. Select an image → dialog closes, thumbnail appears with an attribution chip; the network tab shows a `POST /media/stock/track` for Unsplash selections only.
6. Enable "Add photo credit to caption" before selecting → caption gains "Photo by … on …".
7. Publish/save still works; the media URL in the payload is the provider's hotlink.

---

## Self-review notes (author)

- **Spec coverage:** gateway search+track (A2/A3), envelope+mappers (A1), hotlink (buildDraftMediaItem uses `fullUrl`), server-side trigger (A2 `track` + B5 `useTrackDownload`), mandatory attribution (A1 fields + B4/B5 display), Unsplash-no-video (A2 guard + B4 forces image), opt-in caption credit (B3 helpers + B5 checkbox), backward-compatible `attribution?` (B2). All present.
- **Out of scope kept out:** no cloud storage, no Pixabay/Flickr/Coverr/Giphy, no re-hosting, media-library page untouched.
- **Type consistency:** `StockMediaItem` fields identical across backend (`stock-media.types.ts`) and frontend (`stock-media.api.ts`); `buildDraftMediaItem` id format `provider:providerId` matches `StockTile` key.
