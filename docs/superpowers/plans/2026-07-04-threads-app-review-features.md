# Threads App Review Features — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Threads mentions (read+reply), hide/unhide replies, and insights fully implemented + demonstrable so all three can pass Meta App Review.

**Architecture:** Backend (NestJS) reuses the existing `ThreadsService` (raw `fetch` against `https://graph.threads.net/v1.0`), the `PlatformInboxAdapter`/`ThreadsInboxAdapter` pair, the `inboxItems` table, and the poll processor. Mentions ingest as a new `inboxItems.type='mention'`; hide adds an adapter method + an `is_hidden` column; insights only needs its OAuth scope requested (code already exists). Frontend (Vite/React/shadcn) adds a third inbox tab and a per-comment hide action, reusing the existing inbox list/thread/composer components.

**Tech Stack:** NestJS, Drizzle ORM (Postgres), Jest (backend). Vite, React 19, TypeScript, shadcn/ui, TanStack Query v5, Vitest (frontend, pure functions only).

## Global Constraints

- Branch: `feat/threads-app-review` on BOTH repos (already created off `main`). All commits land here.
- Backend-first, then frontend. Backend repo: `socialmedia-workspace`. Frontend repo: `socialmedia-frontend`.
- Threads OAuth scopes go 4 → 6: add `threads_manage_mentions` and `threads_manage_insights` (exact strings, verbatim).
- Existing connected Threads channels must reconnect to receive new scopes; new-scope Graph calls on old tokens MUST degrade gracefully (catch permission errors → do not 500).
- Threads Graph base URL constant already exists: `ThreadsService.graphApiUrl = 'https://graph.threads.net/v1.0'`. Reuse it; never hardcode the base elsewhere.
- Mentions endpoint: `GET /{threads-user-id}/mentions`, permission `threads_manage_mentions`; params `fields`, `since` (≥ `1688540400`), `until`. Private users' media excluded; **unapproved apps only receive mentions from app testers** (relevant for the review screencast — @mention from a tester account).
- Hide endpoint: `POST /{reply_id}/manage_reply` with body `hide` (boolean); hiding auto-hides nested replies. Permission `threads_manage_replies`.
- Frontend UI: shadcn components + lucide-react icons only; theme tokens only (no hardcoded colors).
- `threads_delete` is OUT OF SCOPE (leave existing dead code untouched).

---

## Backend

### Task 1: Add the two OAuth scopes + document env vars

**Files:**
- Modify: `src/drizzle/schema/channels.schema.ts:524-533` (the `threads.oauthScopes` array)
- Modify: `.env.example`
- Test: `src/drizzle/schema/channels.schema.spec.ts` (create)

**Interfaces:**
- Produces: `PLATFORM_CONFIG.threads.oauthScopes` now contains 6 scopes including `threads_manage_mentions` and `threads_manage_insights`.

- [ ] **Step 1: Write the failing test**

Create `src/drizzle/schema/channels.schema.spec.ts`:

```typescript
import { PLATFORM_CONFIG } from './channels.schema';

describe('Threads OAuth scopes', () => {
  it('requests all 6 scopes the features need', () => {
    expect(PLATFORM_CONFIG.threads.oauthScopes).toEqual([
      'threads_basic',
      'threads_content_publish',
      'threads_manage_replies',
      'threads_read_replies',
      'threads_manage_insights',
      'threads_manage_mentions',
    ]);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test -- channels.schema.spec` → FAIL (array has only 4 entries).

- [ ] **Step 3: Add the scopes**

In `src/drizzle/schema/channels.schema.ts`, extend the `threads.oauthScopes` array (after `'threads_read_replies',` at line 532) with:

```typescript
      // Required to read/reply to posts that @mention our account (mentions tab).
      'threads_manage_insights',
      // Required to read account + per-post analytics (insights dashboard).
      'threads_manage_mentions',
```

(Order the final array exactly as the test asserts: basic, content_publish, manage_replies, read_replies, manage_insights, manage_mentions.)

- [ ] **Step 4: Document env vars**

In `.env.example`, add near the other Threads/Meta lines:

```
# Threads (Meta) OAuth app credentials — from the Threads use-case in your Meta app.
THREADS_CLIENT_ID=
THREADS_CLIENT_SECRET=
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `npm test -- channels.schema.spec` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/drizzle/schema/channels.schema.ts src/drizzle/schema/channels.schema.spec.ts .env.example
git commit -m "feat(threads): request manage_insights + manage_mentions scopes; doc env vars"
```

