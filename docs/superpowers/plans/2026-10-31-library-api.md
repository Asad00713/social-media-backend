# Library API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the redesigned Library: fix the five known bugs, add alt text, storage provider and page count, merge folders to one per tab kind, keep a per-plan storage limit per workspace and enforce it on every upload path, report real usage ("Used in N posts", "Never used"), aggregate stats and folder stats, a unified bin, AI alt text, and links with UTM tags and favicons.

**Architecture:** Everything lives in the existing `MediaLibraryModule` (`src/media-library/`). The five library services move from the global `db` import to `@Inject(DRIZZLE)` so their SQL can be tested against local Postgres in a rolled-back transaction. Upload routes move out of `MediaController` into a new `LibraryUploadController` (MediaLibraryModule already imports MediaModule; the reverse would be a cycle). Every upload ends in one place, `MediaItemService` creating the row under a per-workspace advisory lock that re-checks storage. `usage_count` is kept as a post count by ONE Postgres trigger on `posts`, because about 25 code paths write posts.

**Tech Stack:** NestJS 11, Drizzle ORM 0.45 (PostgreSQL 17 locally, 18 on prod), class-validator, Jest 30, Cloudinary SDK 2, AWS S3 SDK (R2), `@google/generative-ai` (Gemini), new: `yazl` (zip).

**Spec:** `D:/My Documents/MyProjects/FullStackProjects/socialmedia-frontend-library/docs/superpowers/specs/2026-10-30-library-redesign-design.md` (§2, §4, §6, §8). **Contract (binding for shapes):** `D:/My Documents/MyProjects/FullStackProjects/socialmedia-frontend-library/docs/superpowers/specs/2026-10-31-library-api-contract.md`.

**Branch:** `feat/library-api` off `main`, worktree `D:/My Documents/MyProjects/FullStackProjects/socialmedia-workspace-library`. Migrations start at `0054` (latest on main is `0053`).

**Worktree setup (once, before Task 1):** the worktree has no `node_modules` and no `.env`.
1. `npm ci` inside the worktree. It must be a real directory, never a junction to another checkout: Task 11 adds a dependency, and `git worktree remove --force` follows junctions.
2. Copy `D:/My Documents/MyProjects/FullStackProjects/socialmedia-workspace/.env` into the worktree. Check that `DATABASE_URL`'s host is `localhost` or `127.0.0.1`. If not, stop and ask.
3. Prove the DB harness works: `PLANNER_DB_TESTS=1 npx jest --runInBand src/planner/testing/rollback-db.db.spec.ts` → PASS.

## Contract rulings (2026-10-31, now in the contract)

1. The presign route keeps `sizeBytes`. No new `bytes` field (Task 15).
2. `upload/file` takes `purpose: 'library' | 'thumbnail'`, default `library`. A thumbnail creates no row and returns `libraryItem: null` (Task 15).
3. Snippet usage is counted by text match. Snippets shorter than 3 characters never count, and filled-in fill-ins undercount; that is accepted (Task 6).
4. The new bin shape replaces the old one, and both repos ship together. The legacy `type` query parameter is still mapped to `kind` (Task 14).
5. The three `upload/*` calls take optional `categoryId` and `tags` (Task 15).
6. `POST templates/bulk`, `snippets/bulk` and `links/bulk` follow the same rules as `items/bulk` and return `{affectedCount}` (Task 12).
7. `GET templates` and `GET snippets` take `sort` (`newest|most_used|recently_used|name`) and `starred` (Task 12).
8. Zip is two steps: a bearer-gated `POST categories/:id/zip-ticket`, then a bearer-less `GET categories/:id/zip?ticket=` carrying a 5-minute HMAC ticket. A bad or expired ticket gets 401 (Task 11).
9. `items/bulk` returns exactly `{affectedCount}`. Sending both `ids` and `selectAll` is a 400 (Tasks 3 and 12).
10. The 0055 deploy gate gets an exact prod query and a size threshold (Task 6).

## Decisions (spec §9 builder calls and recon)

- **D1 Alt-text model:** Gemini 2.0 Flash (`GeminiChatProvider`, existing `GOOGLE_AI_API_KEY`), sent as inline image data. New AI operation `generate_alt_text` costs **2** tokens. Only files on our own storage are sent (Cloudinary on our cloud name, or the R2 public base). Anything else gets 422 `NOT_AN_IMAGE`, which also closes off server-side request forgery.
- **D2 Ratio tolerance:** ±3%, comparing `width/height` to 1, 0.8, 0.5625 and 16/9. Rows without both dimensions never match.
- **D3 R2 detection:** live rows are R2 when `CloudflareR2Service.keyFromPublicUrl(fileUrl) !== null`. The migration backfill uses `cloudinary_public_id LIKE 'composer/videos/%' AND file_url NOT LIKE 'https://res.cloudinary.com/%'`, because Canva and cloud imports use the Cloudinary folders `composer/canva` and `composer/cloud`, and those must stay `cloudinary`.
- **D4 What counts as "used":** (a) any `posts` row whose base `media_items` or any `platform_content…mediaItems` entry holds the item's `libraryItemId` or its exact `file_url`; (b) a `campaign_slot_content` row not yet turned into a post (`post_id IS NULL`) whose `content.media[]` holds `{id}` = item id or `{url}` = `file_url`; (c) a `campaign_evergreen_posts` pool entry whose `content.media[]` or `variations[*].media[]` does the same. `usage_count` counts (a) only, because the contract says "counts posts". Drip posts are excluded: their `mediaUrls` are images from web search, never Library files.
- **D5 usage_count upkeep:** a posts trigger (Task 6). The trigger also recounts links and snippets whose URL or text appears in the old or new post text.
- **D6 Purchased (non-primary) workspaces:** they get the full per-plan storage, like AI tokens and unlike channels and members. Storage cannot move between workspaces, so no arbitrage opens up.
- **D7 Folder merge:** when two legacy folders in one workspace share a name, the first by kind order (image, gif, video, document), then oldest, keeps it. The others get ` (GIFs)`, ` (Videos)`, ` (Images)` or ` (Docs)` appended, truncated to fit 100 characters. Media folders are renumbered `display_order` 0..n in that same order.
- **D8 Zip:** `yazl` (MIT, one dependency, streams). Files are fetched one at a time and stored uncompressed.
  - The ticket is signed with a NEW env var, `LIBRARY_ZIP_TICKET_SECRET` (at least 32 random bytes). No existing secret is meant for this: the JWT secrets sign auth tokens, and the webhook secrets belong to providers.
  - The ticket URL is absolute, built from the existing `API_PUBLIC_URL`.
  - The owner must set `LIBRARY_ZIP_TICKET_SECRET` on Railway. While it is unset, `zip-ticket` returns 503 `Folder download is not configured`.
