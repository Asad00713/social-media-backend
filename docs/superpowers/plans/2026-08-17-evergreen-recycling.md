# Evergreen Recycling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Evergreen Recycling campaign type that auto-rotates a pool of categorized posts on a repeating schedule forever, with AI variations, performance-aware recycling, freshness guard, and messaging channels.

**Architecture:** Extend the existing NestJS campaigns module. Three new Drizzle tables (categories, pool posts, occurrence log) + a per-fire re-enqueue rotation engine that reuses the existing `post-publishing` BullMQ queue and `materializeAndEnqueue` publish path. Frontend adds a category-first builder view (rail + Up-Next strip + post grid) reusing the composer building blocks. Bulk/Drip untouched.

**Tech Stack:** NestJS, Drizzle ORM (Postgres), BullMQ, class-validator, Jest (BE). Vite/React 19, TypeScript, Tailwind 3, shadcn/ui, TanStack Query v5, Vitest (FE).

**Spec:** `socialmedia-workspace/docs/superpowers/specs/2026-08-17-evergreen-recycling-design.md`

## Global Constraints

- **Bulk/Drip byte-for-byte unchanged.** Evergreen logic is additive; branch on `type==='evergreen'`. Never alter a shared code path in a way that changes bulk/drip behavior. `campaign_days` / `campaign_slot_content` are NOT used by evergreen.
- **Assistant never runs `db:*` / `psql` / migrations.** Generate migration SQL via `npm run db:generate`; the USER applies it. A task that needs a table present tests against the schema/service with a fake DB, not a live one.
- **Never `git add .` / `-A`.** Frontend `.env` is git-TRACKED with secrets; backend `.env` is gitignored with live secrets. Surgical `git add <path>` only. Commit only; never push/PR/merge unless the user explicitly asks.
- **shadcn-only UI + theme tokens only** (no hex, no arbitrary Tailwind colors like `bg-blue-500`). Category colors come from a fixed token set reusing the `ACCENT_CLASSES` pattern.
- **Every async surface** gets loading / disabled / empty / error states (CLAUDE.md Rule 4). Pages stay thin; feature components carry concerns (Rule 1). `kebab-case.tsx` files, `PascalCase` components.
- **Graceful degradation is mandatory:** AI down → publish base caption; no metrics → neutral score; freshness error → don't flag, don't block. The rotation core never depends on a differentiator succeeding.
- **git autocrlf note (BE repo):** working tree is CRLF; committed blobs LF. `npx eslint` shows prettier `␍⏎` noise — do NOT run `--fix`. `nest build` is the gate.
- **Reused exact signatures** (cite verbatim; do not invent):
  - `computeSlotSchedule(schedule: CampaignScheduleJson, slots: {date;time}[], now: Date): { due: {date;time;scheduledAt:Date}[]; pastDue: {date;time}[] }` — `src/campaigns/campaign-schedule.util.ts`
  - `CampaignPublishingService.materializeAndEnqueue(input: { workspaceId; createdById; campaignId; date; channelId; time; content: ChannelDayContentJson; platform: string; scheduledAt: Date; destination?: {id;name?} }): Promise<{ postId: string; jobId: string }>` — `src/campaigns/campaign-publishing.service.ts`
  - `CampaignPublishingService.cancelSlotJob(jobId: string): Promise<void>`
  - `GroqService.generateVariations(content: string, platform: Platform, count?: number): Promise<string[]>` — `src/ai/groq.service.ts`
  - Schema enums `CAMPAIGN_SLOT_STATUSES` / `CampaignSlotStatus`, JSON types `ChannelDayContentJson`, `CampaignScheduleEvergreenJson` — `src/drizzle/schema/campaigns.schema.ts`

---

## File Structure

**Backend (`socialmedia-workspace/`):**
- `src/drizzle/schema/evergreen.schema.ts` — NEW: 3 tables + enums + JSON types + relations + type exports. Re-exported from `src/drizzle/schema/index.ts`.
- `src/campaigns/evergreen-rotation.util.ts` — NEW: pure rotation helpers (`computeNextCategoryFire`, `pickNextPost`, eligibility, variation selection). No DB, fully unit-testable.
- `src/campaigns/evergreen.service.ts` — NEW: `EvergreenService` — category/pool/variation CRUD, launch/pause/resume branches, `fireOccurrence`, reconcile.
- `src/campaigns/evergreen.controller.ts` — NEW: REST routes under `campaigns/workspaces/:ws/...`.
- `src/campaigns/dto/evergreen.dto.ts` — NEW: class-validator DTOs.
- `src/campaigns/processors/evergreen-fire.processor.ts` — NEW: BullMQ processor for the per-fire rotation job.
- `src/campaigns/campaigns.module.ts` — MODIFY: register new providers + the fire queue + reconcile cron.
- `src/campaigns/campaigns.service.ts` — MODIFY (surgical): `launch/pause/resume/assembleCampaign/duplicate` branch to `EvergreenService` when `type==='evergreen'`.

**Frontend (`socialmedia-frontend/`):**
- `src/features/campaigns/types/evergreen.ts` — NEW: types.
- `src/features/campaigns/api/evergreen.api.ts` — NEW: typed API wrappers.
- `src/features/campaigns/hooks/use-evergreen.ts` + `use-evergreen-mutations.ts` — NEW.
- `src/features/campaigns/utils/evergreen-colors.ts` — NEW: category color token map + tests.
- `src/features/campaigns/components/evergreen/` — NEW: `evergreen-builder-view.tsx`, `category-rail.tsx`, `up-next-strip.tsx`, `post-grid.tsx`, `evergreen-post-card.tsx`, `evergreen-post-editor.tsx`, `variations-panel.tsx`, `recycle-policy-control.tsx`, `new-category-dialog.tsx`.
- `src/features/campaigns/constants/type-config.tsx` — MODIFY: nothing (card exists).
- `src/features/campaigns/components/create/new-campaign-type-chooser.tsx` — MODIFY (last task): add `'evergreen'` to `ACTIVE_TYPES`.
- Router / builder routing — MODIFY: route an evergreen campaign to `EvergreenBuilderView` instead of the bonzo builder.