---

### Task 2: `ThreadsService.getMentions()`

**Files:**
- Modify: `src/channels/services/threads.service.ts` (add interface + method)
- Test: `src/channels/services/threads.service.mentions.spec.ts` (create)

**Interfaces:**
- Produces:
  ```typescript
  export interface ThreadsMention {
    id: string;
    text: string | null;
    authorUsername: string | null;
    permalink: string | null;
    timestamp: string;
    mediaType: string | null;
  }
  // async getMentions(accessToken: string, userId: string, since?: Date): Promise<ThreadsMention[]>
  ```

- [ ] **Step 1: Write the failing test**

Create `src/channels/services/threads.service.mentions.spec.ts`:

```typescript
import { ThreadsService } from './threads.service';

describe('ThreadsService.getMentions', () => {
  const svc = new ThreadsService();
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('calls the mentions endpoint and maps fields', async () => {
    const calledUrls: string[] = [];
    global.fetch = jest.fn(async (url: string) => {
      calledUrls.push(url);
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'm1',
              text: 'hey @schedura',
              username: 'alice',
              permalink: 'https://threads.net/@alice/post/1',
              timestamp: '2026-07-01T10:00:00+0000',
              media_type: 'TEXT_POST',
            },
          ],
        }),
      };
    }) as unknown as typeof fetch;

    const out = await svc.getMentions('tok', '123');
    expect(calledUrls[0]).toContain('/123/mentions');
    expect(calledUrls[0]).toContain('access_token=tok');
    expect(out).toEqual([
      {
        id: 'm1',
        text: 'hey @schedura',
        authorUsername: 'alice',
        permalink: 'https://threads.net/@alice/post/1',
        timestamp: '2026-07-01T10:00:00+0000',
        mediaType: 'TEXT_POST',
      },
    ]);
  });

  it('degrades to [] on a permission error (missing scope on old tokens)', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      json: async () => ({ error: { message: 'permissions error', code: 10 } }),
    })) as unknown as typeof fetch;
    await expect(svc.getMentions('tok', '123')).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test -- threads.service.mentions` → FAIL (`getMentions` not a function).

- [ ] **Step 3: Implement**

Add the interface near the other exported interfaces (top of `threads.service.ts`, alongside `ThreadsInsights` at line 43):

```typescript
export interface ThreadsMention {
  id: string;
  text: string | null;
  authorUsername: string | null;
  permalink: string | null;
  timestamp: string;
  mediaType: string | null;
}
```

Add the method to the class (mirror the `getUserProfile` fetch idiom, but return `[]` on error so old tokens without the scope degrade instead of throwing):

```typescript
  /**
   * Posts that @mention the connected account. Requires `threads_manage_mentions`.
   * Returns [] on permission errors so channels connected before the scope was
   * added degrade gracefully instead of failing the whole poll.
   */
  async getMentions(
    accessToken: string,
    userId: string,
    since?: Date,
  ): Promise<ThreadsMention[]> {
    const url = new URL(`${this.graphApiUrl}/${userId}/mentions`);
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set(
      'fields',
      'id,text,username,permalink,timestamp,media_type',
    );
    // API lower bound is 2023-07-05 (1688540400); never send anything earlier.
    if (since) {
      const sinceSec = Math.max(Math.floor(since.getTime() / 1000), 1688540400);
      url.searchParams.set('since', String(sinceSec));
    }

    const response = await fetch(url.toString());
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      this.logger.warn(
        `getMentions failed (userId=${userId}): ${error.error?.message ?? response.status}`,
      );
      return [];
    }

    const body = await response.json();
    const data: any[] = Array.isArray(body.data) ? body.data : [];
    return data.map((m) => ({
      id: String(m.id),
      text: m.text ?? null,
      authorUsername: m.username ?? null,
      permalink: m.permalink ?? null,
      timestamp: m.timestamp,
      mediaType: m.media_type ?? null,
    }));
  }
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test -- threads.service.mentions` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/channels/services/threads.service.ts src/channels/services/threads.service.mentions.spec.ts
git commit -m "feat(threads): getMentions service method with graceful degradation"
```

---

### Task 3: `ThreadsService.manageReply()` (hide/unhide)

**Files:**
- Modify: `src/channels/services/threads.service.ts`
- Test: `src/channels/services/threads.service.hide.spec.ts` (create)

**Interfaces:**
- Produces: `async manageReply(accessToken: string, replyId: string, hide: boolean): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/channels/services/threads.service.hide.spec.ts`:

```typescript
import { BadRequestException } from '@nestjs/common';
import { ThreadsService } from './threads.service';

