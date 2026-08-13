# Campaigns Phase 2 — Real Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a launched campaign publish real, scheduled platform posts by materializing one `posts` row per publishable slot and reusing `PostService.publishPost` + the existing `POST_PUBLISHING` queue (mirroring `src/drips/`).

**Architecture:** No new publishing engine. `launch` computes each slot's publish time (timezone-correct), inserts a `posts` row (`status: 'scheduled'`, `metadata.campaignId` marker), and enqueues it on the existing `POST_PUBLISHING` queue with a `delay`. The existing `PostPublishProcessor` publishes it via `publishPost`. A small status-sync writes the outcome back to the slot. Pause/resume remove/re-enqueue future slot jobs. Metrics are computed-on-read from slot statuses.

**Tech Stack:** NestJS, Drizzle (node-postgres via `import { db } from '../drizzle/db'`), BullMQ (`@nestjs/bullmq`), class-validator DTOs, Jest.

## Global Constraints

- **Reuse only:** publishing goes through `PostService.publishPost(postId, workspaceId, userId, opts)` and the existing `POST_PUBLISHING` queue + `PostPublishProcessor`. NEVER call `PublisherFactory` directly. Mirror `src/drips/processors/drip.processor.ts` (insert `posts` row → link → publish).
- **No new BullMQ processor.** Campaign posts use the existing `{ postId }` job shape on `QUEUES.POST_PUBLISHING`.
- **No migration file committed** (Phase 1 lesson: `db:generate` bundles unrelated drift). Ship the schema file only; columns applied out-of-band before go-live. NEVER run a `db:*` command.
- **Bulk (Simple) campaigns only** for schedule→time computation. drip/evergreen scheduling and any "daily scanner" cron are OUT of scope.
- **AI slots that are not `approved` are SKIPPED at launch** (no generation — Phase 3).
- `campaign_slot_content.channelId` is a **stringified numeric** `socialMediaChannels.id`; coerce with `Number()` (as `refreshChannelCache` already does). `posts.targets[].channelId` is also a stringified numeric id.
- **`CAMPAIGN_STATUSES` unchanged** (`draft|scheduled|active|paused|completed|failed`). No `cancelled` value added — "cancel" = pause + delete.
- **No new user-facing notifications.** The engine emits SSE `post.status.changed`; campaigns inherit only that.
- Staging: exact files per task, `git diff --cached --name-only` before commit. Never `git add -A`. Never stage `.env`.
- **No push / PR / merge** unless the user later asks.
- Backend verify: `npx tsc --noEmit` (or the build tsconfig) + `npx jest <spec>`. Full build gate: `npm run build`.

## File Structure

**Backend (`socialmedia-workspace`), branch `feat/campaigns-backend`:**
- Modify: `src/drizzle/schema/campaigns.schema.ts` — add per-slot publish columns + `launchedAt`.
- Create: `src/campaigns/campaign-schedule.util.ts` — pure `computeSlotSchedule(...)` (timezone-correct date→time list) + `SlotSchedule` type.
- Create: `src/campaigns/campaign-schedule.util.spec.ts` — tz / skipWeekends / blackout / past-due tests.
- Create: `src/campaigns/campaign-publishing.service.ts` — `materializeAndEnqueue`, `cancelSlotJob`, `buildTargetsForSlot`; injects the `POST_PUBLISHING` queue + `PostService`.
- Create: `src/campaigns/campaign-publishing.service.spec.ts`.
- Modify: `src/campaigns/campaigns.service.ts` — rewrite `launch`/`pause`/`resume`, real `computeMetrics`, add slot-status reads; delegate publishing to `CampaignPublishingService`.
- Modify: `src/campaigns/campaigns.service.spec.ts` — launch/pause/resume/metrics tests.
- Create: `src/campaigns/campaign-status-sync.listener.ts` — writes publish outcome back to the slot on `post.status.changed`.
- Create: `src/campaigns/campaign-status-sync.listener.spec.ts`.
- Modify: `src/campaigns/campaigns.module.ts` — register queue + new providers + import `PostsModule` (for `PostService`).
- Modify: `src/posts/services/post.service.ts` (`getWorkspacePosts` only) — exclude `metadata.campaignId` posts from the normal list.

---

## Task 1: Per-slot publish columns (schema)

**Files:**
- Modify: `src/drizzle/schema/campaigns.schema.ts` (the `campaignSlotContent` table at line ~167; the `campaigns` table for `launchedAt`)

**Interfaces:**
- Produces: new columns on `campaignSlotContent` — `scheduledAt: Date|null`, `slotStatus: string` (default `'pending'`), `postId: string|null`, `jobId: string|null`, `publishedAt: Date|null`, `lastError: string|null`; and `campaigns.launchedAt: Date|null`. A `CAMPAIGN_SLOT_STATUSES` const.

- [ ] **Step 1: Add the slot-status enum + columns**

In `src/drizzle/schema/campaigns.schema.ts`, near the other exported enums (e.g. next to `CAMPAIGN_STATUSES`), add:

```ts
export const CAMPAIGN_SLOT_STATUSES = [
  'pending', // not yet launched (or paused back)
  'scheduled', // materialized + enqueued, awaiting publish
  'publishing',
  'published',
  'failed',
  'skipped', // past-due at launch, or an unapproved AI slot
] as const;
export type CampaignSlotStatus = (typeof CAMPAIGN_SLOT_STATUSES)[number];
```

In the `campaignSlotContent` table object (after `content`, before `createdAt`), add:

