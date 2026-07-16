# Google Drive → Picker + `drive.file` Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Google Drive off the restricted `drive.readonly` scope onto `drive.file` + the Google Picker, so the app never requests a restricted Drive scope and never needs a CASA security assessment.

**Architecture:** Two tokens. The **server** keeps its own offline `drive.file` token (as today, scope swapped) and uses it to download files the user picked. The **browser** gets its own ephemeral `drive.file` token straight from Google (GIS) purely to render Google's Picker — our stored token never reaches the browser. The Picker returns only file IDs; the existing import endpoint downloads them server-side into our storage, unchanged.

**Tech Stack:** NestJS + Drizzle + Jest (backend); Vite + React 19 + TypeScript + Tailwind + shadcn/ui + Vitest (frontend); Google Identity Services (`accounts.google.com/gsi/client`) and Google Picker (`apis.google.com/js/api.js`).

**Spec:** `docs/superpowers/specs/2026-07-16-drive-picker-migration-design.md`

## Global Constraints

- **Never request a restricted Drive scope again.** Drive's only scope is exactly `https://www.googleapis.com/auth/drive.file`. Any of `drive`, `drive.readonly`, `drive.metadata`, `drive.metadata.readonly`, `drive.photos.readonly` re-triggers CASA.
- **Our stored cloud token must never reach the browser.** The browser's Picker token is minted by Google directly, is never persisted, and is `drive.file`-scoped only.
- **Google Drive / Photos / Calendar share the YouTube OAuth app** (`YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET`, see `src/channels/services/oauth.service.ts:770-777`). The frontend's `VITE_GOOGLE_CLIENT_ID` **must be that same client ID** — a different client ID means the Picker's `drive.file` grant goes to another client and the server's download 404s.
- **Selection always imports into our storage.** No hotlinking, no expiring provider URLs in a draft.
- **Out of scope:** Maestro action-tool; Google Photos (leave exactly as-is); Dropbox/OneDrive (untouched); reconnect banner / DB migration.
- **Backend worktree:** `d:/My Documents/MyProjects/FullStackProjects/_wt-drive-picker`, branch `feat/drive-picker-migration` off `origin/main`.
- **Frontend worktree:** `d:/My Documents/MyProjects/FullStackProjects/_wt-drive-picker-fe`, branch `feat/drive-picker-migration` off `origin/main`.
- **Never `git add -A`.** Stage only the files a task names; verify with `git diff --cached --name-only`. Never stage `.env`.
- **Never run `npm run db:generate` / `db:push`.** No schema migration is needed in this plan.

---

## File Structure

**Backend (`_wt-drive-picker`)**

| File | Responsibility after this plan |
|---|---|
| `src/drizzle/schema/channels.schema.ts:594` | Drive's single scope becomes `drive.file` |
| `src/drizzle/schema/channels.schema.spec.ts` | **New.** Regression guard: Drive never requests a restricted scope |
| `src/media-sources/media-sources.service.ts` | `browse` rejects `google_drive`; `browseDrive` gone; import maps Drive 403/404 to an actionable 400 |
| `src/media-sources/mappers/drive.mapper.ts` | **Deleted** (only browse used it) |
| `src/channels/services/google-drive.service.ts` | Listing methods deleted; `downloadFile` throws a typed `DriveApiError` carrying HTTP status |
| `src/chatbot/tools/cloud-storage.tools.ts` | `search_google_drive` removed; no longer takes `GoogleDriveService` |
| `src/chatbot/tools/tool-registry.service.ts:140` | Drive display label removed |
| `src/chatbot/services/agent.service.ts:652` | Drive result→media handler removed |

**Frontend (`_wt-drive-picker-fe`)**

| File | Responsibility after this plan |
|---|---|
| `src/features/composer/hooks/use-cloud-sources.ts` | `CloudSourceStatus` also carries `accountEmail` (for `login_hint`) |
| `src/features/composer/constants/cloud-sources.ts` | `CloudSourceMeta.usesPicker`; Drive sets it `true` |
| `src/features/composer/lib/google-picker.ts` | **New.** Script loading, GIS token, opening the Picker |
| `src/features/composer/lib/picker-doc.ts` | **New.** Pure mapper: Picker document → `CloudMediaItem` |
| `src/features/composer/components/media-picker/drive-picker-pane.tsx` | **New.** Drive's launch surface + pick→import→draft |
| `src/features/composer/components/media-picker/cloud-source-pane.tsx` | Branches to `DrivePickerPane` when `meta.usesPicker` |
| `src/features/composer/components/media-picker/cloud-browser.tsx` | **Unchanged** — Dropbox/OneDrive keep it |

---

## Task 1: Drive browse returns 400; delete dead Drive listing code

**Files:**
- Modify: `src/media-sources/media-sources.service.ts` (remove `browseDrive`, its `switch` arm, the `drive.mapper` import)
- Modify: `src/channels/services/google-drive.service.ts` (delete `listFiles`, `listImages`, `listVideos`, `listMedia`, `listFolders` and the now-unused `DriveFolder` / `DriveListResponse` types)
- Delete: `src/media-sources/mappers/drive.mapper.ts`
- Test: `src/media-sources/media-sources.service.browse.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `MediaSourcesService.browse()` throws `BadRequestException('Google Drive uses the Google Picker')` for a `google_drive` channel. `GoogleDriveService` keeps only `getFile`, `getDownloadUrl`, `downloadFile`, `verifyAccess`, `getUserInfo`, and the `DriveFile` interface.

- [ ] **Step 1: Replace the Drive browse test with a rejection test**

In `src/media-sources/media-sources.service.browse.spec.ts`, delete this existing test (lines 72-79):

```ts
it("browse(videos) on google_drive calls listVideos, not listMedia", async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'google_drive' });
  drive.listVideos.mockResolvedValue({ files: [] });
  const svc = await build();
  await svc.browse('ws', 1, { kind: 'videos' });
  expect(drive.listVideos).toHaveBeenCalled();
  expect(drive.listMedia).not.toHaveBeenCalled();
});
```

and add in its place:

```ts
// Drive moved to the Google Picker: the browser picks files inside Google's own
// UI under drive.file, so we can no longer list a user's Drive server-side.
// Browse must say so plainly rather than return a misleading empty listing.
it('browse on google_drive rejects — Drive uses the Google Picker', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'google_drive' });
  const svc = await build();
  await expect(svc.browse('ws', 1, { kind: 'media' })).rejects.toThrow(
    'Google Drive uses the Google Picker',
  );
});