describe('ThreadsService.manageReply', () => {
  const svc = new ThreadsService();
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('POSTs hide flag to manage_reply', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;
    global.fetch = jest.fn(async (url: string, init: any) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ success: true }) };
    }) as unknown as typeof fetch;

    await svc.manageReply('tok', 'reply99', true);
    expect(capturedUrl).toContain('/reply99/manage_reply');
    expect(capturedBody).toEqual({ access_token: 'tok', hide: true });
  });

  it('throws BadRequest on API error', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      json: async () => ({ error: { message: 'nope' } }),
    })) as unknown as typeof fetch;
    await expect(svc.manageReply('tok', 'r', false)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test -- threads.service.hide` → FAIL.

- [ ] **Step 3: Implement**

Add to `ThreadsService` (mirror the `publishThread` POST idiom):

```typescript
  /**
   * Hide (or unhide) a reply on one of our posts. Requires
   * `threads_manage_replies`. Hiding auto-hides all nested replies.
   */
  async manageReply(
    accessToken: string,
    replyId: string,
    hide: boolean,
  ): Promise<void> {
    const url = new URL(`${this.graphApiUrl}/${replyId}/manage_reply`);
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: accessToken, hide }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      this.logger.error('manageReply failed:', error);
      throw new BadRequestException(
        error.error?.message || 'Failed to hide/unhide reply',
      );
    }
  }
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test -- threads.service.hide` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/channels/services/threads.service.ts src/channels/services/threads.service.hide.spec.ts
git commit -m "feat(threads): manageReply service method (hide/unhide)"
```

---

### Task 4: Schema — `'mention'` type + `is_hidden` column + migration

**Files:**
- Modify: `src/drizzle/schema/inbox.schema.ts:21` (INBOX_ITEM_TYPES) and the table body (add column)
- Create: migration via `npm run db:generate`
- Test: `src/drizzle/schema/inbox.schema.spec.ts` (create)

**Interfaces:**
- Produces: `INBOX_ITEM_TYPES` includes `'mention'`; `inboxItems.isHidden` boolean column (default false).

- [ ] **Step 1: Write the failing test**

Create `src/drizzle/schema/inbox.schema.spec.ts`:

```typescript
import { INBOX_ITEM_TYPES, inboxItems } from './inbox.schema';

describe('inbox schema — mentions + hide', () => {
  it('includes the mention item type', () => {
    expect(INBOX_ITEM_TYPES).toContain('mention');
  });
  it('has an isHidden column', () => {
    expect(inboxItems.isHidden).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test -- inbox.schema` → FAIL.

- [ ] **Step 3: Edit the schema**

Line 21 — widen the const:

```typescript
export const INBOX_ITEM_TYPES = ['comment', 'dm', 'mention'] as const;
```

`type` is `varchar('type', { length: 10 })` — `'mention'` (7 chars) fits, no column change needed.

Add the hide column inside the table body, right after the `fromMe` column (line 88):

```typescript
    // Platform-side hidden state for a reply we moderated (Threads manage_reply).
    isHidden: boolean('is_hidden').default(false).notNull(),
```

- [ ] **Step 4: Generate + apply the migration**

Run: `npm run db:generate` (creates a new SQL migration adding `is_hidden`). Then `npm run db:migrate`.
Expected: a new file under `drizzle/migrations/` adding `is_hidden boolean not null default false`.

- [ ] **Step 5: Run the test, verify it passes**

Run: `npm test -- inbox.schema` → PASS. Also `npm run build` → compiles.

- [ ] **Step 6: Commit**

```bash
git add src/drizzle/schema/inbox.schema.ts src/drizzle/schema/inbox.schema.spec.ts drizzle/migrations/
git commit -m "feat(inbox): add 'mention' item type + is_hidden column"
```

---

### Task 5: Adapter interface + `ThreadsInboxAdapter` — `hideComment` + `fetchMentions`

**Files:**
- Modify: `src/inbox/adapters/inbox-adapter.interface.ts:112-115` (add two optional methods)
- Modify: `src/inbox/adapters/threads-inbox.adapter.ts` (implement both)
- Test: `src/inbox/adapters/threads-inbox.adapter.spec.ts` (create)

