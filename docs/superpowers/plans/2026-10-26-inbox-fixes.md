# Inbox Security and Correctness Fixes (F1–F4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four Inbox holes found in recon before the redesign lands: unsigned Meta webhooks, a Guest-triggerable destructive sync, dropped webhook comments on older posts, and stacked concurrent polls.

**Architecture:** Four small, independent changes to existing code. Each task ends green and is its own commit. The branch ships as one PR that merges BEFORE `feat/inbox-api`; that branch is then rebased onto it.

**Tech Stack:** NestJS 11, Drizzle ORM (PostgreSQL), BullMQ 5.66, Jest + supertest.

**Spec:** `D:/My Documents/MyProjects/FullStackProjects/socialmedia-frontend-inbox/docs/superpowers/specs/2026-10-26-inbox-redesign-design.md` §2 (bugs found) and §5.5 (F1–F4). Recon with line numbers: `C:/Users/hp/AppData/Local/Temp/claude/d--My-Documents-MyProjects-FullStackProjects-socialmedia-frontend/d4116103-65ee-4103-9aab-04bc02362fb0/scratchpad/inbox-recon/C-backend.md`.

**Branch set-up (once, before Task 1):** from the backend repo, `git fetch origin && git worktree add "D:/My Documents/MyProjects/FullStackProjects/socialmedia-workspace-inbox-fixes" -b fix/inbox-security origin/main`. All paths below are relative to that worktree. Copy `.env` from `socialmedia-workspace-inbox/.env` (never commit it).

## Global Constraints