---

## Task 1: Evergreen schema (tables + enums + types)

**Files:**
- Create: `src/drizzle/schema/evergreen.schema.ts`
- Modify: `src/drizzle/schema/index.ts` (add `export * from './evergreen.schema';` after the campaigns line at :27)
- Test: `src/drizzle/schema/evergreen.schema.spec.ts`

**Interfaces:**
- Produces: tables `evergreenCategories`, `evergreenPosts`, `evergreenOccurrences`; enums `EVERGREEN_POST_STATUSES`/`EvergreenPostStatus`; JSON types `EvergreenCategoryScheduleJson`, `EvergreenVariationJson`, `RecyclePolicyJson`, `EvergreenSeasonalJson`; type exports `EvergreenCategory`/`NewEvergreenCategory`/`EvergreenPost`/`NewEvergreenPost`/`EvergreenOccurrence`/`NewEvergreenOccurrence`. Consumed by every later BE task.

- [ ] **Step 1: Write the failing test**

```ts
// src/drizzle/schema/evergreen.schema.spec.ts
import {
  evergreenCategories,
  evergreenPosts,
  evergreenOccurrences,
  EVERGREEN_POST_STATUSES,
} from './evergreen.schema';
import { getTableConfig } from 'drizzle-orm/pg-core';

describe('evergreen schema', () => {
  it('defines the three evergreen tables with correct names', () => {
    expect(getTableConfig(evergreenCategories).name).toBe('campaign_evergreen_categories');
    expect(getTableConfig(evergreenPosts).name).toBe('campaign_evergreen_posts');
    expect(getTableConfig(evergreenOccurrences).name).toBe('campaign_evergreen_occurrences');
  });

  it('categories table has a unique (campaign_id, name) index', () => {
    const idx = getTableConfig(evergreenCategories).indexes.map((i) => i.config.name);
    expect(idx).toContain('evergreen_categories_campaign_name_uq');
  });

  it('exports the post status enum', () => {
    expect(EVERGREEN_POST_STATUSES).toEqual(['active', 'paused', 'retired']);
  });

  it('posts table has category_id and campaign_id columns', () => {
    const cols = getTableConfig(evergreenPosts).columns.map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining(['category_id', 'campaign_id', 'content', 'variations', 'recycle_policy', 'performance_score', 'is_stale', 'status']),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/drizzle/schema/evergreen.schema.spec.ts`
Expected: FAIL — cannot find module `./evergreen.schema`.

- [ ] **Step 3: Write the schema**

Follow `campaigns.schema.ts` style exactly (pgTable, column helpers, `uniqueIndex`, `.$type<>()`, relations, `$inferSelect`/`$inferInsert` exports). Import `campaigns` from `./campaigns.schema` for FK references, `CampaignSlotStatus`/`ChannelDayContentJson` too.

```ts
// src/drizzle/schema/evergreen.schema.ts
import {
  pgTable, uuid, text, timestamp, varchar, boolean, jsonb, integer, real, uniqueIndex, index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { campaigns, CampaignSlotStatus, ChannelDayContentJson } from './campaigns.schema';

export const EVERGREEN_POST_STATUSES = ['active', 'paused', 'retired'] as const;
export type EvergreenPostStatus = (typeof EVERGREEN_POST_STATUSES)[number];

export interface EvergreenCategoryScheduleJson {
  weekdays: number[]; // 0=Sun..6=Sat
  times: string[];    // HH:mm
}
export interface EvergreenSeasonalJson {
  startDate: string; // yyyy-MM-dd
  endDate: string;
}
export interface EvergreenVariationJson {
  id: string;
  caption: string;
  media?: { id: string; filename: string; kind: 'image' | 'video'; url?: string }[];
  source: 'ai' | 'manual';
}
export interface RecyclePolicyJson {
  mode: 'forever' | 'maxCount' | 'expiry';
  maxCount?: number;
  expiryDate?: string; // yyyy-MM-dd
}

export const evergreenCategories = pgTable(
  'campaign_evergreen_categories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    color: varchar('color', { length: 20 }).notNull(),
    schedule: jsonb('schedule').$type<EvergreenCategoryScheduleJson>().notNull(),
    channelIds: jsonb('channel_ids').$type<string[]>().default([]).notNull(),
    seasonal: jsonb('seasonal').$type<EvergreenSeasonalJson | null>(),
    isActive: boolean('is_active').default(true).notNull(),
    rotationCursor: integer('rotation_cursor').default(0).notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uqCampaignName: uniqueIndex('evergreen_categories_campaign_name_uq').on(t.campaignId, t.name),
  }),
);

export const evergreenPosts = pgTable(
  'campaign_evergreen_posts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').notNull().references(() => evergreenCategories.id, { onDelete: 'cascade' }),
    content: jsonb('content').$type<ChannelDayContentJson>().notNull(),
    variations: jsonb('variations').$type<EvergreenVariationJson[]>().default([]).notNull(),
    recyclePolicy: jsonb('recycle_policy').$type<RecyclePolicyJson>().notNull(),
    minGapHours: integer('min_gap_hours').default(0).notNull(),
    recycledCount: integer('recycled_count').default(0).notNull(),
    lastPublishedAt: timestamp('last_published_at', { withTimezone: true }),
    performanceScore: real('performance_score'),
    isStale: boolean('is_stale').default(false).notNull(),
    staleReason: text('stale_reason'),
    status: varchar('status', { length: 20 }).$type<EvergreenPostStatus>().default('active').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idxCategoryStatus: index('evergreen_posts_category_status_idx').on(t.categoryId, t.status),
    idxCampaign: index('evergreen_posts_campaign_idx').on(t.campaignId),
  }),
);

export const evergreenOccurrences = pgTable(
  'campaign_evergreen_occurrences',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').notNull().references(() => evergreenCategories.id, { onDelete: 'cascade' }),
    postIdRef: uuid('post_id_ref').notNull().references(() => evergreenPosts.id, { onDelete: 'cascade' }),
    variationId: varchar('variation_id', { length: 64 }),
    channelId: varchar('channel_id', { length: 255 }).notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    slotStatus: varchar('slot_status', { length: 20 }).$type<CampaignSlotStatus>().default('scheduled').notNull(),
    postsRowId: uuid('posts_row_id'),
    jobId: varchar('job_id', { length: 160 }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idxCampaignScheduled: index('evergreen_occurrences_campaign_scheduled_idx').on(t.campaignId, t.scheduledAt),
    idxPostRef: index('evergreen_occurrences_post_ref_idx').on(t.postIdRef),
    idxJob: index('evergreen_occurrences_job_idx').on(t.jobId),
  }),
);

export const evergreenCategoriesRelations = relations(evergreenCategories, ({ one, many }) => ({
  campaign: one(campaigns, { fields: [evergreenCategories.campaignId], references: [campaigns.id] }),
  posts: many(evergreenPosts),
}));
export const evergreenPostsRelations = relations(evergreenPosts, ({ one }) => ({
  category: one(evergreenCategories, { fields: [evergreenPosts.categoryId], references: [evergreenCategories.id] }),
}));

export type EvergreenCategory = typeof evergreenCategories.$inferSelect;
export type NewEvergreenCategory = typeof evergreenCategories.$inferInsert;
export type EvergreenPost = typeof evergreenPosts.$inferSelect;
export type NewEvergreenPost = typeof evergreenPosts.$inferInsert;
export type EvergreenOccurrence = typeof evergreenOccurrences.$inferSelect;
export type NewEvergreenOccurrence = typeof evergreenOccurrences.$inferInsert;
```