**Interfaces:**
- Consumes: `ThreadsService.getMentions`, `ThreadsService.manageReply` (Tasks 2-3); `FetchedComment` shape.
- Produces on `PlatformInboxAdapter`:
  ```typescript
  hideComment?(channel: ResolvedChannel, platformItemId: string, hidden: boolean): Promise<void>;
  fetchMentions?(channel: ResolvedChannel, since?: Date): Promise<FetchedComment[]>;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/inbox/adapters/threads-inbox.adapter.spec.ts`:

```typescript
import { ThreadsInboxAdapter } from './threads-inbox.adapter';
import type { ResolvedChannel } from './inbox-adapter.interface';

const channel: ResolvedChannel = {
  id: 1, workspaceId: 'w1', platform: 'threads',
  platformAccountId: 'acc1', accessToken: 'tok', metadata: {},
  username: 'schedura', accountName: 'Schedura', profilePictureUrl: null,
};

describe('ThreadsInboxAdapter mentions + hide', () => {
  it('fetchMentions maps mentions to FetchedComment', async () => {
    const threads = {
      getMentions: jest.fn().mockResolvedValue([
        { id: 'm1', text: 'hi @schedura', authorUsername: 'bob',
          permalink: 'p', timestamp: '2026-07-01T10:00:00+0000', mediaType: 'TEXT_POST' },
      ]),
    } as any;
    const adapter = new ThreadsInboxAdapter(threads);
    const out = await adapter.fetchMentions!(channel);
    expect(threads.getMentions).toHaveBeenCalledWith('tok', 'acc1', undefined);
    expect(out[0]).toMatchObject({
      platformItemId: 'm1', text: 'hi @schedura', authorHandle: 'bob', fromMe: false,
    });
  });

  it('hideComment calls manageReply', async () => {
    const threads = { manageReply: jest.fn().mockResolvedValue(undefined) } as any;
    const adapter = new ThreadsInboxAdapter(threads);
    await adapter.hideComment!(channel, 'reply5', true);
    expect(threads.manageReply).toHaveBeenCalledWith('tok', 'reply5', true);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test -- threads-inbox.adapter` → FAIL.

- [ ] **Step 3: Extend the interface**

In `src/inbox/adapters/inbox-adapter.interface.ts`, inside `PlatformInboxAdapter` (after the optional `deleteComment?` at line 115), add:

```typescript
  /**
   * Hide (or unhide) a reply on our post. Only implemented by platforms that
   * support server-side moderation (Threads). Service checks existence first.
   */
  hideComment?(
    channel: ResolvedChannel,
    platformItemId: string,
    hidden: boolean,
  ): Promise<void>;

  /**
   * Fetch posts that @mention our account. Only implemented by platforms with
   * a mentions API (Threads). Returns one FetchedComment per mention (no post
   * grouping — mentions ingest as inbox items of type 'mention').
   */
  fetchMentions?(
    channel: ResolvedChannel,
    since?: Date,
  ): Promise<FetchedComment[]>;
```

- [ ] **Step 4: Implement in the adapter**

In `src/inbox/adapters/threads-inbox.adapter.ts`, add two methods to the class (after `commentOnPost`):

```typescript
  async hideComment(
    channel: ResolvedChannel,
    platformItemId: string,
    hidden: boolean,
  ): Promise<void> {
    await this.threads.manageReply(channel.accessToken, platformItemId, hidden);
  }

  async fetchMentions(
    channel: ResolvedChannel,
    since?: Date,
  ): Promise<FetchedComment[]> {
    const mentions = await this.threads.getMentions(
      channel.accessToken,
      channel.platformAccountId,
      since,
    );
    return mentions.map((m) => ({
      platformItemId: m.id,
      platformParentId: null,
      authorHandle: m.authorUsername ?? undefined,
      authorDisplayName: m.authorUsername ?? undefined,
      text: m.text ?? '',
      platformCreatedAt: new Date(m.timestamp),
      fromMe: false,
      metadata: { permalink: m.permalink, mediaType: m.mediaType },
    }));
  }
```

Add `FetchedComment` to the type import at the top if not already imported.

- [ ] **Step 5: Run the test, verify it passes**

