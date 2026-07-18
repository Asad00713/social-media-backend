# YouTube Quota Safety (Effort A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop YouTube inbox polling from exhausting the 10,000-unit/day shared API quota, so uploads, analytics and comment replies keep working all day.

**Architecture:** Four independent layers, each multiplying the previous one's saving. (1) `fetchVideoComments` stops paging as soon as a page contains nothing newer than `since`, cutting the typical call from 5 pages to 1. (2) Videos are assigned an age tier that sets how often they may be polled, so a month-old video stops costing anything. (3) A Redis-backed budget service picks the due set that fits a daily unit allowance, hot tier first, and logs what it deferred. (4) `QuotaTrackerService` gains per-subsystem allowances and is wired into every YouTube call site, so polling can never spend the units publishing needs.

**Tech Stack:** NestJS 11, Drizzle ORM (Postgres), BullMQ + Redis, Jest.

**Source spec:** `docs/superpowers/specs/2026-07-17-youtube-compliance-design.md` (Effort A, sections A1–A5).

**Branch:** `feat/youtube-quota-safety`, off `origin/main`. This plan covers Effort A only; Effort B (ToS compliance) is a separate plan on a separate branch.

## Global Constraints

- **Never run `npm run db:generate` or `npm run db:push`.** This effort requires no schema change at all — per-video poll timestamps live in Redis, not Postgres.
- **The repo has ~47 unrelated dirty files.** Never `git add -A` or `git add .`. Stage only the exact files named in the task, and verify with `git diff --cached --name-only` before committing.
- **`commentThreads.list` has no time filter.** There is no `publishedAfter` parameter. `videoId`, `id` and `allThreadsRelatedToChannelId` are the only filters. Incremental fetching must be done by early-exiting pagination, never by asking the API for a date range.
- **`order=time` is the default and is load-bearing** for early exit — newest first is what makes "stop at the first page with nothing new" correct. Do not remove or change that parameter.
- **Quota costs, verbatim from the spec:** `commentThreads.list` = 1 unit per page; `comments.insert` / `commentThreads.insert` / `comments.delete` = 50 units; `channels.list` / `videos.list` = 1 unit; `thumbnails.set` = 50 units; `playlistItems.insert` = 50 units. `videos.insert` is ~100 units in its **own ~100 calls/day bucket**, outside the 10,000 shared pool.
- **`YOUTUBE_INBOX_DAILY_UNITS` defaults to `3000`** of the 10,000 shared units.
- **Tier boundaries, verbatim from the spec:** Hot `< 48 hours` → 15 minutes; Warm `2–7 days` → 1 hour; Cool `7–30 days` → 6 hours; Cold `> 30 days` → never.
- **`YOUTUBE_APP_AUDITED` defaults to `false`** — a missing env var must fail safe (conservative caps), mirroring `TIKTOK_APP_AUDITED`.
- **Publishing takes precedence over polling.** When the budget is tight, polling yields first. A test must prove an exhausted polling allowance still lets a publish through.
- **Deferral must be logged with counts.** An adaptive scheduler that silently stops polling is indistinguishable from one that is working.
- Backend `npm run build` and `npm run test` must pass at the end of every task.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/channels/services/youtube.service.ts` (modify) | Early-exit pagination in `fetchVideoComments`; quota gating on every YouTube API call |
| `src/inbox/adapters/youtube-inbox.adapter.ts` (modify) | Pass the `since` it already receives down to the service |
| `src/inbox/utils/youtube-inbox-tier.util.ts` (create) | Pure tier table + `pickYoutubeInboxTier` + `isDueForPoll`. No I/O. |
| `src/inbox/services/youtube-inbox-budget.service.ts` (create) | Redis-backed per-video last-poll timestamps; selects the due set that fits `YOUTUBE_INBOX_DAILY_UNITS`, hot first; logs deferrals |
| `src/inbox/processors/inbox-poll.processor.ts` (modify) | For YouTube channels, filter the candidate post list through the budget service before fetching |
| `src/inbox/schedulers/inbox-poll.scheduler.ts` (modify) | Cron `*/30 * * * * *` → every 5 minutes |
| `src/channels/analytics/services/quota-tracker.service.ts` (modify) | Optional per-subsystem allowance on `tryConsume` |
| `src/channels/services/youtube-audit-gate.service.ts` (create) | `YOUTUBE_APP_AUDITED` pre-audit publish cap, mirroring `TikTokQuotaService` |

---

## Task 1: Early-exit pagination in `fetchVideoComments`

**Files:**
- Modify: `src/channels/services/youtube.service.ts:621-679` (the `fetchVideoComments` method and its doc comment)
- Modify: `src/inbox/adapters/youtube-inbox.adapter.ts:30-38` (pass `since` through)
- Test: `src/channels/services/youtube.service.comments.spec.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `YouTubeService.fetchVideoComments(accessToken: string, videoId: string, since?: Date): Promise<YouTubeCommentThread[]>` — the third parameter is new and optional.

**Context:** `YoutubeInboxAdapter.fetchComments` already accepts a `since: Date` and filters on it client-side, but never passes it to the service. So every poll re-downloads up to 5 pages of comments that were already ingested. `order=time` means newest first, so once a whole page contains no thread with activity newer than `since`, no later page can either — that is the exit condition.

"Activity" must account for replies: a two-year-old thread with a reply from five minutes ago is new activity. So a thread's activity timestamp is the newest of its top-level comment's `publishedAt`/`updatedAt` and all its replies' `publishedAt`/`updatedAt`.

- [ ] **Step 1: Write the failing test**

Create `src/channels/services/youtube.service.comments.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { YouTubeService } from './youtube.service';

/** Build a comment thread whose newest activity is at `iso`. */
function thread(id: string, iso: string, replyIso?: string) {
  const snippet = {
    textDisplay: 't',
    textOriginal: 't',
    authorDisplayName: 'a',
    authorProfileImageUrl: 'u',
    publishedAt: iso,
    updatedAt: iso,
  };
  return {
    id,
    snippet: { topLevelComment: { id: `${id}-top`, snippet } },
    replies: replyIso
      ? {
          comments: [
            {
              id: `${id}-r`,
              snippet: { ...snippet, publishedAt: replyIso, updatedAt: replyIso },
            },
          ],
        }
      : undefined,
  };
}

function page(items: unknown[], nextPageToken?: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ items, nextPageToken }),
    text: async () => '',
  };
}

async function build() {
  const mod = await Test.createTestingModule({
    providers: [
      YouTubeService,
      { provide: ConfigService, useValue: { get: () => undefined } },
    ],
  }).compile();
  return mod.get(YouTubeService);
}

describe('YouTubeService.fetchVideoComments early exit', () => {
  afterEach(() => jest.restoreAllMocks());

  it('stops paging at the first page with nothing newer than `since`', async () => {
    const since = new Date('2026-07-10T00:00:00Z');
    const fetchMock = jest
      .fn()
      // Page 1 — all newer than `since`, so keep going.
      .mockResolvedValueOnce(
        page([thread('a', '2026-07-12T00:00:00Z')], 'PAGE2'),
      )
      // Page 2 — all older than `since`. Exit here.
      .mockResolvedValueOnce(
        page([thread('b', '2026-07-01T00:00:00Z')], 'PAGE3'),
      )
      // Page 3 must never be requested.
      .mockResolvedValueOnce(page([thread('c', '2026-06-01T00:00:00Z')]));
    global.fetch = fetchMock as unknown as typeof fetch;

    const svc = await build();
    const out = await svc.fetchVideoComments('TKN', 'vid', since);

    // 2 calls, not 5 — this is the whole point of the change.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('keeps paging when an old thread has a new reply', async () => {
    const since = new Date('2026-07-10T00:00:00Z');
    const fetchMock = jest
      .fn()
      // Top-level is old but the reply is new — this page HAS new activity.
      .mockResolvedValueOnce(
        page(
          [thread('a', '2026-01-01T00:00:00Z', '2026-07-15T00:00:00Z')],
          'PAGE2',
        ),
      )
      .mockResolvedValueOnce(page([thread('b', '2026-01-01T00:00:00Z')]));
    global.fetch = fetchMock as unknown as typeof fetch;

    const svc = await build();
    await svc.fetchVideoComments('TKN', 'vid', since);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still honors the 5-page cap when `since` is undefined', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(page([thread('x', '2026-07-12T00:00:00Z')], 'MORE'));
    global.fetch = fetchMock as unknown as typeof fetch;

    const svc = await build();
    await svc.fetchVideoComments('TKN', 'vid');

    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/channels/services/youtube.service.comments.spec.ts`
