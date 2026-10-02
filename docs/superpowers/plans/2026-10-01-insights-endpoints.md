# Insights endpoints (backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve real post analytics for the workspace Insights page: an overview, a paged content table, and a CSV export, all on the post-performance rule Home already uses.

**Architecture:** A new `src/insights/` Nest module. Its controller validates input, and its service fetches channels, posts (via `PostPerformanceRepository`, one query), follower rollup rows and sync state. Pure functions in `src/insights/lib/` turn those rows into the response, so every rule is unit-tested without a database. Period and follower helpers that Home and Insights share move into `src/post-performance/`.

**Tech Stack:** NestJS 11, Drizzle (node-postgres), Jest + supertest, Postgres 17 locally for proving SQL.

**Spec:** `socialmedia-frontend/docs/superpowers/specs/2026-10-01-insights-post-analytics-design.md`. It lives on frontend branch `feat/insights-post-analytics`, in worktree `socialmedia-frontend-insights`.

**Worktree:** `D:\My Documents\MyProjects\FullStackProjects\socialmedia-workspace-insights`, branch `feat/insights-endpoints`.
- `node_modules` is a junction. Before removing the worktree, run `cmd /c rmdir` on it.
- Run every command from the worktree root.

## Global Constraints

- **Windows:** whole UTC days. The last 7 / 30 / 90 days end **yesterday**, compared with the same span just before. `days` defaults to 30; anything else → 400.
- **Post rule:**
  - every post a channel published in the window, **once per (post, channel)**, with that channel's latest snapshot;
  - engagements = likes + comments + shares;
  - rate = engagements ÷ impressions × 100 (one decimal), over **only** posts that report impressions.
- **Channels:** social only, decided by platform via `CHANNEL_CATEGORY`, never the `category` column.
  - `channels` ids that aren't the workspace's active social channels are **dropped**.
  - A malformed list → 400.
- **Rollup:** never read `channel_analytics_daily`'s engagement or post columns. Only `followers_at_end_of_day` and `followers_gained`.
- **Still collecting:** `stillCollectingFrom` = today − 3 days.
- **Best times:** weekday 0 = Monday, six 4-hour slots from midnight, in `tz` (default `UTC`, invalid → 400).
  - A cell's rate needs ≥ 2 rated posts.
  - `best` is empty when rated posts < 6.
- **Table:**
  - `format` = `all|image|video|carousel|text`; `sort` = `publishedAt|impressions|engagements|engagementRate|likes|comments|shares`; `order` = `desc|asc`;
  - `limit` = 1–100, default 10; `offset` ≥ 0;
  - nulls sort last in both directions.
- **CSV:**
  - UTF-8 BOM, CRLF lines, RFC 4180 quoting;
  - a cell starting with `=` `+` `-` `@` tab or CR gets a leading `'`;
  - filename `schedura-posts-<from>-<to>.csv`.
- **Guards:** `JwtAuthGuard`, `WorkspaceRoleGuard`, `@RequireCapability('analytics:view')`. `:workspaceId` uses `ParseUUIDPipe`.
- **No migration:** every column exists.
- **Style:** Prettier with single quotes and trailing commas. Comments say *why*. Match the surrounding code.

## Review Focus

1. **A caption with commas, quotes, newlines, Urdu or emoji in the CSV.** Excel must open one row per post with the text intact (BOM + quoting). Pinned in Task 6.
2. **A channel disconnected between page loads,** so its id is still in `channels`. The page must not error: the id is dropped and the rest still counts. Pinned in Tasks 6 and 7.
3. **A platform that reports `0` impressions.** The rate must be null, never `Infinity` or `NaN`, and such posts must sort last when sorting by rate. Pinned in Tasks 3 and 6.
4. **A best-times post near a DST change, or near midnight in a far-from-UTC zone.** It must land in the local weekday and hour. Pinned in Task 5 (America/New_York across the November change, and Asia/Karachi).
5. **A post published minutes ago with no snapshot yet.** It counts in Posts, has null metrics, sorts last and is never a "top" post. Pinned in Tasks 5 and 6.

---

### Task 1: Shared period and follower helpers

The window maths and follower rows Home computes privately become shared, so Insights uses the same windows.

**Files:**
- Create: `src/post-performance/period.ts`, `src/post-performance/period.spec.ts`
- Create: `src/post-performance/followers.ts`, `src/post-performance/followers.spec.ts`
- Modify: `src/post-performance/post-performance.ts`: use `round1` from `period.ts`
- Modify: `src/home/home.service.ts`: delete the local `isoDate`, `utcToday`, `windowOf` and `metric`; import them
- Modify: `src/home/lib/home-summary.ts`: re-export `deltaPct`, `FollowerRow`, `followersGainedOf` and the range aliases from the shared files
- Modify: `src/home/dto/home-summary.dto.ts`: `PulseWindow` and `PulseMetric` become aliases

**Interfaces:**
- Produces:
  - `DAY_MS`, `PERIOD_DAYS`, `type PeriodDays`
  - `interface PeriodWindow { from; to; previousFrom; previousTo }`
  - `interface MetricChange { value; previous; deltaPct }`
  - `isoDate(d: Date): string`, `round1(n): number`, `isPeriodDays(n): n is PeriodDays`
  - `utcToday(now: Date): Date`, `windowOf(today: Date, days: number): PeriodWindow`
  - `deltaPct(cur, prev): number | null`, `metricChange(value, previous): MetricChange`
  - `datesBetween(from, to): string[]`
  - `interface FollowerRow { channelId; date; followersAtEndOfDay; followersGained }`
  - `followersGainedOf(rows): number | null`, `followersByDay(rows, from, to): Map<string, number | null>`

- [ ] **Step 1: Write the failing tests**

`src/post-performance/period.spec.ts`:

```ts
import {
  datesBetween,
  deltaPct,
  isPeriodDays,
  metricChange,
  utcToday,
  windowOf,
} from './period';

const NOW = new Date('2026-09-30T12:00:00Z');

describe('windowOf', () => {
  it('is the last whole days ending yesterday, and the same span before', () => {
    expect(windowOf(utcToday(NOW), 7)).toEqual({
      from: '2026-09-23',
      to: '2026-09-29',
      previousFrom: '2026-09-16',
      previousTo: '2026-09-22',
    });
    expect(windowOf(utcToday(NOW), 30)).toEqual({
      from: '2026-08-31',
      to: '2026-09-29',
      previousFrom: '2026-08-01',
      previousTo: '2026-08-30',
    });
  });
});

describe('utcToday', () => {
  it('is midnight UTC whatever the hour', () => {
    expect(utcToday(new Date('2026-09-30T23:59:59Z')).toISOString()).toBe(
      '2026-09-30T00:00:00.000Z',
    );
  });
});

describe('deltaPct / metricChange', () => {
  it('is the percentage change, one decimal', () => {
    expect(deltaPct(12, 10)).toBe(20);
    expect(deltaPct(326, 340)).toBe(-4.1);
  });
  it('is null when there is nothing to compare against', () => {
    expect(deltaPct(5, 0)).toBeNull();
    expect(deltaPct(5, null)).toBeNull();
    expect(deltaPct(null, 5)).toBeNull();
  });
  it('carries both values with the change', () => {
    expect(metricChange(6, 4)).toEqual({ value: 6, previous: 4, deltaPct: 50 });
  });
});

describe('isPeriodDays', () => {
  it('accepts 7, 30 and 90 only', () => {
    expect([7, 30, 90].every(isPeriodDays)).toBe(true);
    expect([0, 1, 14, 31, 365, NaN].some(isPeriodDays)).toBe(false);
  });
});

describe('datesBetween', () => {
  it('lists every date inclusive, across a month end', () => {
    expect(datesBetween('2026-09-29', '2026-10-02')).toEqual([
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
  });
  it('is empty when the range is backwards', () => {
    expect(datesBetween('2026-09-02', '2026-09-01')).toEqual([]);
  });
});
```

`src/post-performance/followers.spec.ts`:

```ts
import {
  followersByDay,
  followersGainedOf,
  type FollowerRow,
} from './followers';

const row = (over: Partial<FollowerRow>): FollowerRow => ({
  channelId: 1,
  date: '2026-09-20',
  followersAtEndOfDay: null,
  followersGained: null,
  ...over,
});

describe('followersGainedOf', () => {
  it('adds the daily gains across channels, losses included', () => {
    expect(
      followersGainedOf([
        row({ channelId: 1, followersGained: 5 }),
        row({ channelId: 2, followersGained: -2 }),
      ]),
    ).toBe(3);
  });
  it('is null, not zero, when no channel reported a change', () => {
    expect(followersGainedOf([row({})])).toBeNull();
  });
});

describe('followersByDay', () => {
  it("carries each channel's last count over days the rollup missed", () => {
    const totals = followersByDay(
      [
        // Seeds the carry: before the range.
        row({ channelId: 1, date: '2026-09-18', followersAtEndOfDay: 100 }),
        row({ channelId: 2, date: '2026-09-20', followersAtEndOfDay: 50 }),
        row({ channelId: 1, date: '2026-09-21', followersAtEndOfDay: 110 }),
      ],
      '2026-09-19',
      '2026-09-22',
    );
    expect([...totals.entries()]).toEqual([
      ['2026-09-19', 100],
      ['2026-09-20', 150],
      ['2026-09-21', 160],
      ['2026-09-22', 160],
    ]);
  });

  it('is null on days before any channel reported', () => {
    const totals = followersByDay(
      [row({ date: '2026-09-21', followersAtEndOfDay: 7 })],
      '2026-09-20',
      '2026-09-21',
    );
    expect(totals.get('2026-09-20')).toBeNull();
    expect(totals.get('2026-09-21')).toBe(7);
  });

  it('ignores a null count instead of wiping the carry', () => {
    const totals = followersByDay(
      [
        row({ date: '2026-09-20', followersAtEndOfDay: 40 }),
        row({ date: '2026-09-21', followersAtEndOfDay: null }),
      ],
      '2026-09-21',
      '2026-09-21',
    );
    expect(totals.get('2026-09-21')).toBe(40);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx jest src/post-performance/period.spec.ts src/post-performance/followers.spec.ts`
Expected: FAIL with `Cannot find module './period'` and `'./followers'`

- [ ] **Step 3: Write the shared modules**

`src/post-performance/period.ts`:

```ts
/**
 * The periods Home and Insights compare: the last 7, 30 or 90 whole UTC days,
 * ending yesterday, against the same span just before. Shared so the two
 * screens can never draw their windows differently.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

export const PERIOD_DAYS = [7, 30, 90] as const;
export type PeriodDays = (typeof PERIOD_DAYS)[number];

/** Inclusive UTC dates: the window and the same span just before it. */
export interface PeriodWindow {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
}

export interface MetricChange {
  /** This window's total; null when nothing reported the metric. */
  value: number | null;
  previous: number | null;
  /** % change vs the previous window, one decimal; null when not comparable. */
  deltaPct: number | null;
}

export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

export const round1 = (n: number): number => Math.round(n * 10) / 10;

export function isPeriodDays(n: number): n is PeriodDays {
  return (PERIOD_DAYS as readonly number[]).includes(n);
}

/**
 * Midnight UTC today. Windows end the day before: today's posts have barely
 * been measured and today's follower rollup is still being written.
 */
export function utcToday(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/** The last `days` complete days and the same span before them. */
export function windowOf(today: Date, days: number): PeriodWindow {
  const from = new Date(today.getTime() - days * DAY_MS);
  return {
    from: isoDate(from),
    to: isoDate(new Date(today.getTime() - DAY_MS)),
    previousFrom: isoDate(new Date(today.getTime() - 2 * days * DAY_MS)),
    previousTo: isoDate(new Date(from.getTime() - DAY_MS)),
  };
}

/** Percentage change, one decimal. Null when either side is unknown or the base is 0. */
export function deltaPct(
  current: number | null,
  previous: number | null,
): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return round1(((current - previous) / previous) * 100);
}

export function metricChange(
  value: number | null,
  previous: number | null,
): MetricChange {
  return { value, previous, deltaPct: deltaPct(value, previous) };
}

/** Every date from `from` to `to`, inclusive, `YYYY-MM-DD`. */
export function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += DAY_MS) {
    dates.push(isoDate(new Date(t)));
  }
  return dates;
}
```

`src/post-performance/followers.ts`:

```ts
import { datesBetween } from './period';

/**
 * A channel's followers on one day, from the daily rollup. Unlike its
 * engagement columns, its follower columns are genuinely per day.
 */
export interface FollowerRow {
  channelId: number;
  /** `YYYY-MM-DD`, one row per channel per day. */
  date: string;
  followersAtEndOfDay: number | null;
  followersGained: number | null;
}

/** Follower gains summed across rows; null when no channel reported a change. */
export function followersGainedOf(rows: FollowerRow[]): number | null {
  let gained: number | null = null;
  for (const r of rows) {
    if (r.followersGained !== null) gained = (gained ?? 0) + r.followersGained;
  }
  return gained;
}

/**
 * Total followers at the end of each day from `from` to `to`. Each channel's
 * last known count is carried over days the rollup missed, and rows before
 * `from` seed the carry. The value is null on a day before any channel had
 * reported.
 */
export function followersByDay(
  rows: FollowerRow[],
  from: string,
  to: string,
): Map<string, number | null> {
  const sorted = rows
    .filter((r) => r.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date));
  const latest = new Map<number, number>();
  const totals = new Map<string, number | null>();
  let i = 0;

  for (const date of datesBetween(from, to)) {
    while (i < sorted.length && sorted[i].date <= date) {
      const r = sorted[i++];
      if (r.followersAtEndOfDay !== null) {
        latest.set(r.channelId, r.followersAtEndOfDay);
      }
    }
    totals.set(
      date,
      latest.size ? [...latest.values()].reduce((a, b) => a + b, 0) : null,
    );
  }
  return totals;
}
```

- [ ] **Step 4: Point Home at the shared modules**

In `src/post-performance/post-performance.ts`, replace `const round1 = (n: number) => Math.round(n * 10) / 10;` with:

```ts
import { round1 } from './period';
```

Put this import above the first interface.

In `src/home/lib/home-summary.ts`:

1. Delete the `FollowerRow` interface and the `followersGainedOf` function.
2. Delete the local `PULSE_RANGES`, `PulseRange`, `isPulseRange`, `deltaPct` and `round1`. `summarizeChannel` still calls `round1`; the import below provides it. Keep the local `DAY_MS` and `WEEK_MS`.
3. Add at the top:

```ts
import {
  followersGainedOf,
  type FollowerRow,
} from '../../post-performance/followers';
import {
  PERIOD_DAYS,
  deltaPct,
  isPeriodDays,
  round1,
  type PeriodDays,
} from '../../post-performance/period';

// Home's names for the shared period helpers; its specs and DTOs use them.
export { deltaPct, followersGainedOf, type FollowerRow };
export const PULSE_RANGES = PERIOD_DAYS;
export type PulseRange = PeriodDays;
export const isPulseRange = isPeriodDays;
```

In `src/home/dto/home-summary.dto.ts`, replace the `PulseMetric` and `PulseWindow` interfaces with:

```ts
import type {
  MetricChange,
  PeriodWindow,
} from '../../post-performance/period';

export type PulseMetric = MetricChange;
/** Inclusive UTC dates: the window and the same span just before it. */
export type PulseWindow = PeriodWindow;
```

In `src/home/home.service.ts`:
1. Delete `DAY_MS`, `isoDate`, `metric`, `utcToday` and `windowOf`.
2. Import them from the shared module:

```ts
import {
  DAY_MS,
  isoDate,
  metricChange as metric,
  utcToday,
  windowOf,
} from '../post-performance/period';
```

- [ ] **Step 5: Run the shared and Home tests**

Run: `npx jest src/post-performance src/home`
Expected: PASS. Home's 25 existing tests are unchanged and green.

Run: `npx tsc -p tsconfig.build.json --noEmit`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add src/post-performance src/home
git commit -m "refactor(post-performance): share period and follower helpers with Home"
```

---

### Task 2: Detail columns on published posts

Insights needs each post's caption, media, link, publish time and reported media type. Home ignores them. It stays one query.

**Files:**
- Modify: `src/post-performance/post-performance.ts`: add fields to `PublishedPost`
- Modify: `src/post-performance/post-performance.repository.ts`: SQL and row mapping
- Create: `src/post-performance/post-performance.repository.spec.ts`
- Modify (test factories only): `src/post-performance/post-performance.spec.ts`, `src/home/lib/home-summary.spec.ts`, `src/home/home.service.spec.ts`

**Interfaces:**
- Produces:
  - `interface PostMediaItem { url: string; type: string; thumbnailUrl?: string | null }`
  - `PublishedPost` gains `publishedAt: string`, `content: string`, `mediaItems: PostMediaItem[]`, `imported: boolean`, `permalink: string | null` and `mediaType: string | null`
  - `toPublishedPost(row: PublishedPostRow): PublishedPost`

- [ ] **Step 1: Write the failing mapping test**

`src/post-performance/post-performance.repository.spec.ts`:

```ts
import { toPublishedPost } from './post-performance.repository';