it('browse on google_drive never calls the Drive provider', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'google_drive' });
  const svc = await build();
  await expect(svc.browse('ws', 1, { kind: 'folders' })).rejects.toBeInstanceOf(
    BadRequestException,
  );
  expect(drive.downloadFile).not.toHaveBeenCalled();
});
```

Also change the `drive` mock on line 16 from:

```ts
const drive = { listMedia: jest.fn(), listImages: jest.fn(), listVideos: jest.fn(), listFolders: jest.fn(), downloadFile: jest.fn() };
```

to:

```ts
const drive = { downloadFile: jest.fn() };
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- media-sources.service.browse`
Expected: FAIL — `browse on google_drive rejects` fails because `browseDrive` currently calls `drive.listMedia`, which is now `undefined` on the mock (TypeError), not a `BadRequestException` with our message.

- [ ] **Step 3: Make browse reject google_drive**

In `src/media-sources/media-sources.service.ts`, change the `switch` in `browse()` from:

```ts
    switch (platform) {
      case 'dropbox':
        return this.browseDropbox(token, args);
      case 'google_drive':
        return this.browseDrive(token, args);
      case 'onedrive':
        return this.browseOneDrive(token, args);
      case 'google_photos':
        return this.browsePhotos(token, args);
    }
```

to:

```ts
    switch (platform) {
      case 'dropbox':
        return this.browseDropbox(token, args);
      case 'google_drive':
        // Drive runs on drive.file: we can only reach files the user picked in
        // Google's own Picker, so there is no server-side listing to return.
        throw new BadRequestException('Google Drive uses the Google Picker');
      case 'onedrive':
        return this.browseOneDrive(token, args);
      case 'google_photos':
        return this.browsePhotos(token, args);
    }