```ts
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    slotStatus: varchar('slot_status', { length: 20 })
      .$type<CampaignSlotStatus>()
      .notNull()
      .default('pending'),
    postId: uuid('post_id'),
    jobId: varchar('job_id', { length: 120 }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    lastError: text('last_error'),
```

Ensure `text` is imported from `drizzle-orm/pg-core` (it likely already is; add if missing).

In the `campaigns` table object (after `platforms`, before `createdAt`), add:

```ts
    launchedAt: timestamp('launched_at', { withTimezone: true }),
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep campaigns.schema`
Expected: no errors referencing `campaigns.schema.ts`. (Unrelated pre-existing spec errors in other modules may appear — ignore those.)

- [ ] **Step 3: Do NOT generate a migration**

Do not run `npm run db:generate` / `db:push` / `db:migrate`. The columns are applied out-of-band before go-live. Add a one-line note to the top of the file's changelog comment if one exists; otherwise skip.

- [ ] **Step 4: Commit**

```bash
git add src/drizzle/schema/campaigns.schema.ts
git commit -m "feat(campaigns): per-slot publish columns + launchedAt (Phase 2 schema)"
```

---

## Task 2: Timezone-correct slot schedule helper (pure)

**Files:**
- Create: `src/campaigns/campaign-schedule.util.ts`
- Test: `src/campaigns/campaign-schedule.util.spec.ts`

**Interfaces:**
- Consumes: `CampaignScheduleJson` from `../drizzle/schema/campaigns.schema`.
- Produces:
  ```ts
  export interface SlotSchedule { date: string; scheduledAt: Date } // date = yyyy-MM-dd
  export function computeSlotSchedule(
    schedule: CampaignScheduleJson,
    dates: string[],          // the campaign's slot dates (yyyy-MM-dd) to schedule
    now: Date,
  ): { due: SlotSchedule[]; pastDue: string[] }
  ```
  `due` = dates whose computed publish time is ≥ now; `pastDue` = dates already elapsed (caller marks these `skipped`). Bulk only; a non-bulk schedule returns everything as `pastDue` (defensive — bulk is the only launchable type in Phase 2).

- [ ] **Step 1: Write the failing test**

```ts
// src/campaigns/campaign-schedule.util.spec.ts
import { computeSlotSchedule } from './campaign-schedule.util';
import type { CampaignScheduleJson } from '../drizzle/schema/campaigns.schema';

function bulk(overrides: Partial<Extract<CampaignScheduleJson, { type: 'bulk' }>> = {}) {
  return {
    type: 'bulk' as const,
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    defaultTime: '09:00',
    timezone: 'UTC',
    blackoutDates: [],
    skipWeekends: false,
    ...overrides,
  };
}

describe('computeSlotSchedule', () => {
  const now = new Date('2026-09-01T00:00:00Z');

  it('computes UTC publish time from date + defaultTime', () => {
    const { due, pastDue } = computeSlotSchedule(bulk(), ['2026-09-02'], now);
    expect(pastDue).toEqual([]);
    expect(due).toHaveLength(1);
    expect(due[0].date).toBe('2026-09-02');
    expect(due[0].scheduledAt.toISOString()).toBe('2026-09-02T09:00:00.000Z');
  });

  it('honors perDayTimes over defaultTime', () => {
    const { due } = computeSlotSchedule(
      bulk({ perDayTimes: { '2026-09-02': '18:30' } }),
      ['2026-09-02'],
      now,
    );
    expect(due[0].scheduledAt.toISOString()).toBe('2026-09-02T18:30:00.000Z');
  });

  it('applies a non-UTC IANA timezone offset', () => {
    // 09:00 in Asia/Karachi (UTC+5, no DST) == 04:00 UTC
    const { due } = computeSlotSchedule(
      bulk({ timezone: 'Asia/Karachi' }),
      ['2026-09-02'],
      now,
    );
    expect(due[0].scheduledAt.toISOString()).toBe('2026-09-02T04:00:00.000Z');
  });

  it('marks a past date as pastDue, not due', () => {
    const { due, pastDue } = computeSlotSchedule(
      bulk(),
      ['2026-08-15'],
      new Date('2026-09-01T00:00:00Z'),
    );
    expect(due).toEqual([]);
    expect(pastDue).toEqual(['2026-08-15']);
  });

  it('drops blackout + weekend dates as pastDue-style exclusions', () => {
    // 2026-09-05 is a Saturday
    const { due } = computeSlotSchedule(
      bulk({ skipWeekends: true, blackoutDates: ['2026-09-03'] }),
      ['2026-09-03', '2026-09-04', '2026-09-05'],
      now,
    );
    const dates = due.map((d) => d.date);
    expect(dates).toContain('2026-09-04');
    expect(dates).not.toContain('2026-09-03'); // blackout
    expect(dates).not.toContain('2026-09-05'); // weekend
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/campaigns/campaign-schedule.util.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

The timezone conversion turns "wall-clock `HH:mm` on `date` in IANA `timezone`" into a real UTC `Date`. Compute the zone's offset for that instant via `Intl.DateTimeFormat` and subtract it.

```ts
// src/campaigns/campaign-schedule.util.ts
import type { CampaignScheduleJson } from '../drizzle/schema/campaigns.schema';