Run: `npm test -- threads-inbox.adapter` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/inbox/adapters/inbox-adapter.interface.ts src/inbox/adapters/threads-inbox.adapter.ts src/inbox/adapters/threads-inbox.adapter.spec.ts
git commit -m "feat(inbox): threads adapter hideComment + fetchMentions"
```

---

### Task 6: Inbox service — `upsertMention`, `hideComment`, mention polling

**Files:**
- Modify: `src/inbox/inbox.service.ts` (add `upsertMention`, `hideComment`; find `upsertComment` to mirror)
- Modify: `src/inbox/processors/inbox-poll.processor.ts:170-227` (fetch + upsert mentions once per Threads channel)
- Test: extend `src/inbox/inbox.service.spec.ts` if present, else create `src/inbox/inbox.service.hide.spec.ts`

**Interfaces:**
- Consumes: adapter `hideComment`, `fetchMentions` (Task 5); `inboxItems.isHidden`, `type='mention'` (Task 4).
- Produces: `inboxService.hideComment(workspaceId, userId, itemId, hidden): Promise<{ success: true; isHidden: boolean }>`; `inboxService.upsertMention(...)` (same param shape as `upsertComment` but sets `type: 'mention'`).

- [ ] **Step 1: `hideComment` service method (mirror `deleteComment` at lines 987-1055)**

Add to `InboxService`:

```typescript
  async hideComment(
    workspaceId: string,
    userId: string,
    itemId: string,
    hidden: boolean,
  ): Promise<{ success: true; isHidden: boolean }> {
    await this.assertWorkspaceAccess(workspaceId, userId);

    const row = await db.query.inboxItems.findFirst({
      where: and(
        eq(inboxItems.id, itemId),
        eq(inboxItems.workspaceId, workspaceId),
      ),
    });
    if (!row) throw new NotFoundException('Comment not found');

    const channel = await this.resolveChannel(row.channelId, workspaceId);
    const adapter = this.dispatcher.get(row.platform);
    if (!adapter.hideComment) {
      throw new BadRequestException(`Hide is not supported on ${row.platform}`);
    }

    try {
      await adapter.hideComment(channel, row.platformItemId, hidden);
    } catch (err) {
      this.logger.error(
        `Hide failed (channel=${row.channelId}, item=${row.platformItemId}): ${(err as Error).message}`,
      );
      throw new BadRequestException(
        `Platform refused hide: ${(err as Error).message}`,
      );
    }

    await db
      .update(inboxItems)
      .set({ isHidden: hidden, updatedAt: new Date() })
      .where(eq(inboxItems.id, row.id));

    this.emitter.emit(workspaceId, 'inbox.item.updated', {
      id: row.id,
      workspaceId,
      channelId: row.channelId,
      changes: { isHidden: hidden },
    });

    return { success: true, isHidden: hidden };
  }
```

- [ ] **Step 2: `upsertMention` service method**

Find `upsertComment` in `inbox.service.ts`. Add a sibling `upsertMention` that is identical EXCEPT it sets `type: 'mention'` and leaves `platformPostId`/`ourPostId` null. If `upsertComment` takes a params object, add an internal `type` param defaulting to `'comment'` and expose `upsertMention` as a thin wrapper passing `'mention'`. Keep the existing `unique_inbox_item_per_channel` dedup behavior (channelId + platformItemId).

- [ ] **Step 3: Poll mentions in the processor**

In `src/inbox/processors/inbox-poll.processor.ts`, after the per-post comment loop (after line 227's block, still inside the channel handler where `adapter` and `channel` are in scope), add:

```typescript
    // Threads mentions ingest as account-level items (not tied to a post).
    if (adapter.fetchMentions) {
      try {
        const mentions = await adapter.fetchMentions(channel, since);
        for (const m of mentions) {
          const inserted = await this.inboxService.upsertMention({
            workspaceId: channelRow.workspaceId,
            channelId,
            platform,
            platformItemId: m.platformItemId,
            platformParentId: m.platformParentId,
            authorHandle: m.authorHandle,
            authorDisplayName: m.authorDisplayName,
            authorAvatarUrl: m.authorAvatarUrl,
            text: m.text,
            platformCreatedAt: m.platformCreatedAt,
            fromMe: m.fromMe,
            metadata: m.metadata,
          });
          if (inserted) ingested += 1;
        }
      } catch (err) {
        this.logger.warn(
          `Mentions poll failed (channel=${channelId}): ${(err as Error).message}`,
        );
      }
    }
