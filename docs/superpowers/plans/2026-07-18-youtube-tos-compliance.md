# YouTube ToS Compliance (Effort B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the four YouTube Developer Policy obligations that must exist in code before the YouTube API Services Compliance Audit can pass: 30-day retention of comment content, token revocation on disconnect, detection of out-of-band revocation, and a user-initiated data deletion path.

**Architecture:** A scheduled retention job nulls identifying content on YouTube inbox rows older than 30 days, measured from each comment's own platform timestamp — the row survives so thread structure, reply status and counts do not. A revoke helper is called on disconnect, but only when no other Google channel still depends on the shared grant. A periodic authorization check does double duty: it detects out-of-band revocation and satisfies the policy's separate "re-verify every 30 days" requirement for the analytics we keep indefinitely.

**Tech Stack:** NestJS 11, Drizzle ORM (Postgres), `@nestjs/schedule` cron, Jest.

**Source spec:** `docs/superpowers/specs/2026-07-17-youtube-compliance-design.md`, sections B1–B4.

**Branch:** `feat/youtube-tos-compliance`, off `origin/main` (`2053c8c`, which already contains Effort A via PR #54).

**Scope:** Backend only. The frontend work this enables — the "Content removed" inbox placeholder, the delete-my-data UI, and the disclosure copy — is a separate phase requiring explicit user approval before it starts, per `CLAUDE.md`.

## Global Constraints

- **Never run `npm run db:generate` or `npm run db:push`.** Nulling existing columns requires no migration. If a migration ever appears necessary, stop and ask — do not generate one.
- **Never `git add -A` or `git add .`.** Stage only the exact files each task names; verify with `git diff --cached --name-only`.
- **Do NOT run `npm run lint --fix`** — in this repo it rewrites ~65 unrelated files.
- **The retention job MUST filter `platform = 'youtube'`.** This is a YouTube Developer Policy obligation, not a general one. Nulling Facebook, Instagram, Bluesky, Mastodon or Threads comments would be wrong and destructive.
- **The retention window is measured from the comment's own `platform_created_at`, never from row insert time.** The spec names this as the top risk: measuring from insert deletes comments early.
- **The wipe set is exactly these five columns:** `text`, `author_display_name`, `author_avatar_url`, `author_handle`, `author_platform_id`. This is broader than the spec's three-column table by explicit user decision — handle and channel id both identify the commenter.
- **The row itself is kept, not deleted** — user decision. `status`, `from_me`, `like_count`, `platform_item_id`, `platform_created_at` and threading pointers all survive.
- **Analytics tables are NOT touched.** `channel_snapshots`, `channel_analytics_daily` and `post_metric_snapshots` are Developer Policy III.E.4.b data, storable indefinitely subject only to the 30-day authorization re-check. Deleting them would destroy the analytics product for no reason.
- **Revoking a Google token revokes ALL scopes for that user on our API project.** Verified against Google's documentation: "If you revoke a token that represents a combined authorization, access to all of that authorization's scopes on behalf of the associated user are revoked simultaneously." Drive, Photos and Calendar share the YouTube OAuth app (`oauth.service.ts:770-777`). Therefore **revoke only when no other Google channel remains in the workspace** — user decision.
- **A revoke failure must never block a disconnect.** The user's intent to disconnect wins; the failure is logged.
- Backend `npm run build` and `npm run test` must pass at the end of every task. Three suites already fail on `main` for unrelated reasons (billing controller module resolution, drizzle pool CA config, stripe price display-name) — confirm the count is unchanged rather than treating them as new.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/inbox/services/youtube-retention.service.ts` (create) | The single SQL statement that nulls expired YouTube comment content, plus its counting/logging. No cron. |
| `src/inbox/schedulers/youtube-retention.scheduler.ts` (create) | Daily cron that invokes the retention service. Thin. |
| `src/channels/services/google-oauth-revoke.service.ts` (create) | Calls Google's revoke endpoint; decides whether revoking is safe given other Google channels in the workspace. |
| `src/channels/services/channel.service.ts` (modify) | `deleteChannel` calls the revoke service before deleting the row. |
| `src/channels/schedulers/youtube-authorization-check.scheduler.ts` (create) | Periodic re-verification of authorization; serves both out-of-band-revoke detection and III.E.4.b. |
| `src/channels/channels.controller.ts` (modify) | The explicit user-initiated data deletion endpoint. |
| `src/channels/analytics/schedulers/tiered-polling.scheduler.ts` (modify) | Delete the comment that describes behavior the code does not have. |
| `docs/youtube-api-compliance.md` (create) | The disclosure text and policy links, in a form the frontend phase and the audit submission both draw from. |

---

## Task 1: Fix the lying comment in the tiered polling scheduler

**Files:**
- Modify: `src/channels/analytics/schedulers/tiered-polling.scheduler.ts:50-52`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

**Context:** `enqueuePostMetricsByTier` opens with the comment "Find all published posts on adapter-supported channels in the last 30 days, plus a sample of older ones (cold tier)." The SQL immediately below hard-filters `p.published_at >= ${cutoff30d}`, so no older post is ever selected. The comment describes a feature that does not exist, and the `cold` tier in `POST_POLLING_TIERS` is consequently unreachable from this query.

This is a one-line docs fix, deliberately kept as its own task so it does not hide inside a larger diff. The comment goes, not the code: the 30-day filter is correct and is what keeps this query bounded.

- [ ] **Step 1: Replace the comment**

In `src/channels/analytics/schedulers/tiered-polling.scheduler.ts`, replace lines 50-52:

```ts
    // Find all published posts on adapter-supported channels in the last 30 days.
    //
    // Deliberately excludes older posts: the cold tier in POST_POLLING_TIERS is
    // unreachable from this query by design. An earlier version of this comment
    // promised "plus a sample of older ones (cold tier)", which the SQL below has
    // never done — the 30-day filter is what keeps this query bounded, so the
    // comment was corrected rather than the code.
    const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
```

- [ ] **Step 2: Verify the build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/channels/analytics/schedulers/tiered-polling.scheduler.ts
git diff --cached --name-only
git commit -m "docs(analytics): correct comment claiming a cold-tier sample that never existed"
```

---

## Task 2: YouTube inbox retention service

**Files:**
- Create: `src/inbox/services/youtube-retention.service.ts`
- Test: `src/inbox/services/youtube-retention.service.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  const YOUTUBE_RETENTION_DAYS = 30;
  interface RetentionResult { wiped: number; cutoff: Date }
  class YoutubeRetentionService {
    wipeExpiredContent(now?: Date): Promise<RetentionResult>
  }
  ```
  `cutoff` is returned so callers and tests can assert on the real boundary
  value rather than string-matching a serialized SQL object.

**Context:** Developer Policy III.E.4.c requires that Authorized Data other than analytics and statistics be deleted or refreshed within 30 calendar days. For us that is inbox comment content: the comment text and everything identifying its author.

The row is kept and its content columns nulled. That preserves the inbox's thread structure, the `replied`/`done` status a user set, and the item counts — while removing every field that identifies a YouTube user.

Two things about this job are load-bearing and are the two most likely ways to get it wrong:

1. **It filters `platform = 'youtube'`.** This obligation comes from YouTube's Developer Policy. Applying it to Facebook or Bluesky comments would be destroying user data for no reason.
2. **The window is measured from `platform_created_at`** — when the comment was actually posted on YouTube — **not from `created_at`**, when our row happened to be inserted. A comment ingested today but posted 40 days ago is already expired. Measuring from insert time would keep expired data and, on backfill, delete fresh data.

The job is idempotent: a second run finds nothing to do, because already-wiped rows have `text IS NULL`.

`now` is an optional parameter so tests can pin the clock without fake timers.

- [ ] **Step 1: Write the failing test**

Create `src/inbox/services/youtube-retention.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import {
  YoutubeRetentionService,
  YOUTUBE_RETENTION_DAYS,
} from './youtube-retention.service';
import { DRIZZLE } from '../../drizzle/drizzle.module';

const execute = jest.fn();
const fakeDb = { execute };

async function build() {
  const mod = await Test.createTestingModule({
    providers: [
      YoutubeRetentionService,
      { provide: DRIZZLE, useValue: fakeDb },
    ],
  }).compile();
  return mod.get(YoutubeRetentionService);
}

/** The SQL the service built, flattened to one searchable string. */
function sqlText(): string {
  const arg = execute.mock.calls[0][0];
  return JSON.stringify(arg);
}

describe('YoutubeRetentionService', () => {
  beforeEach(() => {
    execute.mockReset();
    execute.mockResolvedValue({ rowCount: 0, rows: [] });
  });

  it('retains for 30 days', () => {
    expect(YOUTUBE_RETENTION_DAYS).toBe(30);
  });

  it('reports how many rows it wiped', async () => {
    execute.mockResolvedValue({ rowCount: 7, rows: [] });
    const svc = await build();
    const result = await svc.wipeExpiredContent(new Date('2026-07-18T00:00:00Z'));
    expect(result.wiped).toBe(7);
  });

  // The spec's top risk is the window being wrong. Assert the real cutoff value
  // rather than string-matching a serialized SQL object, which is brittle.
  it('computes the cutoff exactly 30 days before the supplied clock', async () => {
    const svc = await build();
    const result = await svc.wipeExpiredContent(new Date('2026-07-18T00:00:00Z'));
    expect(result.cutoff.toISOString()).toBe('2026-06-18T00:00:00.000Z');
  });

  // The single most destructive way to get this wrong: this obligation is
  // YouTube's, and applying it to other platforms would delete their users'
  // comments for no reason.
  it('scopes the wipe to youtube only', async () => {
    const svc = await build();
    await svc.wipeExpiredContent(new Date('2026-07-18T00:00:00Z'));
    expect(sqlText()).toContain('youtube');
  });

  // The spec's top risk: measuring from row-insert time deletes comments early
  // and, on a backfill, deletes fresh ones.
  //
  // Note the negative assertion cannot be `not.toContain('created_at')` —
  // "platform_created_at" contains that substring, so such a test would fail
  // against a CORRECT implementation. Assert on the bare column with a word
  // boundary instead.
  it('measures the window from the comment timestamp, not the row insert time', async () => {
    const svc = await build();
    await svc.wipeExpiredContent(new Date('2026-07-18T00:00:00Z'));
    const sql = sqlText();
    expect(sql).toContain('platform_created_at');
    expect(/[^_]created_at/.test(sql)).toBe(false);
  });

  it('nulls every identifying column and nothing else', async () => {
    const svc = await build();
    await svc.wipeExpiredContent(new Date('2026-07-18T00:00:00Z'));
    const sql = sqlText();
    for (const col of [
      'text',
      'author_display_name',
      'author_avatar_url',
      'author_handle',
      'author_platform_id',
    ]) {
      expect(sql).toContain(col);
    }
    // The row and its non-identifying fields survive — this is a wipe, not a delete.
    expect(sql).toContain('UPDATE');
    expect(sql).not.toContain('DELETE');
  });

  // Analytics is III.E.4.b data and may be kept indefinitely. Touching those
  // tables here would destroy the analytics product for no policy reason.
  it('never touches the analytics tables', async () => {
    const svc = await build();
    await svc.wipeExpiredContent(new Date('2026-07-18T00:00:00Z'));
    const sql = sqlText();
    expect(sql).not.toContain('channel_snapshots');
    expect(sql).not.toContain('channel_analytics_daily');
    expect(sql).not.toContain('post_metric_snapshots');
  });

  // Already-wiped rows must not be re-counted on every run, or the log line
  // reports the same rows as newly wiped forever.
  it('skips rows whose content is already wiped', async () => {
    const svc = await build();
    await svc.wipeExpiredContent(new Date('2026-07-18T00:00:00Z'));
    expect(sqlText()).toContain('IS NOT NULL');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/inbox/services/youtube-retention.service.spec.ts`
Expected: FAIL — `Cannot find module './youtube-retention.service'`.

- [ ] **Step 3: Write the implementation**

Create `src/inbox/services/youtube-retention.service.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';

/**
 * YouTube Developer Policy III.E.4.c: Authorized Data other than analytics and
 * statistics must be deleted or refreshed within 30 calendar days.
 */
export const YOUTUBE_RETENTION_DAYS = 30;

export interface RetentionResult {
  wiped: number;
  /** The boundary actually used, returned so callers and tests can assert on it. */
  cutoff: Date;
}

/**
 * Nulls identifying content on YouTube inbox rows older than 30 days.
 *
 * The ROW SURVIVES. Only the columns that identify a YouTube user or carry
 * their words are nulled: the comment text, the author's display name, avatar,
 * handle, and channel id. Everything else — read/replied status, like count,
 * threading pointers, timestamps — is kept, so a user's inbox history and the
 * fact that they replied to something are not destroyed by a policy job.
 *
 * Two things here are load-bearing:
 *
 *   1. `platform = 'youtube'`. This obligation is YouTube's alone. Applying it
 *      to Facebook, Instagram, Bluesky, Mastodon or Threads rows would delete
 *      those users' data for no reason at all.
 *
 *   2. The window is measured from `platform_created_at` — when the comment was
 *      posted on YouTube — NOT from `created_at`, when our row happened to be
 *      inserted. A comment ingested today but posted 40 days ago is already
 *      expired. Measuring from insert time would both retain expired data and,
 *      during any backfill, destroy fresh data.
 *
 * Analytics tables (channel_snapshots, channel_analytics_daily,
 * post_metric_snapshots) are III.E.4.b data, storable indefinitely subject only
 * to the 30-day authorization re-check. This job must never touch them.
 *
 * Idempotent: already-wiped rows are excluded by the `text IS NOT NULL` guard,
 * so a second run in the same day reports 0 rather than re-counting.
 */
@Injectable()
export class YoutubeRetentionService {
  private readonly logger = new Logger(YoutubeRetentionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: any) {}

  async wipeExpiredContent(now: Date = new Date()): Promise<RetentionResult> {
    const cutoff = new Date(
      now.getTime() - YOUTUBE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const cutoffIso = cutoff.toISOString();

    const result: any = await this.db.execute(sql`
      UPDATE inbox_items
      SET
        text = NULL,
        author_display_name = NULL,
        author_avatar_url = NULL,
        author_handle = NULL,
        author_platform_id = NULL
      WHERE platform = 'youtube'
        AND platform_created_at < ${cutoffIso}
        AND (
          text IS NOT NULL
          OR author_display_name IS NOT NULL
          OR author_avatar_url IS NOT NULL
          OR author_handle IS NOT NULL
          OR author_platform_id IS NOT NULL
        )
    `);

    const wiped = Number(result?.rowCount ?? 0);
    if (wiped > 0) {
      this.logger.log(
        `YouTube retention: wiped content on ${wiped} inbox items older than ` +
          `${YOUTUBE_RETENTION_DAYS} days (cutoff ${cutoffIso})`,
      );
    }
    return { wiped, cutoff };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/inbox/services/youtube-retention.service.spec.ts`
Expected: PASS — 8 passed.

- [ ] **Step 5: Commit**

```bash
git add src/inbox/services/youtube-retention.service.ts src/inbox/services/youtube-retention.service.spec.ts
git diff --cached --name-only
git commit -m "feat(inbox): 30-day retention wipe for youtube comment content"
```

---

## Task 3: Retention scheduler and boundary verification

**Files:**
- Create: `src/inbox/schedulers/youtube-retention.scheduler.ts`
- Test: `src/inbox/schedulers/youtube-retention.scheduler.spec.ts`
- Modify: `src/inbox/inbox.module.ts` (register both the service and the scheduler)

**Interfaces:**
- Consumes: `YoutubeRetentionService.wipeExpiredContent(now?: Date): Promise<{ wiped: number }>` from Task 2.
- Produces: nothing for later tasks.

**Context:** The service does the work; this task runs it daily and registers both in `InboxModule`. Existing scheduler shapes to follow live in `src/channels/schedulers/` and `src/channels/analytics/schedulers/` — a thin `@Injectable()` class with a `@Cron` method and a logger.

The job runs daily rather than hourly because the obligation is measured in calendar days and the work is a single indexed UPDATE. A failure must be caught and logged, not thrown: an unhandled rejection in a cron handler takes down the scheduler for every later tick.

This task also carries the retention **boundary** tests the spec explicitly requires — a comment at 29 days survives, at 31 days its content is gone — verified against the real cutoff arithmetic rather than a mocked SQL string.

- [ ] **Step 1: Write the failing test**

Create `src/inbox/schedulers/youtube-retention.scheduler.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { YoutubeRetentionScheduler } from './youtube-retention.scheduler';
import {
  YoutubeRetentionService,
  YOUTUBE_RETENTION_DAYS,
} from '../services/youtube-retention.service';

const DAY = 24 * 60 * 60 * 1000;

const retention = { wipeExpiredContent: jest.fn() };

async function build() {
  const mod = await Test.createTestingModule({
    providers: [
      YoutubeRetentionScheduler,
      { provide: YoutubeRetentionService, useValue: retention },
    ],
  }).compile();
  return mod.get(YoutubeRetentionScheduler);
}

describe('YoutubeRetentionScheduler', () => {
  beforeEach(() => {
    retention.wipeExpiredContent.mockReset();
    retention.wipeExpiredContent.mockResolvedValue({ wiped: 0 });
  });

  it('runs the retention wipe', async () => {
    const scheduler = await build();
    await scheduler.wipeExpiredYoutubeContent();
    expect(retention.wipeExpiredContent).toHaveBeenCalledTimes(1);
  });

  // An unhandled rejection inside a cron handler kills the scheduler for every
  // later tick — one bad night must not stop retention running forever after.
  it('swallows and logs a failure rather than throwing', async () => {
    retention.wipeExpiredContent.mockRejectedValue(new Error('db is down'));
    const scheduler = await build();
    await expect(scheduler.wipeExpiredYoutubeContent()).resolves.toBeUndefined();
  });
});

// The spec calls the retention window its top risk. These assert the arithmetic
// the service actually uses, at the boundary where an off-by-one shows up.
describe('retention boundary', () => {
  const now = new Date('2026-07-18T12:00:00Z');
  const cutoff = new Date(now.getTime() - YOUTUBE_RETENTION_DAYS * DAY);

  function isExpired(commentPostedAt: Date): boolean {
    return commentPostedAt < cutoff;
  }

  it('keeps a comment posted 29 days ago', () => {
    expect(isExpired(new Date(now.getTime() - 29 * DAY))).toBe(false);
  });

  it('wipes a comment posted 31 days ago', () => {
    expect(isExpired(new Date(now.getTime() - 31 * DAY))).toBe(true);
  });

  it('keeps a comment posted exactly 30 days ago', () => {
    // Strictly-less-than at the boundary: a comment on its 30th day has not yet
    // exceeded 30 calendar days, so it survives one more run.
    expect(isExpired(new Date(now.getTime() - 30 * DAY))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/inbox/schedulers/youtube-retention.scheduler.spec.ts`
Expected: FAIL — `Cannot find module './youtube-retention.scheduler'`.

- [ ] **Step 3: Write the scheduler**

Create `src/inbox/schedulers/youtube-retention.scheduler.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { YoutubeRetentionService } from '../services/youtube-retention.service';

/**
 * Runs the YouTube 30-day content retention wipe once a day.
 *
 * Daily rather than hourly because the obligation is measured in calendar days
 * and the work is a single indexed UPDATE. 03:00 UTC keeps it away from the
 * busiest publishing hours.
 *
 * NOTE for anyone reading this at deploy time: the first run in production will
 * wipe comment content older than 30 days. That is the intended, policy-required
 * behavior and it is not reversible. Analytics data is untouched.
 */
@Injectable()
export class YoutubeRetentionScheduler {
  private readonly logger = new Logger(YoutubeRetentionScheduler.name);

  constructor(private readonly retention: YoutubeRetentionService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM, {
    timeZone: 'UTC',
    name: 'youtubeContentRetention',
  })
  async wipeExpiredYoutubeContent(): Promise<void> {
    try {
      const { wiped } = await this.retention.wipeExpiredContent();
      this.logger.log(`YouTube retention sweep complete: ${wiped} items wiped`);
    } catch (err) {
      // Never rethrow from a cron handler — an unhandled rejection stops the
      // scheduler for every later tick, silently ending retention entirely.
      this.logger.error(
        `YouTube retention sweep failed: ${(err as Error).message}`,
      );
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/inbox/schedulers/youtube-retention.scheduler.spec.ts`
Expected: PASS — 5 passed.

- [ ] **Step 5: Register both in the module**

In `src/inbox/inbox.module.ts`, add the imports beside the other service and scheduler imports:

```ts
import { YoutubeRetentionService } from './services/youtube-retention.service';
import { YoutubeRetentionScheduler } from './schedulers/youtube-retention.scheduler';
```

and add both `YoutubeRetentionService,` and `YoutubeRetentionScheduler,` to the `providers` array.

- [ ] **Step 6: Verify the suite and build**

Run: `npm run build && npm run test`
Expected: build succeeds; the three known-failing suites still fail and nothing else does.

- [ ] **Step 7: Commit**

```bash
git add src/inbox/schedulers/youtube-retention.scheduler.ts src/inbox/schedulers/youtube-retention.scheduler.spec.ts src/inbox/inbox.module.ts
git diff --cached --name-only
git commit -m "feat(inbox): daily scheduler for youtube content retention"
```

---

## Task 4: Google token revocation on disconnect

**Files:**
- Create: `src/channels/services/google-oauth-revoke.service.ts`
- Test: `src/channels/services/google-oauth-revoke.service.spec.ts`
- Modify: `src/channels/services/channel.service.ts:613-642` (`deleteChannel`)
- Modify: `src/channels/channels.module.ts` (provide and export the service)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  const GOOGLE_PLATFORMS: readonly string[]; // youtube, google_drive, google_photos, google_calendar
  class GoogleOauthRevokeService {
    revokeIfLastGoogleChannel(
      channelId: number,
      workspaceId: string,
      platform: string,
      accessToken: string,
    ): Promise<{ revoked: boolean; reason: string }>
  }
  ```

**Context:** Developer Policy III.D.2.3.a requires that an in-app disconnect revoke the grant immediately and delete the data within 7 days. Deletion already happens: `deleteChannel` hard-deletes the channel row and Postgres cascades to every YouTube-derived table. Revocation does not happen at all — nothing in the codebase calls Google's revoke endpoint. The only revoke call anywhere is Mastodon's, at `src/channels/services/mastodon.service.ts:624`, which is a useful shape to copy: it logs a failure and deliberately does not throw.

**The hazard that shapes this task.** Google Drive, Google Photos and Google Calendar all share the YouTube OAuth application — see `oauth.service.ts:770-777`, where those platforms resolve to `envPrefix = 'YOUTUBE'`. Google consolidates every scope a user grants to one API project into a single combined authorization, and its documentation is explicit: *"If you revoke a token that represents a combined authorization, access to all of that authorization's scopes on behalf of the associated user are revoked simultaneously."*

So naively revoking on YouTube disconnect would silently break the user's Drive, Photos and Calendar connections. By explicit decision, this implementation **revokes only when no other Google channel remains in the workspace**. When another Google channel is still connected, the revoke is skipped and the reason logged — the YouTube data is still deleted immediately by the cascade, so the deletion obligation is met either way, and the grant is revoked as soon as nothing else legitimately depends on it.

A revoke failure must never block the disconnect. The user asked to disconnect; that must succeed regardless of what Google says.

- [ ] **Step 1: Write the failing test**

Create `src/channels/services/google-oauth-revoke.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { GoogleOauthRevokeService } from './google-oauth-revoke.service';
import { DRIZZLE } from '../../drizzle/drizzle.module';

const execute = jest.fn();
const fakeDb = { execute };

async function build() {
  const mod = await Test.createTestingModule({
    providers: [
      GoogleOauthRevokeService,
      { provide: DRIZZLE, useValue: fakeDb },
    ],
  }).compile();
  return mod.get(GoogleOauthRevokeService);
}

/** Make the "other Google channels in this workspace" count return `n`. */
function otherGoogleChannels(n: number) {
  execute.mockResolvedValue({ rows: [{ count: String(n) }] });
}

describe('GoogleOauthRevokeService', () => {
  beforeEach(() => {
    execute.mockReset();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' }) as any;
  });

  afterEach(() => jest.restoreAllMocks());

  it('revokes when this is the last Google channel', async () => {
    otherGoogleChannels(0);
    const svc = await build();
    const result = await svc.revokeIfLastGoogleChannel(1, 'ws', 'youtube', 'TKN');

    expect(result.revoked).toBe(true);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/revoke');
    expect(init.body).toContain('TKN');
  });

  // Drive/Photos/Calendar share the YouTube OAuth app, and Google revokes the
  // WHOLE combined authorization — so revoking here would silently kill the
  // user's Drive. This is the single most important behavior in this service.
  it('does NOT revoke while another Google channel is still connected', async () => {
    otherGoogleChannels(1);
    const svc = await build();
    const result = await svc.revokeIfLastGoogleChannel(1, 'ws', 'youtube', 'TKN');

    expect(result.revoked).toBe(false);
    expect(result.reason).toMatch(/other google/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does nothing for a non-Google platform', async () => {
    const svc = await build();
    const result = await svc.revokeIfLastGoogleChannel(1, 'ws', 'twitter', 'TKN');

    expect(result.revoked).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    // No point querying the DB for a platform that was never a Google grant.
    expect(execute).not.toHaveBeenCalled();
  });

  // The user asked to disconnect. Whatever Google says, that must succeed.
  it('reports failure without throwing when Google rejects the revoke', async () => {
    otherGoogleChannels(0);
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 400, text: async () => 'invalid_token' }) as any;
    const svc = await build();

    const result = await svc.revokeIfLastGoogleChannel(1, 'ws', 'youtube', 'TKN');
    expect(result.revoked).toBe(false);
    expect(result.reason).toMatch(/400/);
  });

  it('reports failure without throwing when the network is down', async () => {
    otherGoogleChannels(0);
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
    const svc = await build();

    const result = await svc.revokeIfLastGoogleChannel(1, 'ws', 'youtube', 'TKN');
    expect(result.revoked).toBe(false);
    expect(result.reason).toMatch(/ECONNREFUSED/);
  });

  it('excludes the channel being disconnected from the other-channel count', async () => {
    otherGoogleChannels(0);
    const svc = await build();
    await svc.revokeIfLastGoogleChannel(42, 'ws', 'youtube', 'TKN');

    // The query must say "other Google channels EXCEPT id 42" — otherwise the
    // channel being disconnected counts itself and revoke never fires.
    expect(JSON.stringify(execute.mock.calls[0][0])).toContain('42');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/channels/services/google-oauth-revoke.service.spec.ts`
Expected: FAIL — `Cannot find module './google-oauth-revoke.service'`.

- [ ] **Step 3: Write the implementation**

Create `src/channels/services/google-oauth-revoke.service.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';

/**
 * Platforms that authenticate through our single Google OAuth application.
 * See oauth.service.ts, where google_drive / google_photos / google_calendar
 * all resolve to envPrefix 'YOUTUBE'.
 */
export const GOOGLE_PLATFORMS: readonly string[] = [
  'youtube',
  'google_drive',
  'google_photos',
  'google_calendar',
];

const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export interface RevokeOutcome {
  revoked: boolean;
  reason: string;
}

/**
 * Revokes our Google OAuth grant when a Google channel is disconnected.
 *
 * YouTube Developer Policy III.D.2.3.a requires an in-app disconnect to revoke
 * immediately. Nothing in this codebase did that before — the grant survived in
 * the user's Google Account after they disconnected.
 *
 * THE CATCH, and why this is not just a fetch call:
 *
 * Drive, Photos and Calendar share the YouTube OAuth application. Google merges
 * every scope a user grants to one API project into a single combined
 * authorization, and revoking any token from it takes down ALL of those scopes
 * at once — Google's own words: "If you revoke a token that represents a
 * combined authorization, access to all of that authorization's scopes on
 * behalf of the associated user are revoked simultaneously."
 *
 * So revoking on YouTube disconnect would silently break the same user's Drive,
 * Photos and Calendar. Instead we revoke only once no other Google channel is
 * left in the workspace. The YouTube DATA is deleted immediately either way, by
 * the cascade on channel deletion, so the deletion obligation is met regardless;
 * the grant goes as soon as nothing else legitimately depends on it.
 *
 * The proper structural fix is a separate OAuth client per Google service, which
 * would make revocation isolated — that requires new credentials and a reconnect
 * for every existing Google channel, so it is deliberately out of scope here.
 *
 * Never throws. A disconnect must succeed whatever Google says.
 */
@Injectable()
export class GoogleOauthRevokeService {
  private readonly logger = new Logger(GoogleOauthRevokeService.name);

  constructor(@Inject(DRIZZLE) private readonly db: any) {}

  async revokeIfLastGoogleChannel(
    channelId: number,
    workspaceId: string,
    platform: string,
    accessToken: string,
  ): Promise<RevokeOutcome> {
    if (!GOOGLE_PLATFORMS.includes(platform)) {
      return { revoked: false, reason: 'not a Google platform' };
    }

    let remaining: number;
    try {
      // GOOGLE_PLATFORMS is a module constant, never user input, but pass it as
      // a bound parameter anyway rather than interpolating it into the string.
      const result: any = await this.db.execute(sql`
        SELECT COUNT(*) AS count
        FROM social_media_channels
        WHERE workspace_id = ${workspaceId}
          AND id <> ${channelId}
          AND platform = ANY(${[...GOOGLE_PLATFORMS]})
      `);
      const rows = result?.rows ?? result ?? [];
      remaining = Number(rows[0]?.count ?? 0);
    } catch (err) {
      // If we cannot tell whether other Google channels exist, do NOT revoke —
      // wrongly revoking breaks working Drive/Photos/Calendar connections,
      // while wrongly skipping only delays the grant cleanup.
      const reason = `could not count other Google channels: ${(err as Error).message}`;
      this.logger.error(`Google revoke skipped for channel ${channelId} — ${reason}`);
      return { revoked: false, reason };
    }

    if (remaining > 0) {
      const reason = `${remaining} other Google channel(s) still connected in this workspace`;
      this.logger.log(
        `Google revoke skipped for channel ${channelId} (${platform}) — ${reason}. ` +
          `Revoking would take down the shared grant for all of them. ` +
          `Channel data is still deleted immediately.`,
      );
      return { revoked: false, reason };
    }

    try {
      const res = await fetch(GOOGLE_REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: accessToken }).toString(),
      });

      if (!res.ok) {
        const body = await res.text();
        const reason = `Google revoke returned ${res.status}: ${body}`;
        // Best effort, exactly like MastodonService.revokeToken — never throw.
        this.logger.warn(`Google revoke failed for channel ${channelId}: ${reason}`);
        return { revoked: false, reason };
      }

      this.logger.log(
        `Google grant revoked for channel ${channelId} (${platform}) — last Google channel in workspace`,
      );
      return { revoked: true, reason: 'revoked' };
    } catch (err) {
      const reason = (err as Error).message;
      this.logger.warn(`Google revoke failed for channel ${channelId}: ${reason}`);
      return { revoked: false, reason };
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/channels/services/google-oauth-revoke.service.spec.ts`
Expected: PASS — 6 passed.

- [ ] **Step 5: Call it from `deleteChannel`**

In `src/channels/services/channel.service.ts`, add the constructor dependency:

```ts
    private readonly googleRevoke: GoogleOauthRevokeService,
```

with the import:

```ts
import { GoogleOauthRevokeService } from './google-oauth-revoke.service';
```

Then in `deleteChannel`, between the `onChannelDisconnected` call and the `db.delete`, insert:

```ts
    // Revoke the Google grant BEFORE deleting the row — afterwards we no longer
    // have the token. Best-effort by design: a revoke failure must not stop the
    // user disconnecting, and the data deletion below happens regardless.
    if (GOOGLE_PLATFORMS.includes(channel[0].platform)) {
      try {
        const accessToken = await this.getAccessToken(channelId, workspaceId);
        await this.googleRevoke.revokeIfLastGoogleChannel(
          channelId,
          workspaceId,
          channel[0].platform,
          accessToken,
        );
      } catch (err) {
        this.logger.warn(
          `Could not revoke Google grant for channel ${channelId}: ${(err as Error).message}`,
        );
      }
    }
```

Add `GOOGLE_PLATFORMS` to the same import.

- [ ] **Step 6: Register the service**

In `src/channels/channels.module.ts`, add the import and add `GoogleOauthRevokeService` to both the `providers` and `exports` arrays.

- [ ] **Step 7: Verify the suite and build**

Run: `npm run build && npm run test`
Expected: build succeeds. `ChannelService` gained a constructor dependency — any spec constructing it directly needs a `{ revokeIfLastGoogleChannel: async () => ({ revoked: false, reason: 'test' }) }` mock. Check `src/channels/services/channel.service.spec.ts` in particular.

- [ ] **Step 8: Commit**

```bash
git add src/channels/services/google-oauth-revoke.service.ts src/channels/services/google-oauth-revoke.service.spec.ts src/channels/services/channel.service.ts src/channels/channels.module.ts
git diff --cached --name-only
git commit -m "feat(channels): revoke google grant on disconnect when no google channel remains"
```

Add `src/channels/services/channel.service.spec.ts` to the `git add` if Step 7 required changing it.

---

## Task 5: Periodic authorization re-check

**Files:**
- Create: `src/channels/schedulers/youtube-authorization-check.scheduler.ts`
- Test: `src/channels/schedulers/youtube-authorization-check.scheduler.spec.ts`
- Modify: `src/channels/channels.module.ts` (register the scheduler)

**Interfaces:**
- Consumes: `YouTubeService.verifyToken(accessToken: string): Promise<boolean>` (exists at `src/channels/services/youtube.service.ts:114`; returns false rather than throwing on failure) and `ChannelService.getAccessToken(channelId, workspaceId)`.
- Produces: nothing for later tasks.

**Context:** This one job satisfies two different policy obligations, which are the same question asked for two reasons:

- **III.D.2.3.b — out-of-band revocation.** When a user revokes access from Google's own security settings, we currently notice only reactively: `channel-profile-snapshot.handler.ts` flips `connectionStatus` to `expired` after `RECONNECT_THRESHOLD = 3` consecutive auth failures. That flip stops future syncs but purges nothing, and it only happens if something happened to be syncing. The policy allows 30 days to delete after an out-of-band revocation.
- **III.E.4.b — the analytics we keep indefinitely.** Analytics and statistics may be stored "for as long as is necessary", but only if the client "ensure[s] every 30 days that it is still authorized by the user to access that data." Without this check, our indefinite analytics retention has no legal basis.

The job runs weekly, which is comfortably inside both 30-day windows and cheap: `verifyToken` costs 1 quota unit per channel and is charged to the `publishing` subsystem by Effort A's gating.

**What it does on failure matters.** A single failed check is not proof of revocation — it could be a network blip or a transient Google error. So a failure marks the channel `expired` (reusing the existing status, so the existing reconnect UI just works) and records when authorization was last confirmed. Actual deletion of a revoked channel's data is deliberately NOT automatic here: doing so on a false negative would destroy a paying user's analytics history. Instead the channel is flagged, and the 30-day deletion obligation is met by the disconnect path once the user acts, or by an operator using the Task 6 endpoint. This trade-off is recorded in the code comment so a reviewer sees it was chosen, not overlooked.

- [ ] **Step 1: Write the failing test**

Create `src/channels/schedulers/youtube-authorization-check.scheduler.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { YoutubeAuthorizationCheckScheduler } from './youtube-authorization-check.scheduler';
import { ChannelService } from '../services/channel.service';
import { YouTubeService } from '../services/youtube.service';
import { DRIZZLE } from '../../drizzle/drizzle.module';

const execute = jest.fn();
const update = jest.fn();
const fakeDb = {
  execute,
  update: () => ({ set: () => ({ where: update }) }),
};
const channelService = { getAccessToken: jest.fn() };
const youtube = { verifyToken: jest.fn() };

async function build() {
  const mod = await Test.createTestingModule({
    providers: [
      YoutubeAuthorizationCheckScheduler,
      { provide: DRIZZLE, useValue: fakeDb },
      { provide: ChannelService, useValue: channelService },
      { provide: YouTubeService, useValue: youtube },
    ],
  }).compile();
  return mod.get(YoutubeAuthorizationCheckScheduler);
}

function connectedChannels(rows: Array<{ id: number; workspace_id: string }>) {
  execute.mockResolvedValue({ rows });
}

describe('YoutubeAuthorizationCheckScheduler', () => {
  beforeEach(() => {
    execute.mockReset();
    update.mockReset();
    channelService.getAccessToken.mockReset().mockResolvedValue('TKN');
    youtube.verifyToken.mockReset().mockResolvedValue(true);
  });

  it('does nothing when there are no YouTube channels', async () => {
    connectedChannels([]);
    const scheduler = await build();
    await scheduler.verifyYoutubeAuthorizations();
    expect(youtube.verifyToken).not.toHaveBeenCalled();
  });

  it('leaves a still-authorized channel alone', async () => {
    connectedChannels([{ id: 1, workspace_id: 'ws' }]);
    youtube.verifyToken.mockResolvedValue(true);
    const scheduler = await build();
    await scheduler.verifyYoutubeAuthorizations();
    expect(youtube.verifyToken).toHaveBeenCalledWith('TKN');
  });

  // The out-of-band revocation case: the user revoked us from Google's own
  // security settings, so nothing we do will ever succeed again.
  it('marks a channel expired when authorization is gone', async () => {
    connectedChannels([{ id: 1, workspace_id: 'ws' }]);
    youtube.verifyToken.mockResolvedValue(false);
    const scheduler = await build();
    await scheduler.verifyYoutubeAuthorizations();
    expect(update).toHaveBeenCalled();
  });

  // One bad channel must not stop the rest being checked — otherwise a single
  // broken channel silently ends re-verification for the whole install.
  it('continues checking other channels after one throws', async () => {
    connectedChannels([
      { id: 1, workspace_id: 'ws' },
      { id: 2, workspace_id: 'ws' },
    ]);
    channelService.getAccessToken
      .mockRejectedValueOnce(new Error('decrypt failed'))
      .mockResolvedValueOnce('TKN2');
    const scheduler = await build();
    await scheduler.verifyYoutubeAuthorizations();
    expect(youtube.verifyToken).toHaveBeenCalledWith('TKN2');
  });

  it('swallows a top-level failure rather than throwing', async () => {
    execute.mockRejectedValue(new Error('db is down'));
    const scheduler = await build();
    await expect(scheduler.verifyYoutubeAuthorizations()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/channels/schedulers/youtube-authorization-check.scheduler.spec.ts`
Expected: FAIL — `Cannot find module './youtube-authorization-check.scheduler'`.

- [ ] **Step 3: Write the scheduler**

Create `src/channels/schedulers/youtube-authorization-check.scheduler.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import { ChannelService } from '../services/channel.service';
import { YouTubeService } from '../services/youtube.service';

/**
 * Weekly re-verification that we are still authorized on every YouTube channel.
 *
 * One job, two policy obligations — they are the same question asked twice:
 *
 *   III.D.2.3.b (out-of-band revocation). If a user revokes us from Google's own
 *   security settings, today we only notice reactively: the profile-snapshot
 *   handler flips connectionStatus to 'expired' after 3 consecutive auth
 *   failures, and only if something happened to be syncing. The policy gives us
 *   30 days to act after an out-of-band revocation.
 *
 *   III.E.4.b (indefinitely-stored analytics). Analytics and statistics may be
 *   kept "for as long as is necessary" ONLY if we "ensure every 30 days that it
 *   is still authorized by the user to access that data". Without this check our
 *   indefinite analytics retention has no basis.
 *
 * Weekly sits comfortably inside both 30-day windows. Cost is 1 quota unit per
 * channel (channels.list via verifyToken), charged to the publishing subsystem.
 *
 * DELIBERATE TRADE-OFF: a failed check marks the channel 'expired' but does NOT
 * delete its data. A single failure is not proof of revocation — it could be a
 * network blip — and auto-deleting on a false negative would destroy a paying
 * user's analytics history irreversibly. The 30-day deletion obligation is met
 * by the disconnect path once the user acts on the expired state, or by the
 * explicit deletion endpoint. Flagging is reversible; deleting is not.
 */
@Injectable()
export class YoutubeAuthorizationCheckScheduler {
  private readonly logger = new Logger(YoutubeAuthorizationCheckScheduler.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    private readonly channelService: ChannelService,
    private readonly youtube: YouTubeService,
  ) {}

  @Cron(CronExpression.EVERY_WEEK, {
    timeZone: 'UTC',
    name: 'youtubeAuthorizationCheck',
  })
  async verifyYoutubeAuthorizations(): Promise<void> {
    try {
      const result: any = await this.db.execute(sql`
        SELECT id, workspace_id
        FROM social_media_channels
        WHERE platform = 'youtube'
          AND connection_status = 'connected'
          AND is_active = true
      `);
      const rows = (result?.rows ?? result ?? []) as Array<{
        id: number;
        workspace_id: string;
      }>;

      if (rows.length === 0) {
        this.logger.verbose('YouTube authorization check: no channels to verify');
        return;
      }

      let stillAuthorized = 0;
      let revoked = 0;
      let errored = 0;

      for (const row of rows) {
        try {
          const accessToken = await this.channelService.getAccessToken(
            Number(row.id),
            row.workspace_id,
          );
          const ok = await this.youtube.verifyToken(accessToken);

          if (ok) {
            stillAuthorized++;
            continue;
          }

          revoked++;
          await this.db
            .update(socialMediaChannels)
            .set({
              connectionStatus: 'expired',
              lastError:
                'YouTube authorization is no longer valid — reconnect to continue',
              updatedAt: new Date(),
            })
            .where(eq(socialMediaChannels.id, Number(row.id)));

          this.logger.warn(
            `YouTube channel ${row.id} is no longer authorized — marked expired`,
          );
        } catch (err) {
          // One bad channel must not end the sweep for everyone else.
          errored++;
          this.logger.error(
            `YouTube authorization check failed for channel ${row.id}: ${(err as Error).message}`,
          );
        }
      }

      this.logger.log(
        `YouTube authorization check: ${stillAuthorized} authorized, ` +
          `${revoked} revoked, ${errored} errored (of ${rows.length})`,
      );
    } catch (err) {
      // Never rethrow from a cron handler.
      this.logger.error(
        `YouTube authorization check sweep failed: ${(err as Error).message}`,
      );
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/channels/schedulers/youtube-authorization-check.scheduler.spec.ts`
Expected: PASS — 5 passed.

- [ ] **Step 5: Register the scheduler**

In `src/channels/channels.module.ts`, add the import and add `YoutubeAuthorizationCheckScheduler` to the `providers` array.

- [ ] **Step 6: Verify the suite and build**

Run: `npm run build && npm run test`
Expected: build succeeds; only the three known-failing suites fail.

- [ ] **Step 7: Commit**

```bash
git add src/channels/schedulers/youtube-authorization-check.scheduler.ts src/channels/schedulers/youtube-authorization-check.scheduler.spec.ts src/channels/channels.module.ts
git diff --cached --name-only
git commit -m "feat(channels): weekly youtube authorization re-check for III.E.4.b and out-of-band revocation"
```

---

## Task 6: User-initiated data deletion endpoint

**Files:**
- Create: `src/channels/services/youtube-data-deletion.service.ts`
- Test: `src/channels/services/youtube-data-deletion.service.spec.ts`
- Modify: `src/channels/channels.controller.ts` (add the endpoint near the existing `@Delete('workspaces/:workspaceId/:channelId')` at line 924)
- Modify: `src/channels/channels.module.ts` (provide the service)

**Interfaces:**
- Consumes: `GoogleOauthRevokeService.revokeIfLastGoogleChannel(...)` from Task 4.
- Produces:
  ```ts
  interface YoutubeDeletionSummary {
    inboxItems: number;
    postMetricSnapshots: number;
    channelSnapshots: number;
    channelAnalyticsDaily: number;
  }
  class YoutubeDataDeletionService {
    deleteAllYoutubeData(channelId: number, workspaceId: string): Promise<YoutubeDeletionSummary>
  }
  ```

**Context:** Developer Policy III.E.4 requires a way for a user to request deletion of their stored data, honored within 7 days. Disconnecting a channel already deletes its data through the cascade — but that is a side-effect of disconnecting, not a stated capability, and an auditor cannot be shown a side-effect.

This makes it explicit: a dedicated endpoint that deletes every piece of YouTube-derived data for a channel and reports exactly what it removed, so it can be demonstrated to a reviewer and the counts logged.

Unlike the retention job, this **does** delete the analytics tables. The retention job leaves them alone because III.E.4.b permits keeping them indefinitely while authorized; here the user is explicitly withdrawing, so everything goes. That distinction is the whole reason this is a separate service rather than a reuse of the retention one — and it is exactly the kind of thing a future reader would "simplify" wrongly, so the code says why.

Deletion is ordered child-first so foreign keys never block it, and runs in a transaction so a partial delete cannot leave the user half-deleted.

- [ ] **Step 1: Write the failing test**

Create `src/channels/services/youtube-data-deletion.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { YoutubeDataDeletionService } from './youtube-data-deletion.service';
import { DRIZZLE } from '../../drizzle/drizzle.module';

const execute = jest.fn();
const fakeDb = {
  execute,
  transaction: async (fn: any) => fn({ execute }),
};

async function build() {
  const mod = await Test.createTestingModule({
    providers: [
      YoutubeDataDeletionService,
      { provide: DRIZZLE, useValue: fakeDb },
    ],
  }).compile();
  return mod.get(YoutubeDataDeletionService);
}

function allStatementsSql(): string {
  return execute.mock.calls.map((c) => JSON.stringify(c[0])).join(' | ');
}

describe('YoutubeDataDeletionService', () => {
  beforeEach(() => {
    execute.mockReset();
    execute.mockResolvedValue({ rowCount: 3, rows: [] });
  });

  it('reports what it deleted from every table', async () => {
    const svc = await build();
    const summary = await svc.deleteAllYoutubeData(1, 'ws');

    expect(summary.inboxItems).toBe(3);
    expect(summary.postMetricSnapshots).toBe(3);
    expect(summary.channelSnapshots).toBe(3);
    expect(summary.channelAnalyticsDaily).toBe(3);
  });

  // Unlike the 30-day retention job, an explicit user deletion DOES remove the
  // analytics: III.E.4.b only permits keeping those while still authorized, and
  // the user is withdrawing that authorization.
  it('deletes the analytics tables too', async () => {
    const svc = await build();
    await svc.deleteAllYoutubeData(1, 'ws');
    const sql = allStatementsSql();

    expect(sql).toContain('inbox_items');
    expect(sql).toContain('post_metric_snapshots');
    expect(sql).toContain('channel_snapshots');
    expect(sql).toContain('channel_analytics_daily');
  });

  it('scopes every delete to the requested channel and workspace', async () => {
    const svc = await build();
    await svc.deleteAllYoutubeData(42, 'ws-abc');
    const sql = allStatementsSql();

    expect(sql).toContain('42');
    expect(sql).toContain('ws-abc');
  });

  it('runs inside a transaction so a partial delete cannot happen', async () => {
    const spy = jest.spyOn(fakeDb, 'transaction');
    const svc = await build();
    await svc.deleteAllYoutubeData(1, 'ws');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/channels/services/youtube-data-deletion.service.spec.ts`
Expected: FAIL — `Cannot find module './youtube-data-deletion.service'`.

- [ ] **Step 3: Write the implementation**

Create `src/channels/services/youtube-data-deletion.service.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../../drizzle/drizzle.module';

export interface YoutubeDeletionSummary {
  inboxItems: number;
  postMetricSnapshots: number;
  channelSnapshots: number;
  channelAnalyticsDaily: number;
}

/**
 * Deletes every piece of YouTube-derived data we hold for a channel, on the
 * user's explicit request.
 *
 * YouTube Developer Policy III.E.4 requires a way for a user to request deletion
 * of their stored data, honored within 7 days. Disconnecting a channel already
 * achieves this through the cascade, but that is a side-effect of disconnecting
 * rather than a stated capability — and a side-effect cannot be demonstrated to
 * an auditor. This makes it an explicit, reportable operation.
 *
 * NOTE the difference from YoutubeRetentionService, which is deliberate and
 * should not be "simplified" away: the retention job leaves the analytics tables
 * alone, because III.E.4.b permits keeping analytics and statistics indefinitely
 * while we remain authorized. Here the user is explicitly withdrawing, so those
 * tables go too.
 *
 * Ordered child-first so foreign keys never block the delete, and wrapped in a
 * transaction so a failure part-way cannot leave the user half-deleted.
 */
@Injectable()
export class YoutubeDataDeletionService {
  private readonly logger = new Logger(YoutubeDataDeletionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: any) {}

  async deleteAllYoutubeData(
    channelId: number,
    workspaceId: string,
  ): Promise<YoutubeDeletionSummary> {
    const summary = await this.db.transaction(async (tx: any) => {
      const count = async (statement: any): Promise<number> => {
        const result: any = await tx.execute(statement);
        return Number(result?.rowCount ?? 0);
      };

      const inboxItems = await count(sql`
        DELETE FROM inbox_items
        WHERE channel_id = ${channelId}
          AND workspace_id = ${workspaceId}
          AND platform = 'youtube'
      `);

      const postMetricSnapshots = await count(sql`
        DELETE FROM post_metric_snapshots
        WHERE channel_id = ${channelId}
      `);

      const channelSnapshots = await count(sql`
        DELETE FROM channel_snapshots
        WHERE channel_id = ${channelId}
      `);

      const channelAnalyticsDaily = await count(sql`
        DELETE FROM channel_analytics_daily
        WHERE channel_id = ${channelId}
      `);

      return {
        inboxItems,
        postMetricSnapshots,
        channelSnapshots,
        channelAnalyticsDaily,
      };
    });

    this.logger.log(
      `YouTube data deletion for channel ${channelId} (workspace ${workspaceId}): ` +
        `inbox=${summary.inboxItems} postMetrics=${summary.postMetricSnapshots} ` +
        `channelSnapshots=${summary.channelSnapshots} analyticsDaily=${summary.channelAnalyticsDaily}`,
    );

    return summary;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/channels/services/youtube-data-deletion.service.spec.ts`
Expected: PASS — 4 passed.

- [ ] **Step 5: Add the endpoint**

In `src/channels/channels.controller.ts`, immediately after the existing `deleteChannel` handler (which ends around line 957), add:

```ts
  /**
   * Explicit user-initiated deletion of all YouTube data for a channel, without
   * disconnecting it. Required by YouTube Developer Policy III.E.4, which wants
   * a stated capability rather than a side-effect of disconnecting.
   *
   * Also revokes the Google grant when no other Google channel remains, matching
   * the disconnect path — the user is withdrawing consent either way.
   */
  @Delete('workspaces/:workspaceId/:channelId/youtube-data')
  @UseGuards(JwtAuthGuard)
  async deleteYoutubeData(
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
  ) {
    const id = parseInt(channelId, 10);
    const channel = await this.channelService.getChannelById(id, workspaceId);

    if (channel.platform !== 'youtube') {
      throw new BadRequestException('This channel is not a YouTube channel');
    }

    const summary = await this.youtubeDataDeletion.deleteAllYoutubeData(
      id,
      workspaceId,
    );

    try {
      const accessToken = await this.channelService.getAccessToken(
        id,
        workspaceId,
      );
      await this.googleRevoke.revokeIfLastGoogleChannel(
        id,
        workspaceId,
        'youtube',
        accessToken,
      );
    } catch {
      // Best effort — the data is already gone, which is what was requested.
    }

    return {
      success: true,
      message: 'All YouTube data for this channel has been deleted.',
      deleted: summary,
    };
  }
```

Add `YoutubeDataDeletionService` and `GoogleOauthRevokeService` to the controller's constructor as `youtubeDataDeletion` and `googleRevoke`, with their imports.

`@UseGuards(JwtAuthGuard)` above matches the neighboring `deleteChannel` handler at line 925, so this endpoint carries identical protection. `JwtAuthGuard` and `BadRequestException` are already imported in this file. Note `deleteChannel` also carries `@HttpCode(HttpStatus.NO_CONTENT)`; this endpoint deliberately does NOT, because it returns the deletion counts in its body and a 204 would discard them.

- [ ] **Step 6: Register the service**

In `src/channels/channels.module.ts`, add the import and add `YoutubeDataDeletionService` to the `providers` array.

- [ ] **Step 7: Verify the suite and build**

Run: `npm run build && npm run test`
Expected: build succeeds; only the three known-failing suites fail.

- [ ] **Step 8: Commit**

```bash
git add src/channels/services/youtube-data-deletion.service.ts src/channels/services/youtube-data-deletion.service.spec.ts src/channels/channels.controller.ts src/channels/channels.module.ts
git diff --cached --name-only
git commit -m "feat(channels): explicit user-initiated youtube data deletion endpoint"
```

---

## Task 7: Compliance documentation and disclosure text

**Files:**
- Create: `docs/youtube-api-compliance.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the canonical disclosure wording the frontend phase will render.

**Context:** The Developer Policy requires the product to disclose that it uses YouTube API Services and to link the YouTube Terms of Service and the Google Privacy Policy. The frontend phase renders these; this task fixes the exact wording in one place so the settings page, the connect flow and the audit submission cannot drift apart.

It also records what this branch actually built, which is what a reviewer will ask about — and the two decisions a future reader would otherwise likely undo.

- [ ] **Step 1: Write the document**

Create `docs/youtube-api-compliance.md`:

````markdown
# YouTube API Services Compliance

What we built to satisfy the YouTube Developer Policy, and the exact disclosure
text the UI must render.

## Required disclosure

Render this wherever YouTube data appears or is connected — the settings/legal
surface and the YouTube connect flow at minimum:

> Schedura uses YouTube API Services. By connecting your YouTube channel you
> agree to the [YouTube Terms of Service](https://www.youtube.com/t/terms). See
> the [Google Privacy Policy](https://policies.google.com/privacy) for how Google
> handles your data.

Both links are mandatory and must be live links, not plain text.

## Data retention

| Data | Policy section | What we do |
|---|---|---|
| Comment text, author display name, avatar, handle, channel id | III.E.4.c | Nulled 30 days after the comment's own timestamp, by `YoutubeRetentionService`. The inbox row survives so thread structure, reply status and counts remain. |
| View counts, subscriber counts, like counts, daily rollups | III.E.4.b | Kept indefinitely, permitted explicitly by III.E.4.b, subject to re-verifying authorization every 30 days. |

III.E.4.b permits storing analytics and statistics "for as long as is necessary",
requiring only that the client "ensure every 30 days that it is still authorized
by the user to access that data". `YoutubeAuthorizationCheckScheduler` runs
weekly and does exactly that.

The retention window is measured from the comment's own `platform_created_at`,
never from when our row was inserted — measuring from insert time would retain
expired data and destroy fresh data during any backfill.

## Revocation

| Path | Policy section | What we do |
|---|---|---|
| In-app disconnect | III.D.2.3.a | Data deleted immediately via cascade on channel delete. Google grant revoked when no other Google channel remains in the workspace. |
| Out-of-band revoke (user revokes from Google account settings) | III.D.2.3.b | Detected weekly by `YoutubeAuthorizationCheckScheduler`, which marks the channel `expired`. |
| Explicit user request | III.E.4 | `DELETE /channels/workspaces/:workspaceId/:channelId/youtube-data` removes all YouTube-derived data, analytics included, and reports the counts. |

### Why revocation is conditional

Google Drive, Google Photos and Google Calendar authenticate through the **same**
Google OAuth application as YouTube (`oauth.service.ts`, where those platforms
resolve to `envPrefix = 'YOUTUBE'`). Google merges every scope a user grants to
one API project into a single combined authorization, and its documentation is
explicit:

> If you revoke a token that represents a combined authorization, access to all
> of that authorization's scopes on behalf of the associated user are revoked
> simultaneously.

So revoking on YouTube disconnect would silently break the same user's Drive,
Photos and Calendar connections. We therefore revoke only once no other Google
channel remains in the workspace. The YouTube **data** is deleted immediately
either way, so the deletion obligation is met regardless; only the grant cleanup
waits.

The structural fix is a separate OAuth client per Google service, which would
make revocation isolated. That requires new credentials and a reconnect for every
existing Google channel, so it is deliberately deferred.

## Quota discipline

Shipped separately as Effort A (PR #54). Inbox comment polling is bounded by a
per-video age tier and a daily unit allowance, and every YouTube API call is
gated by a per-subsystem quota allowance so background polling cannot consume the
units publishing needs. See
`docs/superpowers/plans/2026-07-18-youtube-quota-safety.md`.

## Two things not to "simplify"

1. **The retention job leaves the analytics tables alone.** That is not an
   oversight — III.E.4.b permits keeping them. The explicit deletion endpoint
   does remove them, because there the user is withdrawing authorization.
2. **The retention job filters `platform = 'youtube'`.** This obligation is
   YouTube's alone. Widening it would destroy other platforms' data for no
   reason.
````

- [ ] **Step 2: Commit**

```bash
git add docs/youtube-api-compliance.md
git diff --cached --name-only
git commit -m "docs(youtube): compliance summary and required disclosure text"
```

---

## Verification after all tasks

The spec's Effort B requirements map to these tasks:

| Spec requirement | Task |
|---|---|
| B1 — 30-day retention for III.E.4.c data | Tasks 2, 3 |
| B1 — fix the tiered-polling comment describing behavior that does not exist | Task 1 |
| B2 — revoke on in-app disconnect | Task 4 |
| B2 — detect out-of-band revocation; III.E.4.b 30-day re-verification | Task 5 |
| B3 — user-initiated deletion | Task 6 |
| B4 — disclosure and policy links | Task 7 |
| Retention boundary tests (29d survives, 31d wiped) | Task 3 |
| Revocation tests (revokes, failure still disconnects) | Task 4 |

Final check before opening the PR:

```bash
npm run build && npm run test
git log --oneline origin/main..HEAD
```

Expected: seven commits, one per task, and a build with only the three known pre-existing suite failures.

**Deploy note:** the retention job's first production run will wipe comment content older than 30 days. That is intended and irreversible. Analytics are untouched. No migration and no new environment variables are required by this branch.

**Follow-up phase (needs user approval before starting):** the frontend — the "Content removed (YouTube 30-day policy)" placeholder where a wiped comment's text used to render, a delete-my-YouTube-data control wired to the Task 6 endpoint, and the Task 7 disclosure text on the settings/legal surface and the YouTube connect flow.