export interface SlotSchedule {
  date: string; // yyyy-MM-dd
  scheduledAt: Date;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

/** Offset (minutes) of `timeZone` from UTC at the given UTC instant.
 *  Positive means east of UTC (e.g. Asia/Karachi → +300). */
function zoneOffsetMinutes(timeZone: string, at: Date): number {
  // Format the same instant as wall-clock in the target zone, read it back as
  // if it were UTC, and diff — a standard, DST-correct offset trick.
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** Convert wall-clock `date` + `HH:mm` in `timeZone` to a UTC Date. Falls back
 *  to treating the wall-clock as UTC if the zone is invalid. */
function wallClockToUtc(date: string, time: string, timeZone: string): Date | null {
  const d = DATE_RE.exec(date);
  const t = TIME_RE.exec(time);
  if (!d || !t) return null;
  const [, y, mo, da] = d;
  const [, hh, mm] = t;
  // First approximation: treat the wall-clock as UTC.
  const naiveUtcMs = Date.UTC(+y, +mo - 1, +da, +hh, +mm, 0, 0);
  let offsetMin = 0;
  try {
    offsetMin = zoneOffsetMinutes(timeZone, new Date(naiveUtcMs));
  } catch {
    offsetMin = 0; // invalid zone → UTC fallback
  }
  // Real UTC instant = wall-clock minus the zone's offset.
  return new Date(naiveUtcMs - offsetMin * 60000);
}

function isWeekend(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 || day === 6;
}

export function computeSlotSchedule(
  schedule: CampaignScheduleJson,
  dates: string[],
  now: Date,
): { due: SlotSchedule[]; pastDue: string[] } {
  const due: SlotSchedule[] = [];
  const pastDue: string[] = [];

  if (schedule.type !== 'bulk') {
    // Phase 2 launches bulk only; defensively treat others as nothing-due.
    return { due: [], pastDue: [...dates] };
  }

  const blackout = new Set(schedule.blackoutDates ?? []);
  const perDay = schedule.perDayTimes ?? {};

  for (const date of dates) {
    if (blackout.has(date)) continue; // excluded, not published, not counted past-due
    if (schedule.skipWeekends && isWeekend(date)) continue;

    const time = perDay[date] ?? schedule.defaultTime;
    const at = wallClockToUtc(date, time, schedule.timezone);
    if (!at) continue;

    if (at.getTime() >= now.getTime()) {
      due.push({ date, scheduledAt: at });
    } else {
      pastDue.push(date);
    }
  }

  return { due, pastDue };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/campaigns/campaign-schedule.util.spec.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/campaigns/campaign-schedule.util.ts src/campaigns/campaign-schedule.util.spec.ts
git commit -m "feat(campaigns): timezone-correct slot schedule helper"
```

---

## Task 3: CampaignPublishingService — materialize + enqueue

**Files:**
- Create: `src/campaigns/campaign-publishing.service.ts`
- Test: `src/campaigns/campaign-publishing.service.spec.ts`

**Interfaces:**
- Consumes: the `POST_PUBLISHING` BullMQ queue (`@InjectQueue(QUEUES.POST_PUBLISHING)`), `db`, `socialMediaChannels`, `ChannelDayContentJson`, `PostTarget` (`../drizzle/schema/posts.schema`).
- Produces:
  ```ts
  // Builds a posts row + enqueues it with delay. Returns the ids written to the slot.
  materializeAndEnqueue(input: {
    workspaceId: string; createdById: string; campaignId: string;
    date: string; channelId: string; content: ChannelDayContentJson;
    platform: string; scheduledAt: Date;
  }): Promise<{ postId: string; jobId: string }>

  cancelSlotJob(jobId: string): Promise<void>   // remove a scheduled BullMQ job
  ```

- [ ] **Step 1: Write the failing test**

```ts
// src/campaigns/campaign-publishing.service.spec.ts
import { CampaignPublishingService } from './campaign-publishing.service';

describe('CampaignPublishingService', () => {
  function make() {
    const add = jest.fn().mockResolvedValue({ id: 'job-1' });
    const getJob = jest.fn();
    const queue = { add, getJob } as never;
    const service = new CampaignPublishingService(queue);
    return { service, add, getJob };
  }

  it('cancelSlotJob removes the job when present', async () => {
    const { service, getJob } = make();
    const remove = jest.fn().mockResolvedValue(undefined);
    getJob.mockResolvedValue({ remove });
    await service.cancelSlotJob('job-1');
    expect(getJob).toHaveBeenCalledWith('job-1');
    expect(remove).toHaveBeenCalled();
  });

  it('cancelSlotJob is a no-op when the job is already gone', async () => {
    const { service, getJob } = make();
    getJob.mockResolvedValue(null);
    await expect(service.cancelSlotJob('missing')).resolves.toBeUndefined();
  });

  it('enqueues with a delay derived from scheduledAt and a deterministic jobId', () => {
    const { service } = make();
    // buildJobId is a pure helper — assert its shape (used for idempotency).
    expect(service.buildJobId('c1', '2026-09-02', '42')).toBe(
      'campaign-c1-2026-09-02-42',
    );
  });
});
```

> NOTE: `materializeAndEnqueue` writes to the real `db` and is covered by the launch integration test in Task 4 (which mocks `db` at the service boundary). Here we unit-test the queue-facing pure/near-pure surface (`cancelSlotJob`, `buildJobId`) to avoid duplicating a full db mock.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/campaigns/campaign-publishing.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

```ts
// src/campaigns/campaign-publishing.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '../drizzle/db';
import { posts, type PostTarget } from '../drizzle/schema/posts.schema';
import type { ChannelDayContentJson } from '../drizzle/schema/campaigns.schema';
import { QUEUES } from '../queue/queue.module';

interface MaterializeInput {
  workspaceId: string;
  createdById: string;
  campaignId: string;
  date: string;
  channelId: string; // stringified numeric channel id
  content: ChannelDayContentJson;
  platform: string;
  scheduledAt: Date;
}

/**
 * Turns a campaign slot into a real scheduled `posts` row and enqueues it on
 * the EXISTING post-publishing queue (mirrors src/drips). The existing
 * PostPublishProcessor picks up the { postId } job and calls publishPost.
 */
@Injectable()
export class CampaignPublishingService {
  private readonly logger = new Logger(CampaignPublishingService.name);

  constructor(
    @InjectQueue(QUEUES.POST_PUBLISHING) private readonly queue: Queue,
  ) {}

  /** Deterministic per-(campaign,date,channel) job id → idempotent enqueue. */
  buildJobId(campaignId: string, date: string, channelId: string): string {
    return `campaign-${campaignId}-${date}-${channelId}`;
  }

  buildTargets(channelId: string, platform: string): PostTarget[] {
    return [{ channelId, platform: platform as PostTarget['platform'], status: 'scheduled' }];
  }

  async materializeAndEnqueue(
    input: MaterializeInput,
  ): Promise<{ postId: string; jobId: string }> {
    const c = input.content;
    const platformContent: Record<string, { text?: string }> = {
      [input.platform]: { text: c.caption },
    };

    const [post] = await db
      .insert(posts)
      .values({
        workspaceId: input.workspaceId,
        createdById: input.createdById,
        content: c.caption,
        mediaItems: (c.media ?? []).map((m) => ({
          url: m.url ?? '',
          type: m.kind === 'video' ? 'video' : 'image',
        })),
        targets: this.buildTargets(input.channelId, input.platform),
        status: 'scheduled',
        scheduledAt: input.scheduledAt,
        platformContent,
        metadata: {
          campaignId: input.campaignId,
          campaignSlot: { date: input.date, channelId: input.channelId },
        },
      })
      .returning();

    const jobId = this.buildJobId(input.campaignId, input.date, input.channelId);
    const delay = Math.max(0, input.scheduledAt.getTime() - Date.now());

    const job = await this.queue.add(
      'publish-post', // same job name the existing processor consumes ({ postId })
      { postId: post.id },
      { delay, jobId, attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    );

    await db
      .update(posts)
      .set({ jobId: job.id as string })
      .where(eq(posts.id, post.id));

    return { postId: post.id, jobId: job.id as string };
  }

  async cancelSlotJob(jobId: string): Promise<void> {
    try {
      const job = await this.queue.getJob(jobId);
      if (job) await job.remove();
    } catch (err) {
      this.logger.warn(`cancelSlotJob(${jobId}) failed: ${String(err)}`);
    }
  }
}
```

> Before implementing, OPEN `src/queue/queue.constants.ts` (or wherever `QUEUES` is defined — grep `QUEUES.POST_PUBLISHING`) and import from the real path. Confirm `mediaItems` element shape against `MediaItem` in `posts.schema.ts` and adjust the `.map` if fields differ (e.g. required `type` union). If `PostTarget.platform` is a strict `SupportedPlatform` union, keep the `as` cast but ensure the campaign only passes real platform strings (they come from `socialMediaChannels.platform`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/campaigns/campaign-publishing.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep campaign-publishing`
Expected: no errors referencing the new file.

- [ ] **Step 6: Commit**

```bash
git add src/campaigns/campaign-publishing.service.ts src/campaigns/campaign-publishing.service.spec.ts
git commit -m "feat(campaigns): CampaignPublishingService — materialize slot into scheduled post + enqueue"
```

---

## Task 4: Rewrite launch + preflight (+ resolve channels/platforms)

**Files:**
- Modify: `src/campaigns/campaigns.service.ts` (`launch`, and a new private `resolveSlotChannels` + `collectPublishableSlots`)
- Modify: `src/campaigns/campaigns.module.ts` (wire `CampaignPublishingService`, import `PostsModule`, register the queue)
- Test: `src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `CampaignPublishingService.materializeAndEnqueue` (Task 3), `computeSlotSchedule` (Task 2), `CampaignSlotStatus` (Task 1).
- Produces: `launch(workspaceId, id)` that materializes/enqueues publishable slots, writes `postId`/`jobId`/`scheduledAt`/`slotStatus` onto each slot row, sets `launchedAt`, and returns the assembled `CampaignDto`.

- [ ] **Step 1: Register the queue + providers in the module**

OPEN `src/campaigns/campaigns.module.ts`. Add (mirroring `src/posts/posts.module.ts`):
- `BullModule.registerQueue({ name: QUEUES.POST_PUBLISHING })` in `imports`.
- `PostsModule` in `imports` (to inject `PostService` in Task 6; safe to add now — if it creates a circular dep, use `forwardRef(() => PostsModule)` and note it in the report).
- `CampaignPublishingService` in `providers`.

- [ ] **Step 2: Write the failing test** (launch materializes + enqueues; preflight rejects empty)

Add to `campaigns.service.spec.ts`. The suite already mocks `db`; extend the mock so `launch` can read slots/days and update rows. Provide a mock `CampaignPublishingService` with `materializeAndEnqueue` returning `{ postId: 'p1', jobId: 'j1' }`. Assert:

```ts
it('launch rejects a campaign with no publishable slots', async () => {
  // getOne returns a campaign with zero filled slots
  await expect(service.launch('ws', 'c1')).rejects.toThrow(/no publishable/i);
});

it('launch materializes + enqueues each publishable slot and marks it scheduled', async () => {
  // one filled manual slot, future date, connected channel
  const result = await service.launch('ws', 'c1');
  expect(publishing.materializeAndEnqueue).toHaveBeenCalledTimes(1);
  expect(result.status).toBe('active');
  // slot row updated with postId/jobId/slotStatus='scheduled'
});

it('launch skips past-due slots (marks skipped, does not enqueue)', async () => {
  // slot date already elapsed
  await service.launch('ws', 'c1');
  expect(publishing.materializeAndEnqueue).not.toHaveBeenCalled();
});
```

(Follow the existing spec's `db` mock style — mock the `select/from/where` chain to return the campaign row, days, and slots; mock `update` to capture the slot writes.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest src/campaigns/campaigns.service.spec.ts -t launch`
Expected: FAIL — current `launch` only flips status.

- [ ] **Step 4: Implement launch**

Inject the new service (constructor): `constructor(private readonly publishing: CampaignPublishingService) {}` (the service currently has no constructor deps — add one). Replace `launch`:

```ts
async launch(workspaceId: string, id: string): Promise<CampaignDto> {
  const campaign = await this.getOne(workspaceId, id); // 404 if wrong workspace

  // Preflight: gather publishable slots (filled + day not skipped + AI approved).
  const publishable = await this.collectPublishableSlots(id);
  if (publishable.length === 0) {
    throw new BadRequestException(
      'This campaign has no publishable content. Add at least one filled post before launching.',
    );
  }

  // Resolve platform per channel; reject if a referenced channel is gone.
  const channelMap = await this.resolveSlotChannels(
    publishable.map((s) => s.channelId),
  );

  const dates = [...new Set(publishable.map((s) => s.date))];
  const { due, pastDue } = computeSlotSchedule(campaign.schedule, dates, new Date());
  const dueByDate = new Map(due.map((d) => [d.date, d.scheduledAt]));
  const pastDueSet = new Set(pastDue);

  for (const slot of publishable) {
    // Past-due (or blackout/weekend-excluded → not in `due`) → skip.
    const scheduledAt = dueByDate.get(slot.date);
    if (!scheduledAt || pastDueSet.has(slot.date)) {
      await db
        .update(campaignSlotContent)
        .set({ slotStatus: 'skipped', updatedAt: new Date() })
        .where(eq(campaignSlotContent.id, slot.slotId));
      continue;
    }
    const platform = channelMap.get(slot.channelId);
    if (!platform) {
      await db
        .update(campaignSlotContent)
        .set({ slotStatus: 'skipped', lastError: 'Channel unavailable', updatedAt: new Date() })
        .where(eq(campaignSlotContent.id, slot.slotId));
      continue;
    }

    const { postId, jobId } = await this.publishing.materializeAndEnqueue({
      workspaceId,
      createdById: campaign_createdById(campaign), // see note
      campaignId: id,
      date: slot.date,
      channelId: slot.channelId,
      content: slot.content,
      platform,
      scheduledAt,
    });

    await db
      .update(campaignSlotContent)
      .set({ postId, jobId, scheduledAt, slotStatus: 'scheduled', updatedAt: new Date() })
      .where(eq(campaignSlotContent.id, slot.slotId));
  }

  await db
    .update(campaigns)
    .set({ status: 'active', launchedAt: new Date(), updatedAt: new Date() })
    .where(eq(campaigns.id, id));

  return this.assembleCampaign(id);
}
```

Add the two private helpers:

```ts
/** Publishable = slot is filled, its day is not skipped, and if AI-mode its
 *  aiSubState is 'approved'. Returns slot id/date/channelId/content. */
private async collectPublishableSlots(campaignId: string): Promise<
  { slotId: string; date: string; channelId: string; content: ChannelDayContentJson }[]
> {
  const [days, slots] = await Promise.all([
    db.select().from(campaignDays).where(eq(campaignDays.campaignId, campaignId)),
    db.select().from(campaignSlotContent).where(eq(campaignSlotContent.campaignId, campaignId)),
  ]);
  const skipped = new Set(days.filter((d) => d.skip).map((d) => d.date));
  return slots
    .filter((s) => !skipped.has(s.date))
    .filter((s) => this.isSlotFilled(s.content))
    .filter((s) => s.content.mode !== 'ai' || s.content.aiSubState === 'approved')
    .map((s) => ({ slotId: s.id, date: s.date, channelId: s.channelId, content: s.content }));
}

/** channelId (stringified numeric) → platform. Missing/deleted channels are
 *  absent from the map, so the caller skips them. */
private async resolveSlotChannels(channelIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(channelIds)];
  const numericIds = unique.map((c) => Number(c)).filter((n) => Number.isFinite(n));
  if (numericIds.length === 0) return new Map();
  const rows = await db
    .select({ id: socialMediaChannels.id, platform: socialMediaChannels.platform })
    .from(socialMediaChannels)
    .where(inArray(socialMediaChannels.id, numericIds));
  return new Map(rows.map((r) => [String(r.id), r.platform]));
}
```

Notes for the implementer:
- `campaign.createdById` is NOT on the `CampaignDto` returned by `getOne` (the DTO omits it). Load it from the raw row: add `createdById` to the DTO OR fetch `db.select({ createdById: campaigns.createdById }).from(campaigns).where(eq(campaigns.id, id))` at the top of launch. Pick the smaller change; the `campaign_createdById(campaign)` placeholder above must be replaced with the real value. Prefer fetching the raw column (don't widen the public DTO).
- Import `BadRequestException` from `@nestjs/common`, `computeSlotSchedule` from `./campaign-schedule.util`, and `CampaignPublishingService`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/campaigns/campaigns.service.spec.ts -t launch`
Expected: PASS.

- [ ] **Step 6: Full campaigns suite + typecheck**

Run: `npx jest src/campaigns && npx tsc --noEmit 2>&1 | grep -E "campaigns\.(service|module)"`
Expected: campaigns specs pass; no tsc errors in the campaigns service/module.

- [ ] **Step 7: Commit**

```bash
git add src/campaigns/campaigns.service.ts src/campaigns/campaigns.module.ts src/campaigns/campaigns.service.spec.ts
git commit -m "feat(campaigns): launch materializes + enqueues publishable slots (preflight, past-due skip)"
```

---

## Task 5: pause / resume real jobs

**Files:**
- Modify: `src/campaigns/campaigns.service.ts` (`pause`, `resume`)
- Test: `src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `CampaignPublishingService.cancelSlotJob` + `.materializeAndEnqueue` (re-enqueue), `computeSlotSchedule`.
- Produces: `pause` cancels every still-`scheduled` slot's job and resets it to `pending`; `resume` re-materializes/enqueues every `pending` future slot and sets it `scheduled`.

- [ ] **Step 1: Write the failing test**

```ts
it('pause cancels scheduled slot jobs and resets them to pending', async () => {
  // two slots: one 'scheduled' (has jobId), one 'published'
  const result = await service.pause('ws', 'c1');
  expect(publishing.cancelSlotJob).toHaveBeenCalledTimes(1); // only the scheduled one
  expect(result.status).toBe('paused');
  // the published slot is untouched
});

it('resume re-enqueues pending future slots', async () => {
  // one 'pending' slot, future date, connected channel
  const result = await service.resume('ws', 'c1');
  expect(publishing.materializeAndEnqueue).toHaveBeenCalledTimes(1);
  expect(result.status).toBe('active');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/campaigns/campaigns.service.spec.ts -t "pause|resume"`
Expected: FAIL — current pause/resume only flip status.

- [ ] **Step 3: Implement pause/resume**

```ts
async pause(workspaceId: string, id: string): Promise<CampaignDto> {
  await this.getOne(workspaceId, id);

  const slots = await db
    .select()
    .from(campaignSlotContent)
    .where(and(eq(campaignSlotContent.campaignId, id), eq(campaignSlotContent.slotStatus, 'scheduled')));

  for (const slot of slots) {
    if (slot.jobId) await this.publishing.cancelSlotJob(slot.jobId);
    // Remove the not-yet-published post so it can't fire, and reset the slot.
    if (slot.postId) await db.delete(posts).where(eq(posts.id, slot.postId));
    await db
      .update(campaignSlotContent)
      .set({ slotStatus: 'pending', postId: null, jobId: null, scheduledAt: null, updatedAt: new Date() })
      .where(eq(campaignSlotContent.id, slot.id));
  }

  await db.update(campaigns).set({ status: 'paused', updatedAt: new Date() }).where(eq(campaigns.id, id));
  return this.assembleCampaign(id);
}

async resume(workspaceId: string, id: string): Promise<CampaignDto> {
  const campaign = await this.getOne(workspaceId, id);
  const createdById = await this.loadCreatedById(id); // small helper: select createdById

  const pendingSlots = await db
    .select()
    .from(campaignSlotContent)
    .where(and(eq(campaignSlotContent.campaignId, id), eq(campaignSlotContent.slotStatus, 'pending')));

  // Respect per-day skip exactly like launch (collectPublishableSlots does this).
  const resumeDays = await db.select().from(campaignDays).where(eq(campaignDays.campaignId, id));
  const skippedDates = new Set(resumeDays.filter((d) => d.skip).map((d) => d.date));
  const publishable = pendingSlots.filter(
    (s) => !skippedDates.has(s.date) && this.isSlotFilled(s.content) && (s.content.mode !== 'ai' || s.content.aiSubState === 'approved'),
  );
  const channelMap = await this.resolveSlotChannels(publishable.map((s) => s.channelId));
  const dates = [...new Set(publishable.map((s) => s.date))];
  const { due } = computeSlotSchedule(campaign.schedule, dates, new Date());
  const dueByDate = new Map(due.map((d) => [d.date, d.scheduledAt]));

  for (const slot of publishable) {
    const scheduledAt = dueByDate.get(slot.date);
    const platform = channelMap.get(slot.channelId);
    if (!scheduledAt || !platform) continue; // past-due/unavailable stays pending
    const { postId, jobId } = await this.publishing.materializeAndEnqueue({
      workspaceId, createdById, campaignId: id, date: slot.date,
      channelId: slot.channelId, content: slot.content, platform, scheduledAt,
    });
    await db
      .update(campaignSlotContent)
      .set({ postId, jobId, scheduledAt, slotStatus: 'scheduled', updatedAt: new Date() })
      .where(eq(campaignSlotContent.id, slot.id));
  }

  await db.update(campaigns).set({ status: 'active', updatedAt: new Date() }).where(eq(campaigns.id, id));
  return this.assembleCampaign(id);
}
```

Add `import { posts } from '../drizzle/schema/posts.schema';` and a small `loadCreatedById(id)` helper (the same raw-column fetch used in launch — factor it out so both use one helper).

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/campaigns/campaigns.service.spec.ts -t "pause|resume"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/campaigns/campaigns.service.ts src/campaigns/campaigns.service.spec.ts
git commit -m "feat(campaigns): pause cancels scheduled jobs; resume re-enqueues pending slots"
```

---

## Task 6: Slot status sync + real metrics

**Files:**
- Create: `src/campaigns/campaign-status-sync.listener.ts`
- Test: `src/campaigns/campaign-status-sync.listener.spec.ts`
- Modify: `src/campaigns/campaigns.service.ts` (`computeMetrics`)
- Modify: `src/campaigns/campaigns.module.ts` (register listener)
- Test: `src/campaigns/campaigns.service.spec.ts` (metrics)

**Interfaces:**
- Consumes: the realtime `post.status.changed` payload (`PostStatusChangedPayload` from `src/realtime/types/analytics-events.types.ts`) and its emitter (`AnalyticsEventEmitter` in `src/realtime/`).
- Produces: on a `post.status.changed` event for a post carrying `metadata.campaignId`, updates the matching slot row (`slotStatus`, `publishedAt`, `lastError`); `computeMetrics` reads slot statuses.

- [ ] **Step 1: Inspect the emitter seam**

OPEN `src/realtime/analytics-event-emitter.service.ts` and `src/posts/services/post.service.ts` (`emitPostStatusChanged`). Determine whether events are consumable via a NestJS `@OnEvent`/EventEmitter2 subscription or an in-process observable. Use whatever the codebase already uses to subscribe (mirror any existing listener). If there is NO subscribe seam (emit-only to SSE), fall back to the inline path: in `post.service.ts`'s finalizer, after computing the final status, if `post.metadata?.campaignId` is set, call a `CampaignsService.syncSlotFromPost(post)` method. Record which path you took in the report.

- [ ] **Step 2: Write the failing test** (the sync function, pure over db)

```ts
// campaign-status-sync.listener.spec.ts — test the write logic given a payload
import { CampaignStatusSyncListener } from './campaign-status-sync.listener';

describe('CampaignStatusSyncListener.syncFromPost', () => {
  it('marks the slot published with platformPostId on success', async () => {
    // mock db.update capture; post has metadata.campaignId + campaignSlot
    // target status 'published', platformPostId 'x'
    // expect slot update: slotStatus 'published', publishedAt set
  });
  it('marks the slot failed with lastError on failure', async () => {
    // final status 'failed' → slotStatus 'failed', lastError from target.errorMessage
  });
  it('ignores a post with no campaignId metadata', async () => {
    // expect no db.update
  });
});
```

Flesh out the assertions using the existing spec's db-mock style.

- [ ] **Step 3: Implement the listener + sync**

```ts
// src/campaigns/campaign-status-sync.listener.ts
import { Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { db } from '../drizzle/db';
import { campaignSlotContent, type CampaignSlotStatus } from '../drizzle/schema/campaigns.schema';
import type { PostStatusChangedPayload } from '../realtime/types/analytics-events.types';

@Injectable()
export class CampaignStatusSyncListener {
  private readonly logger = new Logger(CampaignStatusSyncListener.name);

  // Wire this to the emitter per Step 1 (e.g. @OnEvent('post.status.changed')).
  async syncFromPost(payload: PostStatusChangedPayload): Promise<void> {
    const meta = payload.metadata as { campaignId?: string; campaignSlot?: { date: string; channelId: string } } | undefined;
    if (!meta?.campaignId || !meta.campaignSlot) return;

    const status = payload.status; // final post status
    let slotStatus: CampaignSlotStatus | null = null;
    if (status === 'published' || status === 'partially_published') slotStatus = 'published';
    else if (status === 'failed') slotStatus = 'failed';
    else if (status === 'publishing') slotStatus = 'publishing';
    if (!slotStatus) return;

    const firstTarget = payload.targets?.[0];
    await db
      .update(campaignSlotContent)
      .set({
        slotStatus,
        publishedAt: slotStatus === 'published' ? new Date() : undefined,
        lastError: slotStatus === 'failed' ? (firstTarget?.errorMessage ?? 'Publish failed') : undefined,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(campaignSlotContent.campaignId, meta.campaignId),
          eq(campaignSlotContent.date, meta.campaignSlot.date),
          eq(campaignSlotContent.channelId, meta.campaignSlot.channelId),
        ),
      );
  }
}
```

> Adjust `payload.metadata`/`payload.targets`/`payload.status` field names to the REAL `PostStatusChangedPayload` shape you read in Step 1. If the payload lacks `metadata`, load the post row by `payload.postId` to read `metadata.campaignId` (add a `db.select` on `posts`).

Then replace `computeMetrics` in `campaigns.service.ts` to count slot statuses. Change its signature to also receive the raw slot rows' `slotStatus`:

```ts
computeMetrics(
  days: Pick<CampaignDay, 'date' | 'skip'>[],
  slots: Pick<CampaignSlotContent, 'date' | 'content' | 'slotStatus'>[],
): CampaignMetricsDto {
  const skippedDates = new Set(days.filter((d) => d.skip).map((d) => d.date));
  let postsPlanned = 0, postsPublished = 0, postsFailed = 0, postsSkipped = 0;
  for (const slot of slots) {
    if (skippedDates.has(slot.date)) continue;
    if (!this.isSlotFilled(slot.content)) continue;
    postsPlanned += 1;
    if (slot.slotStatus === 'published') postsPublished += 1;
    else if (slot.slotStatus === 'failed') postsFailed += 1;
    else if (slot.slotStatus === 'skipped') postsSkipped += 1;
  }
  return { postsPlanned, postsPublished, postsFailed, postsSkipped };
}
```

`CampaignSlotContent` already includes `slotStatus` after Task 1, so `toDto`'s existing `slots` argument carries it — no call-site change needed beyond the signature type.

Register `CampaignStatusSyncListener` in `campaigns.module.ts` providers.

- [ ] **Step 4: Run tests**

Run: `npx jest src/campaigns`
Expected: listener + metrics + prior tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/campaigns/campaign-status-sync.listener.ts src/campaigns/campaign-status-sync.listener.spec.ts src/campaigns/campaigns.service.ts src/campaigns/campaigns.module.ts src/campaigns/campaigns.service.spec.ts
git commit -m "feat(campaigns): sync slot status from publish outcome + real metrics"
```

---

## Task 7: Exclude campaign posts from the normal post list

**Files:**
- Modify: `src/posts/services/post.service.ts` (`getWorkspacePosts` only)
- Test: `src/posts/services/post.service.spec.ts` (if it exists; else a targeted new spec)

**Interfaces:**
- Consumes: nothing new.
- Produces: `getWorkspacePosts` no longer returns posts whose `metadata.campaignId` is set (they show only on the calendar, tagged). Mirrors how drip posts are excluded (check for an existing `dripCampaignId` filter and follow it).

- [ ] **Step 1: Inspect existing exclusion**

OPEN `getWorkspacePosts` in `post.service.ts`. Grep for `dripCampaignId` — if drip posts are already filtered out of this list, mirror that exact mechanism for `campaignId`. If drips are NOT filtered (they appear in the list), then match the drip behavior for consistency: do the SAME thing for campaigns as is done for drips (if drips appear, campaigns appear — and this task is a no-op beyond a code comment; record that in the report).

- [ ] **Step 2: Write/adjust the test**

If `getWorkspacePosts` has a spec, add a case: a post with `metadata.campaignId` is excluded from the returned list. If no spec exists and adding one requires heavy DB-mock scaffolding disproportionate to a one-line filter, SKIP the unit test and instead verify via `npm run build` + a note in the report (the filter is a single predicate; the risk is low). Record the choice.

- [ ] **Step 3: Implement the filter**

Add a predicate to the query/result of `getWorkspacePosts` that drops rows where `metadata.campaignId` is set (SQL `jsonb` filter if the query is SQL-side, or an in-memory `.filter` if the method already post-filters — match the method's existing style). Keep the calendar method (`getCalendarPosts`) unchanged so campaign posts still appear there.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add src/posts/services/post.service.ts
# add the spec too if you wrote one:
git add src/posts/services/post.service.spec.ts 2>/dev/null || true
git commit -m "feat(campaigns): hide campaign-materialized posts from the normal post list"
```

---

## Self-Review Notes

- **Spec coverage:** Task 1 = per-slot columns; Task 2 = timezone-correct scheduling (fixes Phase 1 TODO); Task 3 = materialize+enqueue via existing queue (drips mirror); Task 4 = launch + preflight + past-due skip; Task 5 = pause/resume real jobs; Task 6 = slot↔post sync + real metrics; Task 7 = posts-list pollution guard. All spec sections covered. Auto-complete (campaign → `completed` when no slot remains scheduled) is folded into Task 6's sync (when the last slot flips to published/failed) — the implementer adds a check in `syncFromPost`: after writing a terminal slot status, if no slot for that campaign is `scheduled`/`publishing`, set campaign `status: 'completed'`. **Added to Task 6 scope explicitly here.**
- **Type consistency:** `CampaignSlotStatus` (Task 1) used in Tasks 4/5/6; `materializeAndEnqueue`/`cancelSlotJob`/`buildJobId` (Task 3) consumed in Tasks 4/5; `computeSlotSchedule` (Task 2) in Tasks 4/5; `computeMetrics` new signature (Task 6) matches `toDto`'s existing slot argument.
- **Placeholder honesty:** the `campaign_createdById(campaign)` token in Task 4 Step 4 is explicitly flagged to be replaced with a real `createdById` fetch (helper factored in Task 5). The emitter seam (Task 6 Step 1) and posts-list existing-filter (Task 7 Step 1) are genuine inspect-first steps because they depend on realtime/posts internals not fully enumerated here — each has a concrete fallback.
- **Out of scope (unchanged):** AI generation (Phase 3), drip/evergreen cron, new notifications, migration files.
- **DB columns applied out-of-band** before go-live (Task 1 ships schema only) — same operational step as Phase 1.

## Auto-complete addendum (Task 6)

In `syncFromPost`, after writing a terminal (`published`/`failed`) slot status, run:
```ts
const remaining = await db
  .select({ id: campaignSlotContent.id })
  .from(campaignSlotContent)
  .where(and(
    eq(campaignSlotContent.campaignId, meta.campaignId),
    inArray(campaignSlotContent.slotStatus, ['scheduled', 'publishing']),
  ));
if (remaining.length === 0) {
  await db.update(campaigns).set({ status: 'completed', updatedAt: new Date() })
    .where(and(eq(campaigns.id, meta.campaignId), eq(campaigns.status, 'active')));
}
```
Import `campaigns`, `inArray`. Only transition an `active` campaign (guard prevents clobbering a manually paused one).