```

Match the exact param shape `upsertMention`/`upsertComment` expects (read the real `upsertComment` signature and mirror it).

- [ ] **Step 4: Test hide service**

Add a test that mocks `dispatcher.get` to return an adapter with `hideComment`, mocks `db` (or use the project's existing service-test harness pattern — check how `inbox.service.spec.ts` mocks `db`), and asserts the row is updated with `isHidden: true`. If the repo has no service-test harness for `InboxService`, cover hide via an adapter+service integration-style unit that stubs `resolveChannel` and `db.update`. Run: `npm test -- inbox.service` → PASS.

- [ ] **Step 5: Build + commit**

```bash
npm run build
git add src/inbox/inbox.service.ts src/inbox/processors/inbox-poll.processor.ts src/inbox/inbox.service.hide.spec.ts
git commit -m "feat(inbox): hideComment + upsertMention service + mention polling"
```

---

### Task 7: Controller — hide endpoint + mentions list endpoint

**Files:**
- Modify: `src/inbox/inbox.controller.ts` (add PATCH hide + GET mentions)
- Modify: `src/inbox/inbox.service.ts` (add `listMentions`; DTO for hide body)
- Create/Modify: a `HideDto` (mirror `UpdateStatusDto`)
- Test: extend controller/service specs as available

**Interfaces:**
- Consumes: `inboxService.hideComment` (Task 6), `inboxService.listComments` pattern.
- Produces HTTP: `PATCH inbox/workspaces/:workspaceId/comments/:itemId/hide` (body `{ hidden: boolean }`); `GET inbox/workspaces/:workspaceId/mentions` (returns a flat list of mention items).

- [ ] **Step 1: Hide DTO**

Alongside the existing DTOs (where `UpdateStatusDto` lives — check imports at top of `inbox.controller.ts`), add:

```typescript
export class HideDto {
  @IsBoolean()
  hidden: boolean;
}
```

- [ ] **Step 2: Hide endpoint** (mirror `updateStatus` at lines 92-105)

```typescript
  @Patch('comments/:itemId/hide')
  async hide(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: HideDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inboxService.hideComment(
      workspaceId,
      user.userId,
      itemId,
      dto.hidden,
    );
  }
```

- [ ] **Step 3: Mentions list endpoint**

```typescript
  @Get('mentions')
  async mentions(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query() query: ListCommentsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.inboxService.listMentions(workspaceId, user.userId, query);
  }
```

- [ ] **Step 4: `listMentions` service method**

Mirror `listComments` but filter `where type = 'mention'` (flat list — each mention item returned as its own row with `id, author, text, timestamp, permalink (from metadata), platformItemId, isHidden`). Return shape: `{ mentions: MentionItemDto[]; nextCursor: string | null }`. Define `MentionItemDto` accordingly.

- [ ] **Step 5: Build + verify + commit**

```bash
npm run build
npm test -- inbox
git add src/inbox/inbox.controller.ts src/inbox/inbox.service.ts
git commit -m "feat(inbox): hide + mentions list endpoints"
```

- [ ] **Step 6: Backend checkpoint**

Run the full backend build + test suite: `npm run build && npm test`. All green before starting frontend. **STOP and report to the controller here** (backend-first checkpoint per repo rules).

---

## Frontend

> Frontend has no component test runner (Vitest is for pure functions only). Verify each task with `npm run build` (tsc + vite) and note manual-check steps. All UI uses shadcn + lucide only.

### Task 8: Types + API client — mentions + hide

**Files:**
- Modify: `src/features/inbox/types/inbox.ts` (widen `ConversationType`; add `isHidden` to `CommentNode`; add `MentionItem`)
- Modify: `src/features/inbox/api/inbox.api.ts` (add `listMentions`, `hideComment`; `isHidden` on `InboxCommentNodeDto`)

**Interfaces:**
- Consumes: backend `GET .../mentions`, `PATCH .../comments/:id/hide`.
- Produces: `ConversationType = 'dm' | 'comment' | 'mention'`; `inboxApi.hideComment(workspaceId, itemId, hidden)`; `inboxApi.listMentions(workspaceId, params)`; `MentionItem` type.

- [ ] **Step 1: Types**

In `types/inbox.ts`: widen line 3 to `export type ConversationType = 'dm' | 'comment' | 'mention'`. Add `isHidden?: boolean` to `CommentNode` (line 88-115). Add:

```typescript
export interface MentionItem {
  id: string
  author: { handle: string; displayName: string; avatarUrl?: string }
  text: string
  timestamp: string
  permalink?: string
  platformItemId: string
  isHidden: boolean
  platform: SocialPlatform
  channelId: string
}
```

- [ ] **Step 2: API**

In `inbox.api.ts`: add `isHidden?: boolean` to `InboxCommentNodeDto` (line 5-21). Add to the `inboxApi` object:

```typescript
  listMentions: (workspaceId: string, params: ListCommentsParams = {}) =>
    apiClient.get<{ mentions: MentionItem[]; nextCursor: string | null }>(
      `/inbox/workspaces/${workspaceId}/mentions${buildQuery(
        params as Record<string, unknown>,
      )}`,
    ),

  hideComment: (workspaceId: string, itemId: string, hidden: boolean) =>
    apiClient.patch<{ success: true; isHidden: boolean }>(
      `/inbox/workspaces/${workspaceId}/comments/${itemId}/hide`,
      { hidden },
    ),