- Never run `db:push`, never connect to or modify the production database. Migrations are hand-written numbered `.sql` files in `drizzle/migrations/`, applied by the boot runner (`node dist/src/drizzle/migrate/migrate`); never hand-apply one anywhere but inside the rollback harness. Local DB only (`DATABASE_URL` on localhost). Read `docs/migrations.md` once.
- A migration is idempotent (`IF NOT EXISTS`), carries the repo header (`-- WHY` / `-- SAFETY` / `-- ROLLBACK` / "Never run `db:push` against prod"), uses no `CONCURRENTLY` and no `BEGIN`/`COMMIT`. This plan's only migration is `0045_posts_targets_gin.sql`; if `0045` is taken on `origin/main` when you start, use the next free number and say so in the commit.
- NestJS Service-Controller-Module pattern. Request bodies use `class-validator` DTOs (global `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })`).
- Every workspace route keeps `@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)` plus an explicit `@RequireCapability(...)`. `src/workspace-members/every-workspace-route-guarded.spec.ts` must stay green; its `OPEN_ROUTES` table may only gain a route that is behind `SuperAdminGuard`, with the existing `SUPER_ADMIN_ONLY` reason.
- Prettier: single quotes, trailing commas. Never skip hooks (`--no-verify`). Never push, never merge, never `git stash` (compare with `git show origin/main:<path>` instead).
- Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Tasks are executed by implementers who see only their own task. Each task states every name it needs.
- DB specs (`*.db.spec.ts`) use `describeDb` / `withRollbackDb` from `src/planner/testing/rollback-db.ts`, run only with `PLANNER_DB_TESTS=1`, and must run with `--runInBand` (parallel migration replays deadlock on catalog locks). The harness applies the named migration files twice inside a transaction it rolls back. Do not call `db.transaction()` inside code exercised by a DB spec in this plan (the harness's single client would commit; the API plan fixes that, this plan does not need it).

**Per-task verification ("V"):**
1. `npx jest <the task's spec files>` (plus `PLANNER_DB_TESTS=1 npx jest --runInBand <db spec>` where the task has one).
2. `npm run build`.
3. `npx eslint --no-fix <touched .ts files>`; for each touched file that exists on `origin/main`, `git show origin/main:<file> | npx eslint --no-fix --stdin --stdin-filename <file>` — the error count must not rise. (Do not run `npm run lint`: it auto-fixes the whole repo.)

## Review Focus

1. **A Meta POST signed with the Instagram or Threads app secret rather than the Facebook app secret** — Instagram Login and Threads apps have their own secrets (`INSTAGRAM_CLIENT_SECRET`, `THREADS_CLIENT_SECRET`); checking only `META_APP_SECRET` would 401 every real IG/Threads delivery and silently stop realtime. Test: Task 1 accepts a body signed with each configured candidate secret for that endpoint and rejects one signed with an unrelated secret.
2. **Body re-serialisation** — a signature computed over `JSON.stringify(req.body)` instead of the raw bytes fails on any payload with unicode escapes or key order differences. Test: Task 1 signs a raw body containing `\u00e9` and extra whitespace, and it verifies.
3. **A secret that is unset in production** — must fail closed (401 / 403), never fall back to a default. Test: Task 1, both the POST and the GET verify path.
4. **A Guest pressing refresh** — `POST sync` must 403 for a Guest and the orphan cleanup must no longer run from it at all. Test: Task 2.
5. **A webhook comment on the 51st-oldest post of a busy channel** — must resolve to our post. Test: Task 3 seeds 60 posts for the channel and asserts the oldest one resolves.

---

### Task 1: Verify Meta webhook signatures (F1)

**Files:**
- Create: `src/channels/utils/meta-webhook-secrets.ts`
- Modify: `src/channels/webhooks.controller.ts` (`META_VERIFY_TOKEN` field ~line 52; `respondToVerify` ~132; `handleInstagramWebhook`, `handleFacebookWebhook`, `handleThreadsWebhook` ~152–185; class doc comment ~39–48)
- Modify: `.env.example` (document `INSTAGRAM_CLIENT_SECRET` and `THREADS_CLIENT_SECRET` as webhook signing secrets next to `META_APP_SECRET`)
- Test: `src/channels/utils/meta-webhook-secrets.spec.ts`, `src/channels/webhooks.meta-signature.controller.spec.ts`

**Interfaces:**
- Consumes: `verifyMetaSignature({ appSecret, signatureHeader, rawBody })` from `src/common/utils/webhook-signature.util.ts` (already used by the WhatsApp handler, `webhooks.controller.ts:185-200`). `main.ts` already creates the app with `rawBody: true`, so `req.rawBody` is a `Buffer`.
- Produces (`meta-webhook-secrets.ts`):
  - `type MetaWebhookSource = 'facebook' | 'instagram' | 'threads'`
  - `metaSigningSecrets(source: MetaWebhookSource, env: NodeJS.ProcessEnv = process.env): string[]` — non-empty, trimmed values only, in this order: `facebook` → `[META_APP_SECRET]`; `instagram` → `[INSTAGRAM_CLIENT_SECRET, META_APP_SECRET]`; `threads` → `[THREADS_CLIENT_SECRET, META_APP_SECRET]`.
  - `isValidMetaDelivery(source: MetaWebhookSource, signatureHeader: string | undefined, rawBody: Buffer | undefined, env?: NodeJS.ProcessEnv): boolean` — `false` when `rawBody` is missing or no secret is configured; `true` when ANY candidate secret verifies.
- Behaviour:
  - Each of the three POST handlers takes `@Req() req: ExpressRequest, @Res() res: Response`, checks `isValidMetaDelivery(source, req.headers['x-hub-signature-256'], req.rawBody)` FIRST, and on failure logs `"<source> webhook signature verification failed"` and returns `res.status(401).send('invalid signature')` without processing. On success it keeps today's flow (ack `200 EVENT_RECEIVED`, then `processMetaWebhook(req.body, source)` / `processThreadsWebhook(req.body)`).
  - `META_VERIFY_TOKEN` becomes `process.env.META_WEBHOOK_VERIFY_TOKEN ?? ''` (no `'webondev_verify_123'` fallback). `respondToVerify` returns 403 when the configured token is empty, whatever the request sends.
  - Replace the "TODO — Phase 1 skips" lines in the class comment with one line: Meta POSTs are verified with `X-Hub-Signature-256` against the endpoint's app secret(s); unsigned or mis-signed POSTs get 401.
  - Source for the candidate list (write it as a comment above `metaSigningSecrets`): Meta signs every webhook POST with the app secret of the app that owns the subscription (https://developers.facebook.com/docs/graph-api/webhooks/getting-started#validate-payloads). Instagram API with Instagram Login and the Threads API run under their own app ids with their own secrets, so those endpoints accept either secret.

- [ ] **Step 1: Write the failing tests**
  - `meta-webhook-secrets.spec.ts` (pure, pass an explicit `env` object):
    - `metaSigningSecrets('instagram', { INSTAGRAM_CLIENT_SECRET: 'ig', META_APP_SECRET: 'fb' })` equals `['ig', 'fb']`; `('threads', { META_APP_SECRET: 'fb' })` equals `['fb']`; `('facebook', { META_APP_SECRET: '  ' })` equals `[]`.
    - `isValidMetaDelivery`: a body signed `sha256=` + HMAC-SHA256 with `'ig'` is valid for `instagram` with env `{ INSTAGRAM_CLIENT_SECRET: 'ig', META_APP_SECRET: 'fb' }`; signed with `'fb'` also valid; signed with `'other'` invalid; same body for `facebook` with only `INSTAGRAM_CLIENT_SECRET: 'ig'` set is invalid; `rawBody: undefined` invalid; header `undefined` invalid; header `'sha1=abc'` invalid; env `{}` invalid (Review Focus 3).
    - Raw-bytes case (Review Focus 2): rawBody `Buffer.from('{"text":"caf\\u00e9" ,  "a":1}')` signed over those exact bytes is valid.
  - `webhooks.meta-signature.controller.spec.ts` (supertest; build the app with `moduleRef.createNestApplication({ rawBody: true })`; provide `WebhooksController` with jest fakes for every constructor dependency — `InboxService`, `FacebookService`, `InstagramService`, `ChannelService`, the five queues via `getQueueToken(QUEUES.X)`, and `WhatsAppTemplatesService`; spy on the private `processMetaWebhook` / `processThreadsWebhook` with `jest.spyOn(WebhooksController.prototype as any, 'processMetaWebhook').mockResolvedValue(undefined)`):
    - For each of `instagram`, `facebook`, `threads`: a correctly signed POST answers `200 'EVENT_RECEIVED'` and the matching process method is called once with the parsed body; an unsigned POST answers 401 and the process method is not called; a POST signed with a wrong secret answers 401.
    - `GET /webhooks/facebook?hub.mode=subscribe&hub.verify_token=webondev_verify_123&hub.challenge=x` with `META_WEBHOOK_VERIFY_TOKEN` unset answers 403 (set/restore `process.env` in `beforeEach`/`afterEach`, and construct the module after setting it because the token is read at construction).
    - With `META_WEBHOOK_VERIFY_TOKEN='t'`, `hub.verify_token=t` answers 200 with body `x`.
- [ ] **Step 2:** Run `npx jest src/channels/utils/meta-webhook-secrets.spec.ts src/channels/webhooks.meta-signature.controller.spec.ts`. Expected: FAIL (module missing; unsigned POST still 200).
- [ ] **Step 3:** Implement `meta-webhook-secrets.ts` and the controller changes above. Keep the WhatsApp handler unchanged.
- [ ] **Step 4:** Run the two specs. Expected: PASS.
- [ ] **Step 5:** Mutation check: make `isValidMetaDelivery` return `true` when no secret is configured; the `env {}` test and the "unsigned POST answers 401" tests must fail. Revert. Run V.
- [ ] **Step 6: Commit**

```bash
git add src/channels/utils/meta-webhook-secrets.ts src/channels/utils/meta-webhook-secrets.spec.ts src/channels/webhooks.controller.ts src/channels/webhooks.meta-signature.controller.spec.ts .env.example
git commit -m "fix(webhooks): verify X-Hub-Signature-256 on Instagram, Facebook and Threads POSTs; no default verify token

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

**Deploy note for the PR description (not code):** before merging, confirm `META_APP_SECRET`, `INSTAGRAM_CLIENT_SECRET`, `THREADS_CLIENT_SECRET` and `META_WEBHOOK_VERIFY_TOKEN` are set on Railway. If one is missing, that platform's webhooks are refused (fail closed) and the 30-second poll keeps the Inbox fed, so nothing is lost, only realtime.

---

### Task 2: `POST sync` needs `inbox:reply` and stops deleting data (F2)

**Files:**
- Create: `src/inbox/inbox-admin.controller.ts`
- Modify: `src/inbox/inbox.controller.ts` (`syncNow`, ~line 202: capability), `src/inbox/inbox.service.ts` (`syncNow` ~1973: drop the cleanup call and the `cleanedUp` field; `cleanupOrphanedThreadKeys` ~1818: split), `src/inbox/inbox.module.ts` (register the controller), `src/workspace-members/every-workspace-route-guarded.spec.ts` (`OPEN_ROUTES` gains one `SUPER_ADMIN_ONLY` entry)
- Test: `src/inbox/inbox.controller.sync.spec.ts`, `src/inbox/inbox-admin.controller.spec.ts`

**Interfaces:**
- Produces:
  - `InboxService.cleanupOrphanedThreadKeysForWorkspace(workspaceId: string): Promise<{ deleted: number; channels: number[] }>` — the existing body without the membership check. `cleanupOrphanedThreadKeys(workspaceId, userId)` keeps its signature and calls it after `assertWorkspaceAccess` (no route calls it any more; kept for API stability of the service).
  - `InboxService.syncNow(workspaceId, userId)` returns `{ queued: number; channels: number[]; webhookActivated: number; webhookErrors: { channelId: number; reason: string }[] }` (no `cleanedUp`; the frontend type never had it).
  - `InboxAdminController` — `@Controller('admin/inbox')`, `@UseGuards(JwtAuthGuard, SuperAdminGuard)` (`src/auth/guards/super-admin.guard.ts`), one handler `cleanupOrphanedThreadKeys` = `POST workspaces/:workspaceId/cleanup-orphaned-thread-keys` (`ParseUUIDPipe`), `@HttpCode(200)`, returns the service result.
  - `OPEN_ROUTES['POST /admin/inbox/workspaces/:workspaceId/cleanup-orphaned-thread-keys'] = SUPER_ADMIN_ONLY`.
- `syncNow` keeps the poll-cursor reset and the webhook re-subscribe (that is what "refresh" means); only the DELETE leaves.

- [ ] **Step 1: Write the failing tests**
  - `inbox.controller.sync.spec.ts` (supertest, same harness shape as `src/planner/planner-notes.controller.spec.ts`: real `WorkspaceRoleGuard`, fake `WorkspaceRoleService` `{ getRole, isPlatformSuperAdmin }`, `JwtAuthGuard` overridden to set `req.user = { userId: 'user-1' }`, fakes for `InboxService`, `ScheduledMessagesService`, `CloudflareR2Service`): GUEST → 403 and `syncNow` not called; MEMBER → 202 and `syncNow` called with `(WS, 'user-1')`; non-member (`getRole` → null) → 403. Capability metadata: `Reflect.getMetadata(REQUIRE_CAPABILITY, InboxController.prototype.syncNow)` is `'inbox:reply'`.
  - Same file, service-level: construct `InboxService` with jest fakes and spy `cleanupOrphanedThreadKeysForWorkspace`; stub the private db reads by spying `assertWorkspaceAccess` and the channel select (simplest: `jest.spyOn(service as any, 'assertWorkspaceAccess').mockResolvedValue(undefined)` and make the dispatcher's `supportedPlatforms()` return `[]` so no channels qualify; mock `db` only if needed through `jest.mock('../drizzle/db')`). Assert `syncNow` never calls `cleanupOrphanedThreadKeysForWorkspace` and the result has no `cleanedUp` key.
  - `inbox-admin.controller.spec.ts`: with `SuperAdminGuard` overridden to allow, `POST /admin/inbox/workspaces/<uuid>/cleanup-orphaned-thread-keys` → 200 and the service called with the uuid; with it overridden to deny → 403; non-uuid id → 400.
- [ ] **Step 2:** Run both specs. Expected: FAIL.
- [ ] **Step 3:** Implement. Register `InboxAdminController` in `InboxModule.controllers`.
- [ ] **Step 4:** Run both specs plus `npx jest src/workspace-members/every-workspace-route-guarded.spec.ts`. Expected: PASS.
- [ ] **Step 5:** Mutation check: put `@RequireCapability('inbox:view')` back on `syncNow`; the GUEST test must fail. Revert. Run V.
- [ ] **Step 6: Commit** `fix(inbox): sync needs inbox:reply and no longer deletes rows; orphan cleanup is a super-admin action` (with the trailer).

---

### Task 3: `findOurPostId` is an exact indexed lookup (F3)

**Files:**
- Create: `drizzle/migrations/0045_posts_targets_gin.sql`, `src/inbox/find-our-post-id.db.spec.ts`
- Modify: `src/inbox/inbox.service.ts` (`findOurPostId`, ~line 2187), `src/drizzle/schema/posts.schema.ts` (declare the index in the table's index list so the schema matches the DB)

**Interfaces:**
- Produces: `InboxService.findOurPostId(channelId: number, platformPostId: string): Promise<string | null>` (same signature) — one query, `LIMIT 1`, no JS scan:
  `WHERE posts.targets @> '[{"channelId":"<id>","platformPostId":"<pid>"}]'::jsonb OR posts.targets @> '[{"channelId":<id>,"platformPostId":"<pid>"}]'::jsonb` (string and numeric `channelId` forms, both index-assisted), `ORDER BY posts.created_at DESC`.
- Migration `0045_posts_targets_gin.sql`: `CREATE INDEX IF NOT EXISTS "posts_targets_gin_idx" ON "posts" USING gin ("targets" jsonb_path_ops);`. Header SAFETY must say: a plain `CREATE INDEX` takes a write lock on `posts` for the build (seconds at current size); `CONCURRENTLY` is impossible inside the runner's transaction. ROLLBACK: `DROP INDEX IF EXISTS posts_targets_gin_idx;`.
- Drizzle: `index('posts_targets_gin_idx').using('gin', sql\`${table.targets} jsonb_path_ops\`)`.

- [ ] **Step 1: Write the failing DB spec** (`describeDb`, `withRollbackDb(['0045_posts_targets_gin.sql'], …)`; insert a user, workspace, channel, and posts with raw SQL):
  - Seed 60 posts whose `targets` contain `{ channelId: '<ch>', platformPostId: 'p-<n>', platform: 'instagram', status: 'published' }`, created oldest first; `findOurPostId(ch, 'p-0')` (the oldest) returns post 0's id (Review Focus 5; the old code's `LIMIT 50` without order misses it).
  - A post on another channel with the same `platformPostId` is not returned for `ch`.
  - A target stored with numeric `channelId` (`{"channelId": <ch>}`) is found.
  - Unknown id returns `null`.
  - With `SET LOCAL enable_seqscan = off`, `EXPLAIN` of the service's query text contains `posts_targets_gin_idx`.
  - The service uses the `db` singleton (`src/drizzle/db.ts`); in the spec, `jest.mock('../drizzle/db', () => ({ db: <the harness db> }))` is not possible after import, so instead extract the query into an exported pure builder `findOurPostIdQuery(db: DbType, channelId: number, platformPostId: string)` in `inbox.service.ts` that the method calls with the singleton and the spec calls with the harness db.
- [ ] **Step 2:** `PLANNER_DB_TESTS=1 npx jest --runInBand src/inbox/find-our-post-id.db.spec.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the migration, schema index, `findOurPostIdQuery` and the method.
- [ ] **Step 4:** Run the DB spec. Expected: PASS. Also run `npx jest src/inbox` (no regressions).
- [ ] **Step 5:** Mutation check: drop the numeric-form `OR`; the numeric test must fail. Revert. Run V.
- [ ] **Step 6: Commit** `fix(inbox): findOurPostId uses an indexed exact lookup instead of scanning 50 posts` (with the trailer).

---

### Task 4: One active poll per channel (F4)

**Files:**
- Modify: `src/inbox/schedulers/inbox-poll.scheduler.ts` (`enqueueInboxPolling`), `src/inbox/inbox.service.ts` (`syncNow` enqueue loop)
- Create: `src/inbox/schedulers/poll-dedup.ts`
- Test: `src/inbox/schedulers/inbox-poll.scheduler.spec.ts`

**Interfaces:**
- Produces (`poll-dedup.ts`): `pollDedupId(channelId: number): string` → `` `inbox-poll-${channelId}` `` (no colon: BullMQ rejects custom ids containing `:`).
- Both enqueue sites add the option `deduplication: { id: pollDedupId(channelId) }` (BullMQ 5.66 "simple mode": a second add with the same id is ignored until the first job completes or finally fails, retries included). The existing unique `jobId`s stay.
- Behaviour note for the code comment: a `POST sync` while that channel's poll is running is ignored for that channel; the sync has already reset `last_inbox_poll_at`, so the next cron poll does the full refresh.

- [ ] **Step 1: Write the failing test** (`inbox-poll.scheduler.spec.ts`): construct `InboxPollScheduler` with a fake queue `{ add: jest.fn() }`; mock `../../drizzle/db` (`jest.mock`) so the channel select resolves `[{ id: 7 }, { id: 9 }]` (chain `select().from().where()`); call `enqueueInboxPolling()`; assert `add` was called twice and the third argument of each call contains `deduplication: { id: 'inbox-poll-7' }` / `{ id: 'inbox-poll-9' }`. Also `pollDedupId(12) === 'inbox-poll-12'` and contains no `:`.
- [ ] **Step 2:** `npx jest src/inbox/schedulers/inbox-poll.scheduler.spec.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement in both enqueue sites.
- [ ] **Step 4:** Run the spec. Expected: PASS.
- [ ] **Step 5:** Run the full suite once: `npx jest` (compare failures with `origin/main`: run `git -C <repo> worktree add <tmp> origin/main` only if a failure looks pre-existing and you need proof — never stash). Run V. Boot check: `npm run build && PORT=3999 timeout 90 node dist/src/main.js` logs "Nest application successfully started" (Redis ECONNREFUSED is expected locally).
- [ ] **Step 6: Commit** `fix(inbox): one active poll per channel via BullMQ deduplication` (with the trailer).