describe('toPublishedPost', () => {
  const base = {
    post_id: 'p1',
    channel_id: '16',
    published_on: '2026-09-25',
    published_at: new Date('2026-09-25T10:00:00Z'),
    content: 'Hello',
    media_items: [{ url: 'https://x/a.jpg', type: 'image' }],
    imported: false,
    permalink: 'https://instagram.com/p/abc',
    likes_count: '50',
    comments_count: 1,
    shares_count: null,
    impressions_count: '900',
    media_type: 'CAROUSEL_ALBUM',
  };

  it('turns Postgres strings into numbers and keeps unreported counts null', () => {
    expect(toPublishedPost(base)).toEqual({
      postId: 'p1',
      channelId: 16,
      publishedOn: '2026-09-25',
      publishedAt: '2026-09-25T10:00:00.000Z',
      content: 'Hello',
      mediaItems: [{ url: 'https://x/a.jpg', type: 'image' }],
      imported: false,
      permalink: 'https://instagram.com/p/abc',
      likes: 50,
      comments: 1,
      shares: null,
      impressions: 900,
      mediaType: 'CAROUSEL_ALBUM',
    });
  });

  it('copes with a string timestamp, no media and a null import flag', () => {
    const p = toPublishedPost({
      ...base,
      published_at: '2026-09-25 10:00:00+00',
      media_items: null,
      imported: null,
      permalink: null,
      media_type: null,
    });
    expect(p.publishedAt).toBe('2026-09-25T10:00:00.000Z');
    expect(p.mediaItems).toEqual([]);
    expect(p.imported).toBe(false);
    expect(p.permalink).toBeNull();
    expect(p.mediaType).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/post-performance/post-performance.repository.spec.ts`
Expected: FAIL. The returned object lacks `publishedAt`, `content` and the other new fields.

- [ ] **Step 3: Extend the type and the repository**

In `src/post-performance/post-performance.ts`, add above `PublishedPost`:

```ts
/** A media item as stored on the post. Imported posts call every item `image`. */
export interface PostMediaItem {
  url: string;
  type: string;
  thumbnailUrl?: string | null;
}
```

Add these fields to `PublishedPost`, after `impressions`:

```ts
  /** When it went out, ISO 8601. */
  publishedAt: string;
  /** Caption, first 280 characters; '' when there is none. */
  content: string;
  mediaItems: PostMediaItem[];
  /** Imported from the platform rather than composed in Schedura. */
  imported: boolean;
  /** The post on the platform, when the target recorded it. */
  permalink: string | null;
  /** Latest snapshot's `platform_metrics.mediaType` (Instagram, Threads, X). */
  mediaType: string | null;
```

Replace `PublishedPostRow`, `toPublishedPost` and the SQL in `src/post-performance/post-performance.repository.ts`:

```ts
import type { PostMediaItem, PublishedPost } from './post-performance';

/** A row as Postgres returns it: bigint ids and counts can arrive as strings. */
export interface PublishedPostRow {
  post_id: string;
  channel_id: string | number;
  published_on: string;
  published_at: Date | string;
  content: string | null;
  media_items: PostMediaItem[] | null;
  imported: boolean | null;
  permalink: string | null;
  likes_count: string | number | null;
  comments_count: string | number | null;
  shares_count: string | number | null;
  impressions_count: string | number | null;
  media_type: string | null;
}

const count = (v: string | number | null): number | null =>
  v === null ? null : Number(v);

export function toPublishedPost(r: PublishedPostRow): PublishedPost {
  return {
    postId: r.post_id,
    channelId: Number(r.channel_id),
    publishedOn: r.published_on,
    publishedAt: new Date(r.published_at).toISOString(),
    content: r.content ?? '',
    mediaItems: r.media_items ?? [],
    imported: r.imported === true,
    permalink: r.permalink,
    likes: count(r.likes_count),
    comments: count(r.comments_count),
    shares: count(r.shares_count),
    impressions: count(r.impressions_count),
    mediaType: r.media_type,
  };
}
```

The query body, replacing the existing `SELECT … FROM posts p …` (the `WHERE` clause is unchanged):

```ts
    const result = await this.db.execute(sql`
      SELECT
        p.id AS post_id,
        t.channel_id,
        to_char(p.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS published_on,
        p.published_at,
        left(coalesce(p.content, ''), 280) AS content,
        coalesce(p.media_items, '[]'::jsonb) AS media_items,
        coalesce(p.metadata->>'syncedFrom', '') = 'platform' AS imported,
        t.permalink,
        m.likes_count,
        m.comments_count,
        m.shares_count,
        m.impressions_count,
        m.media_type
      FROM posts p
      CROSS JOIN LATERAL (
        -- One row per channel: a post can target one channel twice (e.g. two
        -- Slack destinations); it is still one publication on that channel.
        SELECT
          e->>'channelId' AS channel_id,
          max(e->>'platformPostUrl') AS permalink
        FROM jsonb_array_elements(p.targets) e
        WHERE (e->>'status' = 'published' OR e->>'publishStatus' = 'published')
          AND e->>'channelId' IN (${ids})
        GROUP BY e->>'channelId'
      ) t
      LEFT JOIN LATERAL (
        SELECT
          s.likes_count, s.comments_count, s.shares_count, s.impressions_count,
          s.platform_metrics->>'mediaType' AS media_type
        FROM post_metric_snapshots s
        WHERE s.post_id = p.id
          AND s.channel_id::text = t.channel_id
        ORDER BY s.snapshot_at DESC
        LIMIT 1
      ) m ON true
      WHERE p.workspace_id = ${workspaceId}
        AND p.status IN ('published', 'partially_published')
        AND p.published_at >= ${new Date(`${from}T00:00:00Z`)}
        AND p.published_at < ${new Date(`${before}T00:00:00Z`)}
    `);
```

- [ ] **Step 4: Give the test factories the new fields**

In each of these files, the `post` factory's default object gains the new fields, before `...over`:
- `src/post-performance/post-performance.spec.ts`
- `src/home/lib/home-summary.spec.ts`
- `src/home/home.service.spec.ts`

```ts
  publishedAt: '2026-09-20T10:00:00.000Z',
  content: '',
  mediaItems: [],
  imported: false,
  permalink: null,
  mediaType: null,
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx jest src/post-performance src/home`
Expected: PASS

Run: `npx tsc -p tsconfig.build.json --noEmit`
Expected: exit 0

- [ ] **Step 6: Prove the SQL against local Postgres (rolled back)**

Update the scratchpad script `verify-published-posts.ts`. The recipe is in memory note `reference_local_postgres_sql_verification`.
- Fixture changes:
  - P1's IG target gets `platformPostUrl: 'https://instagram.com/p/one'`;
  - its latest IG snapshot gets `platform_metrics '{"mediaType":"CAROUSEL_ALBUM"}'`;
  - P2 gets a 300-character caption and `metadata '{"syncedFrom":"platform"}'`.
- Print `postId`, `channelId`, `publishedAt`, `content.length`, `imported`, `permalink` and `mediaType`.

Run, from the worktree:
```bash
NODE_PATH="D:/My Documents/MyProjects/FullStackProjects/socialmedia-workspace/node_modules" \
TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' \
npx ts-node -T <scratchpad>/verify-published-posts.ts
```

Expected:
- The same five rows as before.
- P1/IG has permalink `https://instagram.com/p/one` and mediaType `CAROUSEL_ALBUM`.
- P1/LinkedIn has permalink null.
- P2 has `content.length` 280 and `imported` true.
- "rolled back" is printed.

Then `psql` re-count shows posts=3, snapshots=0.

- [ ] **Step 7: Commit**

```bash
git add src/post-performance src/home
git commit -m "feat(post-performance): each published post carries its caption, media, link and media type"
```

---

### Task 3: Insight posts and their format

**Files:**
- Create: `src/insights/lib/insight-post.ts`, `src/insights/lib/insight-post.spec.ts`

**Interfaces:**
- Consumes: `PublishedPost`, `engagementsOf` (post-performance), `round1` (period)
- Produces:
  - `POST_FORMATS`, `type PostFormat = 'image'|'video'|'carousel'|'text'`, `type InsightFormat = PostFormat | 'unknown'`
  - `interface InsightPost { postId; channelId; publishedAt; content; format; thumbnailUrl; permalink; likes; comments; shares; impressions; engagements; engagementRate }`
  - `classifyFormat(p: PublishedPost, platform: string): InsightFormat`
  - `toInsightPost(p: PublishedPost, platform: string): InsightPost`

- [ ] **Step 1: Write the failing tests**

`src/insights/lib/insight-post.spec.ts`:

```ts
import type { PublishedPost } from '../../post-performance/post-performance';
import { classifyFormat, toInsightPost } from './insight-post';

const post = (over: Partial<PublishedPost>): PublishedPost => ({
  postId: 'p1',
  channelId: 1,
  publishedOn: '2026-09-20',
  likes: null,
  comments: null,
  shares: null,
  impressions: null,
  publishedAt: '2026-09-20T10:00:00.000Z',
  content: '',
  mediaItems: [],
  imported: false,
  permalink: null,
  mediaType: null,
  ...over,
});

describe('classifyFormat', () => {
  it('calls every YouTube and TikTok post a video', () => {
    const imported = post({ imported: true, mediaItems: [{ url: 'u', type: 'image' }] });
    expect(classifyFormat(imported, 'youtube')).toBe('video');
    expect(classifyFormat(imported, 'tiktok')).toBe('video');
  });

  it.each([
    ['IMAGE', 'image'],
    ['photo', 'image'],
    ['VIDEO', 'video'],
    ['REELS', 'video'],
    ['video', 'video'],
    ['animated_gif', 'video'],
    ['CAROUSEL_ALBUM', 'carousel'],
    ['TEXT', 'text'],
    ['TEXT_POST', 'text'],
  ])('trusts the media type the platform reported (%s → %s)', (mediaType, format) => {
    expect(classifyFormat(post({ mediaType, imported: true }), 'instagram')).toBe(format);
  });

  it('reads a Schedura post from its own media', () => {
    const img = { url: 'u', type: 'image' };
    expect(classifyFormat(post({}), 'linkedin')).toBe('text');
    expect(classifyFormat(post({ mediaItems: [img] }), 'linkedin')).toBe('image');
    expect(classifyFormat(post({ mediaItems: [{ url: 'u', type: 'gif' }] }), 'linkedin')).toBe('image');
    expect(classifyFormat(post({ mediaItems: [{ url: 'u', type: 'video' }] }), 'linkedin')).toBe('video');
    expect(classifyFormat(post({ mediaItems: [img, img] }), 'linkedin')).toBe('carousel');
    expect(classifyFormat(post({ mediaItems: [{ url: 'u', type: 'carousel' }] }), 'linkedin')).toBe('carousel');
  });

  it("won't guess for an imported post: its media is always stored as image", () => {
    expect(
      classifyFormat(post({ imported: true, mediaItems: [{ url: 'u', type: 'image' }] }), 'facebook'),
    ).toBe('unknown');
  });

  it('ignores a media type it does not know, including prototype keys', () => {
    expect(classifyFormat(post({ mediaType: 'constructor', imported: true }), 'instagram')).toBe('unknown');
    expect(classifyFormat(post({ mediaType: 'HOLOGRAM' }), 'instagram')).toBe('text');
  });
});

describe('toInsightPost', () => {
  it('adds engagements, the rate and a thumbnail', () => {
    const p = toInsightPost(
      post({
        likes: 40,
        comments: 8,
        shares: 2,
        impressions: 1000,
        content: 'Caption',
        permalink: 'https://x/p',
        mediaItems: [{ url: 'https://x/v.mp4', type: 'video', thumbnailUrl: 'https://x/v.jpg' }],
      }),
      'instagram',
    );
    expect(p).toMatchObject({
      engagements: 50,
      engagementRate: 5,
      thumbnailUrl: 'https://x/v.jpg',
      format: 'video',
      content: 'Caption',
      permalink: 'https://x/p',
    });
  });

  it('uses the media url when there is no thumbnail, and null without media', () => {
    expect(toInsightPost(post({ mediaItems: [{ url: 'https://x/a.jpg', type: 'image' }] }), 'x').thumbnailUrl).toBe('https://x/a.jpg');
    expect(toInsightPost(post({}), 'x').thumbnailUrl).toBeNull();
  });

  it('has no rate without impressions, or with zero impressions', () => {
    expect(toInsightPost(post({ likes: 5 }), 'bluesky').engagementRate).toBeNull();
    expect(toInsightPost(post({ likes: 5, impressions: 0 }), 'x').engagementRate).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx jest src/insights/lib/insight-post.spec.ts`
Expected: FAIL with `Cannot find module './insight-post'`

- [ ] **Step 3: Implement**

`src/insights/lib/insight-post.ts`:

```ts
import {
  engagementsOf,
  type PublishedPost,
} from '../../post-performance/post-performance';
import { round1 } from '../../post-performance/period';

export const POST_FORMATS = ['image', 'video', 'carousel', 'text'] as const;
export type PostFormat = (typeof POST_FORMATS)[number];
/** `unknown`: an imported post whose platform didn't say what it was. */
export type InsightFormat = PostFormat | 'unknown';

/** One post on one channel, as the Insights page shows it. */
export interface InsightPost {
  postId: string;
  channelId: number;
  publishedAt: string;
  content: string;
  format: InsightFormat;
  thumbnailUrl: string | null;
  permalink: string | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  impressions: number | null;
  engagements: number;
  /** Engagements ÷ impressions × 100, one decimal; null without impressions. */
  engagementRate: number | null;
}

/** Every post on these platforms is a video, whatever was stored. */
const VIDEO_PLATFORMS = new Set(['youtube', 'tiktok']);

/** What the Instagram, Threads and X adapters record as `mediaType`. */
const REPORTED_FORMAT = new Map<string, PostFormat>([
  ['IMAGE', 'image'],
  ['photo', 'image'],
  ['VIDEO', 'video'],
  ['REELS', 'video'],
  ['video', 'video'],
  ['animated_gif', 'video'],
  ['CAROUSEL_ALBUM', 'carousel'],
  ['TEXT', 'text'],
  ['TEXT_POST', 'text'],
]);

/**
 * The post's format: the platform first, then what the platform reported,
 * then the media we composed. An imported post's media is always stored as
 * `image`, so for one the platform hasn't described we say `unknown` rather
 * than guess.
 */
export function classifyFormat(
  p: PublishedPost,
  platform: string,
): InsightFormat {
  if (VIDEO_PLATFORMS.has(platform)) return 'video';
  const reported = p.mediaType ? REPORTED_FORMAT.get(p.mediaType) : undefined;
  if (reported) return reported;
  if (p.imported) return 'unknown';

  const items = p.mediaItems;
  if (items.length === 0) return 'text';
  if (items.length > 1 || items.some((i) => i.type === 'carousel')) {
    return 'carousel';
  }
  if (items.some((i) => i.type === 'video')) return 'video';
  return 'image';
}

export function toInsightPost(p: PublishedPost, platform: string): InsightPost {
  const engagements = engagementsOf(p);
  const first = p.mediaItems[0];
  return {
    postId: p.postId,
    channelId: p.channelId,
    publishedAt: p.publishedAt,
    content: p.content,
    format: classifyFormat(p, platform),
    thumbnailUrl: first ? (first.thumbnailUrl ?? first.url) : null,
    permalink: p.permalink,
    likes: p.likes,
    comments: p.comments,
    shares: p.shares,
    impressions: p.impressions,
    engagements,
    engagementRate: p.impressions
      ? round1((engagements / p.impressions) * 100)
      : null,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/insights/lib/insight-post.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/insights/lib
git commit -m "feat(insights): classify each post's format without guessing for imports"
```

---

### Task 4: Day series, follower totals and the per-channel breakdown

**Files:**
- Create: `src/insights/lib/series.ts`, `src/insights/lib/series.spec.ts`
- Create: `src/insights/lib/breakdown.ts`, `src/insights/lib/breakdown.spec.ts`

**Interfaces:**
- Consumes: `PublishedPost`, `totalsOf`, `engagementsOf`, `FollowerRow`, `followersByDay`, `followersGainedOf`, `PeriodWindow`, `datesBetween`, `round1`
- Produces:
  - `interface InsightsDay { date; postsPublished; impressions: number | null; engagements; ratedEngagements; followers: number | null }`
  - `daySeries(posts, followers, from, to): InsightsDay[]`
  - `interface FollowerTotals { value; gained; growthPct; previousGained }`, `followerTotals(rows, window): FollowerTotals`
  - `interface ChannelBreakdown { channelId; postsPublished; impressions; engagements; engagementRate; followers; followersGained; previous: { postsPublished; impressions; engagements; followersGained }; series: InsightsDay[] }`
  - `channelBreakdown(channelIds, posts, followers, window): ChannelBreakdown[]`

- [ ] **Step 1: Write the failing tests**

`src/insights/lib/series.spec.ts`:

```ts
import type { FollowerRow } from '../../post-performance/followers';
import type { PublishedPost } from '../../post-performance/post-performance';
import { daySeries, followerTotals } from './series';

const post = (over: Partial<PublishedPost>): PublishedPost => ({
  postId: 'p1',
  channelId: 1,
  publishedOn: '2026-09-21',
  likes: null,
  comments: null,
  shares: null,
  impressions: null,
  publishedAt: '2026-09-21T10:00:00.000Z',
  content: '',
  mediaItems: [],
  imported: false,
  permalink: null,
  mediaType: null,
  ...over,
});
const row = (over: Partial<FollowerRow>): FollowerRow => ({
  channelId: 1,
  date: '2026-09-21',
  followersAtEndOfDay: null,
  followersGained: null,
  ...over,
});

describe('daySeries', () => {
  it('puts each post on its day and keeps the rate numerator to rated posts', () => {
    const series = daySeries(
      [
        post({ postId: 'a', likes: 10, impressions: 500 }),
        post({ postId: 'b', channelId: 2, likes: 30 }), // reports no impressions
      ],
      [row({ date: '2026-09-21', followersAtEndOfDay: 900 })],
      '2026-09-21',
      '2026-09-22',
    );
    expect(series).toEqual([
      {
        date: '2026-09-21',
        postsPublished: 2,
        impressions: 500,
        engagements: 40,
        ratedEngagements: 10,
        followers: 900,
      },
      // Nothing posted: zeros, and followers carried forward.
      {
        date: '2026-09-22',
        postsPublished: 0,
        impressions: null,
        engagements: 0,
        ratedEngagements: 0,
        followers: 900,
      },
    ]);
  });

  it('leaves out posts outside the range', () => {
    const [day] = daySeries(
      [post({ publishedOn: '2026-09-20', likes: 9 })],
      [],
      '2026-09-21',
      '2026-09-21',
    );
    expect(day.postsPublished).toBe(0);
    expect(day.followers).toBeNull();
  });
});

describe('followerTotals', () => {
  const window = {
    from: '2026-09-23',
    to: '2026-09-29',
    previousFrom: '2026-09-16',
    previousTo: '2026-09-22',
  };

  it('is the count at the end, the gain in the window, and growth from the start', () => {
    expect(
      followerTotals(
        [
          row({ date: '2026-09-18', followersGained: 4, followersAtEndOfDay: 950 }),
          row({ date: '2026-09-25', followersGained: 50, followersAtEndOfDay: 1000 }),
          row({ channelId: 2, date: '2026-09-27', followersGained: null, followersAtEndOfDay: 100 }),
        ],
        window,
      ),
    ).toEqual({ value: 1100, gained: 50, growthPct: 4.8, previousGained: 4 });
  });

  it('has no growth when nothing is known', () => {
    expect(followerTotals([], window)).toEqual({
      value: null,
      gained: null,
      growthPct: null,
      previousGained: null,
    });
  });
});
```

`src/insights/lib/breakdown.spec.ts`:

```ts
import type { PublishedPost } from '../../post-performance/post-performance';
import { channelBreakdown } from './breakdown';

const post = (over: Partial<PublishedPost>): PublishedPost => ({
  postId: 'p1',
  channelId: 1,
  publishedOn: '2026-09-25',
  likes: null,
  comments: null,
  shares: null,
  impressions: null,
  publishedAt: '2026-09-25T10:00:00.000Z',
  content: '',
  mediaItems: [],
  imported: false,
  permalink: null,
  mediaType: null,
  ...over,
});
const window = {
  from: '2026-09-23',
  to: '2026-09-29',
  previousFrom: '2026-09-16',
  previousTo: '2026-09-22',
};

describe('channelBreakdown', () => {
  it('gives each channel its own totals, previous window and series', () => {
    const [ig, li] = channelBreakdown(
      [1, 2],
      [
        post({ postId: 'a', likes: 20, impressions: 400 }),
        post({ postId: 'old', publishedOn: '2026-09-18', likes: 5, impressions: 100 }),
        post({ postId: 'b', channelId: 2, likes: 7 }),
      ],
      [
        { channelId: 1, date: '2026-09-25', followersAtEndOfDay: 500, followersGained: 10 },
      ],
      window,
    );
    expect(ig).toMatchObject({
      channelId: 1,
      postsPublished: 1,
      impressions: 400,
      engagements: 20,
      engagementRate: 5,
      followers: 500,
      followersGained: 10,
      previous: { postsPublished: 1, impressions: 100, engagements: 5, followersGained: null },
    });
    expect(ig.series).toHaveLength(7);
    expect(li).toMatchObject({
      channelId: 2,
      postsPublished: 1,
      impressions: null,
      engagementRate: null,
      followers: null,
    });
  });

  it('lists a channel with nothing in the window at zero', () => {
    const [c] = channelBreakdown([3], [], [], window);
    expect(c.postsPublished).toBe(0);
    expect(c.series.every((d) => d.postsPublished === 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx jest src/insights/lib/series.spec.ts src/insights/lib/breakdown.spec.ts`
Expected: FAIL with `Cannot find module './series'` and `'./breakdown'`

- [ ] **Step 3: Implement**

`src/insights/lib/series.ts`:

```ts
import {
  followersByDay,
  followersGainedOf,
  type FollowerRow,
} from '../../post-performance/followers';
import {
  datesBetween,
  round1,
  type PeriodWindow,
} from '../../post-performance/period';
import {
  engagementsOf,
  type PublishedPost,
} from '../../post-performance/post-performance';

export interface InsightsDay {
  date: string;
  postsPublished: number;
  /** null when no post that day reported impressions. */
  impressions: number | null;
  engagements: number;
  /**
   * Engagements on posts that report impressions: the rate's numerator. Kept
   * apart so a week's rate is recomputed from sums, never averaged from days.
   */
  ratedEngagements: number;
  /** Total followers at the end of the day, carried forward; null if unknown. */
  followers: number | null;
}

/** Every day from `from` to `to`: each post on the day it went out. */
export function daySeries(
  posts: PublishedPost[],
  followers: FollowerRow[],
  from: string,
  to: string,
): InsightsDay[] {
  const totals = followersByDay(followers, from, to);
  const days = new Map<string, InsightsDay>();
  for (const date of datesBetween(from, to)) {
    days.set(date, {
      date,
      postsPublished: 0,
      impressions: null,
      engagements: 0,
      ratedEngagements: 0,
      followers: totals.get(date) ?? null,
    });
  }

  for (const p of posts) {
    const day = days.get(p.publishedOn);
    if (!day) continue;
    const e = engagementsOf(p);
    day.postsPublished += 1;
    day.engagements += e;
    if (p.impressions !== null) {
      day.impressions = (day.impressions ?? 0) + p.impressions;
      day.ratedEngagements += e;
    }
  }
  return [...days.values()];
}

export interface FollowerTotals {
  /** Followers at the end of the window. */
  value: number | null;
  /** Net new followers in the window. */
  gained: number | null;
  /** gained ÷ followers at the start × 100, one decimal. */
  growthPct: number | null;
  previousGained: number | null;
}

export function followerTotals(
  rows: FollowerRow[],
  window: PeriodWindow,
): FollowerTotals {
  const value = followersByDay(rows, window.to, window.to).get(window.to) ?? null;
  const gained = followersGainedOf(
    rows.filter((r) => r.date >= window.from && r.date <= window.to),
  );
  const start = value !== null && gained !== null ? value - gained : null;
  return {
    value,
    gained,
    growthPct:
      start !== null && start > 0 && gained !== null
        ? round1((gained / start) * 100)
        : null,
    previousGained: followersGainedOf(
      rows.filter(
        (r) => r.date >= window.previousFrom && r.date <= window.previousTo,
      ),
    ),
  };
}
```

`src/insights/lib/breakdown.ts`:

```ts
import type { FollowerRow } from '../../post-performance/followers';
import type { PeriodWindow } from '../../post-performance/period';
import {
  totalsOf,
  type PublishedPost,
} from '../../post-performance/post-performance';
import { daySeries, followerTotals, type InsightsDay } from './series';

export interface ChannelBreakdown {
  channelId: number;
  postsPublished: number;
  impressions: number | null;
  engagements: number;
  engagementRate: number | null;
  followers: number | null;
  followersGained: number | null;
  previous: {
    postsPublished: number;
    impressions: number | null;
    engagements: number;
    followersGained: number | null;
  };
  series: InsightsDay[];
}

/**
 * One entry per channel, in the order given. `posts` and `followers` cover
 * both windows.
 */
export function channelBreakdown(
  channelIds: number[],
  posts: PublishedPost[],
  followers: FollowerRow[],
  window: PeriodWindow,
): ChannelBreakdown[] {
  return channelIds.map((channelId) => {
    const mine = posts.filter((p) => p.channelId === channelId);
    const myFollowers = followers.filter((r) => r.channelId === channelId);
    const current = mine.filter((p) => p.publishedOn >= window.from);
    const cur = totalsOf(current);
    const prev = totalsOf(mine.filter((p) => p.publishedOn < window.from));
    const f = followerTotals(myFollowers, window);

    return {
      channelId,
      postsPublished: cur.postsPublished,
      impressions: cur.impressions,
      engagements: cur.engagements,
      engagementRate: cur.engagementRate,
      followers: f.value,
      followersGained: f.gained,
      previous: {
        postsPublished: prev.postsPublished,
        impressions: prev.impressions,
        engagements: prev.engagements,
        followersGained: f.previousGained,
      },
      series: daySeries(current, myFollowers, window.from, window.to),
    };
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/insights/lib/series.spec.ts src/insights/lib/breakdown.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/insights/lib
git commit -m "feat(insights): day series with carried followers, and a per-channel breakdown"
```

---

### Task 5: Top posts, format stats and best times

**Files:**
- Create: `src/insights/lib/rankings.ts`, `src/insights/lib/rankings.spec.ts`

**Interfaces:**
- Consumes: `InsightPost`, `POST_FORMATS`, `PostFormat`, `round1`
- Produces:
  - `TOP_KEYS`, `type TopKey = 'impressions'|'engagements'|'comments'`, `topPosts(posts, key, n = 3): InsightPost[]`
  - `interface FormatStat { format; posts; ratedPosts; engagementRate; avgImpressions }`, `formatStats(posts): { formats: FormatStat[]; unknownFormatPosts: number }`
  - `SLOT_HOURS = 4`, `SLOT_COUNT = 6`, `MIN_CELL_RATED = 2`, `MIN_RATED_POSTS = 6`
  - `interface BestTimeCell { weekday; slot; posts; engagementRate }`, `interface BestTimes { cells; best: { weekday; slot }[]; ratedPosts }`, `bestTimes(posts, tz): BestTimes`

- [ ] **Step 1: Write the failing tests**

`src/insights/lib/rankings.spec.ts`:

```ts
import type { InsightPost } from './insight-post';
import { bestTimes, formatStats, topPosts } from './rankings';

const ip = (over: Partial<InsightPost>): InsightPost => ({
  postId: 'p',
  channelId: 1,
  publishedAt: '2026-09-21T10:00:00.000Z',
  content: '',
  format: 'image',
  thumbnailUrl: null,
  permalink: null,
  likes: null,
  comments: null,
  shares: null,
  impressions: null,
  engagements: 0,
  engagementRate: null,
  ...over,
});

describe('topPosts', () => {
  it('ranks by the key, newest first on a tie, three at most', () => {
    const top = topPosts(
      [
        ip({ postId: 'a', impressions: 100 }),
        ip({ postId: 'b', impressions: 900 }),
        ip({ postId: 'c', impressions: 500, publishedAt: '2026-09-20T00:00:00.000Z' }),
        ip({ postId: 'd', impressions: 500, publishedAt: '2026-09-22T00:00:00.000Z' }),
      ],
      'impressions',
    );
    expect(top.map((p) => p.postId)).toEqual(['b', 'd', 'c']);
  });

  it('never ranks a post with nothing on that key: unmeasured or zero', () => {
    const top = topPosts(
      [ip({ postId: 'new' }), ip({ postId: 'zero', comments: 0 }), ip({ postId: 'x', comments: 2 })],
      'comments',
    );
    expect(top.map((p) => p.postId)).toEqual(['x']);
  });
});

describe('formatStats', () => {
  it('rates each format over its rated posts, best first, and counts unknowns apart', () => {
    const { formats, unknownFormatPosts } = formatStats([
      ip({ format: 'video', engagements: 30, impressions: 300 }),
      ip({ format: 'video', engagements: 10, impressions: 100 }),
      ip({ format: 'image', engagements: 5, impressions: 500 }),
      ip({ format: 'image', engagements: 99 }), // no impressions: counted, not rated
      ip({ format: 'unknown', engagements: 50, impressions: 50 }),
    ]);
    expect(formats).toEqual([
      { format: 'video', posts: 2, ratedPosts: 2, engagementRate: 10, avgImpressions: 200 },
      { format: 'image', posts: 2, ratedPosts: 1, engagementRate: 1, avgImpressions: 500 },
    ]);
    expect(unknownFormatPosts).toBe(1);
  });

  it('puts a format with no rated posts last', () => {
    const { formats } = formatStats([
      ip({ format: 'text', engagements: 4 }),
      ip({ format: 'image', engagements: 1, impressions: 100 }),
    ]);
    expect(formats.map((f) => f.format)).toEqual(['image', 'text']);
    expect(formats[1].engagementRate).toBeNull();
  });
});

describe('bestTimes', () => {
  // 2026-09-28 is a Monday.
  const at = (iso: string, engagements: number, impressions: number | null = 100) =>
    ip({ publishedAt: iso, engagements, impressions });

  it('buckets posts by local weekday and 4-hour slot', () => {
    // 20:30 UTC Monday is 01:30 Tuesday in Karachi (UTC+5).
    const { cells } = bestTimes(
      [at('2026-09-28T20:30:00Z', 10), at('2026-09-28T21:00:00Z', 20)],
      'Asia/Karachi',
    );
    const tueNight = cells.find((c) => c.weekday === 1 && c.slot === 0)!;
    expect(tueNight).toEqual({ weekday: 1, slot: 0, posts: 2, engagementRate: 15 });
    expect(cells).toHaveLength(42);
  });

  it('follows the clock across a DST change', () => {
    // New York leaves DST on 2026-11-01. 12:30 UTC is 08:30 EDT on Saturday
    // (slot 2, 08–12) but 07:30 EST on Monday (slot 1, 04–08). A fixed
    // offset would put both in slot 2.
    const { cells } = bestTimes(
      [at('2026-10-31T12:30:00Z', 1), at('2026-11-02T12:30:00Z', 1)],
      'America/New_York',
    );
    expect(cells.find((c) => c.weekday === 5 && c.slot === 2)!.posts).toBe(1);
    expect(cells.find((c) => c.weekday === 0 && c.slot === 1)!.posts).toBe(1);
    expect(cells.find((c) => c.weekday === 0 && c.slot === 2)!.posts).toBe(0);
  });

  it('leaves a cell empty with fewer than two rated posts', () => {
    const { cells } = bestTimes([at('2026-09-28T10:00:00Z', 50)], 'UTC');
    const monMorning = cells.find((c) => c.weekday === 0 && c.slot === 2)!;
    expect(monMorning.posts).toBe(1);
    expect(monMorning.engagementRate).toBeNull();
  });

  it('picks the best three cells only once there are six rated posts', () => {
    const posts = [
      at('2026-09-28T10:00:00Z', 10), at('2026-09-28T11:00:00Z', 10), // Mon 08–12: 10%
      at('2026-09-29T18:00:00Z', 30), at('2026-09-29T19:00:00Z', 30), // Tue 16–20: 30%
      at('2026-09-30T13:00:00Z', 20), at('2026-09-30T14:00:00Z', 20), // Wed 12–16: 20%
      at('2026-10-01T02:00:00Z', 90, null), // unrated: counted, not rated
    ];
    expect(bestTimes(posts, 'UTC')).toMatchObject({
      ratedPosts: 6,
      best: [
        { weekday: 1, slot: 4 },
        { weekday: 2, slot: 3 },
        { weekday: 0, slot: 2 },
      ],
    });
    expect(bestTimes(posts.slice(0, 5), 'UTC').best).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx jest src/insights/lib/rankings.spec.ts`
Expected: FAIL with `Cannot find module './rankings'`

- [ ] **Step 3: Implement**

`src/insights/lib/rankings.ts`:

```ts
import { round1 } from '../../post-performance/period';
import { POST_FORMATS, type InsightPost, type PostFormat } from './insight-post';

export const TOP_KEYS = ['impressions', 'engagements', 'comments'] as const;
export type TopKey = (typeof TOP_KEYS)[number];

/**
 * The best `n` posts by `key`, newest first on a tie. A post with nothing on
 * that key (not measured yet, or zero) is never "top performing".
 */
export function topPosts(posts: InsightPost[], key: TopKey, n = 3): InsightPost[] {
  return posts
    .filter((p) => (p[key] ?? 0) > 0)
    .sort(
      (a, b) =>
        (b[key] ?? 0) - (a[key] ?? 0) ||
        b.publishedAt.localeCompare(a.publishedAt),
    )
    .slice(0, n);
}

export interface FormatStat {
  format: PostFormat;
  posts: number;
  /** Posts whose platform reports impressions: what the rate is built on. */
  ratedPosts: number;
  engagementRate: number | null;
  avgImpressions: number | null;
}

/** Each format's rate over its rated posts, highest first; unknowns counted apart. */
export function formatStats(posts: InsightPost[]): {
  formats: FormatStat[];
  unknownFormatPosts: number;
} {
  const acc = new Map<
    PostFormat,
    { posts: number; rated: number; ratedEngagements: number; impressions: number }
  >();
  let unknownFormatPosts = 0;

  for (const p of posts) {
    if (p.format === 'unknown') {
      unknownFormatPosts += 1;
      continue;
    }
    const a = acc.get(p.format) ?? {
      posts: 0,
      rated: 0,
      ratedEngagements: 0,
      impressions: 0,
    };
    a.posts += 1;
    if (p.impressions !== null) {
      a.rated += 1;
      a.ratedEngagements += p.engagements;
      a.impressions += p.impressions;
    }
    acc.set(p.format, a);
  }

  const formats = POST_FORMATS.filter((f) => acc.has(f))
    .map((format): FormatStat => {
      const a = acc.get(format)!;
      return {
        format,
        posts: a.posts,
        ratedPosts: a.rated,
        engagementRate:
          a.impressions > 0
            ? round1((a.ratedEngagements / a.impressions) * 100)
            : null,
        avgImpressions: a.rated ? Math.round(a.impressions / a.rated) : null,
      };
    })
    // Rates are never negative, so -1 sorts an unrated format last.
    .sort((x, y) => (y.engagementRate ?? -1) - (x.engagementRate ?? -1));

  return { formats, unknownFormatPosts };
}

export const SLOT_HOURS = 4;
export const SLOT_COUNT = 24 / SLOT_HOURS;
/** A cell's rate from a single post would just be that post. */
export const MIN_CELL_RATED = 2;
/** Below this, any "best time" is noise. */
export const MIN_RATED_POSTS = 6;

const WEEKDAY: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

export interface BestTimeCell {
  /** 0 = Monday. */
  weekday: number;
  /** 0–5: 4-hour blocks from midnight. */
  slot: number;
  posts: number;
  engagementRate: number | null;
}

export interface BestTimes {
  cells: BestTimeCell[];
  best: { weekday: number; slot: number }[];
  ratedPosts: number;
}

/**
 * When the workspace's posts did best: weekday × 4-hour block in `tz`, by
 * engagement rate over rated posts. Platforms don't say when followers are
 * online, so this measures our own posts instead.
 */
export function bestTimes(posts: InsightPost[], tz: string): BestTimes {
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  });
  const acc = Array.from({ length: 7 * SLOT_COUNT }, () => ({
    posts: 0,
    rated: 0,
    ratedEngagements: 0,
    impressions: 0,
  }));
  let ratedPosts = 0;

  for (const p of posts) {
    const parts = clock.formatToParts(new Date(p.publishedAt));
    const weekday = WEEKDAY[parts.find((x) => x.type === 'weekday')!.value];
    const hour = Number(parts.find((x) => x.type === 'hour')!.value) % 24;
    const cell = acc[weekday * SLOT_COUNT + Math.floor(hour / SLOT_HOURS)];
    cell.posts += 1;
    if (p.impressions !== null) {
      cell.rated += 1;
      cell.ratedEngagements += p.engagements;
      cell.impressions += p.impressions;
      ratedPosts += 1;
    }
  }

  const cells = acc.map((c, i): BestTimeCell => ({
    weekday: Math.floor(i / SLOT_COUNT),
    slot: i % SLOT_COUNT,
    posts: c.posts,
    engagementRate:
      c.rated >= MIN_CELL_RATED && c.impressions > 0
        ? round1((c.ratedEngagements / c.impressions) * 100)
        : null,
  }));

  const best =
    ratedPosts < MIN_RATED_POSTS
      ? []
      : cells
          .filter((c) => c.engagementRate !== null)
          .sort(
            (a, b) => b.engagementRate! - a.engagementRate! || b.posts - a.posts,
          )
          .slice(0, 3)
          .map(({ weekday, slot }) => ({ weekday, slot }));

  return { cells, best, ratedPosts };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/insights/lib/rankings.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/insights/lib
git commit -m "feat(insights): top posts, format comparison and best times"
```

---

### Task 6: Query parsing, the content table, CSV and freshness

**Files:**
- Create: `src/insights/lib/query.ts`, `src/insights/lib/query.spec.ts`
- Create: `src/insights/lib/content-table.ts`, `src/insights/lib/content-table.spec.ts`
- Create: `src/insights/lib/freshness.ts`, `src/insights/lib/freshness.spec.ts`

**Interfaces:**
- Consumes: `InsightPost`, `POST_FORMATS`, `PostFormat`, `PERIOD_DAYS`, `isPeriodDays`, `PeriodDays`, `round1`
- Produces:
  - `parseDays(raw?: string): PeriodDays`, `parseChannels(raw: string | undefined, allowed: number[]): number[]`, `parseTz(raw?: string): string`
  - `SORT_KEYS`, `type SortKey`, `interface TableQuery { format: PostFormat | 'all'; sort: SortKey; order: 'asc' | 'desc'; limit: number; offset: number }`, `parseTableQuery(raw): TableQuery`
  - `filterAndSort(posts, q: Pick<TableQuery,'format'|'sort'|'order'>): InsightPost[]`
  - `interface TableTotals { posts; impressions; engagements; engagementRate; likes; comments; shares }`, `tableTotals(rows): TableTotals`
  - `csvCell(v): string`, `interface CsvChannel { name: string; platform: string }`, `postsCsv(rows, channels: Map<number, CsvChannel>): string`
  - `FAILING_AFTER = 3`, `interface SyncStateRow { channelId; lastProfileSyncAt: Date | null; lastPostsSyncAt: Date | null; consecutiveFailures: number; pausedUntil: Date | null }`, `interface ChannelFreshness { channelId; lastSyncedAt: string | null; failing: boolean }`, `freshnessOf(channelIds, rows, now): ChannelFreshness[]`

- [ ] **Step 1: Write the failing tests**

`src/insights/lib/query.spec.ts`:

```ts
import { BadRequestException } from '@nestjs/common';
import { parseChannels, parseDays, parseTableQuery, parseTz } from './query';

describe('parseDays', () => {
  it('defaults to 30 and accepts 7, 30 and 90', () => {
    expect(parseDays(undefined)).toBe(30);
    expect(parseDays('')).toBe(30);
    expect(parseDays('7')).toBe(7);
    expect(parseDays('90')).toBe(90);
  });
  it.each(['14', '0', '-7', '7.5', 'abc', '1e1'])('rejects %s', (raw) => {
    expect(() => parseDays(raw)).toThrow(BadRequestException);
  });
});

describe('parseChannels', () => {
  const allowed = [16, 15, 18];

  it('is every allowed channel when none are asked for', () => {
    expect(parseChannels(undefined, allowed)).toEqual(allowed);
    expect(parseChannels(' ', allowed)).toEqual(allowed);
  });

  it('keeps the allowed ones asked for, in allowed order', () => {
    expect(parseChannels('18,16', allowed)).toEqual([16, 18]);
  });

  it("drops ids that aren't allowed: a stale id must not break the page", () => {
    expect(parseChannels('16,999', allowed)).toEqual([16]);
    // Every id foreign: nothing, not "all channels".
    expect(parseChannels('999', allowed)).toEqual([]);
  });

  it.each(['16,abc', '16;15', '1.5', '16,,15'])('rejects malformed %s', (raw) => {
    expect(() => parseChannels(raw, allowed)).toThrow(BadRequestException);
  });
});

describe('parseTz', () => {
  it('defaults to UTC and accepts IANA zones', () => {
    expect(parseTz(undefined)).toBe('UTC');
    expect(parseTz('Asia/Karachi')).toBe('Asia/Karachi');
  });
  it('rejects anything else', () => {
    expect(() => parseTz('Mars/Olympus')).toThrow(BadRequestException);
  });
});

describe('parseTableQuery', () => {
  it('defaults to every format, newest first, ten at a time', () => {
    expect(parseTableQuery({})).toEqual({
      format: 'all',
      sort: 'publishedAt',
      order: 'desc',
      limit: 10,
      offset: 0,
    });
  });
  it('accepts each documented value', () => {
    expect(
      parseTableQuery({ format: 'video', sort: 'engagementRate', order: 'asc', limit: '100', offset: '20' }),
    ).toEqual({ format: 'video', sort: 'engagementRate', order: 'asc', limit: 100, offset: 20 });
  });
  it.each([
    [{ format: 'gif' }],
    [{ sort: 'reach' }],
    [{ order: 'up' }],
    [{ limit: '0' }],
    [{ limit: '101' }],
    [{ offset: '-1' }],
    [{ limit: '10.5' }],
  ])('rejects %p', (raw) => {
    expect(() => parseTableQuery(raw)).toThrow(BadRequestException);
  });
});
```

`src/insights/lib/content-table.spec.ts`:

```ts
import type { InsightPost } from './insight-post';
import { csvCell, filterAndSort, postsCsv, tableTotals } from './content-table';

const ip = (over: Partial<InsightPost>): InsightPost => ({
  postId: 'p',
  channelId: 1,
  publishedAt: '2026-09-21T10:00:00.000Z',
  content: '',
  format: 'image',
  thumbnailUrl: null,
  permalink: null,
  likes: null,
  comments: null,
  shares: null,
  impressions: null,
  engagements: 0,
  engagementRate: null,
  ...over,
});

describe('filterAndSort', () => {
  const rows = [
    ip({ postId: 'a', engagementRate: 2, publishedAt: '2026-09-21T00:00:00.000Z' }),
    ip({ postId: 'zero-impr', engagementRate: null, publishedAt: '2026-09-25T00:00:00.000Z' }),
    ip({ postId: 'b', engagementRate: 9, format: 'video', publishedAt: '2026-09-22T00:00:00.000Z' }),
  ];

  it('puts unmeasured posts last whichever way it sorts', () => {
    const order = (o: 'asc' | 'desc') =>
      filterAndSort(rows, { format: 'all', sort: 'engagementRate', order: o }).map((r) => r.postId);
    expect(order('desc')).toEqual(['b', 'a', 'zero-impr']);
    expect(order('asc')).toEqual(['a', 'b', 'zero-impr']);
  });

  it('filters by format and sorts by date', () => {
    expect(
      filterAndSort(rows, { format: 'image', sort: 'publishedAt', order: 'desc' }).map((r) => r.postId),
    ).toEqual(['zero-impr', 'a']);
  });
});

describe('tableTotals', () => {
  it('sums the rows and rates only rated posts', () => {
    expect(
      tableTotals([
        ip({ likes: 10, comments: 2, engagements: 12, impressions: 600 }),
        ip({ likes: 40, engagements: 40 }), // no impressions
      ]),
    ).toEqual({
      posts: 2,
      impressions: 600,
      engagements: 52,
      engagementRate: 2,
      likes: 50,
      comments: 2,
      shares: null,
    });
  });
});

describe('csvCell', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });
  it('defuses a cell a spreadsheet would run as a formula', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@me')).toBe("'@me");
  });
  it('writes numbers plainly, negatives included, and null as empty', () => {
    expect(csvCell(-4)).toBe('-4');
    expect(csvCell(null)).toBe('');
  });
});

describe('postsCsv', () => {
  it('starts with a BOM and a header, one CRLF row per post, Urdu intact', () => {
    const csv = postsCsv(
      [ip({ postId: 'a', content: 'سلام, دنیا 👋', impressions: 100, engagements: 5, engagementRate: 5, likes: 5, permalink: 'https://x/p' })],
      new Map([[1, { name: 'Asad, Co', platform: 'instagram' }]]),
    );
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(
      'published_at,channel,platform,format,caption,impressions,engagements,engagement_rate,likes,comments,shares,link',
    );
    expect(lines[1]).toBe(
      '2026-09-21T10:00:00.000Z,"Asad, Co",instagram,image,"سلام, دنیا 👋",100,5,5,5,,,https://x/p',
    );
    expect(lines[2]).toBe('');
  });
});
```

`src/insights/lib/freshness.spec.ts`:

```ts
import { freshnessOf } from './freshness';

const NOW = new Date('2026-09-30T12:00:00Z');

describe('freshnessOf', () => {
  it('takes the later sync and flags a channel that keeps failing or is paused', () => {
    expect(
      freshnessOf(
        [1, 2, 3, 4],
        [
          { channelId: 1, lastProfileSyncAt: new Date('2026-09-30T10:00:00Z'), lastPostsSyncAt: new Date('2026-09-30T11:00:00Z'), consecutiveFailures: 0, pausedUntil: null },
          { channelId: 2, lastProfileSyncAt: new Date('2026-09-20T10:00:00Z'), lastPostsSyncAt: null, consecutiveFailures: 3, pausedUntil: null },
          { channelId: 3, lastProfileSyncAt: null, lastPostsSyncAt: null, consecutiveFailures: 0, pausedUntil: new Date('2026-10-01T00:00:00Z') },
        ],
        NOW,
      ),
    ).toEqual([
      { channelId: 1, lastSyncedAt: '2026-09-30T11:00:00.000Z', failing: false },
      { channelId: 2, lastSyncedAt: '2026-09-20T10:00:00.000Z', failing: true },
      { channelId: 3, lastSyncedAt: null, failing: true },
      // No sync row yet: never synced, not failing.
      { channelId: 4, lastSyncedAt: null, failing: false },
    ]);
  });

  it('does not flag a pause that already ended', () => {
    const [f] = freshnessOf(
      [1],
      [{ channelId: 1, lastProfileSyncAt: null, lastPostsSyncAt: null, consecutiveFailures: 0, pausedUntil: new Date('2026-09-29T00:00:00Z') }],
      NOW,
    );
    expect(f.failing).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx jest src/insights/lib/query.spec.ts src/insights/lib/content-table.spec.ts src/insights/lib/freshness.spec.ts`
Expected: FAIL with `Cannot find module` for each

- [ ] **Step 3: Implement**

`src/insights/lib/query.ts`:

```ts
import { BadRequestException } from '@nestjs/common';
import {
  PERIOD_DAYS,
  isPeriodDays,
  type PeriodDays,
} from '../../post-performance/period';
import { POST_FORMATS, type PostFormat } from './insight-post';

export function parseDays(raw?: string): PeriodDays {
  if (raw === undefined || raw === '') return 30;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!isPeriodDays(n)) {
    throw new BadRequestException(
      `days must be one of ${PERIOD_DAYS.join(', ')}`,
    );
  }
  return n;
}

/**
 * The asked-for channels narrowed to `allowed`: the workspace's active social
 * channels. Ids outside it are dropped, never queried. A stale id left by a
 * disconnect shouldn't break the page, and dropping says nothing about other
 * workspaces. With no `channels` param, every allowed channel counts.
 */
export function parseChannels(
  raw: string | undefined,
  allowed: number[],
): number[] {
  if (raw === undefined || raw.trim() === '') return allowed;
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.some((s) => !/^\d+$/.test(s))) {
    throw new BadRequestException('channels must be comma-separated ids');
  }
  const wanted = new Set(parts.map(Number));
  return allowed.filter((id) => wanted.has(id));
}

export function parseTz(raw?: string): string {
  if (raw === undefined || raw === '') return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw });
    return raw;
  } catch {
    throw new BadRequestException('tz must be an IANA time zone');
  }
}

export const SORT_KEYS = [
  'publishedAt',
  'impressions',
  'engagements',
  'engagementRate',
  'likes',
  'comments',
  'shares',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export interface TableQuery {
  format: PostFormat | 'all';
  sort: SortKey;
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
}

function oneOf<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
  name: string,
): T {
  if (raw === undefined || raw === '') return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new BadRequestException(`${name} must be one of ${allowed.join(', ')}`);
  }
  return raw as T;
}

function intIn(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (raw === undefined || raw === '') return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new BadRequestException(`${name} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

export function parseTableQuery(raw: {
  format?: string;
  sort?: string;
  order?: string;
  limit?: string;
  offset?: string;
}): TableQuery {
  return {
    format: oneOf(raw.format, ['all', ...POST_FORMATS] as const, 'all', 'format'),
    sort: oneOf(raw.sort, SORT_KEYS, 'publishedAt', 'sort'),
    order: oneOf(raw.order, ['desc', 'asc'] as const, 'desc', 'order'),
    limit: intIn(raw.limit, 10, 1, 100, 'limit'),
    offset: intIn(raw.offset, 0, 0, 1_000_000, 'offset'),
  };
}
```

`src/insights/lib/content-table.ts`:

```ts
import { round1 } from '../../post-performance/period';
import type { InsightPost } from './insight-post';
import type { SortKey, TableQuery } from './query';

const sortValue = (p: InsightPost, key: SortKey): number | null =>
  key === 'publishedAt' ? Date.parse(p.publishedAt) : p[key];

/** Newest first, then stable by post and channel. */
const tieBreak = (a: InsightPost, b: InsightPost) =>
  b.publishedAt.localeCompare(a.publishedAt) ||
  a.postId.localeCompare(b.postId) ||
  a.channelId - b.channelId;

/** Rows for the table. An unmeasured value sorts last in either direction. */
export function filterAndSort(
  posts: InsightPost[],
  q: Pick<TableQuery, 'format' | 'sort' | 'order'>,
): InsightPost[] {
  const dir = q.order === 'asc' ? 1 : -1;
  return posts
    .filter((p) => q.format === 'all' || p.format === q.format)
    .sort((a, b) => {
      const va = sortValue(a, q.sort);
      const vb = sortValue(b, q.sort);
      if (va === null || vb === null) {
        if (va === vb) return tieBreak(a, b);
        return va === null ? 1 : -1;
      }
      return (va - vb) * dir || tieBreak(a, b);
    });
}

export interface TableTotals {
  posts: number;
  impressions: number | null;
  engagements: number;
  engagementRate: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
}

/** Sum of the values reported; null when no row reported any. */
const sumReported = (values: (number | null)[]): number | null =>
  values.some((v) => v !== null)
    ? values.reduce<number>((a, v) => a + (v ?? 0), 0)
    : null;

/** The total row: same rate rule as everywhere, rated posts only. */
export function tableTotals(rows: InsightPost[]): TableTotals {
  const impressions = sumReported(rows.map((r) => r.impressions));
  const ratedEngagements = rows
    .filter((r) => r.impressions !== null)
    .reduce((a, r) => a + r.engagements, 0);
  return {
    posts: rows.length,
    impressions,
    engagements: rows.reduce((a, r) => a + r.engagements, 0),
    engagementRate: impressions
      ? round1((ratedEngagements / impressions) * 100)
      : null,
    likes: sumReported(rows.map((r) => r.likes)),
    comments: sumReported(rows.map((r) => r.comments)),
    shares: sumReported(rows.map((r) => r.shares)),
  };
}

const CSV_HEADER = [
  'published_at',
  'channel',
  'platform',
  'format',
  'caption',
  'impressions',
  'engagements',
  'engagement_rate',
  'likes',
  'comments',
  'shares',
  'link',
];

/**
 * One RFC 4180 cell. Text starting with = + - @ tab or CR is prefixed with '
 * so a spreadsheet shows it instead of running it as a formula.
 */
export function csvCell(v: string | number | null): string {
  if (v === null) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface CsvChannel {
  name: string;
  platform: string;
}

/** The CSV body. The BOM is what makes Excel read Urdu and emoji as UTF-8. */
export function postsCsv(
  rows: InsightPost[],
  channels: Map<number, CsvChannel>,
): string {
  const lines = [CSV_HEADER.join(',')];
  for (const r of rows) {
    const ch = channels.get(r.channelId);
    lines.push(
      [
        r.publishedAt,
        ch?.name ?? '',
        ch?.platform ?? '',
        r.format,
        r.content,
        r.impressions,
        r.engagements,
        r.engagementRate,
        r.likes,
        r.comments,
        r.shares,
        r.permalink,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
```

`src/insights/lib/freshness.ts`:

```ts
/** Failed syncs in a row before a channel counts as failing. */
export const FAILING_AFTER = 3;

export interface SyncStateRow {
  channelId: number;
  lastProfileSyncAt: Date | null;
  lastPostsSyncAt: Date | null;
  consecutiveFailures: number;
  pausedUntil: Date | null;
}

export interface ChannelFreshness {
  channelId: number;
  /** The later of the profile and posts syncs; null when never synced. */
  lastSyncedAt: string | null;
  failing: boolean;
}

export function freshnessOf(
  channelIds: number[],
  rows: SyncStateRow[],
  now: Date,
): ChannelFreshness[] {
  const byChannel = new Map(rows.map((r) => [r.channelId, r]));
  return channelIds.map((channelId) => {
    const r = byChannel.get(channelId);
    if (!r) return { channelId, lastSyncedAt: null, failing: false };
    const times = [r.lastProfileSyncAt, r.lastPostsSyncAt]
      .filter((d): d is Date => d !== null)
      .map((d) => new Date(d).getTime());
    return {
      channelId,
      lastSyncedAt: times.length
        ? new Date(Math.max(...times)).toISOString()
        : null,
      failing:
        r.consecutiveFailures >= FAILING_AFTER ||
        (r.pausedUntil !== null && new Date(r.pausedUntil) > now),
    };
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/insights/lib`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/insights/lib
git commit -m "feat(insights): query parsing, content table, CSV export and channel freshness"
```

---

### Task 7: InsightsService

**Files:**
- Create: `src/insights/dto/insights.dto.ts`
- Create: `src/insights/insights.service.ts`, `src/insights/insights.service.spec.ts`

**Interfaces:**
- Consumes: every `lib/` export above, `PostPerformanceRepository.publishedPosts(ws, ids, from, before)`, and these schema objects: `socialMediaChannels`, `CHANNEL_CATEGORY`, `channelAnalyticsDaily`, `channelSyncState`.
- Produces:
  - `InsightsService.overview(workspaceId: string, days: PeriodDays, channels: string | undefined, tz: string, now?: Date): Promise<InsightsOverviewDto>`
  - `InsightsService.posts(workspaceId, days, channels, table: TableQuery, now?): Promise<InsightsPostsDto>`
  - `InsightsService.csv(workspaceId, days, channels, table: Pick<TableQuery,'format'|'sort'|'order'>, now?): Promise<{ filename: string; body: string }>`

- [ ] **Step 1: Write the DTOs**

`src/insights/dto/insights.dto.ts`:

```ts
import type { MetricChange, PeriodDays, PeriodWindow } from '../../post-performance/period';
import type { ChannelBreakdown } from '../lib/breakdown';
import type { TableTotals } from '../lib/content-table';
import type { ChannelFreshness } from '../lib/freshness';
import type { InsightPost } from '../lib/insight-post';
import type { BestTimes, FormatStat } from '../lib/rankings';
import type { FollowerTotals, InsightsDay } from '../lib/series';

export interface InsightsOverviewDto {
  days: PeriodDays;
  window: PeriodWindow;
  /** The channels counted: the request's, narrowed to active social ones. */
  channelIds: number[];
  /** Posts from this date on are still gaining; drawn dashed. */
  stillCollectingFrom: string;
  freshness: ChannelFreshness[];
  kpis: {
    followers: FollowerTotals;
    postsPublished: MetricChange;
    impressions: MetricChange;
    engagements: MetricChange;
    /** Change in percentage points, one decimal. */
    engagementRate: { value: number | null; previous: number | null; deltaPts: number | null };
  };
  series: InsightsDay[];
  previousSeries: InsightsDay[];
  channels: ChannelBreakdown[];
  top: { impressions: InsightPost[]; engagements: InsightPost[]; comments: InsightPost[] };
  formats: FormatStat[];
  unknownFormatPosts: number;
  bestTimes: BestTimes;
}

export interface InsightsPostsDto {
  total: TableTotals;
  rows: InsightPost[];
  hasMore: boolean;
}
```

- [ ] **Step 2: Write the failing service tests**

`src/insights/insights.service.spec.ts`:

```ts
import type { PublishedPost } from '../post-performance/post-performance';
import { InsightsService } from './insights.service';

/**
 * A db double whose `select()` chains resolve, in call order, to the arrays
 * given. The service issues: channels, follower rows, sync state.
 */
interface Chain extends PromiseLike<unknown[]> {
  from: () => Chain;
  where: () => Chain;
}
function fakeDb(results: unknown[][]) {
  let i = 0;
  const calls: string[] = [];
  const chain = (): Chain => {
    const c: Chain = {
      from: () => c,
      where: () => c,
      then: (resolve, reject) =>
        Promise.resolve(results[i++] ?? []).then(resolve, reject),
    };
    return c;
  };
  return { db: { select: () => (calls.push('select'), chain()) }, calls };
}

const NOW = new Date('2026-09-30T12:00:00Z');
const CHANNELS = [
  { id: 2, platform: 'linkedin', accountName: 'Asad Manzoor' },
  { id: 1, platform: 'instagram', accountName: 'asad_codm' },
  { id: 9, platform: 'slack', accountName: 'team' },
];
const post = (over: Partial<PublishedPost>): PublishedPost => ({
  postId: 'p1',
  channelId: 1,
  publishedOn: '2026-09-25',
  likes: null,
  comments: null,
  shares: null,
  impressions: null,
  publishedAt: '2026-09-25T10:00:00.000Z',
  content: '',
  mediaItems: [],
  imported: false,
  permalink: null,
  mediaType: null,
  ...over,
});
const IMG = { url: 'https://x/a.jpg', type: 'image' };
const repoWith = (posts: PublishedPost[]) => ({
  publishedPosts: jest.fn().mockResolvedValue(posts),
});

describe('InsightsService.overview', () => {
  it('counts social channels across both windows and shapes every section', async () => {
    const { db } = fakeDb([
      CHANNELS,
      [{ channelId: 1, date: '2026-09-25', followersAtEndOfDay: 500, followersGained: 10 }],
      [{ channelId: 1, lastProfileSyncAt: new Date('2026-09-30T09:00:00Z'), lastPostsSyncAt: null, consecutiveFailures: 0, pausedUntil: null }],
    ]);
    const repo = repoWith([
      post({ postId: 'a', likes: 20, comments: 4, impressions: 400, mediaType: 'REELS' }),
      post({ postId: 'old', publishedOn: '2026-08-20', publishedAt: '2026-08-20T10:00:00.000Z', likes: 5, impressions: 100 }),
      post({ postId: 'b', channelId: 2, likes: 7 }),
    ]);

    const o = await new InsightsService(db as any, repo as any).overview(
      'ws1', 30, undefined, 'UTC', NOW,
    );

    // Social channels only, in id order; both windows; up to (not incl.) today.
    expect(repo.publishedPosts).toHaveBeenCalledWith('ws1', [1, 2], '2026-08-01', '2026-09-30');
    expect(o.channelIds).toEqual([1, 2]);
    expect(o.window).toEqual({ from: '2026-08-31', to: '2026-09-29', previousFrom: '2026-08-01', previousTo: '2026-08-30' });
    expect(o.stillCollectingFrom).toBe('2026-09-27');
    expect(o.kpis.postsPublished).toEqual({ value: 2, previous: 1, deltaPct: 100 });
    expect(o.kpis.engagements).toEqual({ value: 31, previous: 5, deltaPct: 520 });
    expect(o.kpis.engagementRate).toEqual({ value: 6, previous: 5, deltaPts: 1 });
    expect(o.kpis.followers).toMatchObject({ value: 500, gained: 10 });
    expect(o.series).toHaveLength(30);
    expect(o.previousSeries).toHaveLength(30);
    expect(o.channels.map((c) => c.channelId)).toEqual([1, 2]);
    // Current window only, never the previous one.
    expect(o.top.engagements.map((p) => p.postId)).toEqual(['a', 'b']);
    expect(o.formats[0]).toMatchObject({ format: 'video', posts: 1 });
    expect(o.freshness).toEqual([
      { channelId: 1, lastSyncedAt: '2026-09-30T09:00:00.000Z', failing: false },
      { channelId: 2, lastSyncedAt: null, failing: false },
    ]);
  });

  it('narrows to the asked-for channels and drops ones that are not social or not here', async () => {
    const { db } = fakeDb([CHANNELS, [], []]);
    const repo = repoWith([]);
    const o = await new InsightsService(db as any, repo as any).overview(
      'ws1', 7, '2,9,404', 'UTC', NOW,
    );
    expect(o.channelIds).toEqual([2]);
    expect(repo.publishedPosts).toHaveBeenCalledWith('ws1', [2], '2026-09-16', '2026-09-30');
  });

  it('skips the queries when no channel is left, and answers with empty sections', async () => {
    const { db, calls } = fakeDb([CHANNELS]);
    const repo = repoWith([]);
    const o = await new InsightsService(db as any, repo as any).overview(
      'ws1', 7, '404', 'UTC', NOW,
    );
    expect(calls).toHaveLength(1);
    expect(repo.publishedPosts).not.toHaveBeenCalled();
    expect(o.channelIds).toEqual([]);
    expect(o.kpis.postsPublished.value).toBe(0);
    expect(o.series).toHaveLength(7);
    expect(o.bestTimes.best).toEqual([]);
  });
});

describe('InsightsService.posts', () => {
  it('reads the current window only, filters, totals the filter and pages', async () => {
    const { db } = fakeDb([CHANNELS]);
    const repo = repoWith([
      post({ postId: 'a', likes: 1, impressions: 10, mediaItems: [IMG], publishedAt: '2026-09-25T10:00:00.000Z' }),
      post({ postId: 'b', likes: 2, impressions: 10, mediaItems: [IMG], publishedAt: '2026-09-26T10:00:00.000Z' }),
      post({ postId: 'c', likes: 3, impressions: 10, mediaItems: [IMG], publishedAt: '2026-09-27T10:00:00.000Z' }),
      post({ postId: 'v', channelId: 2, mediaItems: [{ url: 'u', type: 'video' }], publishedAt: '2026-09-28T10:00:00.000Z' }),
    ]);
    const svc = new InsightsService(db as any, repo as any);

    const page = await svc.posts(
      'ws1', 7, undefined,
      { format: 'image', sort: 'publishedAt', order: 'desc', limit: 2, offset: 0 },
      NOW,
    );

    expect(repo.publishedPosts).toHaveBeenCalledWith('ws1', [1, 2], '2026-09-23', '2026-09-30');
    expect(page.total).toMatchObject({ posts: 3, likes: 6, impressions: 30 });
    expect(page.rows.map((r) => r.postId)).toEqual(['c', 'b']);
    expect(page.hasMore).toBe(true);
  });

  it('is empty past the end', async () => {
    const { db } = fakeDb([CHANNELS]);
    const page = await new InsightsService(db as any, repoWith([post({})]) as any).posts(
      'ws1', 7, undefined,
      { format: 'all', sort: 'publishedAt', order: 'desc', limit: 10, offset: 50 },
      NOW,
    );
    expect(page.rows).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.total.posts).toBe(1);
  });
});

describe('InsightsService.csv', () => {
  it('names the file after the window and labels channels', async () => {
    const { db } = fakeDb([CHANNELS]);
    const { filename, body } = await new InsightsService(
      db as any,
      repoWith([post({ content: 'Hi', likes: 3 })]) as any,
    ).csv('ws1', 7, undefined, { format: 'all', sort: 'publishedAt', order: 'desc' }, NOW);
    expect(filename).toBe('schedura-posts-2026-09-23-2026-09-29.csv');
    expect(body).toContain('asad_codm,instagram,text,Hi');
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx jest src/insights/insights.service.spec.ts`
Expected: FAIL with `Cannot find module './insights.service'`

- [ ] **Step 4: Implement the service**

`src/insights/insights.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { channelAnalyticsDaily } from '../drizzle/schema/channel-analytics-daily.schema';
import { channelSyncState } from '../drizzle/schema/channel-sync-state.schema';
import {
  CHANNEL_CATEGORY,
  socialMediaChannels,
  type SupportedPlatform,
} from '../drizzle/schema/channels.schema';
import type { FollowerRow } from '../post-performance/followers';
import {
  DAY_MS,
  isoDate,
  metricChange,
  round1,
  utcToday,
  windowOf,
  type PeriodDays,
} from '../post-performance/period';
import {
  totalsOf,
  type PublishedPost,
} from '../post-performance/post-performance';
import { PostPerformanceRepository } from '../post-performance/post-performance.repository';
import type { InsightsOverviewDto, InsightsPostsDto } from './dto/insights.dto';
import { channelBreakdown } from './lib/breakdown';
import {
  filterAndSort,
  postsCsv,
  tableTotals,
  type CsvChannel,
} from './lib/content-table';
import { freshnessOf, type SyncStateRow } from './lib/freshness';
import { toInsightPost, type InsightPost } from './lib/insight-post';
import { parseChannels, type TableQuery } from './lib/query';
import { bestTimes, formatStats, topPosts } from './lib/rankings';
import { daySeries, followerTotals } from './lib/series';

/** Posts this young are still gaining; the chart draws them dashed. */
const STILL_COLLECTING_DAYS = 3;
/** Follower rows this far before the window seed the carried-forward count. */
const FOLLOWER_LOOKBACK_DAYS = 31;

interface SocialChannel {
  id: number;
  platform: SupportedPlatform;
  accountName: string;
}

/**
 * The workspace Insights page: how the chosen social channels' posts did over
 * the last 7, 30 or 90 days, on the same post rule as Home's Performance.
 */
@Injectable()
export class InsightsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly postPerformance: PostPerformanceRepository,
  ) {}

  async overview(
    workspaceId: string,
    days: PeriodDays,
    channels: string | undefined,
    tz: string,
    now = new Date(),
  ): Promise<InsightsOverviewDto> {
    const today = utcToday(now);
    const window = windowOf(today, days);
    const social = await this.socialChannels(workspaceId);
    const channelIds = parseChannels(channels, social.map((c) => c.id));
    const platformOf = new Map(social.map((c) => [c.id, c.platform]));

    const published = await this.publishedPosts(
      workspaceId,
      channelIds,
      window.previousFrom,
      today,
    );
    const followers = await this.followerRows(
      channelIds,
      isoDate(
        new Date(
          Date.parse(`${window.previousFrom}T00:00:00Z`) -
            FOLLOWER_LOOKBACK_DAYS * DAY_MS,
        ),
      ),
      today,
    );
    const syncRows = await this.syncState(channelIds);

    const current = published.filter((p) => p.publishedOn >= window.from);
    const previous = published.filter((p) => p.publishedOn < window.from);
    const cur = totalsOf(current);
    const prev = totalsOf(previous);
    const posts: InsightPost[] = current.map((p) =>
      toInsightPost(p, platformOf.get(p.channelId) ?? ''),
    );
    const { formats, unknownFormatPosts } = formatStats(posts);

    return {
      days,
      window,
      channelIds,
      stillCollectingFrom: isoDate(
        new Date(today.getTime() - STILL_COLLECTING_DAYS * DAY_MS),
      ),
      freshness: freshnessOf(channelIds, syncRows, now),
      kpis: {
        followers: followerTotals(followers, window),
        postsPublished: metricChange(cur.postsPublished, prev.postsPublished),
        impressions: metricChange(cur.impressions, prev.impressions),
        engagements: metricChange(cur.engagements, prev.engagements),
        engagementRate: {
          value: cur.engagementRate,
          previous: prev.engagementRate,
          deltaPts:
            cur.engagementRate !== null && prev.engagementRate !== null
              ? round1(cur.engagementRate - prev.engagementRate)
              : null,
        },
      },
      series: daySeries(current, followers, window.from, window.to),
      previousSeries: daySeries(
        previous,
        followers,
        window.previousFrom,
        window.previousTo,
      ),
      channels: channelBreakdown(channelIds, published, followers, window),
      top: {
        impressions: topPosts(posts, 'impressions'),
        engagements: topPosts(posts, 'engagements'),
        comments: topPosts(posts, 'comments'),
      },
      formats,
      unknownFormatPosts,
      bestTimes: bestTimes(posts, tz),
    };
  }

  async posts(
    workspaceId: string,
    days: PeriodDays,
    channels: string | undefined,
    table: TableQuery,
    now = new Date(),
  ): Promise<InsightsPostsDto> {
    const { rows } = await this.tableRows(workspaceId, days, channels, table, now);
    return {
      total: tableTotals(rows),
      rows: rows.slice(table.offset, table.offset + table.limit),
      hasMore: table.offset + table.limit < rows.length,
    };
  }

  async csv(
    workspaceId: string,
    days: PeriodDays,
    channels: string | undefined,
    table: Pick<TableQuery, 'format' | 'sort' | 'order'>,
    now = new Date(),
  ): Promise<{ filename: string; body: string }> {
    const { rows, social, window } = await this.tableRows(
      workspaceId,
      days,
      channels,
      table,
      now,
    );
    const labels = new Map<number, CsvChannel>(
      social.map((c) => [c.id, { name: c.accountName, platform: c.platform }]),
    );
    return {
      filename: `schedura-posts-${window.from}-${window.to}.csv`,
      body: postsCsv(rows, labels),
    };
  }

  /** The window's posts as table rows, filtered and sorted. */
  private async tableRows(
    workspaceId: string,
    days: PeriodDays,
    channels: string | undefined,
    table: Pick<TableQuery, 'format' | 'sort' | 'order'>,
    now: Date,
  ) {
    const today = utcToday(now);
    const window = windowOf(today, days);
    const social = await this.socialChannels(workspaceId);
    const channelIds = parseChannels(channels, social.map((c) => c.id));
    const platformOf = new Map(social.map((c) => [c.id, c.platform]));
    const published = await this.publishedPosts(
      workspaceId,
      channelIds,
      window.from,
      today,
    );
    const rows = filterAndSort(
      published.map((p) => toInsightPost(p, platformOf.get(p.channelId) ?? '')),
      table,
    );
    return { rows, social, window };
  }

  /**
   * Active social channels, by id. Social is decided by platform: the stored
   * `category` column may mislabel older rows.
   */
  private async socialChannels(workspaceId: string): Promise<SocialChannel[]> {
    const rows = (await this.db
      .select({
        id: socialMediaChannels.id,
        platform: socialMediaChannels.platform,
        accountName: socialMediaChannels.accountName,
      })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.workspaceId, workspaceId),
          eq(socialMediaChannels.isActive, true),
        ),
      )) as SocialChannel[];
    return rows
      .filter((c) => CHANNEL_CATEGORY[c.platform] === 'social')
      .sort((a, b) => a.id - b.id);
  }

  private publishedPosts(
    workspaceId: string,
    channelIds: number[],
    fromIso: string,
    before: Date,
  ): Promise<PublishedPost[]> {
    if (!channelIds.length) return Promise.resolve([]);
    return this.postPerformance.publishedPosts(
      workspaceId,
      channelIds,
      fromIso,
      isoDate(before),
    );
  }

  /** Follower rollup rows from `fromIso` up to, not including, `before`. */
  private async followerRows(
    channelIds: number[],
    fromIso: string,
    before: Date,
  ): Promise<FollowerRow[]> {
    if (!channelIds.length) return [];
    return this.db
      .select({
        channelId: channelAnalyticsDaily.channelId,
        date: channelAnalyticsDaily.date,
        followersAtEndOfDay: channelAnalyticsDaily.followersAtEndOfDay,
        followersGained: channelAnalyticsDaily.followersGained,
      })
      .from(channelAnalyticsDaily)
      .where(
        and(
          inArray(channelAnalyticsDaily.channelId, channelIds),
          gte(channelAnalyticsDaily.date, fromIso),
          lt(channelAnalyticsDaily.date, isoDate(before)),
        ),
      );
  }

  private async syncState(channelIds: number[]): Promise<SyncStateRow[]> {
    if (!channelIds.length) return [];
    return this.db
      .select({
        channelId: channelSyncState.channelId,
        lastProfileSyncAt: channelSyncState.lastProfileSyncAt,
        lastPostsSyncAt: channelSyncState.lastPostsSyncAt,
        consecutiveFailures: channelSyncState.consecutiveFailures,
        pausedUntil: channelSyncState.pausedUntil,
      })
      .from(channelSyncState)
      .where(inArray(channelSyncState.channelId, channelIds));
  }
}
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx jest src/insights`
Expected: PASS

Run: `npx tsc -p tsconfig.build.json --noEmit`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add src/insights
git commit -m "feat(insights): service assembling the overview, the content table and the CSV"
```

---

### Task 8: Controller, module and HTTP behaviour

**Files:**
- Create: `src/insights/insights.controller.ts`, `src/insights/insights.module.ts`
- Create: `src/insights/insights.controller.spec.ts`
- Modify: `src/app.module.ts`: import `InsightsModule` after `HomeModule`

**Interfaces:**
- Consumes: `InsightsService` (Task 7), `parseDays`, `parseTz` and `parseTableQuery` (Task 6), `JwtAuthGuard`, `WorkspaceRoleGuard`, `RequireCapability`, `WorkspaceRoleModule`, `PostPerformanceModule`
- Produces:
  - `GET /insights/workspaces/:workspaceId/overview`
  - `GET /insights/workspaces/:workspaceId/posts`
  - `GET /insights/workspaces/:workspaceId/posts/export`

- [ ] **Step 1: Write the failing HTTP tests**

`src/insights/insights.controller.spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../workspace-members/workspace-role.service';
import { InsightsController } from './insights.controller';
import { InsightsService } from './insights.service';

const WS = '11111111-1111-4111-8111-111111111111';

describe('InsightsController over HTTP', () => {
  let app: INestApplication<App>;
  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  const insights = {
    overview: jest.fn(),
    posts: jest.fn(),
    csv: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InsightsController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: InsightsService, useValue: insights },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: {
          switchToHttp: () => { getRequest: () => { user?: unknown } };
        }) => {
          ctx.switchToHttp().getRequest().user = { userId: 'user-1' };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(() => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    roles.getRole.mockResolvedValue('GUEST');
    roles.isPlatformSuperAdmin.mockResolvedValue(false);
    insights.overview.mockResolvedValue({ ok: true });
    insights.posts.mockResolvedValue({ rows: [] });
    insights.csv.mockResolvedValue({ filename: 'schedura-posts-a-b.csv', body: '\uFEFFx\r\n' });
  });

  it('refuses a signed-in user who is not in the workspace', async () => {
    roles.getRole.mockResolvedValue(null);
    await request(app.getHttpServer()).get(`/insights/workspaces/${WS}/overview`).expect(403);
    expect(insights.overview).not.toHaveBeenCalled();
  });

  it('lets a guest read the overview, passing parsed input through', async () => {
    await request(app.getHttpServer())
      .get(`/insights/workspaces/${WS}/overview?days=7&channels=16,15&tz=Asia/Karachi`)
      .expect(200, { ok: true });
    expect(insights.overview).toHaveBeenCalledWith(WS, 7, '16,15', 'Asia/Karachi');
  });

  it.each([
    ['overview?days=14'],
    ['overview?tz=Mars/Olympus'],
    ['posts?limit=500'],
    ['posts?sort=reach'],
  ])('answers 400 to %s', async (path) => {
    await request(app.getHttpServer()).get(`/insights/workspaces/${WS}/${path}`).expect(400);
  });

  it('rejects a workspace id that is not a uuid', async () => {
    await request(app.getHttpServer()).get('/insights/workspaces/probe/overview').expect(400);
  });

  it('passes the table query to posts', async () => {
    await request(app.getHttpServer())
      .get(`/insights/workspaces/${WS}/posts?format=video&sort=likes&order=asc&limit=20&offset=40`)
      .expect(200);
    expect(insights.posts).toHaveBeenCalledWith(WS, 30, undefined, {
      format: 'video',
      sort: 'likes',
      order: 'asc',
      limit: 20,
      offset: 40,
    });
  });

  it('downloads the CSV as an attachment', async () => {
    const res = await request(app.getHttpServer())
      .get(`/insights/workspaces/${WS}/posts/export?days=7`)
      .expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="schedura-posts-a-b.csv"',
    );
    // The body arrives as sent; supertest may or may not keep the BOM when
    // decoding, so assert on what follows it.
    expect(res.text.replace(/^\uFEFF/, '')).toBe('x\r\n');
  });
});
```

A malformed `channels` list is rejected by `parseChannels` inside the service, where the workspace's channels are known. It is pinned in `query.spec.ts`, not here.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx jest src/insights/insights.controller.spec.ts`
Expected: FAIL with `Cannot find module './insights.controller'`

- [ ] **Step 3: Implement the controller and module, and register it**

`src/insights/insights.controller.ts`:

```ts
import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireCapability } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import type { InsightsOverviewDto, InsightsPostsDto } from './dto/insights.dto';
import { InsightsService } from './insights.service';
import { parseDays, parseTableQuery, parseTz } from './lib/query';

@Controller('insights/workspaces/:workspaceId')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
@RequireCapability('analytics:view')
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  /** Everything above the content table, for 7, 30 or 90 days. */
  @Get('overview')
  overview(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('days') days?: string,
    @Query('channels') channels?: string,
    @Query('tz') tz?: string,
  ): Promise<InsightsOverviewDto> {
    return this.insights.overview(workspaceId, parseDays(days), channels, parseTz(tz));
  }

  /** The "All content" table, a page at a time. */
  @Get('posts')
  posts(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('days') days?: string,
    @Query('channels') channels?: string,
    @Query('format') format?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<InsightsPostsDto> {
    return this.insights.posts(
      workspaceId,
      parseDays(days),
      channels,
      parseTableQuery({ format, sort, order, limit, offset }),
    );
  }

  /** The same table, every row, as a CSV download. */
  @Get('posts/export')
  async export(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Res({ passthrough: true }) res: Response,
    @Query('days') days?: string,
    @Query('channels') channels?: string,
    @Query('format') format?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
  ): Promise<string> {
    const { format: f, sort: s, order: o } = parseTableQuery({ format, sort, order });
    const { filename, body } = await this.insights.csv(
      workspaceId,
      parseDays(days),
      channels,
      { format: f, sort: s, order: o },
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return body;
  }
}
```

`src/insights/insights.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PostPerformanceModule } from '../post-performance/post-performance.module';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';
import { InsightsController } from './insights.controller';
import { InsightsService } from './insights.service';

// WorkspaceRoleModule (not WorkspaceMembersModule) supplies the guard's
// dependencies without pulling in Billing; see home.module.ts.
@Module({
  imports: [WorkspaceRoleModule, PostPerformanceModule],
  controllers: [InsightsController],
  providers: [InsightsService],
})
export class InsightsModule {}
```

In `src/app.module.ts`:
1. Add `import { InsightsModule } from './insights/insights.module';` beside the `HomeModule` import.
2. Add `InsightsModule,` after `HomeModule,` in `imports`.

- [ ] **Step 4: Run the tests**

Run: `npx jest src/insights`
Expected: PASS

- [ ] **Step 5: Mutation-check the guards**

Do each of these on the committed state, then restore it with `git checkout -- <file>`:

| Mutation | Expected failure |
|---|---|
| Remove `WorkspaceRoleGuard` from `@UseGuards` | the 403 test |
| Remove `@RequireCapability('analytics:view')` | the 403 test (no capability means the guard passes everyone) |
| Change `parseDays(days)` to `30` in `overview` | the `days=14` 400 test and the parsed-input test |

- [ ] **Step 6: Commit**

```bash
git add src/insights src/app.module.ts
git commit -m "feat(insights): overview, content table and CSV endpoints for workspace members"
```

---

### Task 9: Whole-branch verification and the PR

- [ ] **Step 1: Lint and build**

Run: `npx eslint src/insights src/post-performance src/home`
Expected: 0 errors. Warnings may only be the existing `as any` test-double pattern.

Run: `npx prettier --check src/insights src/post-performance src/home`
Expected: all files pass. If not, run `npx prettier --write` on them and re-run the tests.

Run: `npx tsc -p tsconfig.build.json --noEmit`
Expected: exit 0

- [ ] **Step 2: Full suite**

Run: `npx jest`
Expected: everything passes except the 4 suites that also fail on a clean `main`: `billing.controller`, `evergreen.service`, `pool-config` and `price-provisioning`. Name any other failure in the PR.

- [ ] **Step 3: The real query once more**

Re-run the Task 2 SQL proof script and confirm the output is unchanged and the transaction rolled back.

- [ ] **Step 4: Push and open the PR**

Push with the per-command credential helper for `Asad00713` (memory note `reference_gh_cli_multiaccount`), and verify with `git ls-remote`. Open the PR against `main`. The body covers:
- what the endpoints return;
- the post rule;
- the format classifier;
- dropped channel ids;
- CSV safety (BOM, quoting, formula defusing);
- tests, mutation checks and the SQL proof.

Do **not** merge. Merging needs the user's OK.