- **D9 Usage entries:** one entry per post. Its `platform` is the first target's platform.
- **D10 `storageProvider`** is worked out on the server from the URL. It is not a request field.
- **D11 Real size:** R2 sizes come from a HEAD request. Cloudinary sizes come from `cloudinary.api.resource`, which is rate-limited; on any failure the declared `fileSize` is used and a warning is logged.
- **D12 Search** uses `ilike` with `%`, `_` and `\` escaped. Items match on name only (per the contract; description matching is dropped). Templates match on name and description, snippets on name and content, links on name, url and `preview_title`.
- **D13 `use` endpoints:** items, snippets and links only set `last_used_at`. Templates keep today's behaviour.

## Global Constraints

- **Database safety:** never run `db:push`, `db:migrate` or `db:migrate:sql`. Never connect to, migrate or query production. Local Postgres only (`DATABASE_URL` from the copied `.env`, guarded by `assertLocalDatabase`). Never run the Task 18 scripts against anything but localhost.
- **Migrations:** hand-written numbered `.sql` files `drizzle/migrations/0054_…` and `0055_…`, following `docs/migrations.md` and the `0046`–`0053` pattern:
  - Each file carries the header (`-- WHY`, `-- SAFETY`, `-- ROLLBACK`, "Never run `db:push` against prod. The boot migrator applies this file.").
  - The first statement is `SET LOCAL lock_timeout = '10s';`.
  - No `BEGIN`/`COMMIT`, no `CONCURRENTLY`, no `SAVEPOINT`.
  - Each file is idempotent: `IF NOT EXISTS`, constraints inside `DO $$ … EXCEPTION WHEN duplicate_object THEN NULL; END $$`, data updates that are no-ops on a second run. The harness applies every file twice.
  - Each file is safe on a populated Postgres 18 database. Generated columns say `GENERATED ALWAYS AS (…) STORED` explicitly.
  - `drizzle/migrations/meta/_journal.json` is NOT edited (it stops at 0026 on purpose).
  - Each migration ships its Drizzle schema change in the same task.
- **Storage values (verbatim):** FREE `524288000`, BASIC `2147483648`, PRO `10737418240`, MAX `26843545600` bytes. Migration 0054 itself writes them to `plans` and backfills `workspace_usage.storage_bytes_limit` from each workspace owner's plan, because seeds don't run on deploy. Storage columns are `bigint` (MAX is over 2^31), Drizzle `bigint(…, { mode: 'number' })`.
- **Contract fidelity:** contract types are copied verbatim into `src/media-library/dto/contract.ts` (Task 9 creates the file; later tasks append) and imported from there. Error bodies:
  - `413 {code:'STORAGE_FULL', message, used, limit}`
  - `413 {code:'ZIP_TOO_LARGE', message}`
  - `422 {code:'NOT_AN_IMAGE', message}`
  - `402 {code:'AI_TOKENS_EXHAUSTED', message}`
- **Cutover compatibility:** the old Library, the composer picker (`library-pane.tsx`), Maestro (`mention-search.service.ts`, `maestro/tools/library.tools.ts`) and the chatbot keep calling these routes until the frontend ships.
  - Legacy request fields stay accepted: items `sortBy`/`sortOrder`/`isStarred`/`isDeleted`; snippets `snippetType` and the value `bio` (mapped to `signature`); category types `image|video|gif|document` (mapped to `media`); bin `type`.
  - Item and category responses only ADD keys.
- **Routes:** every new workspace route sits on `MediaLibraryController` (`workspaces/:workspaceId/media-library`, `@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)`), declares `@RequireCapability(...)`, and validates uuid path ids with `ParseUUIDPipe`. Each new handler is added to `src/workspace-members/remaining-workspace-guards.spec.ts`. `every-workspace-route-guarded.spec.ts` stays green. Its `OPEN_ROUTES` allowlist gains exactly ONE entry, the ticket-gated zip download (Task 11, ruling 8), with the reason written out. Nothing else is added. `/media/*` routes check access through `WorkspaceAccessService.assertCan(workspaceId, userId, 'posts:draft')`.
- **BullMQ:** job ids never contain `:` (no new queues are planned; this holds if one is added).
- **Tests:** Jest, co-located `*.spec.ts`, TDD per task.
  - DB-touching specs are named `*.db.spec.ts`, use `describeLibraryDb`/`withLibraryDb` (Task 1), and run as `PLANNER_DB_TESTS=1 npx jest --runInBand <file>`.
  - Run only the touched spec files plus `npm run build`.
  - Anything compared to "now" takes an injected `now: Date` or uses fake timers. No hard-coded future dates.
  - The `billing.controller.spec` "should be defined" failure exists on `main` and is not ours.
- **Lint:** `npx eslint --fix <touched .ts files>` (the config `npm run lint` uses, narrowed to touched files). Never run the whole-repo `npm run lint`, and never a bare `npx prettier`.
- **Git:** commit after each task. The message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push, never `git stash` (compare with `git show origin/main:<path>`), never `--no-verify`.
- **Per-task verification ("V"):** the task's specs (DB specs with the command above), then `npm run build`, then eslint on touched files, then one mutation check where the task names one: break the guarded line, watch the named test fail, revert.
- **Implementers see only their own task.** Trust the names in each Interfaces block.

## Review Focus

1. **A workspace already over its limit (§4.6).** Every new upload is refused with 413 and the stored file is removed. Editing, starring, moving, restoring from the bin and posting with existing files all keep working, and the stats show `level: 'full'`. Test: Task 15 ("over-limit workspace").
2. **Two uploads racing past the limit.** Both pass the presign check. The second registration must hit 413 and delete its own file. Check and insert must happen inside one advisory-locked transaction. Test: Task 15 (`getUsage` receives the locked tx; insert runs inside `runLocked`).
3. **Search text with `%`, `_`, `\` and mixed case.** "50%" finds only names containing "50%". "SALE" finds "sale". Test: Task 2.
4. **Folder merge with clashing names.** An Images "Launch" and a Videos "Launch" both survive, one renamed. Items keep their folder, and running the migration again adds no second suffix. Test: Task 5.
5. **Editing or deleting a post that uses a Library file.** `usage_count` follows. A post that holds the same item by id and by URL counts once. A status-only update doesn't fire the trigger. Another workspace's post with the same URL doesn't count. Deleting a workspace still works. Test: Task 6.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/media-library/testing/library-db.ts` | DB harness, migration list, fixtures |
| `src/media-library/dto/contract.ts` | Contract types, verbatim |
| `src/media-library/lib/search.ts` | `ilikePattern` |
| `src/media-library/lib/folder-kind.ts` | Folder kinds, legacy mapping |
| `src/media-library/lib/storage.ts` | Percent, level, `wouldExceed`, `StorageFullException` |
| `src/media-library/lib/ratio.ts` | Ratio bounds |
| `src/media-library/lib/usage-sql.ts` | The one "is this item referenced" SQL fragment, status mappers |
| `src/media-library/lib/user-ref.ts` | Row → `UserRef` |
| `src/media-library/lib/zip-names.ts` | Unique zip entry names |
| `src/media-library/lib/link-meta.ts` | Favicon extraction, UTM normalisation |
| `src/media-library/lib/vision.ts` | Vision source URL, alt-text cleanup |
| `src/media-library/lib/upload-type.ts` | Upload result → `MediaType` |
| `src/media-library/services/storage-object.service.ts` | Provider detection, delete, real size |
| `src/media-library/services/storage-quota.service.ts` | Used/limit, assert, advisory lock |
| `src/media-library/services/library-stats.service.ts` | `GET stats` |
| `src/media-library/services/media-usage.service.ts` | `GET items/:id/usage` |
| `src/media-library/services/recycle-bin.service.ts` | Unified bin: list, restore, delete, empty |
| `src/media-library/services/category-zip.service.ts` | Folder zip stream |
| `src/media-library/services/alt-text.service.ts` | AI alt text |
| `src/media-library/services/library-ingest.service.ts` | Server-side uploads into the Library |
| `src/media-library/library-upload.controller.ts` | `/media/upload/*`, signed params, R2 presign |
| `src/media-library/library-zip.controller.ts`, `lib/zip-ticket.ts` | Ticket-gated zip download (no bearer) |
| `src/media-library/lib/bulk.ts` | ids-or-selectAll rule, chunking |
| `src/media-library/scripts/backfill-library-refs.ts`, `backfill-file-sizes.ts` | One-off owner scripts |
| `drizzle/migrations/0054_library_columns.sql`, `0055_posts_library_refs.sql` | Hand-written, idempotent |

---

### Task 1: Library services take the injected DB; library DB harness

**Files:**
- Modify: `src/media-library/services/{category,media-item,template,text-snippet,saved-link}.service.ts`
- Create: `src/media-library/testing/library-db.ts`, `src/media-library/testing/library-db.db.spec.ts`

**Interfaces:**
- Produces: each service drops `import { db } from '../../drizzle/db'` and takes `@Inject(DRIZZLE) private readonly db: DbType` as its FIRST constructor parameter (`DRIZZLE` from `src/drizzle/drizzle.module.ts`, `DbType` from `src/drizzle/db.ts`). Every `db.` becomes `this.db.`, and nothing else changes. Constructors: `CategoryService(db)`, `MediaItemService(db, cloudinaryService)`, `TemplateService(db)`, `TextSnippetService(db)`, `SavedLinkService(db)`.
- Produces (`library-db.ts`):
  - `LIBRARY_MIGRATIONS: string[]`, starting as `[]`. Tasks 5 and 6 append their files.
  - `describeLibraryDb = describeDb`.
  - `withLibraryDb<T>(fn: (db: DbType, client: PoolClient) => Promise<T>): Promise<T>` = `withRollbackDb(LIBRARY_MIGRATIONS, fn)`.
  - `applyMigrationAgain(client: PoolClient, file: string): Promise<void>` reads `drizzle/migrations/<file>` and runs it through `client.query`. Backfill tests seed legacy rows first and then call this.
  - Fixtures (raw SQL, random suffixes; re-export `seedWorkspace`, `seedMember`, `seedChannel` from `src/inbox/testing/inbox-db.ts`):
    - `seedMediaItem(client, i: SeedMediaItemInput): Promise<string>` where `SeedMediaItemInput { workspaceId: string; uploadedById: string; type?: 'image'|'video'|'gif'|'document'; name?: string; fileUrl?: string; thumbnailUrl?: string|null; mimeType?: string|null; fileSize?: number|null; width?: number|null; height?: number|null; tags?: string[]; isStarred?: boolean; isDeleted?: boolean; deletedAt?: Date|null; deletedById?: string|null; categoryId?: string|null; cloudinaryPublicId?: string|null; createdAt?: Date; usageCount?: number; lastUsedAt?: Date|null }`
    - `seedTemplate(client, { workspaceId, createdById, name?, templateType?, thumbnailUrl?, categoryId?, isDeleted?, deletedAt? }): Promise<string>`
    - `seedSnippet(client, { workspaceId, createdById, name?, snippetType?, content?, categoryId?, isDeleted?, deletedAt? }): Promise<string>`
    - `seedLink(client, { workspaceId, createdById, name?, url?, previewImageUrl?, categoryId?, isDeleted?, deletedAt? }): Promise<string>`
    - `seedCategory(client, workspaceId, type: string, name?: string, createdAt?: Date): Promise<string>`
    - `seedPost(client, { workspaceId, createdById, content?: string|null, mediaItems?: unknown[]|null, platformContent?: Record<string, unknown>|null, targets?: unknown[], status?: string, scheduledAt?: Date|null, publishedAt?: Date|null, metadata?: Record<string, unknown> }): Promise<string>`
    - `seedUsage(client, workspaceId, opts?: { storageBytesLimit?: number; extraStoragePurchased?: number }): Promise<void>` inserts `workspace_usage` (`channels_limit` 3, `members_limit` 1). It writes the storage columns only when given, so it compiles before Task 5.
    - `seedSubscription(client, userId, planCode: string): Promise<void>`
    - `seedCampaignSlot(client, { workspaceId, createdById, campaignName?, channelId?: string, media: { id: string; url?: string }[], postId?: string|null, scheduledAt?: Date|null, slotStatus?: string }): Promise<{ campaignId: string; slotId: string }>`
    - `seedEvergreenPost(client, { workspaceId, createdById, media: {id:string;url?:string}[], variationMedia?: {id:string;url?:string}[] }): Promise<{ campaignId: string; postId: string }>`

- [ ] **Step 1: Failing test** `library-db.db.spec.ts` (`describeLibraryDb`). Inside `withLibraryDb`, seed a workspace, one image, one post, one campaign slot and one evergreen post, then call `new MediaItemService(db, {} as CloudinaryService).findAll(workspaceId)`. Expect `total === 1` and `items[0].name` to be the seeded name. After the harness returns, a fresh `pg.Client` finds no `media_items` row with that name.
- [ ] **Step 2:** Run it. It fails: the `MediaItemService` constructor has no db parameter and the fixtures don't exist.
- [ ] **Step 3:** Make the services injectable as above and write `library-db.ts`.
- [ ] **Step 4:** Run → PASS. V. (`npx jest src/maestro/tools/library.tools.spec.ts src/chatbot` stays green.)
- [ ] **Step 5: Commit** `refactor(library): services take the injected db; library DB harness`

---

### Task 2: Fix the ignored tags filter and case-sensitive search (§6.3)

**Files:**
- Create: `src/media-library/lib/search.ts`, `search.spec.ts`, `src/media-library/services/library-query.db.spec.ts`
- Modify: `media-item.service.ts` (`findAll`), `template.service.ts`, `text-snippet.service.ts`, `saved-link.service.ts` (`findAll` search)

**Interfaces:**
- Produces: `ilikePattern(term: string): string` escapes `\`, `%` and `_` with a backslash and wraps the result in `%…%`. Use it with drizzle `ilike(column, pattern)` (Postgres's default LIKE escape character is `\`).
- `MediaItemService.findAll`:
  - A non-empty `tags` adds `sql\`${mediaItems.tags} @> ${JSON.stringify(tags)}::jsonb\`` (the item has every listed tag).
  - Search becomes `ilike(mediaItems.name, ilikePattern(search))` (D12).
- Templates search name and description, snippets name and content, links name, url and `preview_title`, all through `ilikePattern`.

- [ ] **Step 1: Failing tests**
  - `search.spec.ts`: `ilikePattern('50%_\\')` → `'%50\\%\\_\\\\%'`; `ilikePattern('Sale')` → `'%Sale%'`.
  - `library-query.db.spec.ts`:
    - Items A `tags ['launch','q4']`, B `['launch']`, C `[]`. `findAll(ws,{tags:['launch','q4']})` → only A, `total 1`. `{tags:['launch']}` → A and B, `total 2`.
    - Items "Summer SALE banner", "sale-50%-off", "sale_50x". `search:'sale'` → 3. `'50%'` → only "sale-50%-off". `'_50'` → only "sale_50x".
    - Template "Product Launch" is found by `'launch'`. Snippet content "Link In Bio" is found by `'in bio'`. Link url `https://Example.com/A` is found by `'example.com'`.
- [ ] **Step 2:** Run → FAIL (tags ignored; `like` is case-sensitive).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS. Mutation: drop the tags condition and the first tags case fails. V.
- [ ] **Step 5: Commit** `fix(library): tags filter applies; search is case-insensitive and escapes wildcards`

---

### Task 3: Permanent delete removes the file from the right store (§6.3)

**Files:**
- Create: `src/media-library/services/storage-object.service.ts`, `storage-object.service.spec.ts`, `src/media-library/services/media-item.purge.db.spec.ts`
- Modify: `src/media/cloudinary.service.ts` (`isOwnUrl`), `media-item.service.ts` (`permanentDelete`, bulk `permanentDelete`, `cleanupRecycleBin`), `media-library.module.ts` (provider)

**Interfaces:**
- Produces (`storage-object.service.ts`, injects `CloudinaryService`, `CloudflareR2Service`):
  - `type StorageProvider = 'cloudinary' | 'r2'`
  - `interface StoredFileRef { storageProvider?: StorageProvider; cloudinaryPublicId: string | null; fileUrl: string; type: string; mimeType: string | null }`
  - `providerOf(fileUrl: string, publicId: string | null): StorageProvider` returns `'r2'` when `r2.keyFromPublicUrl(fileUrl) !== null`, else `'cloudinary'` (D3).
  - `isOwnStorageUrl(url: string): boolean` = R2 public base or `cloudinary.isOwnUrl(url)`.
  - `deleteFile(ref: StoredFileRef): Promise<void>`. It is idempotent and throws only on a real failure.
    - R2: `r2.deleteObject(r2.keyFromPublicUrl(fileUrl) ?? cloudinaryPublicId)`.
    - Cloudinary: needs `cloudinaryPublicId`; without one there is nothing stored by us, so it resolves without a call. Otherwise `cloudinary.delete(publicId, cloudinaryResourceType(ref))`. A `false` result (Cloudinary reports "not found") counts as success.
  - `cloudinaryResourceType(ref): 'image' | 'video' | 'raw'` (exported): `video` → `'video'`; `document` with `mimeType === 'application/pdf'` or a URL ending `.pdf` → `'image'`; any other `document` → `'raw'`; everything else → `'image'`.
- Produces (`CloudinaryService`): `isOwnUrl(url: string): boolean`, true when the URL starts with `https://res.cloudinary.com/<CLOUDINARY_CLOUD_NAME>/`.
- Produces (`MediaItemService`, constructor `(db, cloudinaryService, storageObjects: StorageObjectService)`):
  - `purgeItems(rows: MediaLibraryItem[]): Promise<{ deletedIds: string[]; failedIds: string[] }>`. Deletes files at most 8 at a time (`PURGE_CONCURRENCY = 8`), then deletes only the rows whose file deletion succeeded. Failures are logged with id and error.
  - `purgeDeleted(scope: { workspaceId?: string; deletedBefore?: Date }): Promise<{ deleted: number; failed: number }>`. Walks deleted rows (`is_deleted = true`, plus the scope) keyset-style by `id` ascending, `PURGE_BATCH = 200` per page, always moving the cursor past the page's last id, so rows that fail never stall the loop. It stops on an empty page.
  - `permanentDelete` → `purgeItems([item])`. If it failed, throw `BadGatewayException('Could not delete the file from storage. Try again.')` and keep the row.
  - Bulk `permanentDelete` → `purgeItems(items)`. `bulkAction` now returns exactly `{ affectedCount }` (ruling 9): the number of rows actually changed or deleted. Failed ids are logged, not returned.
  - `cleanupRecycleBin(now = new Date())` → `purgeDeleted({ deletedBefore: now − 30 days })`, returns `{ deletedCount }`.

- [ ] **Step 1: Failing tests**
  - `storage-object.service.spec.ts` (mocked providers, `keyFromPublicUrl` returns the key for `https://pub.r2.dev/…` URLs only):
    - An R2 URL → `providerOf` is `'r2'`; `deleteFile` calls `deleteObject('composer/videos/w/u/1-a.mp4')` and never calls `cloudinary.delete`.
    - Cloudinary video → `delete(id,'video')`. PDF document → `'image'`. `.docx` document → `'raw'`. `delete` returning `false` → resolves.
    - `delete` throwing → rejects.
    - No public id and not R2 → resolves, no calls.
  - `media-item.purge.db.spec.ts`:
    - One R2 item and one Cloudinary item. The R2 delete rejects → `{deletedIds:[cloudinaryId], failedIds:[r2Id]}`, and the R2 row still exists.
    - `permanentDelete` on an R2 item calls `deleteObject` with its key and removes the row. When the delete rejects → `BadGatewayException` and the row stays.
    - `cleanupRecycleBin(now)` with 3 rows deleted 31 days before `now` and 1 deleted yesterday → `deletedCount 3`.
    - `purgeDeleted` with failing ids at positions 1 and 250 of 450 → `deleted 448, failed 2`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Register `StorageObjectService` in the module's providers and exports.
- [ ] **Step 4:** Run → PASS. Mutation: route every delete to Cloudinary and the R2 case fails. V.
- [ ] **Step 5: Commit** `fix(library): permanent delete removes R2 files too and keeps the row when storage refuses`

---

### Task 4: Bin type filter before paging; empty bin in batches with no cap (§6.3)

**Files:**
- Create: `src/media-library/services/recycle-bin.service.ts`, `recycle-bin.empty.db.spec.ts`
- Modify: `media-item.service.ts` (`getRecycleBin`), `media-library.controller.ts` (`getRecycleBin`, `emptyRecycleBin`), `media-library.module.ts`

**Interfaces:**
- Consumes: `MediaItemService.purgeDeleted` (Task 3).
- Produces:
  - `MediaItemService.getRecycleBin(workspaceId, limit = 50, offset = 0, type?: 'image'|'video'|'gif'|'document')` filters `type` in SQL. The controller passes it instead of filtering the page.
  - `RecycleBinService` (injects `DRIZZLE`, `MediaItemService`) `empty(workspaceId: string): Promise<{ deleted: number }>`: `purgeDeleted({ workspaceId })` for media, then one `DELETE … WHERE workspace_id = $1 AND is_deleted = true` each for templates, snippets and links. Re-running it is safe.
  - `emptyRecycleBin` returns `this.recycleBin.empty(workspaceId)`, i.e. `{ deleted }` (contract).

- [ ] **Step 1: Failing DB tests**
  - 3 deleted videos (deleted first) and 60 deleted images (deleted later). The controller `getRecycleBin(ws,{type:'video',limit:50})` returns `mediaItems.items.length === 3` and `total === 3`.
  - Bulk-insert 1203 deleted media rows, 1001 deleted snippets, 2 templates and 3 links with `generate_series` SQL. `empty` with the file deleter mocked to resolve → `{deleted: 2209}`, no deleted rows remain, a live row and another workspace's deleted rows are untouched.
  - The deleter rejects for 2 ids → `deleted` is 2 fewer and those rows remain. Run again with the deleter fixed → `{deleted: 2}`.
  - The deleter always rejects → the call terminates and returns the non-media count.
- [ ] **Step 2:** Run → FAIL (short page; 1000 cap).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS. V.
- [ ] **Step 5: Commit** `fix(library): bin filters by type before paging; empty bin has no cap and is safe to retry`

---

### Task 5: Migration 0054 — library columns, folder kinds, storage limits

**Files:**
- Create: `drizzle/migrations/0054_library_columns.sql`, `src/media-library/library-columns.db.spec.ts`, `src/billing/plan-storage.ts`
- Modify: `src/drizzle/schema/media-library.schema.ts`, `src/drizzle/schema/billing.schema.ts`, `src/media-library/testing/library-db.ts` (append the file; fixtures gain `storageProvider`, `altText`), `src/drizzle/migrate/inbox-lock-timeout.spec.ts` (add `0054_library_columns.sql` to `FILES`; rename the describe to `migrations bound their lock wait (I4)`), `media-item.service.ts` (`create` sets `storageProvider`)

**Interfaces:**
- `0054_library_columns.sql`, in order:
  1. `SET LOCAL lock_timeout = '10s';`
  2. `media_items`:
     - `ADD COLUMN IF NOT EXISTS alt_text text`
     - `storage_provider varchar(20) NOT NULL DEFAULT 'cloudinary'`
     - `page_count integer`
     - constraint `media_items_storage_provider_chk CHECK (storage_provider IN ('cloudinary','r2'))`
     - backfill: `UPDATE … SET storage_provider='r2' WHERE storage_provider='cloudinary' AND cloudinary_public_id LIKE 'composer/videos/%' AND file_url NOT LIKE 'https://res.cloudinary.com/%'` (D3)
  3. `UPDATE text_snippets SET snippet_type='signature' WHERE snippet_type='bio'`
  4. `saved_links`: `ADD COLUMN IF NOT EXISTS utm jsonb`, `preview_favicon_url text`
  5. `plans`:
     - `ADD COLUMN IF NOT EXISTS storage_bytes_per_workspace bigint NOT NULL DEFAULT 524288000`
     - then `UPDATE plans SET storage_bytes_per_workspace = v.b FROM (VALUES ('FREE',524288000),('BASIC',2147483648),('PRO',10737418240),('MAX',26843545600)) v(code,b) WHERE plans.code = v.code AND plans.storage_bytes_per_workspace <> v.b`
  6. `workspace_usage`:
     - `ADD COLUMN IF NOT EXISTS storage_bytes_limit bigint NOT NULL DEFAULT 524288000`
     - `extra_storage_purchased bigint NOT NULL DEFAULT 0`
     - backfill `storage_bytes_limit` = the plan value of `COALESCE(owner's subscriptions.plan_code, 'FREE')`, joining `workspace.owner_id → subscriptions.user_id → plans.code`, falling back to FREE's value when no plan row matches. `extra_storage_purchased` is never written by the migration.
  7. `media_categories` (D7): one CTE ranks legacy rows (`type IN ('image','gif','video','document')`) per `(workspace_id, name)` by kind rank (image 1, gif 2, video 3, document 4), then `created_at`, then `id`.
     - Rows with rank > 1 become `left(name, 100 - length(suffix)) || suffix`, with suffix ` (Images)|(GIFs)|(Videos)|(Docs)` by their old type.
     - `display_order` becomes `row_number() - 1` per workspace over (kind rank, `display_order`, `name`).
     - Then `type = 'media'`. Every step touches only legacy rows, so a second run is a no-op.
  - Header SAFETY notes: the media_items `ADD COLUMN … DEFAULT` is metadata-only (no rewrite); the data updates touch only legacy values. ROLLBACK lists the column drops and says the folder merge and `bio` rename are not reversible.
- Drizzle:
  - `mediaItems`: `altText: text('alt_text')`, `storageProvider: varchar('storage_provider',{length:20}).$type<StorageProvider>().notNull().default('cloudinary')`, `pageCount: integer('page_count')`.
  - `mediaCategories.type` is typed `FolderKind` (Task 8 defines the constant; type it as `string` here if Task 8 hasn't landed).
  - `savedLinks`: `utm: jsonb('utm').$type<SavedLinkUtm | null>()`, `previewFaviconUrl: text('preview_favicon_url')`, with `export interface SavedLinkUtm { source?: string; medium?: string; campaign?: string; term?: string; content?: string }`.
  - `TEXT_SNIPPET_TYPES = ['caption','hashtags','cta','signature','other']`.
  - `plans.storageBytesPerWorkspace` and `workspaceUsage.storageBytesLimit` / `extraStoragePurchased` as `bigint(…, { mode: 'number' })` with the same defaults.
  - Keep the `MEDIA_LIBRARY_TYPES` and `MediaLibraryType` exports unchanged (other modules import them).
- Produces (`src/billing/plan-storage.ts`): `export const PLAN_STORAGE_BYTES = { FREE: 524288000, BASIC: 2147483648, PRO: 10737418240, MAX: 26843545600 } as const;` and `export const FREE_STORAGE_BYTES = PLAN_STORAGE_BYTES.FREE;`.
- `MediaItemService.create` writes `storageProvider: this.storageObjects.providerOf(dto.fileUrl, dto.cloudinaryPublicId ?? null)`.

- [ ] **Step 1: Failing DB test** `library-columns.db.spec.ts`. Seed legacy rows, then `applyMigrationAgain(client,'0054_library_columns.sql')`.
  - The four `plans` rows (insert with `ON CONFLICT (code) DO NOTHING` if missing) equal `PLAN_STORAGE_BYTES`.
  - Owner on PRO → that workspace's `storage_bytes_limit` is `10737418240`. Owner with no subscription → `524288000`. A row whose `extra_storage_purchased` was set to 5 keeps 5.
  - Public id `composer/videos/w/u/1-a.mp4` with URL `https://pub-x.r2.dev/composer/videos/w/u/1-a.mp4` → `r2`. Public id `composer/canva/abc` with URL `https://res.cloudinary.com/demo/image/upload/v1/composer/canva/abc.png` → `cloudinary`.
  - A `bio` snippet → `signature`.
  - Folders image "Launch" (oldest), video "Launch", gif "Loops", document "Specs", template "T", link "L" become media "Launch", media "Launch (Videos)", media "Loops", media "Specs". T and L are unchanged. Media `display_order` is Launch 0, Loops 1, Launch (Videos) 2, Specs 3. An item in the old video folder keeps its `category_id`. A third apply leaves the names unchanged.
  - Inserting `storage_provider='s3'` raises `23514` (inside a SAVEPOINT).
  - `MediaItemService.create` with an R2 public URL stores `storage_provider = 'r2'`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Write the migration, schema and constant; append the file to `LIBRARY_MIGRATIONS`. **Step 4:** Run → PASS, plus `npx jest src/drizzle/migrate/inbox-lock-timeout.spec.ts` → PASS. Mutation: remove the `rank > 1` guard and the duplicate-name case fails. V.
- [ ] **Step 5: Commit** `feat(library): migration 0054 — alt text, storage provider, page count, folder kinds, per-plan storage`

---

### Task 6: Migration 0055 — post references and the usage-count trigger

**Files:**
- Create: `drizzle/migrations/0055_posts_library_refs.sql`, `src/media-library/library-usage-trigger.db.spec.ts`, `src/posts/dto/post.dto.library-item.spec.ts`
- Modify: `src/drizzle/schema/posts.schema.ts`, `src/posts/dto/post.dto.ts` (`MediaItemDto`), `src/posts/composer/types/draft.types.ts` (`DraftMediaItem`), `library-db.ts` (append the file), `inbox-lock-timeout.spec.ts` (`FILES` += `0055_posts_library_refs.sql`)

**Interfaces:**
- `0055_posts_library_refs.sql`:
  1. `SET LOCAL lock_timeout = '10s';`
  2. Generated columns. Header SAFETY: they rewrite `posts` under ACCESS EXCLUSIVE, so reads and writes on posts wait for the rewrite and the two GIN builds. Header DEPLOY GATE, verbatim:
     - Before deploying, the owner runs this read-only query in the Railway prod console: `SELECT count(*), pg_size_pretty(pg_total_relation_size('posts')) FROM posts;`
     - **Under 100,000 rows AND under 500 MB:** deploy without timing. The rewrite plus the index builds is expected well under 30 s.
     - **At or over either number:** first time this file on a restored copy of prod. If it holds the lock longer than 30 s, deploy in a low-traffic window.

     The expressions only use immutable functions (`jsonb_path_query_array` without `_tz`, `||`, `COALESCE`); lax `.**` may repeat a value, which containment ignores.
     ```sql
     ALTER TABLE posts ADD COLUMN IF NOT EXISTS library_refs jsonb GENERATED ALWAYS AS (
       jsonb_path_query_array(COALESCE(media_items, '[]'::jsonb), '$[*].libraryItemId')
       || jsonb_path_query_array(COALESCE(platform_content, '{}'::jsonb), '$.**.libraryItemId')
     ) STORED;
     ALTER TABLE posts ADD COLUMN IF NOT EXISTS media_urls jsonb GENERATED ALWAYS AS (
       jsonb_path_query_array(COALESCE(media_items, '[]'::jsonb), '$[*].url')
       || jsonb_path_query_array(COALESCE(platform_content, '{}'::jsonb), '$.**.mediaItems[*].url')
     ) STORED;
     ```
  3. Indexes:
     - `posts_library_refs_gin` GIN `(library_refs jsonb_path_ops)`
     - `posts_media_urls_gin` GIN `(media_urls jsonb_path_ops)`
     - `campaign_slot_content_media_gin` GIN `((content->'media') jsonb_path_ops)`
  4. Function `library_usage_on_post_change()` (plpgsql, `RETURNS trigger`). This is the algorithm; write it as given:
     ```text
     ws := workspace_id of NEW (INSERT/UPDATE) or OLD (DELETE)
     IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM workspace WHERE id = ws) THEN RETURN NULL  -- workspace cascade: skip
     PERFORM pg_advisory_xact_lock(hashtextextended('library-usage:' || ws::text, 0))  -- serialise recounts per workspace
     refs := old.library_refs (if not INSERT) || new.library_refs (if not DELETE), '[]' when absent; urls likewise from media_urls
     txt  := old and new (coalesce(content,'') || ' ' || coalesce(platform_content::text,'')), joined by ' '
     UPDATE media_items mi SET usage_count = (SELECT count(*) FROM posts p WHERE p.workspace_id = mi.workspace_id
               AND (p.library_refs @> jsonb_build_array(mi.id::text) OR p.media_urls @> jsonb_build_array(mi.file_url)))
      WHERE mi.workspace_id = ws
        AND (mi.id::text IN (SELECT jsonb_array_elements_text(refs)) OR mi.file_url IN (SELECT jsonb_array_elements_text(urls)));
     UPDATE saved_links l SET usage_count = (SELECT count(*) FROM posts p WHERE p.workspace_id = l.workspace_id
               AND strpos(coalesce(p.content,'') || ' ' || coalesce(p.platform_content::text,''), l.url) > 0)
      WHERE l.workspace_id = ws AND strpos(txt, l.url) > 0;
     UPDATE text_snippets s SET usage_count = (same count with btrim(s.content))
      WHERE s.workspace_id = ws AND char_length(btrim(s.content)) >= 3 AND strpos(txt, btrim(s.content)) > 0;
     RETURN NULL
     ```
     Each recount statement takes a fresh snapshot (volatile plpgsql under READ COMMITTED), so after the advisory lock it sees every committed post.
  5. Two triggers, because a WHEN clause can't reference OLD on INSERT. Each is preceded by its own `DROP TRIGGER IF EXISTS … ON posts;`, and both run `EXECUTE FUNCTION library_usage_on_post_change()`:
     - `posts_library_usage_ins_del`: `AFTER INSERT OR DELETE ON posts FOR EACH ROW`.
     - `posts_library_usage_upd`: `AFTER UPDATE OF media_items, platform_content, content ON posts FOR EACH ROW WHEN (OLD.media_items IS DISTINCT FROM NEW.media_items OR OLD.platform_content IS DISTINCT FROM NEW.platform_content OR OLD.content IS DISTINCT FROM NEW.content)`.
  6. One-time recount: set-based `UPDATE`s of `media_items.usage_count`, `saved_links.usage_count` and `text_snippets.usage_count`, using the same three count expressions over every row, writing only where `usage_count IS DISTINCT FROM` the count.
- Drizzle `posts`:
  - `libraryRefs: jsonb('library_refs').$type<string[]>().generatedAlwaysAs(sql\`…\`)` and `mediaUrls` with the same SQL text.
  - `MediaItem` gains `libraryItemId?: string`, and `DraftMediaItem` gains `libraryItemId?: string`.
  - `MediaItemDto` gains `@IsOptional() @IsUUID() libraryItemId?: string`. Without it the global `forbidNonWhitelisted` pipe rejects every legacy post carrying the field.

- [ ] **Step 1: Failing tests**
  - `library-usage-trigger.db.spec.ts`:
    - Generated columns: a post with `media_items [{url:U1,libraryItemId:I1},{url:U2}]` and `platform_content {instagram:{overrides:{mediaItems:[{url:U3,libraryItemId:I3}]}}, facebook:{mediaItems:[{url:U4}]}}` has `library_refs` (as a set) = {I1, I3} and `media_urls` = {U1..U4}. A post with null `media_items` and null `platform_content` has `[]` and `[]`.
    - Item X (`file_url` Ux). P1 references X by id only → X `usage_count` 1. P2 references it by URL only → 2. P3 references it by id in one entry and by URL in another → 3. P2's media is cleared → 2. P1 is deleted → 1.
    - Item Y in another workspace with URL Ux stays 0.
    - Set X's `usage_count = 99`, then `UPDATE posts SET status='scheduled'` on P3 → still 99 (the WHEN clause holds).
    - Link `https://shop.example/p`, post content `Buy https://shop.example/p?utm_source=ig` → link count 1. Editing the content to remove it → 0.
    - Snippet `#summer #sale` inside a post → 1. Snippet `ab` → 0.
    - Seed a stale `usage_count = 7` with one real reference, then `applyMigrationAgain('0055_posts_library_refs.sql')` → 1.
    - `DELETE FROM workspace WHERE id = ws` succeeds.
  - `post.dto.library-item.spec.ts`: `validate(plainToInstance(CreatePostDto, {…, mediaItems:[{url:'https://x/a.png', type:'image', libraryItemId:<uuid>}]}), {whitelist:true, forbidNonWhitelisted:true})` → no errors; `libraryItemId:'nope'` → one error.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; append the file to `LIBRARY_MIGRATIONS`. **Step 4:** Run → PASS. Also `npx jest src/posts src/campaigns src/drips src/first-week`: generated columns must never be written (drizzle skips `generatedAlwaysAs` on insert; any code that spreads a selected posts row into `insert`/`update` must still pass). Mutation: drop the `p.workspace_id = mi.workspace_id` filter and the item Y case fails. V.
- [ ] **Step 5: Commit** `feat(library): posts carry library refs; a trigger keeps usage counts as post counts (0055)`

---

### Task 7: Storage limit follows plan changes

**Files:**
- Modify:
  - `src/billing/services/limit-resolver.util.ts` (+spec), `usage-fanout.util.ts` (+spec)
  - `subscription-lookup.service.ts` (+`subscription-lookup.service.spec.ts`)
  - `subscription.service.ts` (the three `insert(workspaceUsage)` sites and the upsert's conflict `set`)
  - `src/workspace/workspace.service.ts` (usage insert)
  - `src/ai/services/ai-token.service.ts` (fallback usage insert)
  - `src/drizzle/seeds/plans.seed.ts`
  - every `PlanLimits` object literal (`grep -rn "queuedPostsPerChannel:" src`)

**Interfaces:**
- Consumes: `PLAN_STORAGE_BYTES`, `FREE_STORAGE_BYTES` (Task 5).
- Produces:
  - `PlanLimits.storageBytesPerWorkspace: number`
  - `ResolvedWorkspaceLimits.storageBytesLimit: number`: the plan value for primary AND non-primary workspaces (D6).
  - `WorkspaceLimitWrite.storageBytesLimit: number`
  - `getPlanLimits` returns `plan.storageBytesPerWorkspace`. `FREE_FALLBACK.storageBytesPerWorkspace = FREE_STORAGE_BYTES`.
  - `applyLimitsToAllWorkspaces` sets `storageBytesLimit`. That one call covers plan changes, scheduled changes, add-ons, resets to FREE and Lemon Squeezy, through its 14 callers.
  - The `subscription.service` upsert's conflict set gains `storageBytesLimit: sql\`excluded.storage_bytes_limit\``.
  - `workspace.service` inserts `storageBytesLimit: limits.storageBytesLimit`. The `ai-token.service` fallback inserts `storageBytesLimit: plan.storageBytesPerWorkspace`.
  - The seed writes `storageBytesPerWorkspace: PLAN_STORAGE_BYTES[code]` and adds it to its conflict set.

- [ ] **Step 1: Failing tests:**
  - `resolveWorkspaceLimits({...PRO, storageBytesPerWorkspace: 10737418240}, NO_ADDONS, true).storageBytesLimit === 10737418240`, and the same with `false`.
  - `buildUsageFanout` writes carry `storageBytesLimit`.
  - In `subscription-lookup.service.spec.ts` (follow its existing db mock), `applyLimitsToAllWorkspaces(user,'MAX',…)` passes `storageBytesLimit: 26843545600` to `set`, and `getPlanLimits` of an unknown code returns `storageBytesPerWorkspace: 524288000`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. Let `npm run build` find every literal. **Step 4:** `npx jest src/billing/services src/workspace src/ai/services` → green except the known billing.controller failure. V.
- [ ] **Step 5: Commit** `feat(billing): per-plan storage limit is written to workspace_usage on every limit change`

---

### Task 8: Folder kinds and snippet types in the API

**Files:**
- Create: `src/media-library/lib/folder-kind.ts`, `folder-kind.spec.ts`, `src/media-library/services/folder-kinds.db.spec.ts`
- Modify: `media-library.dto.ts` (category and snippet DTOs, new `ReorderCategoriesDto`), `category.service.ts`, `media-item.service.ts` (folder checks in `create`, `update`, bulk `move`), `text-snippet.service.ts`, `media-library.controller.ts` (`reorderCategories` body)

**Interfaces:**
- Produces (`folder-kind.ts`):
  - `FOLDER_KINDS = ['media','template','text_snippet','link'] as const`, `type FolderKind`
  - `MEDIA_ITEM_TYPES = ['image','video','gif','document'] as const`, `type MediaType`
  - `normalizeFolderKind(input: unknown): unknown` maps `image|video|gif|document` → `'media'` and passes anything else through for the validator.
  - `normalizeSnippetType(input: unknown): unknown` maps `'bio'` → `'signature'`.
- DTOs:
  - `CreateCategoryDto.type` and `CategoryQueryDto.type`: `@Transform(({value}) => normalizeFolderKind(value)) @IsIn(FOLDER_KINDS)`.
  - `UpdateCategoryDto.type?: FolderKind` (same decorators, per the contract's "`PUT categories/:id` takes `type`"). A kind different from the folder's current kind → 400 `A folder's kind cannot change`, because the folder's items would end up in the wrong tab.
  - `ReorderCategoriesDto { type: FolderKind (same decorators); categoryIds: string[] (@IsArray @IsUUID('all',{each:true})) }`.
  - Snippet `snippetType` fields: `@Transform(normalizeSnippetType) @IsIn(TEXT_SNIPPET_TYPES)`. `TextSnippetQueryDto` adds `type` (same decorators); `type` wins over `snippetType`.
- Services:
  - An item may be filed only into a folder whose `type === 'media'`. Otherwise 400 with the message `Folder "<name>" is not a media folder`. The check lives in `MediaItemService.assertMediaFolder(workspaceId: string, categoryId: string): Promise<void>` (404 `Folder not found` when the folder isn't in the workspace). `create`, `update` and bulk `move` call it, and Task 15 calls it before uploading.
  - `CategoryService.create` checks for a duplicate name per `(workspace, kind)`.
  - `findAllGroupedByType` returns `Record<FolderKind, MediaCategory[]>`.

- [ ] **Step 1: Failing tests:**
  - `folder-kind.spec.ts` (`it.each`): image/video/gif/document → media; template → template; media → media; `'bio'` → `'signature'`.
  - DB spec:
    - A category posted with type `image` is stored as `media`.
    - An image and a video both go into one media folder.
    - An image filed into a template folder → 400.
    - A bulk move of image + gif into a media folder succeeds.
    - A snippet created with `snippetType:'bio'` is stored as `signature`. `findAll({type:'signature'})` and `findAll({snippetType:'bio'})` both return it.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. V.
- [ ] **Step 5: Commit** `feat(library): one folder kind per tab; signatures replace bio (legacy values still accepted)`

---

### Task 9: Reference test, `GET items/:id/usage`, and `use` only marks recency

**Files:**
- Create: `src/media-library/dto/contract.ts`, `src/media-library/lib/usage-sql.ts`, `usage-sql.spec.ts`, `src/media-library/services/media-usage.service.ts`, `media-usage.db.spec.ts`
- Modify: `media-item.service.ts` (`incrementUsage` → `markUsed`), `text-snippet.service.ts`, `saved-link.service.ts` (same rename and behaviour), `media-library.controller.ts`, `remaining-workspace-guards.spec.ts`, `media-library.module.ts`

**Interfaces:**
- Produces (`contract.ts`): verbatim from the contract — `FolderKind`, `MediaType`, `SnippetType`, `BinKind`, `Ratio`, `MediaSort`, `StorageProvider`, `UserRef`, `Page<T>`, `UsageEntry`, `LibraryStats`, `BinRow`, `FolderStats` (`{ itemCount: number; bytes: number; covers: string[] }`). Re-export `FolderKind`/`MediaType` from `folder-kind.ts` rather than duplicating them.
- Produces (`usage-sql.ts`):
  - `itemReferencedSql(item: { id: AnyColumn | SQL; fileUrl: AnyColumn | SQL; workspaceId: AnyColumn | SQL }): SQL` (D4):
    ```sql
    EXISTS (SELECT 1 FROM posts p WHERE p.workspace_id = <ws>
            AND (p.library_refs @> jsonb_build_array(<id>::text) OR p.media_urls @> jsonb_build_array(<url>)))
    OR EXISTS (SELECT 1 FROM campaign_slot_content s JOIN campaigns c ON c.id = s.campaign_id
            WHERE c.workspace_id = <ws> AND s.post_id IS NULL
            AND (s.content->'media' @> jsonb_build_array(jsonb_build_object('id', <id>::text))
              OR s.content->'media' @> jsonb_build_array(jsonb_build_object('url', <url>))))
    OR EXISTS (SELECT 1 FROM campaign_evergreen_posts e JOIN campaigns c ON c.id = e.campaign_id
            WHERE c.workspace_id = <ws>
            AND jsonb_path_exists(jsonb_build_array(e.content->'media', e.variations),
                  'lax $.**.media[*] ? (@.id == $id || @.url == $url)', jsonb_build_object('id', <id>::text, 'url', <url>))
              OR e.content->'media' @> jsonb_build_array(jsonb_build_object('id', <id>::text))
              OR e.content->'media' @> jsonb_build_array(jsonb_build_object('url', <url>)))
    ```
  - `usageStatusOfPost(status: string): UsageEntry['status']`: draft→draft; scheduled|publishing→scheduled; published|partially_published→published; failed→failed; anything else→draft.
  - `usageStatusOfSlot(status: string): UsageEntry['status']`: pending|scheduled|publishing→scheduled; published→published; failed→failed; skipped→draft.
- Produces: `MediaUsageService.getUsage(workspaceId: string, itemId: string): Promise<{ items: UsageEntry[]; total: number }>`. Throws 404 when the item isn't in the workspace. It runs one `UNION ALL` of three sources, newest first by `date` then `id`, `LIMIT 20`, with `total` counted over the same union:
  - Posts: `kind 'post'`, `title = left(coalesce(nullif(btrim(metadata->>'title'),''), nullif(split_part(btrim(coalesce(content,'')), E'\n', 1),''), 'Untitled post'), 120)`, `platform = coalesce(targets->0->>'platform','')` (D9), `date = coalesce(published_at, scheduled_at, updated_at)`.
  - Unmaterialised campaign slots: `kind 'campaign_slot'`, title = campaign name, platform from `social_media_channels` where `id::text = s.channel_id`, `date = coalesce(s.scheduled_at, s.created_at)`.
  - Evergreen pool entries: `kind 'campaign_slot'`, title = campaign name, platform of the first channel in the category's `channel_ids`, `date = coalesce(e.last_published_at, e.created_at)`, status `scheduled`.
  - Status mapping happens in TS with the two mappers. `date` is an ISO string.
- Produces: `MediaItemService.markUsed(workspaceId, itemId)` sets only `last_used_at` and `updated_at`, and 404s outside the workspace. `TextSnippetService.markUsed` and `SavedLinkService.markUsed` do the same (D13). The controller's `record*Usage` handlers call them.
- Route: `GET items/:itemId/usage` → `getMediaItemUsage`, `posts:draft`.

- [ ] **Step 1: Failing tests**
  - `usage-sql.spec.ts`: both mappers, table-driven, with every value above.
  - `media-usage.db.spec.ts`:
    - Item X. P1 is published and references X by id. P2 is a draft referencing it by URL. P3 is in another workspace with the same URL. A pending campaign slot has `media [{id:'m1', url: Ux}]`. A slot with `post_id` set references it too. An evergreen variation holds `{id: X}`.
    - → `total 4`, items ordered by date desc, P1 `status 'published'` with title = its first content line and `platform` = its first target's.
    - 25 referencing posts → `items.length 20`, `total 25+`.
    - `SELECT <itemReferencedSql> ` for X → true; for an unreferenced item → false.
    - `markUsed` leaves `usage_count` unchanged and sets `last_used_at`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement and add the handler to the guards spec. **Step 4:** PASS. Mutation: drop `s.post_id IS NULL` and the materialised-slot case double counts. V.
- [ ] **Step 5: Commit** `feat(library): Used in posts endpoint; one reference test for posts and campaigns; use marks recency only`

---

### Task 10: Storage quota and `GET stats`

**Files:**
- Create: `src/media-library/lib/storage.ts`, `storage.spec.ts`, `src/media-library/services/storage-quota.service.ts`, `library-stats.service.ts`, `library-stats.db.spec.ts`
- Modify: `media-library.controller.ts`, `media-library.module.ts`, `remaining-workspace-guards.spec.ts`

**Interfaces:**
- Produces (`storage.ts`):
  - `STORAGE_ALMOST_FULL_PERCENT = 90`
  - `storagePercent(used: number, limit: number): number`: one decimal, capped at 100. `limit <= 0` → 100 if `used > 0`, else 0.
  - `storageLevel(used, limit): 'ok' | 'almost_full' | 'full'`: full when `limit <= 0 || used >= limit`; almost_full when `used / limit >= 0.9`.
  - `wouldExceed(used, incoming, limit): boolean` = `used + Math.max(incoming, 1) > limit`.
  - `interface StorageUsage { used: number; limit: number }`
  - `class StorageFullException extends HttpException`, constructed with a `StorageUsage`. Status 413, body `{ code: 'STORAGE_FULL', message: 'Storage is full. Free up space or upgrade your plan.', used, limit }`.
- Produces (`StorageQuotaService`, injects `DRIZZLE`):
  - `getUsage(workspaceId: string, db: DbType = this.db): Promise<StorageUsage>`:
    - `used` = `SUM(COALESCE(file_size,0))` over ALL of the workspace's `media_items` (bin included).
    - `limit` = `COALESCE((wu.storage_bytes_limit + wu.extra_storage_purchased), owner's plan storage_bytes_per_workspace, FREE plan's value, 524288000)` in one query.
  - `assertCanStore(workspaceId, incomingBytes, db?): Promise<StorageUsage>` throws `StorageFullException` when `wouldExceed`.
  - `runLocked<T>(workspaceId, fn: (tx: DbType) => Promise<T>): Promise<T>` = `this.db.transaction(async tx => { await tx.execute(sql\`SELECT pg_advisory_xact_lock(hashtextextended(${'library-storage:' + workspaceId}, 0))\`); return fn(tx as unknown as DbType); })`.
- Produces: `LibraryStatsService.getStats(workspaceId): Promise<LibraryStats>`.
  - Aggregates use `FILTER` clauses: one statement over `media_items` (`itemReferencedSql` for unused), one each for templates, snippets, links and folders, plus `getUsage`.
  - `bin.count` covers all four kinds, `bin.bytes` media only.
  - `counts.snippets.all` includes `other`.
- Route: `GET stats` → `getLibraryStats`, `posts:draft`.

- [ ] **Step 1: Failing tests**
  - `storage.spec.ts` (`it.each`):
    - percent: `(0,100)`→0, `(45,100)`→45, `(899,1000)`→89.9, `(1500,1000)`→100, `(5,0)`→100, `(0,0)`→0
    - level: `(899,1000)` ok, `(900,1000)` almost_full, `(1000,1000)` full, `(1200,1000)` full, `(0,0)` full
    - `wouldExceed`: `(0,10,10)` false, `(0,11,10)` true, `(10,0,10)` true, `(9,0,10)` false
    - `new StorageFullException({used:9,limit:10}).getStatus() === 413` and the body equals the shape above
  - `library-stats.db.spec.ts`:
    - `getUsage`: items of 100, 50 (deleted) and null bytes → `used 150`; a usage row of 1000 + 200 extra → `limit 1200`; no usage row with a PRO subscription → `10737418240`; no row and no subscription → `524288000`.
    - `runLocked`: inside `fn`, `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()` ≥ 1.
    - `getStats`, seeded with:
      - images of 100 bytes (starred) and 200, a gif of 50, a video of 1000 referenced by a post, a document of 10, a deleted image of 500
      - templates post ×2 and story ×1, plus a deleted reel
      - snippets caption, signature and other
      - two links, one deleted
      - folders: two media, one link
      - usage limit 10000

      It `toEqual`s:
      ```ts
      { storage: { used: 1860, limit: 10000, percent: 18.6, level: 'ok', byType: { images: 350, videos: 1000, docs: 10 } },
        unused: { count: 4, bytes: 360 }, bin: { count: 3, bytes: 500 },
        counts: { media: { all: 5, images: 3, videos: 1, docs: 1 },
                  templates: { all: 3, post: 2, story: 1, reel: 0, carousel: 0 },
                  snippets: { all: 3, caption: 1, hashtags: 0, cta: 0, signature: 1 },
                  links: 1, folders: { media: 2, template: 0, text_snippet: 0, link: 1 } } }
      ```
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. V.
- [ ] **Step 5: Commit** `feat(library): storage quota service and one stats call for chips, popover and banners`

---

### Task 11: Folder stats, folder search and folder zip

**Files:**
- Create: `src/media-library/lib/zip-names.ts`, `zip-names.spec.ts`, `src/media-library/lib/zip-ticket.ts`, `zip-ticket.spec.ts`, `src/media-library/services/category-zip.service.ts`, `category-zip.service.spec.ts`, `src/media-library/library-zip.controller.ts`, `library-zip.controller.spec.ts`, `src/media-library/services/category-stats.db.spec.ts`
- Modify: `media-library.dto.ts` (`CategoryQueryDto`), `category.service.ts` (`findAll`), `media-library.controller.ts`, `remaining-workspace-guards.spec.ts` (`createCategoryZipTicket: 'posts:draft'`), `src/workspace-members/every-workspace-route-guarded.spec.ts` (one `OPEN_ROUTES` entry), `media-library.module.ts` (the new controller), `.env.example`, `package.json` / `package-lock.json` (`npm install yazl@^3` and `npm install -D @types/yazl`)

**Interfaces:**
- `CategoryQueryDto` gains `withStats?: boolean` (`'true'` transform) and `search?: string`.
- `CategoryService.findAll(workspaceId, query): Promise<(MediaCategory & { stats?: FolderStats })[]>`.
  - `search` → `ilike(name, ilikePattern(search))`.
  - `withStats` runs ONE statement: `media_categories` left-joined to four `LATERAL` aggregates, each guarded by `c.type = '<kind>'`.
  - Media folders: live item count, `SUM(file_size)`, covers = `(array_agg(cover ORDER BY created_at DESC) FILTER (WHERE cover IS NOT NULL))[1:4]` with `cover = COALESCE(thumbnail_url, CASE WHEN type IN ('image','gif') THEN file_url END)`.
  - Template folders: count, `bytes 0`, covers from `thumbnail_url`. Link folders: count, `bytes 0`, covers from `preview_image_url`. Snippet folders: count, `bytes 0`, `covers []`.
- Produces: `zipEntryNames(items: { name: string; mimeType: string | null; fileUrl: string }[]): string[]`.
  - Unsafe characters `/\:*?"<>|` become `_`.
  - The extension comes from the mime type (`image/jpeg`→`.jpg`, `image/png`, `image/gif`, `image/webp`, `video/mp4`, `video/quicktime`→`.mov`, `application/pdf`), else from the URL path, lowercased. It isn't added again when the name already ends with it.
  - Later duplicates become `Name (2).ext`, `Name (3).ext`, and so on.
- Produces: `CategoryZipService.streamZip(workspaceId: string, categoryId: string, res: Response): Promise<void>`.
  - 404 when the folder isn't in the workspace. 400 when it isn't a media folder.
  - 413 `{code:'ZIP_TOO_LARGE', message:'This folder is over 2 GB. Download fewer files at a time.'}` when the live items' `SUM(file_size) > 2147483648`, checked before any header is written.
  - Sets `Content-Type: application/zip` and `Content-Disposition: attachment; filename="<sanitized folder name>.zip"`, then pipes a `yazl.ZipFile` to `res`.
  - For each live item in `created_at` order, only when `storageObjects.isOwnStorageUrl(fileUrl)`: `fetch` it, `zip.addReadStream(Readable.fromWeb(body), name, { compress: false })`, and wait for that stream's `end` before fetching the next one (never more than one download open).
  - Skipped or failed files are listed in a final `_skipped.txt` entry. Then `zip.end()`.
- Produces (`src/media-library/lib/zip-ticket.ts`, ruling 8):
  - `ZIP_TICKET_TTL_MS = 5 * 60 * 1000`
  - `interface ZipTicketPayload { workspaceId: string; categoryId: string; userId: string; exp: number /* epoch ms */ }`
  - `signZipTicket(p: Omit<ZipTicketPayload,'exp'>, secret: string, now: Date): { ticket: string; expiresAt: string }`. The ticket is `base64url(JSON payload) + '.' + base64url(HMAC-SHA256(secret, that first part))`.
  - `verifyZipTicket(ticket: string, secret: string, now: Date): ZipTicketPayload | null`. It compares signatures with `timingSafeEqual` (equal lengths first) and returns `null` for any malformed input, a bad signature, or `now.getTime() > exp`.
- Routes:
  - `POST categories/:categoryId/zip-ticket` on `MediaLibraryController` → `createCategoryZipTicket`, `posts:draft`.
    - Runs the same 404/400/413 folder checks as `streamZip` first. Those live in `CategoryZipService.assertZippable(workspaceId, categoryId): Promise<void>`, which `streamZip` also calls.
    - 503 when `LIBRARY_ZIP_TICKET_SECRET` is unset.
    - Returns `{ url: \`${API_PUBLIC_URL}/workspaces/${ws}/media-library/categories/${id}/zip?ticket=${encodeURIComponent(ticket)}\`, expiresAt }`.
  - `GET categories/:categoryId/zip` → `downloadCategoryZip` on a NEW `src/media-library/library-zip.controller.ts`: `@Controller('workspaces/:workspaceId/media-library')` with no guards, because a browser navigation can't carry the in-memory bearer token.
    - Returns 401 `{code:'INVALID_TICKET', message:'This download link is invalid or has expired.'}` in any of these cases:
      - the ticket is missing
      - `verifyZipTicket` returns null
      - the payload's `workspaceId`/`categoryId` differ from the path
      - `access.assertCan(ws, payload.userId, 'posts:draft')` rejects (a removed member)
    - Otherwise it runs `streamZip(ws, id, res)` via `@Res()`.
  - `every-workspace-route-guarded.spec.ts` `OPEN_ROUTES` gains `'GET /workspaces/:workspaceId/media-library/categories/:categoryId/zip'` with the reason: "folder zip download: a browser navigation cannot carry the in-memory bearer token; access is a 5-minute HMAC ticket minted by the posts:draft-gated zip-ticket route, and the ticket's user is re-checked for posts:draft".
  - `.env.example` gains `LIBRARY_ZIP_TICKET_SECRET=` with a comment saying to generate it with `openssl rand -hex 32`.

- [ ] **Step 1: Failing tests**
  - `zip-ticket.spec.ts`:
    - A round trip returns the payload.
    - `expiresAt` = now + 5 min.
    - Valid at +4:59. `null` at +5:00.001.
    - A flipped payload character → `null`. Another secret → `null`.
    - `''`, `'a.b.c'` and `'!!.??'` → `null`.
  - `library-zip.controller.spec.ts` (`Object.create(prototype)` style):
    - No ticket, an expired ticket, a ticket for another folder, and a ticket whose user `assertCan` rejects → each 401, and `streamZip` is never called.
    - A valid ticket → `streamZip(ws, id, res)`.
    - `createCategoryZipTicket` with the secret unset → 503. With it set → the `url` contains `/categories/<id>/zip?ticket=`.
  - `zip-names.spec.ts`: `[{name:'Hero',mimeType:'image/png'}, {name:'Hero',mimeType:'image/png'}, {name:'Clip',mimeType:null,fileUrl:'https://x/y/clip.MP4?v=1'}, {name:'a/b:c',mimeType:'image/jpeg'}, {name:'Hero.png',mimeType:'image/png'}]` → `['Hero.png','Hero (2).png','Clip.mp4','a_b_c.jpg','Hero (3).png']`.
  - `category-stats.db.spec.ts`:
    - A media folder with 6 items, one deleted, and a video without a thumbnail → `itemCount 5`, `bytes` = the sum of the 5, `covers` = the 4 newest covers newest first, the thumbnail-less video excluded.
    - A template folder gets covers from template thumbnails. A link folder gets covers from preview images. A snippet folder has `covers []`.
    - `search:'lau'` finds "Launch". Without `withStats` there is no `stats` key.
  - `category-zip.service.spec.ts` (mocked db rows, `fetch`, and a collecting `Writable` as `res`):
    - The output starts with `PK\x03\x04` and contains both entry names as bytes.
    - A foreign-host item is listed in `_skipped.txt`.
    - The header is `attachment; filename="Launch.zip"`.
    - Total bytes `2147483649` → 413 `ZIP_TOO_LARGE` and `fetch` is never called.
    - A template folder → 400.
- [ ] **Step 2:** FAIL. **Step 3:** Install `yazl`; implement. **Step 4:** PASS. V.
- [ ] **Step 5: Commit** `feat(library): folder stats in one query, folder search, and ticketed folder zip download`

---

### Task 12: List queries, uploader, alt text field, select-all bulk for every kind

**Files:**
- Create: `src/media-library/lib/ratio.ts`, `ratio.spec.ts`, `src/media-library/lib/user-ref.ts`, `user-ref.spec.ts`, `src/media-library/lib/bulk.ts`, `bulk.spec.ts`
- Modify: `media-library.dto.ts` (`MediaItemQueryDto`, `CreateMediaItemDto`, `UpdateMediaItemDto`, `BulkActionDto`, `TemplateQueryDto`, `TextSnippetQueryDto`, new `TemplateBulkDto`/`SnippetBulkDto`/`LinkBulkDto`), `media-item.service.ts`, `template.service.ts`, `text-snippet.service.ts`, `saved-link.service.ts`, `media-library.controller.ts`, `remaining-workspace-guards.spec.ts`, `library-query.db.spec.ts` (from Task 2)

**Interfaces:**
- `MediaItemQueryDto` adds:
  - `type` also accepts `'images'`
  - `starred` (bool), `neverUsed` (bool), `gifOnly` (bool)
  - `ratio` (`@IsIn(['1:1','4:5','9:16','16:9'])`)
  - `addedSince` (`@IsISO8601()`)
  - `uploadedBy` (`@IsUUID()`)
  - `sort` (`@IsIn(['newest','most_used','recently_used','name','size'])`)
  - It keeps every legacy field. `starred` wins over `isStarred`, and `sort` wins over `sortBy`/`sortOrder`.
- Produces: `RATIO_TOLERANCE = 0.03`, `ratioBounds(r: Ratio): { min: number; max: number }` = `target × (1 ∓ 0.03)`, with targets 1, 0.8, 0.5625 and 16/9.
- Produces: `toUserRef(row: { id: string; name: string | null; email: string; avatarUrl: string | null } | null): UserRef | null`. A null name falls back to the email's local part.
- Produces: `MediaItemService.buildItemConditions(workspaceId: string, query: MediaItemQueryDto): SQL[]`, used by `findAll` and bulk select-all:
  - `images` → `type IN ('image','gif')`; `gifOnly` → `type = 'gif'`
  - `ratio` → `width > 0 AND height > 0 AND width >= min*height AND width <= max*height`
  - `addedSince` → `created_at >= …`
  - `uploadedBy` → `uploaded_by_id = …`
  - `neverUsed` → `NOT (itemReferencedSql(…))`
- Sort orders, each ending in `id DESC` for stability:
  - `newest`: `created_at DESC`
  - `most_used`: `usage_count DESC NULLS LAST, created_at DESC`
  - `recently_used`: `last_used_at DESC NULLS LAST, created_at DESC`
  - `name`: `lower(name) ASC, created_at DESC`
  - `size`: `file_size DESC NULLS LAST, created_at DESC`
- Produces: `type MediaItemView = MediaLibraryItem & { category: MediaCategory | null; uploadedBy: UserRef | null }`. `findAll` returns `Page<MediaItemView>` and `findOne` returns `MediaItemView` (left join `users` on `uploaded_by_id`).
- `UpdateMediaItemDto.altText?: string | null` (`@IsOptional() @ValidateIf(v => v !== null) @IsString() @MaxLength(1000)`). `CreateMediaItemDto` adds `altText?: string` and `pageCount?: number` (`@IsInt() @Min(1)`). `update` writes `altText`, and `create` writes both.
- `BulkActionDto`: `ids?: string[]` (`@ArrayMaxSize(500)`), `selectAll?: BulkSelectAllDto` where `BulkSelectAllDto { @ValidateNested() @Type(() => MediaItemQueryDto) filter: MediaItemQueryDto }`. Exactly one of the two is required; otherwise 400 `Send ids or selectAll, not both`. Select-all resolves ids with `buildItemConditions` (ignoring `limit`/`offset`) and runs the action in chunks of 500. The response is exactly `{ affectedCount }` (ruling 9).
- Produces (`lib/bulk.ts`):
  - `assertIdsXorSelectAll(dto: { ids?: string[]; selectAll?: unknown }): void` throws the 400 above.
  - `chunk<T>(xs: T[], size = 500): T[][]`.

  Items, templates, snippets and links bulk all use both.
- Templates and snippets (ruling 7):
  - `TemplateQueryDto` and `TextSnippetQueryDto` add `starred` (bool) and `sort` (`@IsIn(['newest','most_used','recently_used','name'])`). They keep `isStarred`; `starred` wins.
  - Orders are the same four as items, each ending in `id DESC`. For templates, `usage_count` is still a pick count (D13).
  - `TemplateService.buildTemplateConditions(ws, query): SQL[]`, `TextSnippetService.buildSnippetConditions(ws, query): SQL[]` and `SavedLinkService.buildLinkConditions(ws, query): SQL[]` are extracted from each `findAll`, which now uses them.
- Bulk for the other kinds (ruling 6):
  - DTOs: `TemplateBulkDto`, `SnippetBulkDto`, `LinkBulkDto` = `{ ids?: string[] (@ArrayMaxSize(500) @IsUUID each); selectAll?: { filter: <TemplateQueryDto | TextSnippetQueryDto | SavedLinkQueryDto> }; action: 'delete' | 'star' | 'unstar' | 'move' (@IsIn); categoryId?: string | null }`.
  - Services: `TemplateService.bulkAction(ws, userId, dto)`, `TextSnippetService.bulkAction`, `SavedLinkService.bulkAction`, each `Promise<{ affectedCount: number }>`:
    - `delete` soft-deletes (`is_deleted`, `deleted_at`, `deleted_by_id = userId`).
    - `move` needs `categoryId !== undefined` (null unfiles). The folder must be this kind's (`template`, `text_snippet` or `link`), else 400.
    - Ids outside the workspace → 400 `Some items not found`, as `items/bulk` does.
  - Routes, all `posts:draft`: `POST templates/bulk` → `bulkTemplates`, `POST snippets/bulk` → `bulkTextSnippets`, `POST links/bulk` → `bulkSavedLinks`.

- [ ] **Step 1: Failing tests**
  - `ratio.spec.ts`: `'4:5'` → `{min: 0.776, max: 0.824}`; `'16:9'` → `{min: 1.72444, max: 1.83111}` (`toBeCloseTo`, 4).
  - `user-ref.spec.ts`: `{name:null,email:'sam@x.io'}` → name `'sam'`; `null` → `null`.
  - `library-query.db.spec.ts` additions:
    - `type:'images'` → image and gif, no video. `gifOnly` → gif only.
    - `ratio:'4:5'` matches 1080×1350 and 1080×1349, but not 1080×1080 or a row with null dimensions.
    - `addedSince` and `uploadedBy` filter.
    - `neverUsed` excludes a post-referenced item and a slot-referenced item.
    - `sort:'size'` orders 300, 100, then null. `sort:'recently_used'` puts nulls last. Legacy `sortBy:'lastUsedAt'` still works.
    - Rows carry `uploadedBy: {id, name, avatarUrl}`.
    - `update(…, {altText:'A cat'})` then `{altText:null}` clears it.
    - 120 images match `{type:'image', starred:false}`. Bulk `star` with `selectAll` → exactly `{affectedCount: 120}`, all starred, and a video is untouched. Sending both `ids` and `selectAll` → 400. Sending neither → 400.
    - Templates: `sort:'name'` is ascending, `starred:true` returns only starred ones, and `sort:'recently_used'` puts nulls last. Snippets: the same three cases.
    - Template bulk `move` into a template folder → `{affectedCount: 2}`; into a link folder → 400.
    - Snippet bulk `delete` with `selectAll:{filter:{type:'caption'}}` soft-deletes only the captions and sets `deleted_by_id`.
    - Link bulk `star` with `ids` → `{affectedCount: n}`. A foreign workspace's id → 400.
  - `bulk.spec.ts`: both present → throws, neither → throws, either one alone → passes; `chunk` of 1001 → sizes `[500, 500, 1]`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement and add the three handlers to the guards spec. **Step 4:** PASS. V.
- [ ] **Step 5: Commit** `feat(library): item filters, size sort, uploader, alt text field; sort, starred and select-all bulk for templates, snippets and links`

---

### Task 13: Write alt text with AI

**Files:**
- Create: `src/media-library/lib/vision.ts`, `vision.spec.ts`, `src/media-library/services/alt-text.service.ts`, `alt-text.service.spec.ts`
- Modify: `src/chatbot/llm/gemini.provider.ts` (`generateFromImage`), `src/ai/ai-text.service.ts` (`describeImage`, +spec case), `src/ai/services/ai-token.service.ts` (`AI_OPERATION_COSTS.generate_alt_text = 2`), `media-library.module.ts` (import `AiModule`), `media-library.controller.ts`, `remaining-workspace-guards.spec.ts`

**Interfaces:**
- Produces:
  - `GeminiChatProvider.generateFromImage(systemPrompt: string, userPrompt: string, image: { mimeType: string; data: string /* base64 */ }, opts?: { temperature?: number; maxTokens?: number }): Promise<string>` uses the default model with `generateContent([{ inlineData: image }, userPrompt])`.
  - `AiTextService.describeImage(systemPrompt, userPrompt, image, opts?)`: Gemini when it is available, otherwise `ServiceUnavailableException('AI is not configured')` (D1).
- Produces (`vision.ts`):
  - `visionImageUrl(fileUrl: string): string`: in a Cloudinary `/image/upload/` URL, insert `f_jpg,w_1024,c_limit/` right after `/upload/`; anything else is returned unchanged.
  - `cleanAltText(raw: string): string`: trims, strips wrapping quotes and a leading `Alt text:`, `Image of ` or `Picture of ` (case-insensitive), collapses whitespace, and caps at 250 characters on a word boundary.
  - `ALT_TEXT_SYSTEM_PROMPT` = `"You write alt text for images that will be posted on social media. Describe what matters to someone who cannot see the image: the subject, the action, and any visible text. One sentence, at most 125 characters. Do not start with 'Image of' or 'Picture of'. Reply with the alt text only."`, and the user prompt `"Write alt text for this image."`
- Produces: `AltTextService.generate(workspaceId: string, userId: string, itemId: string): Promise<{ altText: string }>`. It never saves.
  - 404 when the item isn't in the workspace.
  - 422 `{code:'NOT_AN_IMAGE', message:'Alt text can only be written for images stored in the Library.'}` when `type` isn't `image` or `gif`, or `!storageObjects.isOwnStorageUrl(fileUrl)`.
  - 402 `{code:'AI_TOKENS_EXHAUSTED', message}` when `aiTokens.checkTokens(ws,'generate_alt_text').hasAccess` is false. No model call is made.
  - Otherwise `aiTokens.executeWithTokens(ws, userId, 'generate_alt_text', undefined, \`alt text: ${name}\`, …)`: fetch `visionImageUrl(fileUrl)` (15 s timeout, refused over 8 MB or when the content type isn't `image/*`, both → 422), then `describeImage` with `maxTokens: 120`, then `cleanAltText`.
- Route: `POST items/:itemId/alt-text` → `generateMediaItemAltText`, `posts:draft`, returns `{ altText }`.

- [ ] **Step 1: Failing tests**
  - `vision.spec.ts`: `'https://res.cloudinary.com/demo/image/upload/v1/x.gif'` → `'https://res.cloudinary.com/demo/image/upload/f_jpg,w_1024,c_limit/v1/x.gif'`; an R2 URL is unchanged; `cleanAltText('"Image of a red bike leaning on a wall."')` → `'a red bike leaning on a wall.'`.
  - `alt-text.service.spec.ts` (mocks):
    - A video → 422 `NOT_AN_IMAGE` and no token check.
    - A foreign URL → 422.
    - `hasAccess:false` → 402 with `code:'AI_TOKENS_EXHAUSTED'` and `describeImage` never called.
    - Success → `{altText:'A red bike…'}`, `executeWithTokens` called with `'generate_alt_text'`, and the item update never called.
  - `ai-text.service.spec.ts`: with Gemini unavailable, `describeImage` → `ServiceUnavailableException`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, plus `npx jest src/ai/ai.module.di.spec.ts`. V.
- [ ] **Step 5: Commit** `feat(library): Write with Maestro alt text from a vision model, metered as AI tokens`

---

### Task 14: Unified bin with bulk restore and delete

**Files:**
- Create: `src/media-library/services/recycle-bin.list.db.spec.ts`
- Modify: `recycle-bin.service.ts`, `media-library.dto.ts` (`RecycleBinQueryDto`, `BinItemsDto`, `BinItemRefDto`), `media-library.controller.ts`, `remaining-workspace-guards.spec.ts`

**Interfaces:**
- Consumes: `MediaItemService.purgeItems` (Task 3), `toUserRef` (Task 12), `BinRow`, `BinKind`, `Page` (Task 9).
- `RecycleBinQueryDto`:
  - `kind?: BinKind`
  - `sort?: 'deleted' | 'name' | 'size'` (default `deleted`)
  - `limit` 1–100 (default 50), `offset`
  - legacy `type?` mapped to a kind: `image|video|gif|document`→`media`, `template`, `text_snippet`→`snippet`, `link`. An explicit `kind` wins.
- `BinItemRefDto { @IsIn(BIN_KINDS) kind: BinKind; @IsUUID() id: string }`, `BinItemsDto { @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({each:true}) @Type(() => BinItemRefDto) items: BinItemRefDto[] }`.
- Produces (`RecycleBinService`):
  - `list(workspaceId, query): Promise<Page<BinRow> & { countsByKind: Record<BinKind, number> }>`. One `UNION ALL` over the four tables' deleted rows. A `kind` filter drops the other branches BEFORE `ORDER BY … LIMIT/OFFSET`.
    - Media: name, `COALESCE(thumbnail_url, CASE WHEN type IN ('image','gif') THEN file_url END)`, `type`, `file_size`.
    - Template: name, `thumbnail_url`, `'template'`, null.
    - Snippet: name, null, `'snippet'`, null.
    - Link: name, `preview_image_url`, `'link'`, null.
    - `deletedBy` comes from joining `users` on `deleted_by_id`. `purgeAt = deleted_at + interval '30 days'`.
    - Orders: `deleted` = `deleted_at DESC, id`; `name` = `lower(name) ASC, id`; `size` = `size_bytes DESC NULLS LAST, deleted_at DESC, id`.
    - `countsByKind` comes from four counts that ignore the `kind` filter.
  - `restore(workspaceId, items: BinItemRefDto[]): Promise<{ restored: number }>`: per kind, `UPDATE … SET is_deleted=false, deleted_at=NULL, deleted_by_id=NULL WHERE workspace_id AND is_deleted AND id IN (…) RETURNING id`.
  - `deleteForever(workspaceId, items): Promise<{ deleted: number }>`: media through `purgeItems` (only rows of this workspace with `is_deleted = true`); other kinds through `DELETE … WHERE workspace_id AND is_deleted AND id IN (…)`.
- Routes:
  - `GET recycle-bin` → `list`, `posts:draft`
  - `POST recycle-bin/restore` → `restoreRecycleBinItems`, `posts:draft`
  - `POST recycle-bin/delete` → `deleteRecycleBinItems`, `posts:publish`
  - `POST recycle-bin/empty` keeps `posts:publish`

- [ ] **Step 1: Failing DB tests**
  - Seed deleted media of 10 bytes, 30 bytes and null, 2 templates, 1 snippet, 1 link (distinct `deleted_at`), and one live item.
    - Default → `total 7`, deleted desc, `countsByKind {media:3, template:2, snippet:1, link:1}`.
    - `kind:'media', limit:2` → 2 items with `total 3`.
    - `sort:'size'` → 30, 10, then the nulls by deleted desc. `sort:'name'` is ascending.
  - A media row equals `{kind:'media', id, name, thumbnailUrl, type:'image', sizeBytes:10, deletedAt:<ISO>, deletedBy:{id,name,avatarUrl}, purgeAt:<deletedAt + 30 days ISO>}`. A snippet row has `thumbnailUrl null`, `type 'snippet'`, `sizeBytes null`.
  - Legacy `type:'video'` → only media rows.
  - `restore([media, snippet, a live link, another workspace's id])` → `{restored: 2}`.
  - `deleteForever([media, template])` → file deleter called once, `{deleted: 2}`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. V.
- [ ] **Step 5: Commit** `feat(library): one bin list across all kinds, filtered before paging; bulk restore and delete forever`

---

### Task 15: Storage enforcement on uploads and on saving an item

**Files:**
- Create: `src/media-library/lib/upload-type.ts`, `upload-type.spec.ts`, `src/media-library/services/library-ingest.service.ts`, `library-ingest.service.spec.ts`, `src/media-library/library-upload.controller.ts`, `library-upload.controller.spec.ts`, `src/media-library/services/media-item.create.db.spec.ts`
- Modify:
  - `src/media/cloudinary.service.ts` (`UploadResult.pages`, `getResourceBytes`)
  - `storage-object.service.ts` (`realSize`)
  - `media-item.service.ts` (`create`, `createFromUpload`)
  - `src/media/media.controller.ts` (remove the five moved routes and the now-unused DTO imports)
  - `src/media/dto/media.dto.ts`
  - `media-library.module.ts` (controller and providers)
  - `src/workspace-members/open-routes.spec.ts` (move the presign describe to `LibraryUploadController`)

**Interfaces:**
- Consumes: `StorageQuotaService` (`getUsage`, `assertCanStore`, `runLocked`), `wouldExceed`, `StorageFullException` (Task 10), `StorageObjectService` (Task 3).
- Produces:
  - `CloudinaryService`: `UploadResult.pages?: number` (copied from `result.pages`); `getResourceBytes(publicId: string, resourceType: 'image'|'video'|'raw'): Promise<number | null>` via `cloudinary.api.resource`, returning `null` on any error.
  - `StorageObjectService.realSize(ref: StoredFileRef): Promise<number | null>`: R2 → `r2.verifyObject(key).contentLength ?? null`; Cloudinary with a public id → `getResourceBytes(publicId, cloudinaryResourceType(ref))`; otherwise `null` (D11).
  - `mediaTypeFromUpload(u: { resourceType: 'image'|'video'|'raw'; format?: string; mimeType?: string }): MediaType`: gif when the format is `gif` or the mime type is `image/gif`; document when the format is `pdf` or `resourceType` is `raw`; video when `resourceType` is `video`; else image.
- Produces (`MediaItemService`, constructor gains `quota: StorageQuotaService`):
  - `create(workspaceId, userId, dto)` keeps the folder check, then:
    1. `ref` comes from the dto plus `providerOf`.
    2. `bytes = (await storageObjects.realSize(ref)) ?? dto.fileSize ?? 0`.
    3. `quota.runLocked(ws, async tx => { const u = await quota.getUsage(ws, tx); if (wouldExceed(u.used, bytes, u.limit)) throw new StorageFullException(u); insert with fileSize: bytes through tx })`.
    4. On `StorageFullException`, `storageObjects.deleteFile(ref)` (a failure is logged), then rethrow.
    It returns a `MediaItemView`.
  - `createFromUpload(workspaceId: string, userId: string, upload: UploadResult, meta: { name: string; mimeType?: string; categoryId?: string; tags?: string[] }): Promise<MediaItemView>` runs the same locked insert with `bytes = upload.bytes` and no size lookup.
    - `type = mediaTypeFromUpload`
    - `thumbnailUrl = upload.thumbnailUrl ?? (image or gif ? upload.secureUrl : null)`
    - `pageCount = type === 'document' ? upload.pages ?? null : null` (Cloudinary also reports frame counts for GIFs)
- Produces (`LibraryIngestService`, injects `CloudinaryService`, `StorageQuotaService`, `MediaItemService`), all returning `interface IngestResult { upload: UploadResult; libraryItem: MediaItemView | null }`:
  - `ingestBuffer(i: { workspaceId: string; userId: string; buffer: Buffer; originalName?: string; mimeType?: string; folder?: string; resourceType?: 'image'|'video'|'auto'|'raw'; tags?: string[]; purpose?: 'library'|'thumbnail' }): Promise<IngestResult>`: `assertCanStore(ws, buffer.length)`, then `uploadFromBuffer`, then (unless `purpose === 'thumbnail'`) `createFromUpload` with `name` = the original name without its extension, or `'Untitled'`.
  - `ingestRemoteUrl(i: { workspaceId; userId; url; folder?; resourceType?; tags?; publicId? })`: `assertCanStore(ws, 1)`, then `uploadFromUrl`, then `createFromUpload` with the name taken from the URL's last path segment.
  - `ingestBase64(i: { workspaceId; userId; data; folder?; resourceType?; tags?; publicId? })`: `assertCanStore(ws, Math.floor(data.length * 3 / 4))`, then `uploadFromBase64`, then `createFromUpload`.
  - All three also take `categoryId?: string` (ruling 5). When it is given, the FIRST step is `mediaItems.assertMediaFolder(ws, categoryId)` (Task 8), so a bad folder fails before any bytes are stored. `categoryId` and `tags` are passed into `createFromUpload`'s `meta`. `tags` also go to Cloudinary as today.
- Produces (`LibraryUploadController`, `@Controller('media')`, `@UseGuards(JwtAuthGuard)` per route). Every handler first runs `await access.assertCan(dto.workspaceId, user.userId, 'posts:draft')`.
  - `POST upload/url` (`UploadFromUrlDto` + `@IsUUID() workspaceId` + `@IsOptional() @IsUUID() categoryId`; it already has `tags?: string[]`) → `{ message: 'Media uploaded successfully', ...upload, libraryItem }`.
  - `POST upload/base64` (`UploadFromBase64Dto` + the same two fields) → the same shape.
  - `POST upload/file` (multipart, `UploadFileBodyDto { @IsUUID() workspaceId; @IsOptional() @IsUUID() categoryId?; folder?; resourceType?; tags?: string /* comma list, split and trimmed */; @IsOptional() @IsIn(['library','thumbnail']) purpose? }`) → `{ message, originalName, mimeType, ...upload, libraryItem }` (ruling 2). A thumbnail ignores `categoryId` and `tags`.
  - `POST signed-upload-params` (`GetSignedUploadParamsDto` + `workspaceId` + `@IsInt() @Min(1) bytes`) → `assertCanStore(ws, bytes)`, then today's response.
  - `POST r2/presign-composer-video` (unchanged DTO) → `assertCanStore(ws, dto.sizeBytes)` (ruling 1), then `createPresignedUpload`.

- [ ] **Step 1: Failing tests**
  - `upload-type.spec.ts` (`it.each`): `{image,gif}` → gif; `{image,pdf}` → document; `{raw}` → document; `{video}` → video; `{image,'png'}` → image.
  - `media-item.create.db.spec.ts` (real `StorageQuotaService` on the harness db; mocked providers; `seedUsage` limit 1000):
    - Used 900, R2 item with `verifyObject` → 200 → `StorageFullException` with body `{code:'STORAGE_FULL', used:900, limit:1000, message}`, `deleteObject` called with the key, no row inserted.
    - `verifyObject` → 100 with a declared `fileSize: 1` → row has `fileSize 100`.
    - `realSize` null → the declared `fileSize` is used.
    - Over-limit workspace (used 1200, limit 1000): `create` → 413, while `update`, `softDelete`, `restore` and bulk `move` all succeed.
  - `library-ingest.service.spec.ts` (mocks):
    - Full → `assertCanStore` rejects before `uploadFromBuffer` is called.
    - `purpose:'thumbnail'` → `createFromUpload` not called, `libraryItem: null`.
    - Success returns `libraryItem`.
    - `categoryId` + `tags: ['launch']` → `createFromUpload` gets `meta.categoryId` and `meta.tags`.
    - `assertMediaFolder` rejecting (a template folder) → 400, and `uploadFromBuffer` is never called.
    - `createFromUpload` rejecting with `StorageFullException` → it propagates, and the deletion of the uploaded file is asserted in the media-item spec.
    - Lock order (mocked `quota.runLocked` that passes a sentinel tx): `getUsage` receives the sentinel and the insert uses it.
  - `library-upload.controller.spec.ts` (`Object.create(prototype)` style, as in `open-routes.spec.ts`):
    - A non-member gets `NotFoundException` on every route, and no upload, presign or params call is made.
    - `signed-upload-params` with `bytes` over the limit → 413, and `generateSignedUploadParams` isn't called.
    - Presign with `sizeBytes` over the limit → 413, and `createPresignedUpload` isn't called.
    - `upload/file` returns `libraryItem`. Its comma `tags` `'a, b'` reach the ingest call as `['a','b']` together with `categoryId`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; move the routes; update `open-routes.spec.ts`. **Step 4:** PASS, plus `npx jest src/workspace-members`. Mutation: insert outside `runLocked` and the lock-order test fails. V.
- [ ] **Step 5: Commit** `feat(library): every upload checks storage and creates its Library item; saving re-checks the real size under a lock`

---

### Task 16: Canva and cloud imports go through the Library

**Files:**
- Modify: `src/canva/canva-composer.controller.ts` (+spec), `src/canva/canva-composer.types.ts`, `src/canva/canva.module.ts`, `src/media-sources/media-sources.service.ts` (+`media-sources.service.import.spec.ts`), `media-sources.controller.ts` (+spec), `media-sources.types.ts`, `media-sources.module.ts`

**Interfaces:**
- Consumes: `LibraryIngestService.ingestBuffer`, `StorageQuotaService.assertCanStore` (Task 15). Both modules import `MediaLibraryModule` (no cycle: it imports Media, WorkspaceRole, Drizzle and Ai only). `MediaLibraryModule` exports both services.
- `ComposerCanvaImportResult` and `CloudImportResult` gain `libraryItem: MediaItemView | null`.
- `CanvaComposerController.import(workspaceId, dto, user)` gains `@CurrentUser()`:
  1. `assertCanStore(ws, 1)` before exporting.
  2. Then `ingestBuffer({ workspaceId, userId, buffer, mimeType: 'image/png', originalName: \`canva-${dto.designId}.png\`, folder: 'composer/canva', resourceType: 'image' })`.
  3. Returns today's fields plus `libraryItem`.
- `MediaSourcesService.import(workspaceId, channelId, args, userId: string)`: `assertCanStore(ws, 1)` before downloading; then `ingestBuffer({ …, folder: 'composer/cloud', resourceType: 'auto', originalName: basename of args.fileId })`; the returned `type` comes from `upload.resourceType` as today. The controller passes `user.userId`.

- [ ] **Step 1: Failing tests:**
  - Import spec: a full workspace → 413 and `dropbox.downloadFile` never called. Success → `libraryItem` present and `ingestBuffer` called with `folder:'composer/cloud'`. The existing assertions are updated to the ingest mock.
  - Canva spec: same pair, with `exportDesign` never called when full.
  - Controller specs: `userId` is passed through.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, plus `npx jest src/workspace-members/remaining-workspace-guards.spec.ts`. V.
- [ ] **Step 5: Commit** `feat(library): Canva and cloud-drive imports check storage and land in the Library`

---

### Task 17: Links — UTM tags, favicon, search and sort

**Files:**
- Create: `src/media-library/lib/link-meta.ts`, `link-meta.spec.ts`, `src/media-library/services/saved-link.db.spec.ts`
- Modify: `media-library.dto.ts` (`UtmDto`, link DTOs, `SavedLinkQueryDto.sort`), `saved-link.service.ts`

**Interfaces:**
- Produces (`link-meta.ts`):
  - `extractFavicon(html: string, pageUrl: string): string`. Looks for `<link>` tags with `rel` containing `icon` (preferred), then `shortcut icon`, then `apple-touch-icon`, with attributes in any order. Resolves `href` against `pageUrl` with `new URL`. Ignores `data:` hrefs. Falls back to `<origin>/favicon.ico`.
  - `normalizeUtm(utm: SavedLinkUtm | null | undefined): SavedLinkUtm | null`: trims values and drops empty ones; all empty → `null`.
- `UtmDto { source?, medium?, campaign?, term?, content? }`, each `@IsOptional() @IsString() @MaxLength(200)`. `CreateSavedLinkDto.utm?: UtmDto` and `UpdateSavedLinkDto.utm?: UtmDto | null` (`@ValidateIf(v => v !== null) @ValidateNested() @Type(() => UtmDto)`).
- `SavedLinkQueryDto.sort?: 'newest' | 'most_used' | 'name'`: `created_at DESC`; `usage_count DESC NULLS LAST, created_at DESC`; `lower(name) ASC`. Each ends in `id`.
- `fetchLinkPreview` also returns `faviconUrl`. `create`, `refreshPreview`, and an `update` that changes the URL store `previewFaviconUrl`. `create`/`update` store `normalizeUtm(dto.utm)` (`null` clears it).

- [ ] **Step 1: Failing tests**
  - `link-meta.spec.ts`:
    - `<link rel="icon" href="/favicon.png">` on `https://a.com/x` → `https://a.com/favicon.png`
    - `<link href="https://cdn.a.com/i.ico" rel="shortcut icon">` → unchanged
    - only `<link rel="apple-touch-icon" href="t.png">` on `https://a.com/b/c` → `https://a.com/b/t.png`
    - both icon and apple-touch present → the icon wins
    - none → `https://a.com/favicon.ico`
    - a `data:` href → the fallback
    - `normalizeUtm({source:' ig ',medium:'',campaign:'x'})` → `{source:'ig',campaign:'x'}`; `{medium:''}` → `null`
  - DB spec (global `fetch` mocked):
    - `create` with UTM persists it normalised, plus `previewFaviconUrl`.
    - `update({utm:null})` clears it.
    - `sort:'most_used'` orders by count.
    - `search:'shop'` matches the url, and a `preview_title` match counts too.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. V.
- [ ] **Step 5: Commit** `feat(library): links keep UTM tags and favicons; link search and sort`

---

### Task 18: One-off owner scripts — library refs and file sizes

**Files:**
- Create: `src/media-library/scripts/backfill-library-refs.ts`, `backfill-library-refs.db.spec.ts`, `src/media-library/scripts/backfill-file-sizes.ts`, `backfill-file-sizes.spec.ts`
- Modify: `package.json` (`"library:backfill-refs": "node dist/src/media-library/scripts/backfill-library-refs"`, `"library:backfill-sizes": "node dist/src/media-library/scripts/backfill-file-sizes"`)

**Interfaces:**
- Both scripts follow `src/inbox/scripts/backfill-conversations.ts`:
  - `decideTarget(url, confirmedProduction)`
  - refuse a `.railway.internal` host without `--i-know-this-is-production`
  - `buildPoolConfig` connection
  - a `require.main === module` CLI that reads `DATABASE_URL` from dotenv
- `runBackfillLibraryRefs(opts: { databaseUrl: string; confirmedProduction: boolean; batchSize?: number /* 500 */; connect?: (url: string) => Promise<Client> }): Promise<{ postsUpdated: number }>`.
  - Walks posts keyset-style by `id`. For each batch, one `UPDATE posts SET media_items = (SELECT jsonb_agg(CASE WHEN e ? 'libraryItemId' OR m.id IS NULL THEN e ELSE e || jsonb_build_object('libraryItemId', m.id::text) END ORDER BY ord) FROM jsonb_array_elements(p.media_items) WITH ORDINALITY t(e, ord) LEFT JOIN LATERAL (SELECT mi.id FROM media_items mi WHERE mi.workspace_id = p.workspace_id AND mi.file_url = e->>'url' ORDER BY mi.is_deleted, mi.created_at, mi.id LIMIT 1) m ON true)`.
  - It touches only array-typed rows where at least one entry lacks the id and matches an item. It does NOT touch `updated_at`.
  - Base `media_items` only. Platform overrides already count by URL.
- `runBackfillFileSizes(opts: { databaseUrl: string; confirmedProduction: boolean; dryRun: boolean; maxCloudinaryCalls?: number /* 400 */; storage: Pick<StorageObjectService, 'realSize'>; connect?: … }): Promise<{ filled: number; failed: string[]; skippedForRateLimit: number }>`.
  - Walks rows with `file_size IS NULL` keyset-style by `id`, 100 per page.
  - Stops asking Cloudinary after `maxCloudinaryCalls` and counts the rest as skipped. R2 rows don't count toward that limit.
  - Writes only when not `dryRun` and the size isn't null. Rows it can't fill stay null (they count as 0) and are returned in `failed` and logged.
  - The CLI builds `StorageObjectService` from `new CloudinaryService(new ConfigService())` and `new CloudflareR2Service(new ConfigService())`.

- [ ] **Step 1: Failing tests**
  - Refs DB spec. A post's entries:
    - URL A matches a live item → gets its id
    - an entry that already has an id → kept
    - URL B with no item → unchanged
    - URL C matches a deleted item → gets the deleted item's id
    - URL D matches two live items → the older one wins

    Also: `updated_at` unchanged; a re-run → `postsUpdated 0`; afterwards the matched items' `usage_count` equals the live count; a `localhost` URL is allowed and a `.railway.internal` URL without the flag throws.
  - Sizes spec (fake `connect` with an in-memory `query`, fake `storage`):
    - Nulls get filled.
    - `realSize` null → listed in `failed`, no write.
    - `dryRun` → no `UPDATE` issued.
    - `maxCloudinaryCalls: 1` with 3 Cloudinary rows → `skippedForRateLimit 2`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. V.
- [ ] **Step 5: Commit** `feat(library): owner scripts to backfill post library ids and missing file sizes`

---

### Task 19: API docs, contract route audit, whole-branch verification

**Files:**
- Create: `src/media-library/contract-routes.spec.ts`
- Modify: `docs/media-library-api.md`

**Interfaces:**
- `contract-routes.spec.ts` reads controller metadata the same way `src/workspace-members/every-workspace-route-guarded.spec.ts` does. It asserts that each route below exists exactly once with exactly this capability:

| Route (base `/workspaces/:workspaceId/media-library`) | Capability |
|---|---|
| `GET stats` | posts:draft |
| `GET categories` | posts:draft |
| `POST categories/:categoryId/zip-ticket` | posts:draft |
| `GET categories/:categoryId/zip` | none: `LibraryZipController`, no guards, listed in `OPEN_ROUTES` |
| `GET templates` | posts:draft |
| `POST templates/bulk` | posts:draft |
| `GET snippets` | posts:draft |
| `POST snippets/bulk` | posts:draft |
| `GET links` | posts:draft |
| `POST links/bulk` | posts:draft |
| `GET items` | posts:draft |
| `PUT items/:itemId` | posts:draft |
| `POST items/:itemId/use` | posts:draft |
| `GET items/:itemId/usage` | posts:draft |
| `POST items/:itemId/alt-text` | posts:draft |
| `POST items/bulk` | posts:draft |
| `GET recycle-bin` | posts:draft |
| `POST recycle-bin/restore` | posts:draft |
| `POST recycle-bin/delete` | posts:publish |
| `POST recycle-bin/empty` | posts:publish |

  It also asserts that `LibraryUploadController` owns `POST /media/upload/file|url|base64`, `POST /media/signed-upload-params` and `POST /media/r2/presign-composer-video`, and that `MediaController` no longer declares any of them.
- `docs/media-library-api.md` documents every request and response this plan added or changed, with the contract's names:
  - item query parameters and new fields
  - stats, usage, alt text
  - folder kinds and stats; the zip ticket flow and its 401
  - template and snippet `sort`/`starred`; the three new bulk routes; `{affectedCount}`
  - the unified bin and its bulk calls
  - the upload changes (`workspaceId`, `categoryId`, `tags`, `purpose`, `libraryItem`, 413 bodies)
  - links (`utm`, favicon, search, sort)
  - the two owner scripts and the deploy notes:
    - the 0055 gate query and threshold, copied from Task 6
    - set `LIBRARY_ZIP_TICKET_SECRET` on Railway
    - run `library:backfill-refs`, then `library:backfill-sizes`, after deploy

- [ ] **Step 1:** Write the spec. It must PASS on the finished branch; if a row fails, fix the owning task's code, not the spec.
- [ ] **Step 2:** Run the full `npx jest`. The only allowed failure is the known `billing.controller.spec`; compare anything else with `origin/main` through a temporary `git worktree add` (never stash). Then `PLANNER_DB_TESTS=1 npx jest --runInBand db.spec` → PASS.
- [ ] **Step 3:** `npm run build`. Boot check: `PORT=3999 timeout 90 node dist/src/main.js` logs "Nest application successfully started" (Redis `ECONNREFUSED` is expected locally).
- [ ] **Step 4:** `git diff origin/main --stat -- drizzle/migrations` lists exactly `0054_library_columns.sql` and `0055_posts_library_refs.sql`, and no existing migration file or `meta/_journal.json` changed.
- [ ] **Step 5:** Update the docs. **Commit** `docs(library): API reference for the redesign; contract route audit`