Then add to `src/drizzle/schema/index.ts` after line 27: `export * from './evergreen.schema';`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/drizzle/schema/evergreen.schema.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Generate migration (do NOT apply)**

Run: `npm run db:generate`
Expected: a new migration file under `drizzle/migrations/` creating the 3 tables + indexes. Do NOT run `db:migrate`/`db:push`. Note the file path in the commit; the user applies it.

- [ ] **Step 6: Commit**

```bash
git add src/drizzle/schema/evergreen.schema.ts src/drizzle/schema/index.ts src/drizzle/schema/evergreen.schema.spec.ts drizzle/migrations/
git commit -m "feat(evergreen): schema — categories, pool posts, occurrences"
```

---

## Task 2: Rotation utility (pure, no DB)

**Files:**
- Create: `src/campaigns/evergreen-rotation.util.ts`
- Test: `src/campaigns/evergreen-rotation.util.spec.ts`

**Interfaces:**
- Consumes: `EvergreenCategoryScheduleJson`, `EvergreenPost`, `RecyclePolicyJson` (Task 1); `wallClockToUtc` logic pattern from `campaign-schedule.util.ts` (reuse by importing its exported helper if available, else replicate the tz conversion — check the util's exports first).
- Produces:
  - `computeNextCategoryFire(schedule: EvergreenCategoryScheduleJson, timezone: string, blackoutDates: string[], after: Date): Date | null` — next matching weekday+time strictly after `after`, in tz; null if none within a safety scan (e.g. 366 days).
  - `isPostEligible(post: EvergreenPost, category: { isActive: boolean; seasonal: EvergreenSeasonalJson | null }, now: Date): boolean` — status active + category active + within seasonal window + not expired by policy + min-gap satisfied.
  - `pickNextPost(posts: EvergreenPost[], category, now: Date): EvergreenPost | null` — filter eligible, rank least-recently-published-first with D2 weighting `(0.5 + performanceScore)` when non-null, return top or null.
  - `selectVariation(post: EvergreenPost): { variationId: string | null; caption: string }` — cycle base→var1→var2 by `recycledCount % (variations.length + 1)`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/campaigns/evergreen-rotation.util.spec.ts
import { computeNextCategoryFire, isPostEligible, pickNextPost, selectVariation } from './evergreen-rotation.util';

const NOW = new Date('2026-08-17T12:00:00Z'); // Monday

function post(overrides: any = {}): any {
  return {
    id: 'p1', status: 'active', recyclePolicy: { mode: 'forever' }, minGapHours: 0,
    recycledCount: 0, lastPublishedAt: null, performanceScore: null, variations: [], ...overrides,
  };
}
const liveCat = { isActive: true, seasonal: null };

describe('computeNextCategoryFire', () => {
  it('returns the next matching weekday+time after `after`', () => {
    // Wednesday(3) 09:00 UTC, from Monday noon → 2026-08-19T09:00Z
    const next = computeNextCategoryFire({ weekdays: [3], times: ['09:00'] }, 'UTC', [], NOW);
    expect(next?.toISOString()).toBe('2026-08-19T09:00:00.000Z');
  });
  it('skips blackout dates', () => {
    const next = computeNextCategoryFire({ weekdays: [1,2,3], times: ['09:00'] }, 'UTC', ['2026-08-18'], NOW);
    // Mon noon → Tue 18th is blackout → Wed 19th 09:00
    expect(next?.toISOString()).toBe('2026-08-19T09:00:00.000Z');
  });
  it('returns null when no weekday configured', () => {
    expect(computeNextCategoryFire({ weekdays: [], times: ['09:00'] }, 'UTC', [], NOW)).toBeNull();
  });
});

describe('isPostEligible', () => {
  it('true for an active post in an active category', () => {
    expect(isPostEligible(post(), liveCat, NOW)).toBe(true);
  });
  it('false for a paused/retired post', () => {
    expect(isPostEligible(post({ status: 'paused' }), liveCat, NOW)).toBe(false);
    expect(isPostEligible(post({ status: 'retired' }), liveCat, NOW)).toBe(false);
  });
  it('false when category is inactive', () => {
    expect(isPostEligible(post(), { isActive: false, seasonal: null }, NOW)).toBe(false);
  });
  it('false outside a seasonal window', () => {
    expect(isPostEligible(post(), { isActive: true, seasonal: { startDate: '2026-12-01', endDate: '2026-12-31' } }, NOW)).toBe(false);
  });
  it('false when maxCount reached', () => {
    expect(isPostEligible(post({ recyclePolicy: { mode: 'maxCount', maxCount: 3 }, recycledCount: 3 }), liveCat, NOW)).toBe(false);
  });
  it('false when past expiry', () => {
    expect(isPostEligible(post({ recyclePolicy: { mode: 'expiry', expiryDate: '2026-08-01' } }), liveCat, NOW)).toBe(false);
  });
  it('false when min-gap not satisfied', () => {
    expect(isPostEligible(post({ minGapHours: 48, lastPublishedAt: new Date('2026-08-17T00:00:00Z') }), liveCat, NOW)).toBe(false);
  });
});

describe('pickNextPost', () => {
  it('returns null when nothing eligible', () => {
    expect(pickNextPost([post({ status: 'retired' })], liveCat, NOW)).toBeNull();
  });
  it('prefers the least-recently-published post', () => {
    const a = post({ id: 'a', lastPublishedAt: new Date('2026-08-16T00:00:00Z') });
    const b = post({ id: 'b', lastPublishedAt: new Date('2026-08-10T00:00:00Z') }); // older
    expect(pickNextPost([a, b], liveCat, NOW)?.id).toBe('b');
  });
  it('weights a strong performer ahead of a slightly-older weak one', () => {
    const weakOld = post({ id: 'weakOld', lastPublishedAt: new Date('2026-08-10T00:00:00Z'), performanceScore: 0.0 });
    const strongNewer = post({ id: 'strongNewer', lastPublishedAt: new Date('2026-08-11T00:00:00Z'), performanceScore: 1.0 });
    expect(pickNextPost([weakOld, strongNewer], liveCat, NOW)?.id).toBe('strongNewer');
  });
  it('treats null performanceScore as neutral (never excludes on score)', () => {
    const only = post({ id: 'only', performanceScore: null });
    expect(pickNextPost([only], liveCat, NOW)?.id).toBe('only');
  });
});

describe('selectVariation', () => {
  it('uses base caption on the first fire', () => {
    const p = post({ content: { caption: 'BASE' } as any, variations: [{ id: 'v1', caption: 'V1', source: 'ai' }], recycledCount: 0 });
    expect(selectVariation({ ...p, content: { caption: 'BASE' } } as any)).toEqual({ variationId: null, caption: 'BASE' });
  });
  it('cycles to variation 1 on the second fire', () => {
    const p = { content: { caption: 'BASE' }, variations: [{ id: 'v1', caption: 'V1', source: 'ai' }], recycledCount: 1 } as any;
    expect(selectVariation(p)).toEqual({ variationId: 'v1', caption: 'V1' });
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx jest src/campaigns/evergreen-rotation.util.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the util**

Implement the four functions. For `computeNextCategoryFire`, first check `campaign-schedule.util.ts` for an exported `wallClockToUtc`/`zoneOffsetMinutes`; if exported, import and reuse; if not, replicate the exact tz conversion (Intl.DateTimeFormat offset). Scan day-by-day up to 366 days from `after`, for each matching weekday try each time (ascending), skip blackout dates, return the first instant strictly `> after`. Weighting in `pickNextPost`: sort ascending by `lastPublishedAt` (nulls first = highest priority), then compute a priority number = `agePriority × (0.5 + (performanceScore ?? 0.5))` and pick the max; keep it simple and deterministic. Provide clear inline comments.

- [ ] **Step 4: Run to verify pass**

Run: `npx jest src/campaigns/evergreen-rotation.util.spec.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/campaigns/evergreen-rotation.util.ts src/campaigns/evergreen-rotation.util.spec.ts
git commit -m "feat(evergreen): pure rotation util — next-fire, eligibility, picker, variation"
```

---

## Task 3: Evergreen DTOs

**Files:**
- Create: `src/campaigns/dto/evergreen.dto.ts`
- Test: `src/campaigns/dto/evergreen.dto.spec.ts`

**Interfaces:**
- Produces: `CreateEvergreenCampaignDto`, `CreateEvergreenCategoryDto`, `UpdateEvergreenCategoryDto`, `SetCategoryActiveDto`, `CreateEvergreenPostDto`, `UpdateEvergreenPostDto`, `AddVariationDto`, `RecyclePolicyDto`, `CategoryScheduleDto`. Consumed by Task 5 (controller).

- [ ] **Step 1: Write the failing test** (validation behavior)

```ts
// src/campaigns/dto/evergreen.dto.spec.ts
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateEvergreenCategoryDto, CreateEvergreenCampaignDto } from './evergreen.dto';

describe('CreateEvergreenCategoryDto', () => {
  it('accepts a valid category', async () => {
    const dto = plainToInstance(CreateEvergreenCategoryDto, {
      name: 'Tips', color: 'emerald', schedule: { weekdays: [1, 3], times: ['09:00'] }, channelIds: ['12'],
    });
    expect(await validate(dto)).toHaveLength(0);
  });
  it('rejects an empty name', async () => {
    const dto = plainToInstance(CreateEvergreenCategoryDto, {
      name: '', color: 'emerald', schedule: { weekdays: [1], times: ['09:00'] }, channelIds: [],
    });
    expect((await validate(dto)).length).toBeGreaterThan(0);
  });
});

describe('CreateEvergreenCampaignDto', () => {
  it('requires name, startDate, timezone', async () => {
    const dto = plainToInstance(CreateEvergreenCampaignDto, { name: 'X', startDate: '2026-08-20', timezone: 'UTC', channelIds: ['1'] });
    expect(await validate(dto)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify fail** — `npx jest src/campaigns/dto/evergreen.dto.spec.ts` → FAIL (module not found).

- [ ] **Step 3: Implement DTOs** using `class-validator` decorators (`@IsString`, `@IsNotEmpty`, `@IsDateString`, `@IsArray`, `@ValidateNested`, `@Type`, `@IsIn`, `@IsOptional`, `@IsInt`, `@Min`), mirroring the existing `dto/campaigns.dto.ts` style. `CategoryScheduleDto` = `{ weekdays: number[]; times: string[] }`. `RecyclePolicyDto` = `{ mode: 'forever'|'maxCount'|'expiry'; maxCount?; expiryDate? }`. `color` `@IsIn(['emerald','violet','sky','amber','rose','cyan'])`.

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/campaigns/dto/evergreen.dto.ts src/campaigns/dto/evergreen.dto.spec.ts
git commit -m "feat(evergreen): request DTOs"
```

---

## Task 4: EvergreenService — category + pool CRUD (no rotation yet)

**Files:**
- Create: `src/campaigns/evergreen.service.ts`
- Test: `src/campaigns/evergreen.service.spec.ts`

**Interfaces:**
- Consumes: schema (Task 1), DTOs (Task 3), Drizzle `DRIZZLE` provider (inject like `CampaignsService` does — check its constructor for the token), `CampaignsService.assembleCampaign` pattern.
- Produces methods: `createCampaign(workspaceId, userId, dto): Promise<CampaignDto>`; `addCategory / updateCategory / removeCategory / setCategoryActive`; `addPost / updatePost / removePost`; `assembleEvergreen(campaignId)` returning the campaign + `categories[]` (each with `posts[]` + computed `nextRunAt` via Task 2 `computeNextCategoryFire`) + `upNext[]` (next N occurrences, from occurrences table once rotation exists — for now empty array). Return shape must extend the existing `CampaignDto`.

- [ ] **Step 1: Write failing tests** with a fake DB (follow the `buildFakeDb` pattern in `campaigns.service.spec.ts` — a hand-rolled object matching the drizzle query chain used; **the fake's SELECT must return CLONES** `rows.map(r => ({...r}))` to avoid the in-place-mutation trap that masks stale-read bugs). Test: create campaign sets `type='evergreen'`; addCategory persists + returns assembled; addPost defaults `recyclePolicy` to `{mode:'forever'}` when omitted; removeCategory cascades (fake asserts posts deleted); `assembleEvergreen` computes each category's `nextRunAt`.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement `EvergreenService`.** Inject the Drizzle client and (for later) `CampaignPublishingService` + the fire queue (leave rotation methods as stubs marked for Task 6 — do NOT implement fire yet). CRUD writes to the three tables; `assembleEvergreen` reads categories+posts, computes `nextRunAt` per category via `computeNextCategoryFire`, returns `upNext: []` for now.

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit**

```bash
git add src/campaigns/evergreen.service.ts src/campaigns/evergreen.service.spec.ts
git commit -m "feat(evergreen): service — category + pool CRUD + assemble"
```

---

## Task 5: EvergreenController + module wiring (CRUD reachable)

**Files:**
- Create: `src/campaigns/evergreen.controller.ts`
- Modify: `src/campaigns/campaigns.module.ts` (add `EvergreenService`, `EvergreenController`; controller list + providers)
- Test: `src/campaigns/evergreen.controller.spec.ts`

**Interfaces:**
- Consumes: `EvergreenService` (Task 4), DTOs (Task 3), `JwtAuthGuard`, the workspace-scoped route base `campaigns/workspaces/:workspaceId`.
- Produces: routes from spec §5 (create, categories CRUD + active, posts CRUD). Variation/freshness routes are added in their own tasks (8, 9) — leave them out here.

- [ ] **Step 1: Write failing controller test** — mock `EvergreenService`, assert each route delegates with the right args (e.g. `POST /:id/evergreen/categories` calls `service.addCategory(ws, id, dto)`).

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement controller** mirroring `campaigns.controller.ts` (`@Controller('campaigns')`, `@UseGuards(JwtAuthGuard)`, `@Param`, `@Body`, workspace-scoped paths). Register in `campaigns.module.ts` providers + controllers.

- [ ] **Step 4: Run to verify pass** + `nest build` to confirm module wiring compiles.

- [ ] **Step 5: Commit**

```bash
git add src/campaigns/evergreen.controller.ts src/campaigns/evergreen.controller.spec.ts src/campaigns/campaigns.module.ts
git commit -m "feat(evergreen): controller + module wiring (CRUD reachable)"
```

---

## Task 6: Rotation engine — fire + per-fire re-enqueue + processor

**Files:**
- Create: `src/campaigns/processors/evergreen-fire.processor.ts`
- Modify: `src/campaigns/evergreen.service.ts` (implement `fireOccurrence`, `enqueueNextFire`, `armCategory`), `campaigns.module.ts` (register the fire queue + processor)
- Modify: `src/queue/queue.module.ts` (add `EVERGREEN_ROTATION = 'evergreen-rotation'` to `QUEUES`)
- Test: `src/campaigns/evergreen-fire.spec.ts`

**Interfaces:**
- Consumes: `materializeAndEnqueue`, `cancelSlotJob` (from `CampaignPublishingService`), `computeNextCategoryFire`, `pickNextPost`, `selectVariation` (Task 2).
- Produces:
  - `armCategory(category, now): Promise<void>` — compute next fire, insert an `evergreenOccurrences` row (`slot_status='scheduled'`), enqueue a delayed `evergreen-rotation` job `{ occurrenceId }` with deterministic `jobId = evg-<occurrenceId>` and `delay = max(0, nextFire - now)`.
  - `fireOccurrence(occurrenceId): Promise<void>` — load occurrence+category+eligible posts; `pickNextPost`; if null → mark occurrence `skipped`, still `armCategory` next; else `selectVariation`, build `ChannelDayContentJson` with the variation caption, call `materializeAndEnqueue` (scheduledAt=now, carry `destination`), write `postsRowId`/`jobId`, bump post (`recycledCount+1`, `lastPublishedAt=now`), then `armCategory` next. Wrap in try/finally so the next fire is ALWAYS armed even if publish throws (graceful — the chain must not die).
  - The processor's `process(job)` calls `service.fireOccurrence(job.data.occurrenceId)`.

- [ ] **Step 1: Write failing tests** (fake DB + mocked `CampaignPublishingService` + mocked queue). Assert: fire with an eligible post calls `materializeAndEnqueue` with the selected variation caption + destination, bumps the post, and arms the next fire (queue.add called with the next delay). Fire with NO eligible post marks occurrence `skipped` and STILL arms next. Fire where `materializeAndEnqueue` throws still arms next (chain self-heals). `armCategory` with no configured weekday inserts nothing / logs (null next-fire).

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement** the processor + the three service methods. Add `EVERGREEN_ROTATION` queue name; register `BullModule.registerQueue({ name: QUEUES.EVERGREEN_ROTATION })` and the processor in the module. Use deterministic `jobId` for idempotency.

- [ ] **Step 4: Run to verify pass** + `nest build`.

- [ ] **Step 5: Commit**

```bash
git add src/campaigns/processors/evergreen-fire.processor.ts src/campaigns/evergreen.service.ts src/campaigns/evergreen-fire.spec.ts src/campaigns/campaigns.module.ts src/queue/queue.module.ts
git commit -m "feat(evergreen): rotation engine — fire + per-fire re-enqueue + processor"
```

---

## Task 7: Lifecycle branches (launch / pause / resume) + reconcile cron + multi-channel fan-out

**Files:**
- Modify: `src/campaigns/campaigns.service.ts` (branch `launch/pause/resume/assembleCampaign/duplicate` to `EvergreenService` when `type==='evergreen'`)
- Modify: `src/campaigns/evergreen.service.ts` (`launch`, `pause`, `resume`, `reconcile`, **+ multi-channel fan-out in `armCategory`**)
- Create: `src/campaigns/evergreen-reconcile.cron.ts` (one daily `@Cron` that re-arms active categories with no future scheduled occurrence)
- Test: `src/campaigns/evergreen-lifecycle.spec.ts`

**FOLDED-IN FROM TASK 6 REVIEW (multi-channel fan-out):** Task 6 shipped `armCategory` using `category.channelIds[0]` only — a category with N channels silently posts to just the first. Fix here (this is where arm/fire/reconcile design lives together): when a category's fire is due, `armCategory` must insert **one `evergreenOccurrences` row per channelId** in `category.channelIds` (each its own occurrence → own post → own BullMQ job), NOT just the first. `fireOccurrence` already fires a single occurrence's `channelId`, so it needs no change — only `armCategory` fans out, and the reconcile must re-arm ALL channels of a category, not one. Add a test: a category with 2 channelIds arms 2 occurrences (one per channel) at the same fire instant. Keep the single-channel path working. The occurrence's `postIdRef` pick is per-fire-instant (all channels of one fire may share the same picked post, or re-pick per channel — pick shared-per-instant for simplicity + document it).

**Interfaces:**
- Consumes: Task 6 `armCategory`; `cancelSlotJob`.
- Produces: `EvergreenService.launch/pause/resume(workspaceId, id)`; `reconcile()` (idempotent; deterministic jobIds prevent double-fire). `CampaignsService` delegates when evergreen; bulk/drip path untouched (assert this in tests).

- [ ] **Step 1: Write failing tests** — launch arms exactly one fire per active category (≥1 eligible post) and sets status `active`; launch with a category that has 0 eligible posts still launches but that category arms nothing (or arms and later skips — pick one, test it); pause cancels every future scheduled occurrence's job + deletes unpublished posts + status `paused`; resume re-arms; reconcile re-arms a category whose only occurrence is already `published` (dead chain) and is a no-op when a future `scheduled` occurrence exists. Add one test asserting `CampaignsService.launch` for a **bulk** campaign does NOT touch `EvergreenService` (regression guard).

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement.** In `campaigns.service.ts`, add minimal `if (campaign.type === 'evergreen') return this.evergreen.<method>(...)` at the top of each lifecycle method (inject `EvergreenService` — watch for a circular dep: if `EvergreenService` already injects `CampaignsService`, use `forwardRef` or move the shared assemble into a helper; prefer having `EvergreenService` NOT depend on `CampaignsService`). Reconcile cron uses `@Cron(CronExpression.EVERY_DAY_AT_3AM)` scanning active evergreen campaigns.

- [ ] **Step 4: Run to verify pass** + `nest build` (watch the cold-boot circular-dep — a prior effort hit this; verify the app module resolves).

- [ ] **Step 5: Commit**

```bash
git add src/campaigns/campaigns.service.ts src/campaigns/evergreen.service.ts src/campaigns/evergreen-reconcile.cron.ts src/campaigns/evergreen-lifecycle.spec.ts src/campaigns/campaigns.module.ts
git commit -m "feat(evergreen): lifecycle branches + reconcile cron"
```

---

## Task 8: D1 — AI variation generation endpoint

**Files:**
- Modify: `src/campaigns/evergreen.service.ts` (`generateVariations`, `addVariation`, `removeVariation`), `src/campaigns/evergreen.controller.ts` (3 routes), `src/campaigns/campaigns.module.ts` (import `AiModule`/inject `GroqService` + `AiTokenService`)
- Test: `src/campaigns/evergreen-variations.spec.ts`

**Interfaces:**
- Consumes: `GroqService.generateVariations(content, platform, count?)`, `AiTokenService.executeWithTokens(workspaceId, userId, operation, platform, description, fn)` (metering — mirror how `ai.controller.ts` wraps it).
- Produces: `generateVariations(ws, userId, postId, count?)` → appends `{id, caption, source:'ai'}[]`; `addVariation`/`removeVariation`.

- [ ] **Step 1: Write failing tests** — mock `GroqService.generateVariations` → returns `['V1','V2']`; assert service appends two `source:'ai'` variations with unique ids; assert **graceful**: when `generateVariations` throws, the service surfaces a clean error and does NOT corrupt the post (no partial write).

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement** wrapped in `executeWithTokens`; platform derived from the post's first channel platform. Add routes `POST /:id/evergreen/posts/:postId/variations/generate`, `POST .../variations`, `DELETE .../variations/:variationId`.

- [ ] **Step 4: Run to verify pass** + `nest build`.

- [ ] **Step 5: Commit**

```bash
git add src/campaigns/evergreen.service.ts src/campaigns/evergreen.controller.ts src/campaigns/campaigns.module.ts src/campaigns/evergreen-variations.spec.ts
git commit -m "feat(evergreen): D1 AI variation generation"
```

---

## Task 9: D2 performance scoring + D3 freshness guard

**Files:**
- Create: `src/campaigns/evergreen-scoring.service.ts` (performance score task + freshness check)
- Modify: `src/campaigns/evergreen.controller.ts` (add `POST /:id/evergreen/posts/:postId/freshness-check`), `campaigns.module.ts`
- Test: `src/campaigns/evergreen-scoring.spec.ts`

**Interfaces:**
- Consumes: `post_metric_snapshots` reads (mirror `analytics.service` query pattern), `GroqService` (a cheap staleness prompt), the evergreen occurrences→posts link.
- Produces: `recomputeScores(campaignId)` — for each active post, average normalized engagement across its occurrences' snapshots → `performanceScore` in [0,1]; posts with no snapshots stay `null`. `checkFreshness(postId)` — Groq returns `{ isStale, reason }`; write `is_stale`/`stale_reason`; on Groq error return `{isStale:false}` and do NOT flag (graceful). A `@Cron` (weekly) that calls `recomputeScores` for active evergreen campaigns.

- [ ] **Step 1: Write failing tests** — scoring maps snapshot engagement to [0,1] and leaves unsnapshotted posts null; freshness sets flag from a mocked Groq `{isStale:true, reason:'mentions 2025'}`; freshness on Groq throw → `{isStale:false}`, no write. Assert scoring never throws on an empty snapshot set.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement.** Keep scoring off the fire hot-path (separate service/cron). Freshness on-demand via the route + optional cron.

- [ ] **Step 4: Run to verify pass** + `nest build`.

- [ ] **Step 5: Commit**

```bash
git add src/campaigns/evergreen-scoring.service.ts src/campaigns/evergreen.controller.ts src/campaigns/campaigns.module.ts src/campaigns/evergreen-scoring.spec.ts
git commit -m "feat(evergreen): D2 performance scoring + D3 freshness guard"
```

---

## Task 10: Frontend types + API + hooks

**Files:**
- Create: `src/features/campaigns/types/evergreen.ts`, `src/features/campaigns/api/evergreen.api.ts`, `src/features/campaigns/hooks/use-evergreen.ts`, `src/features/campaigns/hooks/use-evergreen-mutations.ts`, `src/features/campaigns/utils/evergreen-colors.ts`
- Test: `src/features/campaigns/utils/evergreen-colors.spec.ts`

**Interfaces:**
- Consumes: the assembled evergreen `Campaign` shape (§5) — mirror BE JSON types in TS.
- Produces: TS types (`EvergreenCategory`, `EvergreenPost`, `EvergreenVariation`, `RecyclePolicy`, `EvergreenOccurrence`, `EvergreenCampaignAssembled` with `categories[]`+`upNext[]`); `evergreenApi` wrappers (mirror `campaigns.api.ts`); React Query hooks (settle-then-invalidate pattern from `use-campaign-event-mutations.ts` — `qc.setQueryData` then `invalidateQueries`); `evergreen-colors.ts` maps a color token → `ACCENT_CLASSES`-style class fragments.

- [ ] **Step 1: Write failing test** for `evergreen-colors.ts` — `colorClasses('emerald')` returns the emerald token fragments; unknown color falls back to emerald.

- [ ] **Step 2: Run to verify fail** — `npx vitest run src/features/campaigns/utils/evergreen-colors.spec.ts`.

- [ ] **Step 3: Implement** types, api, hooks, colors. Types only; no components yet.

- [ ] **Step 4: Run to verify pass** + `tsc -b` (type-check the new API/hooks compile against the query client).

- [ ] **Step 5: Commit**

```bash
git add src/features/campaigns/types/evergreen.ts src/features/campaigns/api/evergreen.api.ts src/features/campaigns/hooks/use-evergreen.ts src/features/campaigns/hooks/use-evergreen-mutations.ts src/features/campaigns/utils/evergreen-colors.ts src/features/campaigns/utils/evergreen-colors.spec.ts
git commit -m "feat(evergreen): FE types, api, hooks, color tokens"
```

---

## Task 11: Frontend builder view — rail + Up-Next + post grid

**Files:**
- Create: `src/features/campaigns/components/evergreen/evergreen-builder-view.tsx`, `category-rail.tsx`, `up-next-strip.tsx`, `post-grid.tsx`, `evergreen-post-card.tsx`, `new-category-dialog.tsx`
- Modify: the campaign builder router/routing to render `EvergreenBuilderView` when `campaign.type === 'evergreen'` (find where the bonzo builder is chosen — likely `campaign-builder-view.tsx` or the route)
- Test: `src/features/campaigns/components/evergreen/up-next-strip.spec.tsx` (+ a smoke render test for the builder)

**Interfaces:**
- Consumes: Task 10 types/hooks; shadcn components (Card, Badge, Button, Dialog, DropdownMenu, Popover, Tabs if needed) — **install via shadcn MCP, don't hand-roll**; `evergreen-colors.ts`.
- Produces: the category-first builder. Thin view file composing rail + strip + grid (Rule 1 — no god-file).

- [ ] **Step 1: Confirm shadcn components** — use the shadcn MCP (`search`/`view`/`get_add_command`) for any primitive not already in `components/ui/`. Do NOT assume names.

- [ ] **Step 2: Write failing test** — `up-next-strip.tsx` renders N upcoming occurrences with category color + time; empty `upNext` → "Add posts to start the rotation" empty state.

- [ ] **Step 3: Run to verify fail.**

- [ ] **Step 4: Implement** the components + wire routing. Each async surface: loading skeleton, empty CTA, error. Card badges: `✎ N variations`, `⚠ stale`, `📈`, `♻︎ N×`. Spacing per CLAUDE.md Rule 3.

- [ ] **Step 5: Run to verify pass** + `tsc -b && vite build`.

- [ ] **Step 6: Commit**

```bash
git add src/features/campaigns/components/evergreen/ src/features/campaigns/components/builder/campaign-builder-view.tsx
git commit -m "feat(evergreen): FE builder view — category rail + up-next + post grid"
```

---

## Task 12: Frontend post editor + activate type-chooser

**Files:**
- Create: `src/features/campaigns/components/evergreen/evergreen-post-editor.tsx`, `variations-panel.tsx`, `recycle-policy-control.tsx`
- Modify: `src/features/campaigns/components/create/new-campaign-type-chooser.tsx` (add `'evergreen'` to `ACTIVE_TYPES`), the create flow to POST `/evergreen` and open the evergreen builder
- Test: `src/features/campaigns/components/evergreen/recycle-policy-control.spec.tsx`

**Interfaces:**
- Consumes: Task 10 hooks (add-post, generate-variations, freshness-check), the existing composer building blocks where the content shape matches.
- Produces: post editor with Variations panel (list + "✨ Generate with AI" spinner-in-button + manual add + remove), Recycle policy control (forever / max N / until date + min-gap), Freshness row ("Check now" → flag + suggestion). Activates the type card.

- [ ] **Step 1: Write failing test** — `recycle-policy-control.tsx`: selecting "max N" reveals a count input and emits `{mode:'maxCount', maxCount}`; "until date" reveals a date input.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement** editor + panels; wire create flow; flip `ACTIVE_TYPES`. AI/freshness buttons show in-button spinners and never block on failure (toast on error).

- [ ] **Step 4: Run to verify pass** + `tsc -b && vite build` + full `npx vitest run` (no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/features/campaigns/components/evergreen/ src/features/campaigns/components/create/new-campaign-type-chooser.tsx
git commit -m "feat(evergreen): FE post editor (variations, policy, freshness) + activate type card"
```

---

## Self-Review

**1. Spec coverage:**
- §3 data model → Task 1. §4 rotation → Tasks 2, 6, 7. §5 API → Tasks 3, 5, 8, 9. §6 FE/UX → Tasks 10, 11, 12. §7 reuse → enforced by Global Constraints + Task 6/7/8 reuse. §8 migrations → Task 1 Step 5 (generate, user applies). §9 testing → every task is TDD. §10 sequencing → task order matches. All covered.

**2. Placeholder scan:** No TBD/TODO. Each code step has real code or a precise, testable description. The one deliberately-deferred item — `upNext: []` in Task 4 — is explicitly called out as filled by Task 6/rotation, not a placeholder.

**3. Type consistency:** `ChannelDayContentJson`, `CampaignSlotStatus`, `CampaignScheduleEvergreenJson` used verbatim from the schema. `computeNextCategoryFire`/`pickNextPost`/`selectVariation` signatures defined in Task 2 and consumed unchanged in Tasks 6/7. `materializeAndEnqueue` input matches the Global Constraints signature. `EvergreenService` method names consistent across Tasks 4→12.

**Known risks flagged for executors:** (a) circular dep between `CampaignsService` and `EvergreenService` (Task 7) — prefer one-directional dependency; a prior effort hit a cold-boot cycle. (b) fake-DB SELECT must clone rows (Task 4) — the in-place-mutation trap masked a real stale-read bug in a prior effort. (c) evergreen fires at `scheduledAt=now`, so the delayed job is effectively immediate — ensure `delay` clamps to `>=0`.