```

Import `MentionItem` from `../types/inbox`.

- [ ] **Step 3: Build + commit**

```bash
npm run build
git add src/features/inbox/types/inbox.ts src/features/inbox/api/inbox.api.ts
git commit -m "feat(inbox): mention + hide types and api client"
```

---

### Task 9: Hide/Unhide action on a comment

**Files:**
- Create: `src/features/inbox/hooks/use-hide-comment.ts` (mirror `use-delete-message.ts:10-36`)
- Modify: `src/features/inbox/components/comment-item.tsx:108-152` (add hide button + hidden styling)

**Interfaces:**
- Consumes: `inboxApi.hideComment`; `CommentNode.isHidden`.
- Produces: `useHideCommentMutation()` returning a mutation keyed on `{ itemId, hidden }`.

- [ ] **Step 1: Mutation hook** (mirror `useDeleteCommentMutation`)

```typescript
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useWorkspaceId } from '@/hooks/use-workspace-id'
import { inboxApi } from '../api/inbox.api'

export function useHideCommentMutation() {
  const workspaceId = useWorkspaceId()
  const qc = useQueryClient()

  return useMutation<
    { success: true; isHidden: boolean },
    Error,
    { itemId: string; hidden: boolean }
  >({
    mutationFn: ({ itemId, hidden }) => {
      if (!workspaceId) throw new Error('Workspace not ready')
      return inboxApi.hideComment(workspaceId, itemId, hidden)
    },
    onSuccess: (_d, vars) => {
      if (!workspaceId) return
      qc.invalidateQueries({
        predicate: (q) =>
          Array.isArray(q.queryKey) &&
          q.queryKey[0] === 'inbox' &&
          q.queryKey[1] === 'thread' &&
          q.queryKey[2] === workspaceId,
      })
      toast.success(vars.hidden ? 'Reply hidden' : 'Reply unhidden')
    },
    onError: (e) => toast.error(e.message),
  })
}
```

- [ ] **Step 2: Add the action to `comment-item.tsx`**

In the action row (lines 108-152), add a shadcn `DropdownMenu` (import from `@/components/ui/dropdown-menu`) with `MoreHorizontal` (lucide) trigger, containing a single item that toggles hide via `useHideCommentMutation`. Show it only for `fromMe === false` comments on comment threads (you hide OTHERS' replies). When `comment.isHidden`, render the comment body with `opacity-60 italic` and label "Hidden". Wire `onSelect` to `mutate({ itemId: comment.id, hidden: !comment.isHidden })`, `disabled` while pending, `e.stopPropagation()` so it doesn't open the sub-thread.

- [ ] **Step 3: Build + manual check + commit**

```bash
npm run build
```

Manual: open a comment thread, hide a reply → toast + row dims; unhide → restores.

```bash
git add src/features/inbox/hooks/use-hide-comment.ts src/features/inbox/components/comment-item.tsx
git commit -m "feat(inbox): hide/unhide reply action on comments"
```

---

### Task 10: Mentions tab — segmented control + list

**Files:**
- Modify: `src/features/inbox/components/inbox-tabs.tsx` (add third tab)
- Modify: `src/features/inbox/components/conversation-list.tsx:21,68-102` (support `'mention'` mode/heading)
- Modify: `src/features/inbox/components/inbox-view.tsx:59-117` (listMode/effectiveType + mentions count + pass to list)
- Create: `src/features/inbox/hooks/use-mentions.ts` (query `['inbox', 'list', workspaceId, 'mention', channelId, folder]`)

**Interfaces:**
- Consumes: `inboxApi.listMentions`; widened `ConversationType`.
- Produces: a working "Mentions" tab that lists mention items for Threads channels.

- [ ] **Step 1: `use-mentions.ts`** (mirror the comment branch of `use-conversations.ts:49-82`)

Query key `['inbox', 'list', workspaceId, 'mention', channelId, folder] as const`; `queryFn` calls `inboxApi.listMentions`; returns `{ mentions, isLoading, isError }`.

- [ ] **Step 2: Third tab in `inbox-tabs.tsx`**

Add a `TabButton` for Mentions with lucide `AtSign` icon, `label="Mentions"`, `count={mentionCount}`. Extend `InboxTabsProps` with `mentionCount?: number` and handle `value === 'mention'`.

- [ ] **Step 3: `conversation-list.tsx`**

Widen `ConversationListMode` to include `'mention'`. In the header block (lines 68-102) render the Mentions heading/icon for `mode === 'mention'`. Extend props with `mentionCount` and, since mentions are a flat list of `MentionItem` (not `Conversation`), render mention items via a small new `MentionListItem` (create `src/features/inbox/components/mention-list-item.tsx`) when `type === 'mention'`. Keep comment/DM rendering unchanged.

- [ ] **Step 4: `inbox-view.tsx`**

Update the capability derivation (lines 77-80): a Threads channel now `supportsComment && supportsMention`; `listMode` gains `'mention'` when only mentions apply, or include Mentions as a third tab when the channel supports it. Add `mentionsForCount` (mirror `commentsForCount`), compute `tabCounts.mentions`, and pass `mentionCount` + mention data into `<ConversationList>`. For a Threads channel, the tabs become Comments + Mentions.

- [ ] **Step 5: Build + manual check + commit**

```bash
npm run build
```

Manual: select a Threads channel → Comments + Mentions tabs appear; Mentions tab lists mention items.

```bash
git add src/features/inbox/components/inbox-tabs.tsx src/features/inbox/components/conversation-list.tsx src/features/inbox/components/inbox-view.tsx src/features/inbox/components/mention-list-item.tsx src/features/inbox/hooks/use-mentions.ts
git commit -m "feat(inbox): mentions tab + list"
```

---

### Task 11: Mention detail + reply

**Files:**
- Create: `src/features/inbox/components/mention-detail.tsx`
- Modify: `src/features/inbox/components/inbox-view.tsx` (render mention detail when a mention is selected)

**Interfaces:**
- Consumes: `MentionItem`; existing `RichReplyComposer`; a reply mutation (reuse `inboxApi.reply` — replying to a mention item posts a reply to that mention's thread; the backend `reply` uses the item's `platformItemId`).

- [ ] **Step 1: `mention-detail.tsx`**

A shadcn `Card`-based panel showing: author (avatar + handle), mention text, a "View on Threads" link (`metadata.permalink`, lucide `ExternalLink`), and a `RichReplyComposer` whose `onSend` calls a reply mutation targeting the mention's item id. Reuse the existing reply hook/mutation used by comment threads (it takes `itemId` + `text`).

- [ ] **Step 2: Wire selection in `inbox-view.tsx`**

When `effectiveType === 'mention'` and a mention is selected, render `<MentionDetail>` in the detail pane instead of `<CommentThreadView>`.

- [ ] **Step 3: Build + manual check + commit**

```bash
npm run build
```

Manual: open a mention → see the post + reply box; send a reply → appears on Threads.

```bash
git add src/features/inbox/components/mention-detail.tsx src/features/inbox/components/inbox-view.tsx
git commit -m "feat(inbox): mention detail view + reply"
```

---

## Post-implementation verification (live, for App Review screencasts)

1. Reconnect the Threads channel (new scopes require re-auth). Confirm the OAuth consent lists mentions + insights.
2. From a **tester account**, @mention the connected account → confirm it appears in the Mentions tab; reply from the app → appears on Threads. (Records the `threads_manage_mentions` video.)
3. On a reply to your post, Hide then Unhide → reflects on Threads. (Records the `threads_manage_replies` video.)
4. Open the Insights dashboard → real Threads follower + per-post metrics render. (Records the `threads_manage_insights` video.)

## Notes / risks

- **Mentions before approval only return tester-account mentions** — expected; use a tester account for the screencast.
- If `listMentions`/`upsertMention` needs a `platformPostId` (non-null) that the schema requires, note the column is nullable — mentions leave it null.
- If the real `upsertComment` signature differs from the assumed params object, mirror its exact shape in Task 6 rather than inventing one.