Expected: FAIL — the first test reports `expect(fetchMock).toHaveBeenCalledTimes(2)` received `5`, because pagination currently ignores `since`.

- [ ] **Step 3: Add the activity helper**

Add this module-scope function near the bottom of `src/channels/services/youtube.service.ts`, beside the exported interfaces:

```ts
/**
 * Newest activity on a comment thread, in epoch ms.
 *
 * A thread is "new" if ANY part of it is new — a two-year-old top-level
 * comment with a reply from five minutes ago is new activity we must ingest.
 * So this is the max over the top-level comment and every inline reply, of
 * both publishedAt and updatedAt (an edited comment bumps updatedAt only).
 */
function threadLastActivityMs(thread: YouTubeCommentThread): number {
  const stamps: string[] = [];
  const top = thread.snippet?.topLevelComment?.snippet;
  if (top) stamps.push(top.publishedAt, top.updatedAt);
  for (const reply of thread.replies?.comments ?? []) {
    stamps.push(reply.snippet.publishedAt, reply.snippet.updatedAt);
  }
  let newest = 0;
  for (const s of stamps) {
    const ms = Date.parse(s);
    if (Number.isFinite(ms) && ms > newest) newest = ms;
  }
  return newest;
}
```

- [ ] **Step 4: Add `since` and the early exit to `fetchVideoComments`**

Replace the doc comment and signature at `src/channels/services/youtube.service.ts:621-632` with:

```ts
  /**
   * Fetch comment threads on a video, including nested replies.
   * Uses commentThreads.list (1 quota unit per call) + paginates via nextPageToken.
   * Each thread carries up to 5 inline replies; for threads with more we'd need
   * a follow-up comments.list call, but that's rare and Phase 1 lives with it.
   *
   * `since` is an EARLY-EXIT hint, not a server-side filter: commentThreads.list
   * has no publishedAfter parameter, so the only way to fetch incrementally is
   * to stop paging early. `order=time` returns newest-first, so once an entire
   * page holds nothing newer than `since`, no later page can either — that is
   * the exit condition. Typically turns a 5-page walk into 1 page.
   *
   * Callers still filter the returned threads themselves; this only bounds how
   * much we download. Hard cap remains 5 pages (~500 threads) for a cold start.
   */
  async fetchVideoComments(
    accessToken: string,
    videoId: string,
    since?: Date,
  ): Promise<YouTubeCommentThread[]> {
    const out: YouTubeCommentThread[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    const maxPages = 5;
    const sinceMs = since?.getTime();
```

Then, inside the `while` loop, replace the three lines at the end of the loop body (currently `if (data.items?.length) out.push(...data.items);` / `if (!data.nextPageToken) break;` / `pageToken = data.nextPageToken;`) with:

```ts
      const items = data.items ?? [];
      if (items.length) out.push(...items);

      // Early exit: nothing on this page is newer than `since`, and pages are
      // newest-first, so every remaining page is older still.
      if (
        sinceMs !== undefined &&
        items.length > 0 &&
        !items.some((t) => threadLastActivityMs(t) > sinceMs)
      ) {
        break;
      }

      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
```

Leave `pages += 1;` as it is.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/channels/services/youtube.service.comments.spec.ts`
Expected: PASS — 3 passed.

- [ ] **Step 6: Pass `since` from the adapter**

In `src/inbox/adapters/youtube-inbox.adapter.ts`, replace the `fetchVideoComments` call at lines 35-38 with:

```ts
    // `since` is an early-exit hint for pagination — the API has no time
    // filter, so we still filter each comment in `toRow` below.
    const threads = await this.youtube.fetchVideoComments(
      channel.accessToken,
      platformPostId,
      since,
    );