```

Delete the whole `browseDrive` method (the block starting `private async browseDrive(`), and remove the now-unused import line:

```ts
import { mapDriveItem, mapDriveFolder } from './mappers/drive.mapper';
```

Note: `browse()` resolves the token before the `switch`. Leave that as-is — the token fetch is harmless and keeps the not-a-cloud-channel check ordering unchanged.

- [ ] **Step 4: Delete the Drive mapper**

```bash
rm src/media-sources/mappers/drive.mapper.ts
```

Check nothing else imports it:

Run: `grep -rn "drive.mapper\|mapDriveItem\|mapDriveFolder" src/`
Expected: no output. If `src/media-sources/mappers/mappers.spec.ts` references them, delete only those Drive cases from that spec.

- [ ] **Step 5: Delete the dead Drive listing methods**

In `src/channels/services/google-drive.service.ts`, delete the methods `listFiles`, `listImages`, `listVideos`, `listMedia`, and `listFolders`, plus these two now-unused interfaces:

```ts
export interface DriveFolder {
  id: string;
  name: string;
}

export interface DriveListResponse {
  files: DriveFile[];
  nextPageToken?: string;
}
```

Keep `DriveFile`, `getFile`, `getDownloadUrl`, `downloadFile`, `verifyAccess`, `getUserInfo`, `apiBaseUrl`, and `logger`.

Run: `grep -rn "listFolders\|listImages\|listVideos\|listMedia\|listFiles\|DriveFolder\|DriveListResponse" src/ | grep -i drive`
Expected: no output. Any hit outside Dropbox/OneDrive/Photos is a caller that must be handled — Task 4 removes the chatbot's Drive caller, so hits in `src/chatbot/tools/cloud-storage.tools.ts` are expected at this point and are fixed there. If a hit appears anywhere else, stop and report it.

- [ ] **Step 6: Run tests and build**

Run: `npm run test -- media-sources`
Expected: PASS

Run: `npm run build`
Expected: exit 0. If it fails inside `src/chatbot/tools/cloud-storage.tools.ts` (the Drive tool still calls the deleted methods), that is Task 4's work — but the branch must not be left red, so complete Task 4 before considering the branch green. Report this state rather than hacking around it.

- [ ] **Step 7: Commit**

```bash
git add src/media-sources/media-sources.service.ts src/media-sources/media-sources.service.browse.spec.ts src/channels/services/google-drive.service.ts
git rm src/media-sources/mappers/drive.mapper.ts
git commit -m "feat(drive): browse rejects Drive — the Picker replaces server-side listing"
```

---

## Task 2: Swap Drive's scope to `drive.file`

**Files:**
- Modify: `src/drizzle/schema/channels.schema.ts:594`
- Test: `src/drizzle/schema/channels.schema.spec.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `PLATFORM_CONFIG.google_drive.oauthScopes === ['https://www.googleapis.com/auth/drive.file']`. `src/channels/services/oauth.service.ts:146` already reads this value, so the OAuth request and the `permissions` stored at connect (`src/channels/channels.controller.ts:4262`) both follow automatically — no other change needed.

- [ ] **Step 1: Write the failing test**

Create `src/drizzle/schema/channels.schema.spec.ts`:

```ts
import { PLATFORM_CONFIG } from './channels.schema';

// Google classifies these as RESTRICTED: requesting any of them forces an
// annual CASA security assessment. drive.file is non-sensitive. This test is
// the tripwire for the whole Picker migration — if someone re-adds a broad
// Drive scope to "make listing work again", CASA silently comes back.
const RESTRICTED_DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.metadata',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/drive.photos.readonly',
];

it('google_drive requests only the non-sensitive drive.file scope', () => {
  expect(PLATFORM_CONFIG.google_drive.oauthScopes).toEqual([
    'https://www.googleapis.com/auth/drive.file',
  ]);
});

it('google_drive requests no restricted Drive scope', () => {
  for (const scope of PLATFORM_CONFIG.google_drive.oauthScopes) {
    expect(RESTRICTED_DRIVE_SCOPES).not.toContain(scope);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- channels.schema`
Expected: FAIL — both tests fail; the config still holds `https://www.googleapis.com/auth/drive.readonly`.

- [ ] **Step 3: Swap the scope**

In `src/drizzle/schema/channels.schema.ts`, change line 594 from:

```ts
    oauthScopes: ['https://www.googleapis.com/auth/drive.readonly'],
```

to:

```ts
    oauthScopes: ['https://www.googleapis.com/auth/drive.file'],
```

Leave `google_photos` (line 605) **exactly as-is** — deliberately out of scope.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- channels.schema`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/drizzle/schema/channels.schema.ts src/drizzle/schema/channels.schema.spec.ts
git commit -m "feat(drive): request drive.file instead of the restricted drive.readonly"
```

---

## Task 3: Actionable error when a picked file isn't reachable

**Why:** Under `drive.file` the server can only read files the user picked **with the same Google account** the channel was connected with. Pick from a different account and Drive answers 403/404. Today `downloadFile` swallows the status and throws a flat `BadRequestException('Failed to download Google Drive file')`, which tells the user nothing.

**Files:**
- Modify: `src/channels/services/google-drive.service.ts` (add `DriveApiError`; `downloadFile` throws it)
- Modify: `src/media-sources/media-sources.service.ts` (`import` maps Drive 403/404 to an actionable message)
- Test: `src/media-sources/media-sources.service.import.spec.ts`

**Interfaces:**
- Consumes: `GoogleDriveService.downloadFile` from Task 1's trimmed service.
- Produces: `export class DriveApiError extends Error { constructor(message: string, readonly status: number) }` exported from `src/channels/services/google-drive.service.ts`. `MediaSourcesService.import` throws `BadRequestException` whose message starts with `Choose files from your connected Google Drive account` when Drive answers 403/404.

- [ ] **Step 1: Write the failing tests**

In `src/media-sources/media-sources.service.import.spec.ts`, add at the top with the other imports:

```ts
import { BadRequestException } from '@nestjs/common';
import { DriveApiError } from '../channels/services/google-drive.service';
```

and append these tests:

```ts
// Under drive.file the server can only read files the user picked with the SAME
// Google account the channel was connected with. Picking from another account is
// the single most likely live failure, so it must name the fix, not 500.
it('import maps a Drive 404 to an actionable account-mismatch error', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'google_drive' });
  drive.downloadFile.mockRejectedValue(new DriveApiError('File not found', 404));
  const svc = await build();
  await expect(svc.import('ws', 3, { fileId: 'f1', kind: 'image' })).rejects.toThrow(
    /Choose files from your connected Google Drive account/,
  );
});

it('import maps a Drive 403 to the same actionable error', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'google_drive' });
  drive.downloadFile.mockRejectedValue(new DriveApiError('Forbidden', 403));
  const svc = await build();
  await expect(svc.import('ws', 3, { fileId: 'f1', kind: 'image' })).rejects.toBeInstanceOf(
    BadRequestException,
  );
});

it('import lets a non-permission Drive failure surface as-is', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'google_drive' });
  drive.downloadFile.mockRejectedValue(new DriveApiError('Drive is down', 500));
  const svc = await build();
  // A 500 is not the user's fault — do not tell them to pick a different account.
  await expect(svc.import('ws', 3, { fileId: 'f1', kind: 'image' })).rejects.toThrow(
    'Drive is down',
  );
});

it('import on google_drive downloads and uploads on the happy path', async () => {
  channelService.getChannelById.mockResolvedValue({ platform: 'google_drive' });
  drive.downloadFile.mockResolvedValue(Buffer.from('z'));
  cloudinary.uploadFromBuffer.mockResolvedValue({ secureUrl: 'https://cdn/z.jpg', width: 10, height: 20, duration: undefined, bytes: 7, resourceType: 'image', publicId: 'r' });
  const svc = await build();
  const res = await svc.import('ws', 3, { fileId: 'f1', kind: 'image' });
  expect(drive.downloadFile).toHaveBeenCalledWith('TKN', 'f1');
  expect(res).toEqual({ url: 'https://cdn/z.jpg', type: 'image', width: 10, height: 20, durationSec: undefined, sizeBytes: 7 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- media-sources.service.import`
Expected: FAIL — `DriveApiError` is not exported yet (TypeScript/import error).

- [ ] **Step 3: Add `DriveApiError` and throw it from `downloadFile`**

In `src/channels/services/google-drive.service.ts`, add above the `@Injectable()` class:

```ts
/**
 * A Drive API failure that keeps its HTTP status.
 *
 * Callers need the status to tell "you picked a file this account can't see"
 * (403/404 — actionable) apart from "Drive is broken" (5xx — not the user's
 * fault). A flat Error would collapse that distinction.
 */
export class DriveApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DriveApiError';
  }
}
```

and change `downloadFile` from:

```ts
  async downloadFile(accessToken: string, fileId: string): Promise<Buffer> {
    const response = await fetch(this.getDownloadUrl(fileId), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to download Drive file: ${error}`);
      throw new BadRequestException('Failed to download Google Drive file');
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
```

to:

```ts
  async downloadFile(accessToken: string, fileId: string): Promise<Buffer> {
    const response = await fetch(this.getDownloadUrl(fileId), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error(`Failed to download Drive file: ${error}`);
      throw new DriveApiError(
        'Failed to download Google Drive file',
        response.status,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
```

- [ ] **Step 4: Map 403/404 in import**

In `src/media-sources/media-sources.service.ts`, add the import:

```ts
import { GoogleDriveService, DriveApiError } from '../channels/services/google-drive.service';
```

(replacing the existing `import { GoogleDriveService } from '../channels/services/google-drive.service';`)

and change the download line inside `import()` from:

```ts
    const buffer = await this.downloadBuffer(platform, token, args.fileId);
```

to:

```ts
    const buffer = await this.downloadPicked(platform, channel, token, args.fileId);
```

then add this private method next to `downloadBuffer`:

```ts
  /**
   * Wraps the provider download so Drive's "this account can't see that file"
   * answer becomes advice instead of a 500.
   *
   * Under drive.file our token only reaches files the user picked with the SAME
   * Google account the channel was connected with. Picking from a second signed-in
   * account is the most likely real-world failure, and Drive reports it as a plain
   * 403/404 — indistinguishable from a bug unless we say so.
   */
  private async downloadPicked(
    platform: CloudStoragePlatform,
    channel: { accountName?: string | null },
    token: string,
    fileId: string,
  ): Promise<Buffer> {
    try {
      return await this.downloadBuffer(platform, token, fileId);
    } catch (error) {
      if (
        platform === 'google_drive' &&
        error instanceof DriveApiError &&
        (error.status === 403 || error.status === 404)
      ) {
        const account = channel.accountName ?? 'your connected account';
        throw new BadRequestException(
          `Choose files from your connected Google Drive account (${account}). ` +
            `Schedura can only open files picked from that account.`,
        );
      }
      throw error;
    }
  }
```

`channel` is already in scope inside `import()` — it is fetched at the top via `this.channelService.getChannelById(channelId, workspaceId)`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -- media-sources.service.import`
Expected: PASS (all tests, including the three pre-existing ones)

- [ ] **Step 6: Commit**

```bash
git add src/channels/services/google-drive.service.ts src/media-sources/media-sources.service.ts src/media-sources/media-sources.service.import.spec.ts
git commit -m "feat(drive): tell the user which account to pick from when a Drive import is denied"
```

---

## Task 4: Remove the chatbot's `search_google_drive` tool

**Why:** It calls the listing methods Task 1 deleted and needs `drive.readonly` to work at all. Left in place it would 403 at runtime; a broken tool is worse than an absent one.

**Files:**
- Modify: `src/chatbot/tools/cloud-storage.tools.ts` (remove the tool and the `GoogleDriveService` parameter)
- Modify: `src/chatbot/tools/tool-registry.service.ts:140` (remove the display label)
- Modify: `src/chatbot/services/agent.service.ts:652-667` (remove the Drive result handler)
- Modify: `src/chatbot/chatbot.module.ts` (lines 21, 112, 127-133 — drop `GoogleDriveService` entirely)
- Test: `src/chatbot/tools/cloud-storage.tools.spec.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `createCloudStorageTools(channelService, oneDriveService, dropboxService, googlePhotosService)` — the `googleDriveService` parameter is **gone**; note the remaining parameter order. No tool named `search_google_drive` exists anywhere.

**Do not touch** `src/chatbot/services/context-builder.service.ts:95` — it only categorizes Drive as an integration and claims no search capability.

- [ ] **Step 1: Write the failing test**

Create `src/chatbot/tools/cloud-storage.tools.spec.ts`:

```ts
import { createCloudStorageTools } from './cloud-storage.tools';

const channelService = { getWorkspaceChannels: jest.fn(), getAccessToken: jest.fn() } as any;
const onedrive = {} as any;
const dropbox = {} as any;
const photos = {} as any;

// Drive moved to the Google Picker under drive.file. A drive.file token cannot
// search a user's Drive, so this tool could only ever 403 — it must not exist.
it('exposes no Google Drive search tool', () => {
  const tools = createCloudStorageTools(channelService, onedrive, dropbox, photos);
  expect(tools.map((t) => t.name)).not.toContain('search_google_drive');
});

it('still exposes the other cloud search tools', () => {
  const tools = createCloudStorageTools(channelService, onedrive, dropbox, photos);
  expect(tools.map((t) => t.name).sort()).toEqual([
    'search_dropbox',
    'search_google_photos',
    'search_onedrive',
  ]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- cloud-storage.tools`
Expected: FAIL — `createCloudStorageTools` still takes 5 services and still returns `search_google_drive`.

- [ ] **Step 3: Remove the tool**

In `src/chatbot/tools/cloud-storage.tools.ts`:

Delete the import:

```ts
import type { GoogleDriveService } from '../../channels/services/google-drive.service';
```

Change the signature from:

```ts
export function createCloudStorageTools(
  channelService: ChannelService,
  googleDriveService: GoogleDriveService,
  oneDriveService: OneDriveService,
  dropboxService: DropboxService,
  googlePhotosService: GooglePhotosService,
): ChatbotTool[] {
```

to:

```ts
export function createCloudStorageTools(
  channelService: ChannelService,
  oneDriveService: OneDriveService,
  dropboxService: DropboxService,
  googlePhotosService: GooglePhotosService,
): ChatbotTool[] {
```

Delete the entire `search_google_drive` tool object — everything from the `// ===== GOOGLE DRIVE =====` comment through the closing `},` immediately before `// ===== ONEDRIVE =====`.

Leave `PLATFORM_LABELS` alone: `google_drive` stays there because `getIntegrationToken` is generic and the label costs nothing.

- [ ] **Step 3b: Fix the call site**

`createCloudStorageTools` has exactly one caller: `src/chatbot/chatbot.module.ts:127`. In that file `googleDriveService` exists *only* to feed this tool (import at line 21, constructor injection at line 112, argument at line 129), so all three go.

Change the call at lines 127-133 from:

```ts
      ...createCloudStorageTools(
        this.channelService,
        this.googleDriveService,
        this.oneDriveService,
        this.dropboxService,
        this.googlePhotosService,
      ),
```

to:

```ts
      ...createCloudStorageTools(
        this.channelService,
        this.oneDriveService,
        this.dropboxService,
        this.googlePhotosService,
      ),
```

Delete the constructor injection at line 112:

```ts
    private readonly googleDriveService: GoogleDriveService,
```

and the import at line 21:

```ts
import { GoogleDriveService } from '../channels/services/google-drive.service';
```

Confirm nothing else in the module still wants it:

Run: `grep -n "googleDriveService\|GoogleDriveService" src/chatbot/chatbot.module.ts`
Expected: no output.

If `GoogleDriveService` is also listed in this module's `providers`/`imports` arrays, leave those alone — removing a provider is out of scope and other modules may resolve it.

- [ ] **Step 4: Remove the display label**

In `src/chatbot/tools/tool-registry.service.ts`, delete line 140:

```ts
      search_google_drive: 'Searching Google Drive',
```

- [ ] **Step 5: Remove the agent result handler**

In `src/chatbot/services/agent.service.ts`, delete the whole block at lines 651-667:

```ts
    // Google Drive results
    if (toolName === 'search_google_drive' && result.data.files) {
      for (const f of result.data.files) {
        const url = f.webContentLink || f.webViewLink;
        if (!this.isValidMediaUrl(url)) continue;
        items.push({
          id: f.id,
          url,
          thumbnailUrl: this.isValidMediaUrl(f.thumbnailLink)
            ? f.thumbnailLink
            : undefined,
          alt: f.name,
          source: 'Google Drive',
          mimeType: f.mimeType,
        });
      }
    }
```

- [ ] **Step 6: Run tests and build**

Run: `grep -rn "search_google_drive" src/`
Expected: no output.

Run: `npm run test`
Expected: PASS (full suite — this is the task that makes the branch green again after Task 1)

Run: `npm run build`
Expected: exit 0

- [ ] **Step 7: Commit**

```bash
git add src/chatbot/tools/cloud-storage.tools.ts src/chatbot/tools/cloud-storage.tools.spec.ts src/chatbot/tools/tool-registry.service.ts src/chatbot/services/agent.service.ts
git commit -m "feat(chatbot): drop the Drive search tool — drive.file cannot search a Drive"
```

Include the `createCloudStorageTools` call-site file found in Step 3 in this `git add`.

---

## Task 5: Expose the connected Google account's email

**Why:** The Picker must open on the **same** Google account the channel was connected with, or every import 403s. Google's token client takes a `hint`. The Drive channel already stores the account email in `username` (`src/channels/channels.controller.ts:4257`), and `ChannelDto.username` already reaches the frontend — but `useCloudSources` currently drops it.

**Files (frontend worktree `_wt-drive-picker-fe`):**
- Modify: `src/features/composer/hooks/use-cloud-sources.ts`
- Test: `src/features/composer/hooks/use-cloud-sources.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface CloudSourceStatus { channelId: number; connected: boolean; accountEmail: string | null }`.

**Note:** this repo has **no `@testing-library/react`** — do not add one. `use-cloud-sources.spec.ts` already defines the harness this task reuses: `renderCloudSourcesHook(workspaceId, seedChannels)` returning the hook's value, and `makeChannel(overrides)` whose default `username` is `null`.

- [ ] **Step 1: Update the two existing assertions that will break**

Two existing tests assert the status object with `toEqual`, which is exact — adding a field breaks them. This is expected and correct: they must state the new shape.

In `src/features/composer/hooks/use-cloud-sources.spec.ts`, change line 81 from:

```ts
    expect(statusOf('dropbox')).toEqual({ channelId: 42, connected: true })
```

to:

```ts
    expect(statusOf('dropbox')).toEqual({ channelId: 42, connected: true, accountEmail: null })
```

and line 93 from:

```ts
    expect(statusOf('dropbox')).toEqual({ channelId: 7, connected: false })
```

to:

```ts
    expect(statusOf('dropbox')).toEqual({ channelId: 7, connected: false, accountEmail: null })
```

- [ ] **Step 2: Write the failing tests**

Append inside the `describe('useCloudSources', ...)` block in the same file:

```ts
  // The Picker must open on the same Google account the channel was connected
  // with — a mismatch makes every import 403. The account email is the hint,
  // and Drive stores it on the channel's `username`.
  it('exposes the connected account email for a cloud channel', () => {
    const drive = makeChannel({
      id: 9,
      platform: 'google_drive' as ChannelDto['platform'],
      username: 'someone@gmail.com',
    })
    const { statusOf } = renderCloudSourcesHook(WORKSPACE_ID, [drive])

    expect(statusOf('google_drive')).toEqual({
      channelId: 9,
      connected: true,
      accountEmail: 'someone@gmail.com',
    })
  })

  it('reports a null account email when the channel carries no username', () => {
    const drive = makeChannel({
      id: 9,
      platform: 'google_drive' as ChannelDto['platform'],
      username: null,
    })
    const { statusOf } = renderCloudSourcesHook(WORKSPACE_ID, [drive])

    expect(statusOf('google_drive')?.accountEmail).toBeNull()
  })
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test -- use-cloud-sources`
Expected: FAIL — all four assertions above fail; `accountEmail` does not exist on the status object yet.

- [ ] **Step 4: Add the field**

In `src/features/composer/hooks/use-cloud-sources.ts`, change:

```ts
export interface CloudSourceStatus {
  channelId: number
  connected: boolean
}
```

to:

```ts
export interface CloudSourceStatus {
  channelId: number
  connected: boolean
  /** The provider account this channel is connected as. Google Drive stores the
   *  Google account email here; the Picker needs it as a login hint so the user
   *  can't pick from a different account than the one our token can read. */
  accountEmail: string | null
}
```

and change the map population from:

```ts
      map.set(channel.platform, {
        channelId: channel.id,
        connected: channel.connectionStatus === 'connected' && channel.isActive,
      })
```

to:

```ts
      map.set(channel.platform, {
        channelId: channel.id,
        connected: channel.connectionStatus === 'connected' && channel.isActive,
        accountEmail: channel.username ?? null,
      })
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -- use-cloud-sources`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/features/composer/hooks/use-cloud-sources.ts src/features/composer/hooks/use-cloud-sources.spec.ts
git commit -m "feat(composer): expose the connected cloud account email"
```

---

## Task 6: Picker document mapper

**Why:** The Picker hands back Google's own document shape. Everything downstream (`useCloudImport`, `toDraftMediaItem`) already speaks `CloudMediaItem`. One pure function bridges them — and being pure, it is the only part of the Picker integration that is genuinely unit-testable.

**Files:**
- Create: `src/features/composer/lib/picker-doc.ts`
- Test: `src/features/composer/lib/picker-doc.spec.ts`

**Interfaces:**
- Consumes: `CloudMediaItem` from `src/features/composer/api/cloud-media.api.ts` — `{ id, kind: 'image'|'video', name, thumbnailUrl, width?, height?, durationSec?, sizeBytes? }`.
- Produces:
  ```ts
  export interface PickerDoc {
    id: string
    name?: string
    mimeType?: string
    sizeBytes?: number | string
    url?: string
  }
  export function pickerDocToCloudMediaItem(doc: PickerDoc): CloudMediaItem
  ```

- [ ] **Step 1: Write the failing test**

Create `src/features/composer/lib/picker-doc.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { pickerDocToCloudMediaItem } from './picker-doc'

describe('pickerDocToCloudMediaItem', () => {
  it('maps an image document', () => {
    const item = pickerDocToCloudMediaItem({
      id: 'file_1',
      name: 'beach.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 2048,
    })
    expect(item).toEqual({
      id: 'file_1',
      kind: 'image',
      name: 'beach.jpg',
      thumbnailUrl: '',
      sizeBytes: 2048,
    })
  })

  it('maps a video document by mime type', () => {
    const item = pickerDocToCloudMediaItem({
      id: 'file_2',
      name: 'clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 99,
    })
    expect(item.kind).toBe('video')
  })

  // The Picker reports sizeBytes as a string for some document types.
  it('coerces a string sizeBytes to a number', () => {
    const item = pickerDocToCloudMediaItem({
      id: 'file_3',
      name: 'a.png',
      mimeType: 'image/png',
      sizeBytes: '4096',
    })
    expect(item.sizeBytes).toBe(4096)
  })

  it('survives a document with no name, mime type or size', () => {
    const item = pickerDocToCloudMediaItem({ id: 'file_4' })
    expect(item).toEqual({
      id: 'file_4',
      kind: 'image',
      name: 'Untitled',
      thumbnailUrl: '',
      sizeBytes: undefined,
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- picker-doc`
Expected: FAIL — cannot resolve `./picker-doc`.

- [ ] **Step 3: Write the mapper**

Create `src/features/composer/lib/picker-doc.ts`:

```ts
import type { CloudMediaItem } from '../api/cloud-media.api'

/** The subset of a Google Picker document we rely on. The Picker returns more
 *  fields; these are the only ones that survive into a draft. */
export interface PickerDoc {
  id: string
  name?: string
  mimeType?: string
  /** The Picker reports this as a number for some document types, a string for others. */
  sizeBytes?: number | string
  url?: string
}

/**
 * Bridges Google's Picker document shape to the `CloudMediaItem` the rest of the
 * composer already speaks, so picked files reuse the existing import + draft path.
 *
 * `thumbnailUrl` is deliberately empty: a Drive thumbnail link needs an auth'd
 * request to render, and the tile is only shown after import anyway — the
 * imported copy carries its own URL.
 */
export function pickerDocToCloudMediaItem(doc: PickerDoc): CloudMediaItem {
  const size = doc.sizeBytes === undefined ? undefined : Number(doc.sizeBytes)
  return {
    id: doc.id,
    kind: doc.mimeType?.startsWith('video/') ? 'video' : 'image',
    name: doc.name ?? 'Untitled',
    thumbnailUrl: '',
    sizeBytes: Number.isFinite(size) ? size : undefined,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- picker-doc`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/features/composer/lib/picker-doc.ts src/features/composer/lib/picker-doc.spec.ts
git commit -m "feat(composer): map Google Picker documents to cloud media items"
```

---

## Task 7: Google Picker integration library

**Why:** Script loading, the GIS token, and opening the Picker are all browser-global side effects. Isolating them in one module keeps `DrivePickerPane` (Task 8) a plain component.

**Files:**
- Create: `src/features/composer/lib/google-picker.ts`
- Modify: `.env.example` (create the entries; **never touch `.env`**)

**Interfaces:**
- Consumes: `PickerDoc` from `src/features/composer/lib/picker-doc.ts` (Task 6).
- Produces:
  ```ts
  export class PickerConfigError extends Error {}
  export function isPickerConfigured(): boolean
  export async function openDrivePicker(opts: { loginHint: string | null }): Promise<PickerDoc[]>
  ```
  `openDrivePicker` resolves `[]` when the user cancels, and rejects with `PickerConfigError` when env vars are missing.

- [ ] **Step 1: Add the env entries**

In `.env.example`, add:

```
# Google Picker (composer → Google Drive source).
# VITE_GOOGLE_CLIENT_ID MUST be the same Google OAuth client the backend uses for
# Drive — the backend shares the YouTube OAuth app (YOUTUBE_CLIENT_ID) across
# Drive/Photos/Calendar. A different client ID means the Picker grants drive.file
# to another app and every server-side import 404s.
VITE_GOOGLE_CLIENT_ID=
VITE_GOOGLE_PICKER_API_KEY=
# Google Cloud project NUMBER (not the project id).
VITE_GOOGLE_PICKER_APP_ID=
```

Then set real values in your local `.env` by hand. Do not commit `.env`.

- [ ] **Step 2: Write the module**

Create `src/features/composer/lib/google-picker.ts`:

```ts
import type { PickerDoc } from './picker-doc'

// Drive's only scope. Never widen this — a broader Drive scope is "restricted"
// and drags the whole app into an annual CASA security assessment.
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

const GIS_SRC = 'https://accounts.google.com/gsi/client'
const GAPI_SRC = 'https://apis.google.com/js/api.js'

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined
const API_KEY = import.meta.env.VITE_GOOGLE_PICKER_API_KEY as string | undefined
const APP_ID = import.meta.env.VITE_GOOGLE_PICKER_APP_ID as string | undefined

/** Thrown when the Picker env vars are missing, so the UI can say so instead of
 *  opening a blank Google dialog. */
export class PickerConfigError extends Error {}

export function isPickerConfigured(): boolean {
  return Boolean(CLIENT_ID && API_KEY && APP_ID)
}

/** Loads a third-party script once; repeated calls share the first promise. */
const scriptPromises = new Map<string, Promise<void>>()
function loadScript(src: string): Promise<void> {
  const existing = scriptPromises.get(src)
  if (existing) return existing

  const promise = new Promise<void>((resolve, reject) => {
    const el = document.createElement('script')
    el.src = src
    el.async = true
    el.onload = () => resolve()
    el.onerror = () => {
      // Let a later attempt retry rather than caching the failure forever.
      scriptPromises.delete(src)
      reject(new Error(`Failed to load ${src}`))
    }
    document.head.appendChild(el)
  })

  scriptPromises.set(src, promise)
  return promise
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Google's picker/GIS globals ship no types. */
declare global {
  interface Window {
    google?: any
    gapi?: any
  }
}

/** Loads gapi and its picker module. */
async function loadPickerApi(): Promise<void> {
  await loadScript(GAPI_SRC)
  await new Promise<void>((resolve, reject) => {
    window.gapi.load('picker', {
      callback: () => resolve(),
      onerror: () => reject(new Error('Failed to load the Google Picker')),
    })
  })
}

/**
 * Gets a short-lived drive.file access token straight from Google.
 *
 * This token is deliberately NOT our stored Drive token: ours never leaves the
 * server. This one is minted by Google for the browser, lives in memory for this
 * Picker session only, and can only reach files the user themselves picks.
 */
async function requestPickerToken(loginHint: string | null): Promise<string> {
  await loadScript(GIS_SRC)
  return new Promise<string>((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: DRIVE_FILE_SCOPE,
      // Steers Google to the account the channel was connected with. It is a
      // hint, not a lock — the server still rejects files from another account.
      hint: loginHint ?? undefined,
      callback: (response: any) => {
        if (response?.access_token) resolve(response.access_token)
        else reject(new Error(response?.error ?? 'Google did not return an access token'))
      },
      error_callback: (error: any) =>
        reject(new Error(error?.message ?? 'Google sign-in was dismissed')),
    })
    client.requestAccessToken({ prompt: '' })
  })
}

/**
 * Opens Google's own Drive picker and resolves the picked documents.
 *
 * Resolves `[]` if the user closes it without picking.
 */
export async function openDrivePicker({
  loginHint,
}: {
  loginHint: string | null
}): Promise<PickerDoc[]> {
  if (!isPickerConfigured()) {
    throw new PickerConfigError('Google Picker is not configured')
  }

  const [token] = await Promise.all([requestPickerToken(loginHint), loadPickerApi()])

  return new Promise<PickerDoc[]>((resolve) => {
    const view = new window.google.picker.DocsView(
      window.google.picker.ViewId.DOCS_IMAGES_AND_VIDEOS,
    )
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false)

    const picker = new window.google.picker.PickerBuilder()
      .enableFeature(window.google.picker.Feature.MULTISELECT_ENABLED)
      .setAppId(APP_ID)
      .setOAuthToken(token)
      .setDeveloperKey(API_KEY)
      .addView(view)
      .setCallback((data: any) => {
        const action = data[window.google.picker.Response.ACTION]
        if (action === window.google.picker.Action.PICKED) {
          resolve((data[window.google.picker.Response.DOCUMENTS] ?? []) as PickerDoc[])
        } else if (action === window.google.picker.Action.CANCEL) {
          resolve([])
        }
      })
      .build()

    picker.setVisible(true)
  })
}
/* eslint-enable @typescript-eslint/no-explicit-any */
```

- [ ] **Step 3: Verify it compiles and lints**

Run: `npm run build`
Expected: exit 0

Run: `npx eslint src/features/composer/lib/google-picker.ts`
Expected: exit 0, no output

There is no unit test for this module: every line is a browser-global side effect (script injection, Google's `gapi`/GIS singletons). Testing it would mean asserting against a hand-built mock of Google's SDK — a test that passes when the real SDK changes shape. Its behavior is covered by the manual smoke in Task 9. The pure part is already tested in Task 6.

- [ ] **Step 4: Commit**

```bash
git add src/features/composer/lib/google-picker.ts .env.example
git commit -m "feat(composer): add the Google Picker integration for Drive"
```

---

## Task 8: The Drive pane

**Files:**
- Create: `src/features/composer/components/media-picker/drive-picker-pane.tsx`
- Modify: `src/features/composer/constants/cloud-sources.ts`
- Modify: `src/features/composer/components/media-picker/cloud-source-pane.tsx`
- Test: `src/features/composer/components/media-picker/cloud-source-pane.spec.tsx`

**Interfaces:**
- Consumes: `openDrivePicker`, `isPickerConfigured`, `PickerConfigError` (Task 7); `pickerDocToCloudMediaItem` (Task 6); `CloudSourceStatus.accountEmail` (Task 5); the existing `useCloudImport(workspaceId, channelId)` and `toDraftMediaItem(source, imported)`.
- Produces: `CloudSourceMeta.usesPicker?: boolean`; `DrivePickerPane` component.

**`CloudBrowser` must not be modified** — Dropbox and OneDrive keep it exactly as-is.

- [ ] **Step 1: Write the failing test**

In `src/features/composer/components/media-picker/cloud-source-pane.spec.tsx`, add near the existing `DROPBOX_META`:

```tsx
const DRIVE_META = CLOUD_SOURCES.find((s) => s.platform === 'google_drive')!
```

Change `renderPane` so it can render a chosen source (it currently hard-codes `DROPBOX_META`):

```tsx
function renderPane(seedChannels: ChannelDto[], meta = DROPBOX_META) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(queryKeys.channels.list(WORKSPACE_ID), seedChannels)

  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(CloudSourcePane, {
        workspaceId: WORKSPACE_ID,
        meta,
        onAdd: vi.fn(),
      }),
    ),
  )
}
```

and append this block:

```tsx
describe('CloudSourcePane — Google Drive', () => {
  // Drive runs on drive.file: there is no server-side listing to render, so a
  // connected Drive must offer Google's Picker, never our file browser.
  it('renders the Picker launch surface, not the file browser', () => {
    const drive = makeChannel({
      id: 8,
      platform: 'google_drive' as ChannelDto['platform'],
      accountName: 'My Drive',
      username: 'someone@gmail.com',
    })
    const markup = renderPane([drive], DRIVE_META)

    expect(markup).toContain('Open Google Drive')
    expect(markup).not.toContain('Search Google Drive')
  })

  it('renders the connect card when Drive is not connected', () => {
    const markup = renderPane([], DRIVE_META)

    expect(markup).toContain('Connect Google Drive')
    expect(markup).not.toContain('Open Google Drive')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- cloud-source-pane`
Expected: FAIL — the connected-Drive case renders `CloudBrowser` (markup contains "Search Google Drive", not "Open Google Drive").

- [ ] **Step 3: Add the `usesPicker` flag**

In `src/features/composer/constants/cloud-sources.ts`, add to the interface:

```ts
export interface CloudSourceMeta {
  platform: CloudStoragePlatform
  label: string
  Logo: ComponentType<IntegrationLogoProps>
  hasFolders: boolean
  hasSearch: boolean
  browseUnit: 'folder' | 'album'
  /** Browse this source through the provider's own picker dialog instead of our
   *  in-app browser. Drive does: under drive.file we can only reach files the
   *  user picks in Google's Picker, so there is nothing to list ourselves. */
  usesPicker?: boolean
}
```

and change the Drive entry to:

```ts
  {
    platform: 'google_drive',
    label: 'Google Drive',
    Logo: GoogleDriveLogo,
    hasFolders: false,
    hasSearch: false,
    browseUnit: 'folder',
    usesPicker: true,
  },
```

`hasFolders`/`hasSearch` become `false` because Google's Picker supplies both itself; ours are dead for Drive.

- [ ] **Step 4: Write the pane**

Create `src/features/composer/components/media-picker/drive-picker-pane.tsx`:

```tsx
// 1. External imports
import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

// 2. Internal imports
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'

// 3. Local imports
import { useCloudImport } from '../../hooks/use-cloud-import'
import { toDraftMediaItem } from '../../lib/cloud-media-item'
import { isPickerConfigured, openDrivePicker, PickerConfigError } from '../../lib/google-picker'
import { pickerDocToCloudMediaItem } from '../../lib/picker-doc'
import type { CloudSourceMeta } from '../../constants/cloud-sources'
import type { DraftMediaItem } from '../../types/draft.types'

// 4. Types
interface DrivePickerPaneProps {
  workspaceId: string
  channelId: number
  meta: CloudSourceMeta
  /** The Google account this channel is connected as — steers the Picker to it. */
  accountEmail: string | null
  onAdd: (items: DraftMediaItem[]) => void
  /** Called only when every picked file imported successfully. */
  onClose?: () => void
}

// 6. Component

/**
 * Google Drive's source pane.
 *
 * Drive is browsed through Google's own Picker rather than our grid: on the
 * `drive.file` scope our token only reaches files the user explicitly picks, so
 * there is no library for us to list. The Picker brings its own search, folders
 * and multi-select — we only launch it, then import what comes back.
 */
export function DrivePickerPane({
  workspaceId,
  channelId,
  meta,
  accountEmail,
  onAdd,
  onClose,
}: DrivePickerPaneProps) {
  const [busy, setBusy] = useState(false)
  const importMutation = useCloudImport(workspaceId, channelId)

  if (!isPickerConfigured()) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Alert>
          <AlertDescription>
            Google Drive isn’t configured on this deployment yet. Add
            <code className="mx-1">VITE_GOOGLE_CLIENT_ID</code>,
            <code className="mx-1">VITE_GOOGLE_PICKER_API_KEY</code> and
            <code className="mx-1">VITE_GOOGLE_PICKER_APP_ID</code>, then reload.
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  async function handleOpen() {
    setBusy(true)
    try {
      const docs = await openDrivePicker({ loginHint: accountEmail })
      if (docs.length === 0) return // user closed the Picker — not an error

      const picked = docs.map(pickerDocToCloudMediaItem)
      const settled = await Promise.allSettled(
        picked.map((item) =>
          importMutation.mutateAsync(item).then((res) => toDraftMediaItem(item, res)),
        ),
      )

      const succeeded: DraftMediaItem[] = []
      let failed = 0
      settled.forEach((result) => {
        if (result.status === 'fulfilled') succeeded.push(result.value)
        else failed++
      })

      // Imports that landed already sit in our storage — never drop them just
      // because a sibling failed.
      if (succeeded.length > 0) onAdd(succeeded)

      if (failed === 0) {
        onClose?.()
      } else {
        const first = settled.find((r) => r.status === 'rejected') as
          | PromiseRejectedResult
          | undefined
        const reason =
          first?.reason instanceof Error ? first.reason.message : 'Import failed.'
        toast.error(
          succeeded.length > 0
            ? `Added ${succeeded.length}, ${failed} failed. ${reason}`
            : reason,
        )
      }
    } catch (error) {
      if (error instanceof PickerConfigError) {
        toast.error('Google Drive isn’t configured on this deployment.')
      } else {
        toast.error(
          error instanceof Error ? error.message : 'Couldn’t open Google Drive.',
        )
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 py-10 text-center">
      <meta.Logo className="size-10 shrink-0" aria-hidden />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">
          Pick from {meta.label}
        </p>
        <p className="max-w-xs text-xs text-muted-foreground">
          {meta.label} opens in Google’s own picker, where you can search and browse
          your files. Only what you choose is shared with Schedura.
        </p>
      </div>
      <Button type="button" onClick={handleOpen} disabled={busy}>
        {busy && <Loader2 className="mr-1.5 size-4 animate-spin" aria-hidden />}
        Open {meta.label}
      </Button>
      {accountEmail ? (
        <p className="text-[11px] text-muted-foreground">
          Connected as {accountEmail}
        </p>
      ) : null}
    </div>
  )
}
```

Confirm `alert` is installed: `ls src/components/ui/alert.tsx`. If it is missing, install it with the shadcn MCP (`mcp__shadcn__get_add_command_for_items` for `alert`) rather than hand-writing it.

- [ ] **Step 5: Branch the source pane**

In `src/features/composer/components/media-picker/cloud-source-pane.tsx`, add the import:

```ts
import { DrivePickerPane } from './drive-picker-pane'
```

and change the connected branch from:

```tsx
  if (status?.connected) {
    return (
      <CloudBrowser
        workspaceId={workspaceId}
        channelId={status.channelId}
        meta={meta}
        onAdd={onAdd}
        onClose={onClose}
      />
    )
  }
```

to:

```tsx
  if (status?.connected) {
    // Picker-based sources (Drive) have no server-side listing to browse.
    if (meta.usesPicker) {
      return (
        <DrivePickerPane
          workspaceId={workspaceId}
          channelId={status.channelId}
          meta={meta}
          accountEmail={status.accountEmail}
          onAdd={onAdd}
          onClose={onClose}
        />
      )
    }

    return (
      <CloudBrowser
        workspaceId={workspaceId}
        channelId={status.channelId}
        meta={meta}
        onAdd={onAdd}
        onClose={onClose}
      />
    )
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test -- cloud-source-pane`
Expected: PASS — including the three pre-existing Dropbox tests, which must be untouched.

Run: `npm run test`
Expected: PASS (full suite)

- [ ] **Step 7: Build and lint**

Run: `npm run build`
Expected: exit 0

Run: `npx eslint src/features/composer/components/media-picker/drive-picker-pane.tsx src/features/composer/components/media-picker/cloud-source-pane.tsx src/features/composer/constants/cloud-sources.ts`
Expected: exit 0, no output

- [ ] **Step 8: Commit**

```bash
git add src/features/composer/components/media-picker/drive-picker-pane.tsx src/features/composer/components/media-picker/cloud-source-pane.tsx src/features/composer/components/media-picker/cloud-source-pane.spec.tsx src/features/composer/constants/cloud-sources.ts
git commit -m "feat(composer): browse Google Drive through Google's Picker"
```

---

## Task 9: Verify end to end

**Why:** Everything above is unit-level. The parts that actually break in production — the Picker rendering, the account hint, CSP, and the real `drive.file` grant reaching the server — only show up when driven for real.

**Files:** none (verification only).

- [ ] **Step 1: Confirm the Google Cloud Console prerequisites are done**

These are manual and must be finished before the smoke test can pass:

1. OAuth consent screen: `drive.readonly` **removed**, `drive.file` **added**.
2. **Google Picker API enabled** in the same project.
3. An **API key** created, restricted by HTTP referrer to the app's origins.
4. Local `.env` has `VITE_GOOGLE_CLIENT_ID` (**the same client ID as the backend's `YOUTUBE_CLIENT_ID`**), `VITE_GOOGLE_PICKER_API_KEY`, `VITE_GOOGLE_PICKER_APP_ID` (the project **number**).

- [ ] **Step 2: Check the CSP allows Google's scripts**

Run: `grep -rn "Content-Security-Policy\|script-src" index.html vercel.json 2>/dev/null`

If any CSP is declared, it must allow `https://apis.google.com` and `https://accounts.google.com` in `script-src`, and `https://docs.google.com` in `frame-src` (the Picker renders in an iframe). If no CSP is declared, nothing to do — record that in the report.

- [ ] **Step 3: Reconnect Drive**

The old connection still holds a `drive.readonly` grant; scopes are never re-granted retroactively.

1. Start the backend and frontend.
2. Disconnect Google Drive in the app.
3. Reconnect it. On Google's consent screen, confirm it now asks only for per-file access ("see and download only the files you open with this app"), **not** "see all your Drive files".

- [ ] **Step 4: Smoke the happy path**

1. Open the composer → Add media → Google Drive.
2. Confirm the pane shows **"Open Google Drive"** and "Connected as \<email\>" — not our file grid.
3. Click it. Google's Picker must open on the connected account.
4. **Search inside the Picker** for a file by name — confirms search survived the migration.
5. Multi-select two files (one image, one video) and pick them.
6. Confirm both import and appear in the draft, and that their URLs point at **our** storage (a Cloudinary URL), not a Google URL.

- [ ] **Step 5: Smoke the account-mismatch path**

1. In the Picker, switch to a **different** Google account and pick a file from it.
2. Confirm the error names the fix — "Choose files from your connected Google Drive account (…)" — and is a toast, not a crash or a bare 500.

- [ ] **Step 6: Confirm nothing else regressed**

1. Open the Dropbox source: its file browser, search and folders must work exactly as before.
2. Ask Maestro to search your Google Drive: it must simply not have that tool — no error, no hang.

- [ ] **Step 7: Report**

Record in the task report: each step's actual observed result, the CSP finding from Step 2, and the exact consent-screen wording seen in Step 3. Do not mark this task complete on "should work" — every step needs an observed result.

---

## Notes for the implementer

- **Backend first, then frontend.** Tasks 1-4 are backend (`_wt-drive-picker`), Tasks 5-8 are frontend (`_wt-drive-picker-fe`), Task 9 spans both. The branch is red between Task 1 and Task 4 (Task 1 deletes methods the chatbot tool still calls) — that is expected; Task 4 closes it. Do not leave the branch there.
- **Do not re-author provider services.** Changes to `google-drive.service.ts` are limited to deleting dead listing methods and adding `DriveApiError`.
- **Google Photos stays exactly as-is** everywhere, including its dead scope and its commented-out entry in `cloud-sources.ts`.
- **`CloudBrowser` is not modified** by any task in this plan.