```

- [ ] **Step 7: Build and commit**

```bash
npm run build
git add src/channels/services/youtube.service.ts src/channels/services/youtube.service.comments.spec.ts src/inbox/adapters/youtube-inbox.adapter.ts
git diff --cached --name-only
git commit -m "perf(youtube): early-exit comment pagination using the since hint"
```

Expected `git diff --cached --name-only`: exactly those three paths and nothing else.

---

## Task 2: YouTube inbox polling tiers

**Files:**
- Create: `src/inbox/utils/youtube-inbox-tier.util.ts`
- Test: `src/inbox/utils/youtube-inbox-tier.util.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface YoutubeInboxTier { name: 'hot' | 'warm' | 'cool' | 'cold'; maxAgeMs: number; intervalMs: number }`
  - `const YOUTUBE_INBOX_TIERS: YoutubeInboxTier[]`
  - `pickYoutubeInboxTier(ageMs: number): YoutubeInboxTier`
  - `isDueForPoll(tier: YoutubeInboxTier, lastPolledAtMs: number | null, nowMs: number): boolean`

**Context:** This mirrors `src/channels/analytics/utils/polling-tier.util.ts`, which is the codebase's existing idiom for the same problem on the analytics side. It is deliberately a separate table rather than a reuse of `POST_POLLING_TIERS`, because the analytics tiers poll cold posts every 24h while inbox comments on a >30-day-old video are not polled at all.

This file is pure — no Redis, no DB, no clock reads. `nowMs` is passed in so tests need no fake timers.

- [ ] **Step 1: Write the failing test**

Create `src/inbox/utils/youtube-inbox-tier.util.spec.ts`:

```ts
import {
  YOUTUBE_INBOX_TIERS,
  pickYoutubeInboxTier,
  isDueForPoll,
} from './youtube-inbox-tier.util';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('pickYoutubeInboxTier', () => {
  it('classifies a brand-new video as hot', () => {
    expect(pickYoutubeInboxTier(0).name).toBe('hot');
  });

  // Boundaries are where off-by-one tier bugs live: a video one millisecond
  // before 48h must still be hot, and at exactly 48h must be warm.
  it('is hot just under 48h and warm at exactly 48h', () => {
    expect(pickYoutubeInboxTier(2 * DAY - 1).name).toBe('hot');
    expect(pickYoutubeInboxTier(2 * DAY).name).toBe('warm');
  });

  it('is warm just under 7d and cool at exactly 7d', () => {
    expect(pickYoutubeInboxTier(7 * DAY - 1).name).toBe('warm');
    expect(pickYoutubeInboxTier(7 * DAY).name).toBe('cool');
  });

  it('is cool just under 30d and cold at exactly 30d', () => {
    expect(pickYoutubeInboxTier(30 * DAY - 1).name).toBe('cool');
    expect(pickYoutubeInboxTier(30 * DAY).name).toBe('cold');
  });

  it('gives each tier the interval the spec requires', () => {
    const byName = Object.fromEntries(
      YOUTUBE_INBOX_TIERS.map((t) => [t.name, t.intervalMs]),
    );
    expect(byName.hot).toBe(15 * MIN);
    expect(byName.warm).toBe(1 * HOUR);
    expect(byName.cool).toBe(6 * HOUR);
    expect(byName.cold).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('isDueForPoll', () => {
  const hot = pickYoutubeInboxTier(0);
  const cold = pickYoutubeInboxTier(60 * DAY);
  const now = 1_000 * DAY;

  it('polls a never-polled video immediately', () => {
    expect(isDueForPoll(hot, null, now)).toBe(true);
  });

  it('does not poll again before the interval has elapsed', () => {
    expect(isDueForPoll(hot, now - (15 * MIN - 1), now)).toBe(false);
  });

  it('polls again once the interval has elapsed', () => {
    expect(isDueForPoll(hot, now - 15 * MIN, now)).toBe(true);
  });

  // Cold is "never", including the never-polled case — an infinite interval
  // must not be short-circuited by the null-lastPolled branch.
  it('never polls a cold video, even one never polled before', () => {
    expect(isDueForPoll(cold, null, now)).toBe(false);
    expect(isDueForPoll(cold, 0, now)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/inbox/utils/youtube-inbox-tier.util.spec.ts`
Expected: FAIL — `Cannot find module './youtube-inbox-tier.util'`.

- [ ] **Step 3: Write the implementation**

Create `src/inbox/utils/youtube-inbox-tier.util.ts`:

```ts
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface YoutubeInboxTier {
  name: 'hot' | 'warm' | 'cool' | 'cold';
  maxAgeMs: number;
  intervalMs: number;
}

/**
 * How often a video's comments may be polled, by video age.
 *
 * Comments arrive overwhelmingly on recent uploads, so a fixed interval is
 * either wasteful on old videos or too slow on new ones. The cold cutoff sits
 * at 30 days to match the existing inbox polling window (POLLING_WINDOW_DAYS
 * in inbox-poll.processor.ts), so no currently-polled video is dropped.
 *
 * Shape mirrors POST_POLLING_TIERS in
 * channels/analytics/utils/polling-tier.util.ts — the same idea for analytics.
 */
export const YOUTUBE_INBOX_TIERS: YoutubeInboxTier[] = [
  { name: 'hot', maxAgeMs: 2 * DAY, intervalMs: 15 * MIN },
  { name: 'warm', maxAgeMs: 7 * DAY, intervalMs: 1 * HOUR },
  { name: 'cool', maxAgeMs: 30 * DAY, intervalMs: 6 * HOUR },
  {
    name: 'cold',
    maxAgeMs: Number.POSITIVE_INFINITY,
    intervalMs: Number.POSITIVE_INFINITY,
  },
];

/** The tier whose maxAgeMs is the smallest one that exceeds the given age. */
export function pickYoutubeInboxTier(ageMs: number): YoutubeInboxTier {
  for (const tier of YOUTUBE_INBOX_TIERS) {
    if (ageMs < tier.maxAgeMs) return tier;
  }
  return YOUTUBE_INBOX_TIERS[YOUTUBE_INBOX_TIERS.length - 1];
}

/**
 * Whether a video is due for another comment poll.
 *
 * A never-polled video is due immediately — except in the cold tier, whose
 * infinite interval means "never", never-polled included.
 */
export function isDueForPoll(
  tier: YoutubeInboxTier,
  lastPolledAtMs: number | null,
  nowMs: number,
): boolean {
  if (!Number.isFinite(tier.intervalMs)) return false;
  if (lastPolledAtMs === null) return true;
  return nowMs - lastPolledAtMs >= tier.intervalMs;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/inbox/utils/youtube-inbox-tier.util.spec.ts`
Expected: PASS — 9 passed.

- [ ] **Step 5: Commit**

```bash
git add src/inbox/utils/youtube-inbox-tier.util.ts src/inbox/utils/youtube-inbox-tier.util.spec.ts
git diff --cached --name-only
git commit -m "feat(inbox): youtube comment polling tiers by video age"
```

---

## Task 3: Budget-aware due-video selection

**Files:**
- Create: `src/inbox/services/youtube-inbox-budget.service.ts`
- Test: `src/inbox/services/youtube-inbox-budget.service.spec.ts`

**Interfaces:**
- Consumes: `pickYoutubeInboxTier`, `isDueForPoll`, `YoutubeInboxTier` from `../utils/youtube-inbox-tier.util`.
- Produces:
  ```ts
  interface PollCandidate { videoId: string; publishedAtMs: number }
  interface PollSelection { due: PollCandidate[]; deferred: number; deferredByTier: Record<string, number> }
  class YoutubeInboxBudgetService {
    selectDue(channelId: number, candidates: PollCandidate[], nowMs: number): Promise<PollSelection>
    markPolled(channelId: number, videoId: string, nowMs: number): Promise<void>
  }
  ```

**Context:** Tiers alone do not bound cost, because cost scales with the number of videos: ten channels each holding a tier-compliant set of videos still costs ten times one channel. So the scheduler is given an explicit daily allowance — `YOUTUBE_INBOX_DAILY_UNITS`, default 3,000 of the 10,000 shared units — and each cycle serves only what fits, hot tier first.

Per-video last-poll timestamps live in Redis, not Postgres — that is why this effort needs no migration. Keys are `yt:inboxpoll:<channelId>:<videoId>`, holding an epoch-ms string, with a 40-day TTL so a video that ages into the cold tier expires itself rather than leaking keys forever.

Budget consumption is counted in the same Redis under a day-bucketed key, `yt:inboxpoll:units:<YYYY-MM-DD>`, so the allowance is shared across all workers and survives a restart.

One page costs 1 unit, and after Task 1 a warm poll is almost always exactly one page, so this service budgets **1 unit per video selected**. That is an estimate, not a ledger — the authoritative accounting is `QuotaTrackerService` in Task 5.

Redis is already available as the `'REDIS_CLIENT'` injection token (see `TikTokQuotaService` and `QuotaTrackerService` for the same pattern of declaring a narrow interface for just the methods used).

- [ ] **Step 1: Write the failing test**

Create `src/inbox/services/youtube-inbox-budget.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { YoutubeInboxBudgetService } from './youtube-inbox-budget.service';

const MIN = 60_000;
const DAY = 24 * 60 * 60_000;
const NOW = 1_000 * DAY;

const fakeRedis = {
  store: new Map<string, string>(),
  async get(key: string) {
    return this.store.get(key) ?? null;
  },
  async set(key: string, value: string) {
    this.store.set(key, value);
    return 'OK';
  },
  async mget(keys: string[]) {
    return keys.map((k) => this.store.get(k) ?? null);
  },
  async incrby(key: string, by: number) {
    const next = Number(this.store.get(key) ?? '0') + by;
    this.store.set(key, String(next));
    return next;
  },
  async expire() {
    return 1;
  },
  clear() {
    this.store.clear();
  },
};

async function build() {
  const mod = await Test.createTestingModule({
    providers: [
      YoutubeInboxBudgetService,
      { provide: 'REDIS_CLIENT', useValue: fakeRedis },
    ],
  }).compile();
  return mod.get(YoutubeInboxBudgetService);
}

/** N videos all published `ageMs` ago. */
function videos(n: number, ageMs: number, prefix = 'v') {
  return Array.from({ length: n }, (_, i) => ({
    videoId: `${prefix}${i}`,
    publishedAtMs: NOW - ageMs,
  }));
}

describe('YoutubeInboxBudgetService', () => {
  beforeEach(() => {
    fakeRedis.clear();
    delete process.env.YOUTUBE_INBOX_DAILY_UNITS;
  });

  it('selects every never-polled hot video when the budget is ample', async () => {
    const svc = await build();
    const sel = await svc.selectDue(1, videos(5, 1 * MIN), NOW);
    expect(sel.due).toHaveLength(5);
    expect(sel.deferred).toBe(0);
  });

  it('excludes cold videos entirely', async () => {
    const svc = await build();
    const sel = await svc.selectDue(1, videos(3, 60 * DAY), NOW);
    expect(sel.due).toHaveLength(0);
    // Cold is not "deferred" — it is out of scope, not starved of budget.
    expect(sel.deferred).toBe(0);
  });

  it('excludes videos polled more recently than their tier interval', async () => {
    const svc = await build();
    await svc.markPolled(1, 'v0', NOW - 1 * MIN);
    const sel = await svc.selectDue(1, videos(1, 1 * MIN), NOW);
    expect(sel.due).toHaveLength(0);
  });

  // The budget is the whole point: without it, cost scales with channel count
  // and any "safe" interval becomes unsafe at 10 channels.
  it('serves hot before warm when the budget cannot cover both', async () => {
    process.env.YOUTUBE_INBOX_DAILY_UNITS = '3';
    const svc = await build();
    const candidates = [
      ...videos(2, 4 * DAY, 'warm'), // warm
      ...videos(3, 1 * MIN, 'hot'), // hot
    ];
    const sel = await svc.selectDue(1, candidates, NOW);

    expect(sel.due).toHaveLength(3);
    expect(sel.due.every((c) => c.videoId.startsWith('hot'))).toBe(true);
    expect(sel.deferred).toBe(2);
    expect(sel.deferredByTier.warm).toBe(2);
  });

  it('spends the allowance across calls, not per call', async () => {
    process.env.YOUTUBE_INBOX_DAILY_UNITS = '4';
    const svc = await build();

    const first = await svc.selectDue(1, videos(3, 1 * MIN, 'a'), NOW);
    expect(first.due).toHaveLength(3);

    // 3 of 4 units are already spent today — only 1 more fits.
    const second = await svc.selectDue(2, videos(3, 1 * MIN, 'b'), NOW);
    expect(second.due).toHaveLength(1);
    expect(second.deferred).toBe(2);
  });

  it('defaults the daily allowance to 3000 units', async () => {
    const svc = await build();
    const sel = await svc.selectDue(1, videos(3200, 1 * MIN), NOW);
    expect(sel.due).toHaveLength(3000);
    expect(sel.deferred).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/inbox/services/youtube-inbox-budget.service.spec.ts`
Expected: FAIL — `Cannot find module './youtube-inbox-budget.service'`.

- [ ] **Step 3: Write the implementation**

Create `src/inbox/services/youtube-inbox-budget.service.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  pickYoutubeInboxTier,
  isDueForPoll,
  type YoutubeInboxTier,
} from '../utils/youtube-inbox-tier.util';

/** Subset of ioredis used here — same pattern as TikTokQuotaService. */
export interface YoutubeInboxBudgetRedis {
  mget(keys: string[]): Promise<(string | null)[]>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  incrby(key: string, by: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

export interface PollCandidate {
  videoId: string;
  publishedAtMs: number;
}

export interface PollSelection {
  due: PollCandidate[];
  deferred: number;
  deferredByTier: Record<string, number>;
}

const DEFAULT_DAILY_UNITS = 3000;
/** commentThreads.list is 1 unit/page, and after early exit a poll is ~1 page. */
const UNITS_PER_VIDEO = 1;
/** Just past the cold cutoff (30d) so aged-out per-video keys self-expire. */
const LAST_POLL_TTL_SECONDS = 40 * 24 * 60 * 60;
const UNITS_TTL_SECONDS = 30 * 60 * 60;

const TIER_ORDER: YoutubeInboxTier['name'][] = ['hot', 'warm', 'cool', 'cold'];

/**
 * Picks which of a channel's videos may have their comments polled right now.
 *
 * Two gates, in order:
 *   1. Tier — has this video's poll interval elapsed? (cold videos: never)
 *   2. Budget — does it fit in today's YOUTUBE_INBOX_DAILY_UNITS allowance?
 *
 * Tiering alone is not enough: cost scales with the number of videos, so an
 * interval that is safe for one channel is unsafe for ten. The allowance caps
 * the total regardless of how many channels exist, and hot videos are served
 * first so the newest comments — the ones users are waiting on — never lose
 * their budget to a six-hour cool-tier sweep.
 *
 * State lives in Redis rather than Postgres so this needs no migration, and
 * so the allowance is shared across workers.
 */
@Injectable()
export class YoutubeInboxBudgetService {
  private readonly logger = new Logger(YoutubeInboxBudgetService.name);

  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: YoutubeInboxBudgetRedis,
  ) {}

  private get dailyUnits(): number {
    const raw = Number(process.env.YOUTUBE_INBOX_DAILY_UNITS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_UNITS;
  }

  private dayKey(nowMs: number): string {
    return new Date(nowMs).toISOString().slice(0, 10);
  }

  private unitsKey(nowMs: number): string {
    return `yt:inboxpoll:units:${this.dayKey(nowMs)}`;
  }

  private lastPollKey(channelId: number, videoId: string): string {
    return `yt:inboxpoll:${channelId}:${videoId}`;
  }

  async selectDue(
    channelId: number,
    candidates: PollCandidate[],
    nowMs: number,
  ): Promise<PollSelection> {
    const empty: PollSelection = { due: [], deferred: 0, deferredByTier: {} };
    if (candidates.length === 0) return empty;

    const lastPolled = await this.redis.mget(
      candidates.map((c) => this.lastPollKey(channelId, c.videoId)),
    );

    // Tier gate. Cold videos are dropped outright — not "deferred", since no
    // amount of budget would ever make them eligible.
    const eligible: Array<{ candidate: PollCandidate; tier: YoutubeInboxTier }> =
      [];
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const tier = pickYoutubeInboxTier(nowMs - candidate.publishedAtMs);
      // A missing or unparseable timestamp means "never polled" — poll it.
      const parsed = Number(lastPolled[i]);
      const lastMs =
        lastPolled[i] !== null && Number.isFinite(parsed) ? parsed : null;
      if (isDueForPoll(tier, lastMs, nowMs)) {
        eligible.push({ candidate, tier });
      }
    }
    if (eligible.length === 0) return empty;

    eligible.sort(
      (a, b) =>
        TIER_ORDER.indexOf(a.tier.name) - TIER_ORDER.indexOf(b.tier.name),
    );

    const spent = Number((await this.redis.get(this.unitsKey(nowMs))) ?? '0');
    const affordable = Math.max(
      0,
      Math.floor((this.dailyUnits - spent) / UNITS_PER_VIDEO),
    );

    const due = eligible.slice(0, affordable);
    const deferredEntries = eligible.slice(affordable);
    const deferredByTier: Record<string, number> = {};
    for (const e of deferredEntries) {
      deferredByTier[e.tier.name] = (deferredByTier[e.tier.name] ?? 0) + 1;
    }

    if (due.length > 0) {
      await this.redis.incrby(
        this.unitsKey(nowMs),
        due.length * UNITS_PER_VIDEO,
      );
      await this.redis.expire(this.unitsKey(nowMs), UNITS_TTL_SECONDS);
    }

    // An adaptive scheduler that quietly stops polling looks exactly like one
    // that is working. Say so, with counts, every time we defer.
    if (deferredEntries.length > 0) {
      this.logger.warn(
        `YouTube inbox budget: channel ${channelId} deferred ${deferredEntries.length} videos ` +
          `(${JSON.stringify(deferredByTier)}) — ${spent}/${this.dailyUnits} units spent today`,
      );
    }

    return {
      due: due.map((e) => e.candidate),
      deferred: deferredEntries.length,
      deferredByTier,
    };
  }

  async markPolled(
    channelId: number,
    videoId: string,
    nowMs: number,
  ): Promise<void> {
    const key = this.lastPollKey(channelId, videoId);
    await this.redis.set(key, String(nowMs));
    await this.redis.expire(key, LAST_POLL_TTL_SECONDS);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/inbox/services/youtube-inbox-budget.service.spec.ts`
Expected: PASS — 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src/inbox/services/youtube-inbox-budget.service.ts src/inbox/services/youtube-inbox-budget.service.spec.ts
git diff --cached --name-only
git commit -m "feat(inbox): budget-aware youtube poll selection with deferral logging"
```

---

## Task 4: Wire tiering into the poll processor and slow the scheduler

**Files:**
- Modify: `src/inbox/processors/inbox-poll.processor.ts` (constructor; the `for (const post of recent)` loop at lines 175-234)
- Modify: `src/inbox/schedulers/inbox-poll.scheduler.ts:47` (the cron expression) and its doc comment
- Modify: `src/inbox/inbox.module.ts` (register `YoutubeInboxBudgetService` as a provider)
- Test: `src/inbox/processors/inbox-poll.processor.youtube.spec.ts` (create)

**Interfaces:**
- Consumes: `YoutubeInboxBudgetService` with `selectDue(channelId, candidates, nowMs)` and `markPolled(channelId, videoId, nowMs)` from Task 3.
- Produces: nothing for later tasks.

**Context:** This is where the saving is actually realized. Two changes:

The scheduler's cron drops from `*/30 * * * * *` (2,880 cycles/day) to every 5 minutes (288 cycles/day), matching `TieredPollingScheduler`'s cadence. This alone is a 10× cut for every platform. Non-YouTube platforms are unaffected beyond the cadence change — their per-cycle behavior is untouched.

The processor then filters YouTube's candidate posts through `YoutubeInboxBudgetService` before fetching. Other platforms bypass the filter entirely: they have different quota models and are out of scope for this effort.

`markPolled` must be called **after** a successful fetch, inside the existing try block. If a fetch throws, the video stays due and is retried next cycle rather than being silently skipped for 15 minutes.

Note the scheduler still enqueues one job per channel; the per-video decision happens in the processor, where the post list is known.

- [ ] **Step 1: Write the failing test**

Create `src/inbox/processors/inbox-poll.processor.youtube.spec.ts`:

```ts
import { InboxPollProcessor } from './inbox-poll.processor';

/**
 * The processor reaches the DB via a module-level `db` singleton, so this
 * suite exercises the one piece that is unit-testable in isolation and is
 * also the piece this task adds: the YouTube branch that narrows the
 * candidate post list to the budget service's `due` set.
 */
describe('InboxPollProcessor.selectYoutubeTargets', () => {
  const budget = {
    selectDue: jest.fn(),
    markPolled: jest.fn(),
  };

  function build() {
    return new InboxPollProcessor(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      budget as any,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  const posts = [
    { platformPostId: 'vidA', publishedAt: new Date('2026-07-18T00:00:00Z') },
    { platformPostId: 'vidB', publishedAt: new Date('2026-06-01T00:00:00Z') },
  ];

  it('returns only the videos the budget service allows', async () => {
    budget.selectDue.mockResolvedValue({
      due: [{ videoId: 'vidA', publishedAtMs: 0 }],
      deferred: 1,
      deferredByTier: { cool: 1 },
    });

    const allowed = await (build() as any).selectYoutubeTargets(7, posts);

    expect(allowed).toEqual(new Set(['vidA']));
    expect(budget.selectDue).toHaveBeenCalledWith(
      7,
      [
        { videoId: 'vidA', publishedAtMs: posts[0].publishedAt.getTime() },
        { videoId: 'vidB', publishedAtMs: posts[1].publishedAt.getTime() },
      ],
      expect.any(Number),
    );
  });

  it('allows nothing when the budget service returns nothing', async () => {
    budget.selectDue.mockResolvedValue({
      due: [],
      deferred: 2,
      deferredByTier: { hot: 2 },
    });

    const allowed = await (build() as any).selectYoutubeTargets(7, posts);

    expect(allowed.size).toBe(0);
  });

  // A post with no publishedAt has no age, so it cannot be tiered. Treat it
  // as brand new rather than dropping it — dropping would silently stop
  // polling a video forever.
  it('treats a post with no publishedAt as newly published', async () => {
    budget.selectDue.mockResolvedValue({
      due: [],
      deferred: 0,
      deferredByTier: {},
    });
    const now = Date.now();

    await (build() as any).selectYoutubeTargets(7, [
      { platformPostId: 'vidC', publishedAt: null },
    ]);

    const [, candidates] = budget.selectDue.mock.calls[0];
    expect(candidates[0].publishedAtMs).toBeGreaterThanOrEqual(now);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/inbox/processors/inbox-poll.processor.youtube.spec.ts`
Expected: FAIL — `processor.selectYoutubeTargets is not a function`.

- [ ] **Step 3: Inject the budget service and add the selection helper**

In `src/inbox/processors/inbox-poll.processor.ts`, add the import beside the other local imports:

```ts
import { YoutubeInboxBudgetService } from '../services/youtube-inbox-budget.service';
```

Add the parameter to the constructor as the last entry, after `instagramService`:

```ts
    private readonly youtubeBudget: YoutubeInboxBudgetService,
```

Then add this private method to the class, directly above `ensureWebhookSubscription`:

```ts
  /**
   * Narrow a YouTube channel's candidate videos to the ones due for a comment
   * poll right now and affordable within today's unit allowance.
   *
   * Returns the set of platformPostIds allowed through. Only YouTube goes
   * through this gate — other platforms have different quota models and keep
   * their existing every-cycle behavior.
   */
  private async selectYoutubeTargets(
    channelId: number,
    candidates: Array<{
      platformPostId: string;
      publishedAt: Date | null | undefined;
    }>,
  ): Promise<Set<string>> {
    const now = Date.now();
    const selection = await this.youtubeBudget.selectDue(
      channelId,
      candidates.map((c) => ({
        videoId: c.platformPostId,
        // No publishedAt means no age, so it cannot be tiered. Treat it as
        // brand new: polling it once too often is far cheaper than dropping
        // it and never polling it again.
        publishedAtMs: c.publishedAt ? c.publishedAt.getTime() : now,
      })),
      now,
    );
    return new Set(selection.due.map((c) => c.videoId));
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/inbox/processors/inbox-poll.processor.youtube.spec.ts`
Expected: PASS — 3 passed.

- [ ] **Step 5: Apply the gate in the poll loop**

In `src/inbox/processors/inbox-poll.processor.ts`, immediately after the `const adapter = this.dispatcher.get(platform);` line (currently line 170), insert:

```ts
    // YouTube: tier + budget gate. Every other platform polls every post
    // every cycle, as before.
    let youtubeAllowed: Set<string> | null = null;
    if (platform === 'youtube') {
      const candidates = recent
        .map((post) => {
          const t = (post.targets ?? []).find(
            (x: PostTarget) => String(x.channelId) === String(channelId),
          );
          return t?.platformPostId
            ? { platformPostId: t.platformPostId, publishedAt: post.publishedAt }
            : null;
        })
        .filter((c): c is { platformPostId: string; publishedAt: Date | null } =>
          Boolean(c),
        );
      youtubeAllowed = await this.selectYoutubeTargets(channelId, candidates);
    }
```

Then, inside the `for (const post of recent)` loop, immediately after the existing `if (!target?.platformPostId) continue;` line, add:

```ts
      if (youtubeAllowed && !youtubeAllowed.has(target.platformPostId)) continue;
```

Finally, inside that loop's `try` block, immediately after the `fetched += items.length;` line, add:

```ts
        // Mark AFTER a successful fetch — a throw leaves the video due, so
        // the next cycle retries instead of skipping it for a whole interval.
        if (platform === 'youtube') {
          await this.youtubeBudget.markPolled(
            channelId,
            target.platformPostId,
            Date.now(),
          );
        }
```

- [ ] **Step 6: Register the provider**

In `src/inbox/inbox.module.ts`, add the import beside the other service imports:

```ts
import { YoutubeInboxBudgetService } from './services/youtube-inbox-budget.service';
```

and add `YoutubeInboxBudgetService,` to the `providers` array.

- [ ] **Step 7: Slow the scheduler cron**

In `src/inbox/schedulers/inbox-poll.scheduler.ts`, replace line 47:

```ts
  @Cron(CronExpression.EVERY_5_MINUTES, {
    timeZone: 'UTC',
    name: 'enqueueInboxPolling',
  })
```

and update the import on line 2 to:

```ts
import { Cron, CronExpression } from '@nestjs/schedule';
```

Then fix the class doc comment, whose first line at line 11 currently reads `Enqueues inbox polling jobs every 5 minutes.` while the cron ran every 30 seconds — the comment described behavior the code did not have. Replace lines 10-12 with:

```ts
/**
 * Enqueues inbox polling jobs every 5 minutes.
 *
 * Was every 30 seconds, which cost YouTube 2,880 comment-list calls per video
 * per day and exhausted the whole 10,000-unit shared quota at four published
 * videos. YouTube additionally gates each video on an age tier and a daily
 * unit allowance inside InboxPollProcessor; this cron only sets the ceiling.
 *
```

- [ ] **Step 8: Verify the whole suite and build**

Run: `npm run build && npm run test`
Expected: build succeeds; all tests pass. If any existing spec constructs `InboxPollProcessor` directly it will now fail on the new constructor arity — add the mock as the sixth argument.

- [ ] **Step 9: Commit**

```bash
git add src/inbox/processors/inbox-poll.processor.ts src/inbox/processors/inbox-poll.processor.youtube.spec.ts src/inbox/schedulers/inbox-poll.scheduler.ts src/inbox/inbox.module.ts
git diff --cached --name-only
git commit -m "feat(inbox): gate youtube comment polling on age tier + daily unit budget"
```

---

## Task 5: Per-subsystem quota allowances and gating at every YouTube call site

**Files:**
- Modify: `src/channels/analytics/services/quota-tracker.service.ts`
- Modify: `src/channels/analytics/services/quota-tracker.service.spec.ts`
- Modify: `src/channels/services/youtube.service.ts` (gate the API calls)
- Modify: `src/channels/channels.module.ts` (only if `AnalyticsModule` is not already re-exported — verify first)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  type QuotaSubsystem = 'publishing' | 'analytics' | 'inbox';
  QuotaTrackerService.tryConsume(
    platform: SupportedPlatform,
    cost: number,
    subsystem?: QuotaSubsystem,
  ): Promise<QuotaConsumeResult>
  ```
  The `subsystem` parameter is optional, so all five existing call sites keep working unchanged.

**Context:** `QuotaTrackerService` is Redis-backed and correctly budgeted (`platform-capabilities.registry.ts:477` sets YouTube's `dailyQuotaBudget: 10000`), but is wired into only four analytics handlers plus one peek in `analytics.service.ts:409`. Every YouTube write and every comment list is currently ungated.

The gap that matters most is isolation: today a runaway poll consumes the same counter publishing draws on, so the user's paid-for action fails because of a background job. Per-subsystem allowances fix that — each subsystem gets a slice of the platform budget, and exhausting one leaves the others untouched.

Allowances for YouTube's 10,000 shared units, matching the spec's split: publishing 2,000, analytics 5,000, inbox 3,000. A call with no `subsystem` keeps the existing whole-budget behavior, so nothing already working changes.

- [ ] **Step 1: Write the failing test**

Append to `src/channels/analytics/services/quota-tracker.service.spec.ts`, inside the existing `describe`:

```ts
  it('keeps subsystem spend in separate buckets', async () => {
    await service.tryConsume('youtube', 100, 'inbox');
    const analytics = await service.tryConsume('youtube', 100, 'analytics');
    expect(analytics.allowed).toBe(true);
    // Analytics' 5000 allowance is untouched by the inbox's 100 units.
    expect(analytics.remaining).toBe(4900);
  });

  // The whole point of the split: a background poll must never be able to
  // make the user's publish fail.
  it('still allows publishing when the inbox allowance is exhausted', async () => {
    // Spend up to the inbox threshold (95% of 3000 = 2850), then confirm the
    // next inbox call is refused — genuinely exhausted, not merely refused.
    const spend = await service.tryConsume('youtube', 2800, 'inbox');
    expect(spend.allowed).toBe(true);
    const refused = await service.tryConsume('youtube', 100, 'inbox');
    expect(refused.allowed).toBe(false);

    const publish = await service.tryConsume('youtube', 100, 'publishing');
    expect(publish.allowed).toBe(true);
  });

  it('falls back to the whole platform budget when no subsystem is given', async () => {
    const result = await service.tryConsume('youtube', 100);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9900);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/channels/analytics/services/quota-tracker.service.spec.ts`
Expected: FAIL — `Expected: 4900, Received: 9800`, because both calls currently share one counter.

- [ ] **Step 3: Add subsystem allowances**

In `src/channels/analytics/services/quota-tracker.service.ts`, add above the class:

```ts
export type QuotaSubsystem = 'publishing' | 'analytics' | 'inbox';

/**
 * Slices of a platform's daily budget, per subsystem.
 *
 * Without this split a runaway inbox poll drains the same counter publishing
 * draws on, so the user's paid-for action fails because of a background job.
 * Publishing wins ties: it is the thing the user actually asked for.
 *
 * YouTube's 10,000 shared units: 2,000 publishing + 5,000 analytics +
 * 3,000 inbox. The inbox slice matches YOUTUBE_INBOX_DAILY_UNITS' default.
 */
const SUBSYSTEM_ALLOWANCES: Partial<
  Record<SupportedPlatform, Record<QuotaSubsystem, number>>
> = {
  youtube: { publishing: 2000, analytics: 5000, inbox: 3000 },
};
```

Then replace the `tryConsume` method body with:

```ts
  async tryConsume(
    platform: SupportedPlatform,
    cost: number,
    subsystem?: QuotaSubsystem,
  ): Promise<QuotaConsumeResult> {
    const budget = this.resolveBudget(platform, subsystem);
    if (budget === null) {
      return { allowed: true, remaining: Number.POSITIVE_INFINITY };
    }

    const scope = subsystem ? `${platform}:${subsystem}` : platform;
    const key = `quota:${scope}:${this.dayKey()}`;
    const current = Number((await this.redis.get(key)) ?? '0');
    const threshold = Math.floor(budget * 0.95);

    if (current + cost > threshold) {
      this.logger.warn(
        `Quota near-exhausted for ${scope}: ${current}/${budget} (threshold ${threshold})`,
      );
      return { allowed: false, remaining: budget - current };
    }

    const next = await this.redis.incrby(key, cost);
    await this.redis.expire(key, 30 * 60 * 60);

    return { allowed: true, remaining: budget - next };
  }

  /**
   * The ceiling this call is measured against: the subsystem's slice when one
   * is named and defined, otherwise the platform's whole daily budget.
   */
  private resolveBudget(
    platform: SupportedPlatform,
    subsystem?: QuotaSubsystem,
  ): number | null {
    if (subsystem) {
      const allowance = SUBSYSTEM_ALLOWANCES[platform]?.[subsystem];
      if (allowance !== undefined) return allowance;
    }
    return this.getBudget(platform);
  }
```

Leave `getBudget` and `dayKey` unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/channels/analytics/services/quota-tracker.service.spec.ts`
Expected: PASS — 5 passed.

Note the exhaustion test relies on the existing 95% threshold: consuming 3,000 against a 3,000 allowance exceeds `floor(3000 * 0.95) = 2850` and is correctly refused.

- [ ] **Step 5: Confirm `QuotaTrackerService` is reachable from `YouTubeService`**

Run: `grep -n "AnalyticsModule" src/channels/channels.module.ts`

`AnalyticsModule` already exports `QuotaTrackerService` (`src/channels/analytics/analytics.module.ts:96-101`). If `channels.module.ts` neither imports nor exports `AnalyticsModule`, add it to both its `imports` and `exports` arrays so `YouTubeService` can inject the tracker and `InboxModule` keeps resolving. If it already appears, change nothing.

- [ ] **Step 6: Gate the YouTube API calls**

In `src/channels/services/youtube.service.ts`, inject the tracker. Add the import:

```ts
import { QuotaTrackerService } from '../analytics/services/quota-tracker.service';
```

and add to the constructor parameters:

```ts
    private readonly quota: QuotaTrackerService,
```

Add this private helper to the class:

```ts
  /**
   * Reserve quota before a YouTube API call, or throw.
   *
   * Costs are fixed by Google and documented per endpoint:
   * commentThreads.list = 1, comments.insert / commentThreads.insert /
   * comments.delete = 50, channels.list / videos.list = 1,
   * thumbnails.set = 50, playlistItems.insert = 50.
   *
   * videos.insert is deliberately NOT tracked here — it costs ~100 units
   * against its own ~100 calls/day bucket, entirely outside the 10,000-unit
   * shared pool this tracker measures.
   */
  private async reserveQuota(
    cost: number,
    subsystem: 'publishing' | 'analytics' | 'inbox',
    operation: string,
  ): Promise<void> {
    const result = await this.quota.tryConsume('youtube', cost, subsystem);
    if (!result.allowed) {
      throw new Error(
        `YouTube ${subsystem} quota exhausted — skipping ${operation} (${result.remaining} units left)`,
      );
    }
  }
```

Then add a reservation immediately before each API call, using these exact pairings:

| Method | Call | Line |
|---|---|---|
| `fetchVideoComments` | `await this.reserveQuota(1, 'inbox', 'commentThreads.list');` | first statement inside the `while` loop, before the `new URL(...)` |
| `postComment` (first comment, `commentThreads.insert`) | `await this.reserveQuota(50, 'publishing', 'commentThreads.insert');` | first statement of the method |
| `replyToComment` (`comments.insert`) | `await this.reserveQuota(50, 'inbox', 'comments.insert');` | first statement of the method |
| `deleteComment` (`comments.delete`) | `await this.reserveQuota(50, 'inbox', 'comments.delete');` | first statement of the method |

For any other method in this file that calls `channels.list`, `videos.list`, `thumbnails.set` or `playlistItems.insert`, add the matching reservation as the method's first statement: cost 1 and subsystem `'analytics'` for the two list calls, cost 50 and subsystem `'publishing'` for `thumbnails.set` and `playlistItems.insert`. Find them with:

```bash
grep -n "googleapis.com/youtube/v3" src/channels/services/youtube.service.ts
```

Do **not** add a reservation to the resumable-upload path (`videos.insert`) — it is on its own bucket, as the helper's doc comment states.

- [ ] **Step 7: Verify the suite and build**

Run: `npm run build && npm run test`
Expected: build succeeds; all tests pass. `YouTubeService` gained a constructor dependency, so any spec that instantiates it directly (including `youtube.service.comments.spec.ts` from Task 1) needs `{ provide: QuotaTrackerService, useValue: { tryConsume: async () => ({ allowed: true, remaining: 9999 }) } }` added to its providers.

- [ ] **Step 8: Commit**

```bash
git add src/channels/analytics/services/quota-tracker.service.ts src/channels/analytics/services/quota-tracker.service.spec.ts src/channels/services/youtube.service.ts src/channels/services/youtube.service.comments.spec.ts src/channels/channels.module.ts
git diff --cached --name-only
git commit -m "feat(youtube): per-subsystem quota allowances gating every API call"
```

Drop `src/channels/channels.module.ts` from the `git add` if Step 5 required no change to it.

---

## Task 6: `YOUTUBE_APP_AUDITED` pre-audit gate

**Files:**
- Create: `src/channels/services/youtube-audit-gate.service.ts`
- Test: `src/channels/services/youtube-audit-gate.service.spec.ts`
- Modify: `src/posts/publishers/youtube.publisher.ts` (call the gate before publishing)
- Modify: `src/channels/channels.module.ts` (provide and export the service)
- Modify: `.env.example`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `YoutubeAuditGateService.reserveUpload(channelId: number): Promise<void>` — throws `HttpException` 429 when a cap is hit.

**Context:** TikTok already carries this exact pattern (`src/channels/services/tiktok-quota.service.ts`): `TIKTOK_APP_AUDITED=false` gates a pre-audit cap enforced at publish time. YouTube gets the same shape, so that while the project sits on default quota it cannot blow through the ~100 uploads/day bucket, and so a reviewer can see the cap exists.

Two caps, both day-bucketed in Redis with a 24h TTL:
- **Pre-audit** (`YOUTUBE_APP_AUDITED !== 'true'`): at most 50 uploads/day across the whole app — half the ~100/day `videos.insert` bucket, leaving headroom for retries.
- **Per-channel** (always): at most 10 uploads/day/channel, so one workspace cannot consume the app-wide cap.

The flag defaults to `false`, so a missing env var fails safe.

- [ ] **Step 1: Write the failing test**

Create `src/channels/services/youtube-audit-gate.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { YoutubeAuditGateService } from './youtube-audit-gate.service';

const fakeRedis = {
  store: new Map<string, number>(),
  async incr(key: string) {
    const next = (this.store.get(key) ?? 0) + 1;
    this.store.set(key, next);
    return next;
  },
  async decr(key: string) {
    const next = (this.store.get(key) ?? 0) - 1;
    this.store.set(key, next);
    return next;
  },
  async expire() {
    return 1;
  },
  clear() {
    this.store.clear();
  },
};

async function build() {
  const mod = await Test.createTestingModule({
    providers: [
      YoutubeAuditGateService,
      { provide: 'REDIS_CLIENT', useValue: fakeRedis },
    ],
  }).compile();
  return mod.get(YoutubeAuditGateService);
}

describe('YoutubeAuditGateService', () => {
  beforeEach(() => {
    fakeRedis.clear();
    delete process.env.YOUTUBE_APP_AUDITED;
  });

  it('allows an upload under both caps', async () => {
    const svc = await build();
    await expect(svc.reserveUpload(1)).resolves.toBeUndefined();
  });

  it('enforces the 10/day per-channel cap', async () => {
    const svc = await build();
    for (let i = 0; i < 10; i++) await svc.reserveUpload(1);
    await expect(svc.reserveUpload(1)).rejects.toBeInstanceOf(HttpException);
  });

  it('enforces the 50/day app-wide cap while unaudited', async () => {
    const svc = await build();
    // Spread across channels so the per-channel cap never fires first.
    for (let i = 0; i < 50; i++) await svc.reserveUpload(i);
    await expect(svc.reserveUpload(999)).rejects.toThrow(/pre-audit/i);
  });

  it('lifts the app-wide cap once audited', async () => {
    process.env.YOUTUBE_APP_AUDITED = 'true';
    const svc = await build();
    for (let i = 0; i < 60; i++) await svc.reserveUpload(i);
    await expect(svc.reserveUpload(999)).resolves.toBeUndefined();
  });

  // A missing env var must fail SAFE — unset means unaudited, not audited.
  it('treats a missing YOUTUBE_APP_AUDITED as unaudited', async () => {
    const svc = await build();
    for (let i = 0; i < 50; i++) await svc.reserveUpload(i);
    await expect(svc.reserveUpload(999)).rejects.toBeInstanceOf(HttpException);
  });

  // A rejected reservation must not leave the counter incremented, or the
  // cap would ratchet down on every rejected attempt.
  it('does not consume a slot when it rejects', async () => {
    const svc = await build();
    for (let i = 0; i < 10; i++) await svc.reserveUpload(1);
    await expect(svc.reserveUpload(1)).rejects.toBeInstanceOf(HttpException);
    await expect(svc.reserveUpload(1)).rejects.toBeInstanceOf(HttpException);
    const day = new Date().toISOString().slice(0, 10);
    expect(fakeRedis.store.get(`youtube:uploads:channel:1:${day}`)).toBe(10);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/channels/services/youtube-audit-gate.service.spec.ts`
Expected: FAIL — `Cannot find module './youtube-audit-gate.service'`.

- [ ] **Step 3: Write the implementation**

Create `src/channels/services/youtube-audit-gate.service.ts`:

```ts
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';

const DAILY_TTL_SECONDS = 24 * 60 * 60;
/** Half of videos.insert's ~100/day bucket, leaving headroom for retries. */
const PRE_AUDIT_DAILY_UPLOADS = 50;
const PER_CHANNEL_DAILY_UPLOADS = 10;

/** Subset of ioredis used here — same pattern as TikTokQuotaService. */
export interface YoutubeAuditGateRedis {
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

/**
 * Caps YouTube uploads while the project is on default API quota.
 *
 * Mirrors TikTokQuotaService, which does exactly this for TikTok's Direct Post
 * audit gate. videos.insert draws on its own ~100 calls/day bucket, so an
 * unbounded upload path exhausts a day's uploads for every workspace at once.
 *
 * Two caps:
 *   1. Pre-audit (YOUTUBE_APP_AUDITED !== 'true'): 50 uploads/day app-wide.
 *   2. Per-channel: 10 uploads/day, always — one workspace must not be able
 *      to consume the whole app-wide allowance.
 *
 * The flag defaults to false, so a missing env var fails safe.
 */
@Injectable()
export class YoutubeAuditGateService {
  private readonly logger = new Logger(YoutubeAuditGateService.name);

  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: YoutubeAuditGateRedis,
  ) {}

  private get isAudited(): boolean {
    return process.env.YOUTUBE_APP_AUDITED === 'true';
  }

  private dayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * Reserves an upload slot for a channel today.
   * Throws HttpException 429 when either cap is exceeded.
   */
  async reserveUpload(channelId: number): Promise<void> {
    const day = this.dayKey();

    const channelKey = `youtube:uploads:channel:${channelId}:${day}`;
    const channelCount = await this.redis.incr(channelKey);
    if (channelCount === 1) await this.redis.expire(channelKey, DAILY_TTL_SECONDS);

    if (channelCount > PER_CHANNEL_DAILY_UPLOADS) {
      await this.redis.decr(channelKey);
      this.logger.warn(
        `YouTube per-channel upload cap reached for channel ${channelId}: ${channelCount - 1}/${PER_CHANNEL_DAILY_UPLOADS}`,
      );
      throw new HttpException(
        `Daily YouTube upload limit reached for this channel (${PER_CHANNEL_DAILY_UPLOADS}/day).`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (!this.isAudited) {
      const appKey = `youtube:uploads:app:${day}`;
      const appCount = await this.redis.incr(appKey);
      if (appCount === 1) await this.redis.expire(appKey, DAILY_TTL_SECONDS);

      if (appCount > PRE_AUDIT_DAILY_UPLOADS) {
        await this.redis.decr(appKey);
        // Release the channel slot too — this attempt is not proceeding.
        await this.redis.decr(channelKey);
        this.logger.warn(
          `YouTube pre-audit upload cap reached: ${appCount - 1}/${PRE_AUDIT_DAILY_UPLOADS} on ${day}`,
        );
        throw new HttpException(
          'YouTube pre-audit cap reached: uploads are limited until our app is audited.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/channels/services/youtube-audit-gate.service.spec.ts`
Expected: PASS — 6 passed.

- [ ] **Step 5: Call the gate from the publisher**

In `src/posts/publishers/youtube.publisher.ts`, add the import:

```ts
import { YoutubeAuditGateService } from '../../channels/services/youtube-audit-gate.service';
```

add to the constructor parameters:

```ts
    private readonly auditGate: YoutubeAuditGateService,
```

and make the first statement of the publish method — before any upload work begins — reserve the slot:

```ts
    // Pre-audit + per-channel upload caps. Throws 429 when either is hit;
    // reserving BEFORE the upload starts avoids burning a videos.insert call
    // on a request we are about to refuse.
    await this.auditGate.reserveUpload(channel.id);
```

Adjust `channel.id` to whatever the method's channel variable is actually named.

- [ ] **Step 6: Register the provider**

In `src/channels/channels.module.ts`, add the import, then add `YoutubeAuditGateService` to both the `providers` and `exports` arrays so `PostsModule` can inject it.

- [ ] **Step 7: Document the env vars**

Add to `.env.example`:

```
# YouTube quota safety
# Set to 'true' only after the YouTube API Services Compliance Audit passes.
# Unset or any other value = unaudited, which enforces conservative caps.
YOUTUBE_APP_AUDITED=false
# Share of YouTube's 10,000/day unit pool that inbox comment polling may spend.
YOUTUBE_INBOX_DAILY_UNITS=3000
```

- [ ] **Step 8: Verify the suite and build**

Run: `npm run build && npm run test`
Expected: build succeeds; all tests pass. `YouTubePublisher` gained a constructor dependency, so any spec constructing it directly needs a `{ reserveUpload: async () => undefined }` mock.

- [ ] **Step 9: Commit**

```bash
git add src/channels/services/youtube-audit-gate.service.ts src/channels/services/youtube-audit-gate.service.spec.ts src/posts/publishers/youtube.publisher.ts src/channels/channels.module.ts .env.example
git diff --cached --name-only
git commit -m "feat(youtube): YOUTUBE_APP_AUDITED pre-audit upload caps"
```

---

## Verification after all tasks

The spec's Testing section maps to these suites:

| Spec requirement | Covered by |
|---|---|
| Quota math across 1, 10, 100 channels | Task 3 — `spends the allowance across calls, not per call`, `defaults the daily allowance to 3000 units` |
| Tier assignment boundary tests at 48h, 7d, 30d | Task 2 — the three boundary tests |
| Early-exit pagination stops at page 2 | Task 1 — `stops paging at the first page with nothing newer than since` |
| Exhausted polling allowance must not block a publish | Task 5 — `still allows publishing when the inbox allowance is exhausted` |
| Deferred tiers logged with counts | Task 3 — `selectDue` logger.warn with `deferredByTier` |

Final check before opening the PR:

```bash
npm run build && npm run test && npm run lint
git log --oneline origin/main..HEAD
```

Expected: six commits, one per task, and a clean build/test/lint.

**Deploy note:** `YOUTUBE_APP_AUDITED` and `YOUTUBE_INBOX_DAILY_UNITS` must be set on Railway before this ships. Both have safe defaults if omitted, but setting them explicitly is what makes the caps auditable.
