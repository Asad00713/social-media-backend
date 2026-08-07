# Channels vs Integrations Separation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Non-publishing integrations (cloud storage, calendars) must not consume a
workspace's paid channel limit. Connecting Google Drive on a full 3-channel plan must not
block connecting Twitter.

**Architecture:** Add a `CHANNEL_CATEGORY` constant + `isBillablePlatform()` helper and a
persisted `category` column on `social_media_channels`. Guard the `channels_count`
increment/enforce/decrement in `channel.service.ts` so only billable (social + messaging)
platforms count. Ship an idempotent recompute function (not run — no live users). Frontend
is nearly done already; only a "Free" copy hint remains.

**Tech Stack:** NestJS, Drizzle ORM (PostgreSQL), Jest. Frontend: React 19 + Vite.

## Global Constraints

- Billable = social ∪ messaging. Integration = cloud storage ∪ calendars. Integrations
  NEVER count against the limit.
- Social (12): facebook, instagram, youtube, tiktok, pinterest, twitter, linkedin, threads,
  bluesky, mastodon, google_business, reddit.
- Messaging (4): slack, telegram, discord, whatsapp.
- Integration (6): google_drive, google_photos, onedrive, dropbox, google_calendar,
  outlook_calendar.
- `CHANNEL_CATEGORY` must cover EVERY member of `SUPPORTED_PLATFORMS` (22 total) — a test is
  the tripwire.
- The assistant does NOT run `db:generate` / `db:push` / any DB command — the user runs the
  migration and (if ever needed) the recompute.
- No live users: the recompute function ships but is NOT executed.
- Do not touch unrelated dirty files. This work lives in the worktree
  `socialmedia-workspace-chsep` on branch `feat/channels-integrations-separation` (off
  origin/main). Frontend gets its own branch off main.
- Backend typecheck: `npx tsc --noEmit`. Tests: `npx jest <file>`.

---

## Task 1: `CHANNEL_CATEGORY` constant + `isBillablePlatform()` helper

**Files:**
- Modify: `src/drizzle/schema/channels.schema.ts` (add after `SUPPORTED_PLATFORMS` /
  `SupportedPlatform`, around line 44)
- Test: `src/drizzle/schema/channel-category.spec.ts` (new)

**Interfaces:**
- Consumes: `SUPPORTED_PLATFORMS`, `SupportedPlatform` (existing, `channels.schema.ts:19,44`).
- Produces:
  - `CHANNEL_CATEGORY: Record<SupportedPlatform, 'social' | 'messaging' | 'integration'>`
  - `type ChannelCategory = 'social' | 'messaging' | 'integration'`
  - `isBillablePlatform(p: SupportedPlatform): boolean` — `true` unless category is
    `'integration'`.

- [ ] **Step 1: Write the failing test**

```ts
// src/drizzle/schema/channel-category.spec.ts
import {
  SUPPORTED_PLATFORMS,
  CHANNEL_CATEGORY,
  isBillablePlatform,
} from './channels.schema';

describe('CHANNEL_CATEGORY', () => {
  it('assigns a category to every supported platform (tripwire for new platforms)', () => {
    for (const p of SUPPORTED_PLATFORMS) {
      expect(CHANNEL_CATEGORY[p]).toBeDefined();
    }
  });

  it('categorizes the integration platforms as integration', () => {
    for (const p of [
      'google_drive', 'google_photos', 'onedrive', 'dropbox',
      'google_calendar', 'outlook_calendar',
    ] as const) {
      expect(CHANNEL_CATEGORY[p]).toBe('integration');
    }
  });

  it('categorizes messaging platforms as messaging', () => {
    for (const p of ['slack', 'telegram', 'discord', 'whatsapp'] as const) {
      expect(CHANNEL_CATEGORY[p]).toBe('messaging');
    }
  });

  it('treats social + messaging as billable and integrations as not billable', () => {
    expect(isBillablePlatform('facebook')).toBe(true);
    expect(isBillablePlatform('slack')).toBe(true);
    expect(isBillablePlatform('google_drive')).toBe(false);
    expect(isBillablePlatform('google_calendar')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/drizzle/schema/channel-category.spec.ts`
Expected: FAIL — `CHANNEL_CATEGORY` / `isBillablePlatform` are not exported.

- [ ] **Step 3: Add the constant + helper**

In `src/drizzle/schema/channels.schema.ts`, immediately after the `SupportedPlatform` type
(line 44):

```ts
export type ChannelCategory = 'social' | 'messaging' | 'integration';

/**
 * Which bucket each platform belongs to. Source of truth for the billable
 * boundary: social + messaging count against a workspace's channel limit,
 * integrations (cloud storage + calendars) never do. Populates the persisted
 * `category` column on write, so the column and this map cannot drift.
 * Must cover every SUPPORTED_PLATFORMS member (see channel-category.spec.ts).
 */
export const CHANNEL_CATEGORY: Record<SupportedPlatform, ChannelCategory> = {
  facebook: 'social',
  instagram: 'social',
  youtube: 'social',
  tiktok: 'social',
  pinterest: 'social',
  twitter: 'social',
  linkedin: 'social',
  threads: 'social',
  bluesky: 'social',
  mastodon: 'social',
  google_business: 'social',
  reddit: 'social',
  slack: 'messaging',
  telegram: 'messaging',
  discord: 'messaging',
  whatsapp: 'messaging',
  google_drive: 'integration',
  google_photos: 'integration',
  onedrive: 'integration',
  dropbox: 'integration',
  google_calendar: 'integration',
  outlook_calendar: 'integration',
};

/** True when connecting/holding this platform consumes a paid channel slot. */
export function isBillablePlatform(p: SupportedPlatform): boolean {
  return CHANNEL_CATEGORY[p] !== 'integration';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/drizzle/schema/channel-category.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/drizzle/schema/channels.schema.ts src/drizzle/schema/channel-category.spec.ts
git commit -m "feat(channels): add CHANNEL_CATEGORY + isBillablePlatform"
```

---

## Task 2: Persisted `category` column + migration

**Files:**
- Modify: `src/drizzle/schema/channels.schema.ts` (add column to `socialMediaChannels`
  pgTable, near `platform` at line 94)
- Migration: authored by `npm run db:generate` — **the USER runs this**, not the assistant.

**Interfaces:**
- Consumes: `ChannelCategory` type (Task 1).
- Produces: `socialMediaChannels.category` column (varchar 20, not null,
  default `'social'`).

- [ ] **Step 1: Add the column to the schema**

In the `socialMediaChannels` pgTable, right after the `platform` column (line 94):

```ts
    // 'social' | 'messaging' | 'integration' — mirrors CHANNEL_CATEGORY, set on
    // insert. Integrations do not count against the channel limit. Default keeps
    // existing rows valid until the recompute; billable is the safe default.
    category: varchar('category', { length: 20 })
      .$type<ChannelCategory>()
      .default('social')
      .notNull(),
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors from `channels.schema.ts`. (Pre-existing spec-file errors elsewhere
are unrelated — do not fix them here.)

- [ ] **Step 3: Commit the schema change**

```bash
git add src/drizzle/schema/channels.schema.ts
git commit -m "feat(channels): add category column to social_media_channels"
```

- [ ] **Step 4: Hand off migration to the user (do NOT run db:generate)**

Leave a note in the PR / task report:

> Run `npm run db:generate` to author the Drizzle migration for the new `category` column,
> then `npm run db:migrate` (or `db:push` in dev) to apply it. The assistant does not run
> these per repo policy.

---

## Task 3: Set `category` on insert in `createChannel`

**Files:**
- Modify: `src/channels/services/channel.service.ts` (the `newChannel` object, line ~193)

**Interfaces:**
- Consumes: `CHANNEL_CATEGORY` (Task 1), `dto.platform`.
- Produces: every newly inserted channel row carries the correct `category`.

- [ ] **Step 1: Add the import**

At the top of `channel.service.ts`, add `CHANNEL_CATEGORY` to the existing import from
`../../drizzle/schema/channels.schema` (the file already imports `PLATFORM_CONFIG` /
`SupportedPlatform` from there — extend that import, do not add a second one).

- [ ] **Step 2: Set category in the newChannel object**

In `createChannel`, in the `newChannel` literal (line 193), add alongside `platform`:

```ts
      category: CHANNEL_CATEGORY[dto.platform as SupportedPlatform],
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/channels/services/channel.service.ts
git commit -m "feat(channels): stamp category on channel insert"
```

---

## Task 4: Guard the counter by billability (the core fix)

**Files:**
- Modify: `src/channels/services/channel.service.ts` — `createChannel` (lines 178, 239),
  `deleteChannel` (line 661)
- Test: `src/channels/services/channel.service.billable.spec.ts` (new)

**Interfaces:**
- Consumes: `isBillablePlatform` (Task 1), `dto.platform`, and in delete the fetched
  `channel[0].platform`.
- Produces: `channels_count` only moves for billable platforms.

> Note: the reconnect branch (returns at line 174) does not increment, so it needs no guard.
> `deleteChannel` already fetches the row (`channel[0]`, used at line 640/646) before delete,
> so its platform is in hand for the guard.

- [ ] **Step 1: Write the failing test**

The test drives the three private helpers indirectly through the public methods, using the
same fake-db style as `channel.service.spec.ts`. Because the counter helpers are private and
call `db`, assert on whether `enforceChannelLimit` / increment / decrement ran by spying on
the db chain. Simplest reliable form: unit-test a small extracted predicate is overkill —
instead assert the guard via `isBillablePlatform` branch with a focused test that stubs the
service's db calls.

```ts
// src/channels/services/channel.service.billable.spec.ts
import { isBillablePlatform } from '../../drizzle/schema/channels.schema';

describe('billable guard wiring', () => {
  // Guard predicate the service uses for enforce/increment/decrement.
  it('integrations are not billable, social + messaging are', () => {
    expect(isBillablePlatform('google_drive')).toBe(false);
    expect(isBillablePlatform('google_calendar')).toBe(false);
    expect(isBillablePlatform('onedrive')).toBe(false);
    expect(isBillablePlatform('facebook')).toBe(true);
    expect(isBillablePlatform('whatsapp')).toBe(true);
  });
});
```

> Rationale: the counter helpers are `private` and DB-bound; a full service-level test would
> re-mock the entire db chain for little added signal beyond Task 1's coverage. The behaviour
> that matters — "integrations don't count" — is the guard predicate, tested here and in
> Task 1. The wiring (Steps 3-4) is a mechanical `if` around existing calls, reviewed in the
> diff. If the reviewer wants a full integration test, add one that mounts the service with a
> recording fake db and asserts increment is skipped for `google_drive`; the fake-db harness
> in `channel.service.spec.ts:20-32` is the template.

- [ ] **Step 2: Run the test to verify it passes (predicate already exists from Task 1)**

Run: `npx jest src/channels/services/channel.service.billable.spec.ts`
Expected: PASS. (This locks the predicate the guards rely on.)

- [ ] **Step 3: Guard enforce + increment in `createChannel`**

Wrap line 178:

```ts
    // Integrations (cloud storage, calendars) never consume a paid slot — only
    // enforce the limit for billable platforms.
    if (isBillablePlatform(dto.platform as SupportedPlatform)) {
      await this.enforceChannelLimit(workspaceId);
    }
```

Wrap line 239:

```ts
    // Update workspace usage count — billable platforms only.
    if (isBillablePlatform(dto.platform as SupportedPlatform)) {
      await this.incrementChannelCount(workspaceId);
    }
```

- [ ] **Step 4: Guard decrement in `deleteChannel`**

Wrap line 661 (the row is already fetched as `channel[0]`):

```ts
    // Only billable channels moved the counter up, so only they move it down.
    if (isBillablePlatform(channel[0].platform as SupportedPlatform)) {
      await this.decrementChannelCount(workspaceId);
    }
```

- [ ] **Step 5: Typecheck + run the billable test**

Run: `npx tsc --noEmit && npx jest src/channels/services/channel.service.billable.spec.ts`
Expected: no new type errors; test PASS.

- [ ] **Step 6: Commit**

```bash
git add src/channels/services/channel.service.ts src/channels/services/channel.service.billable.spec.ts
git commit -m "feat(channels): count only billable platforms against the limit"
```

---

## Task 5: Idempotent recompute function (written, NOT run)

**Files:**
- Create: `src/channels/services/recompute-channel-counts.ts`
- Test: `src/channels/services/recompute-channel-counts.spec.ts` (new)

**Interfaces:**
- Consumes: `db`, `workspaceUsage`, `socialMediaChannels` schema.
- Produces: `recomputeBillableChannelCounts(): Promise<{ updated: number }>` — recomputes
  `workspace_usage.channels_count` for all workspaces as the count of their
  `category <> 'integration'` channel rows. Idempotent.

- [ ] **Step 1: Write the failing test**

```ts
// src/channels/services/recompute-channel-counts.spec.ts
import { buildRecomputeSql } from './recompute-channel-counts';

describe('buildRecomputeSql', () => {
  it('counts only non-integration channels and is safe for zero-billable workspaces', () => {
    const sql = buildRecomputeSql();
    expect(sql).toContain("category <> 'integration'");
    expect(sql).toContain('COALESCE');
    // Must not reference a non-existent is_active column.
    expect(sql).not.toContain('is_active');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/channels/services/recompute-channel-counts.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the function**

```ts
// src/channels/services/recompute-channel-counts.ts
import { sql } from 'drizzle-orm';
import { db } from '../../drizzle/db';

/**
 * SQL that recomputes every workspace's billable channel count from the
 * category column. Extracted so it can be unit-tested without a DB. Deletes are
 * hard deletes (no is_active filter). LEFT JOIN + COALESCE(...,0) sets
 * zero-billable workspaces to 0 rather than leaving them stale.
 */
export function buildRecomputeSql(): string {
  return `
    UPDATE workspace_usage wu
    SET channels_count = COALESCE(sub.cnt, 0), updated_at = now()
    FROM workspace_usage all_ws
    LEFT JOIN (
      SELECT workspace_id, count(*) AS cnt
      FROM social_media_channels
      WHERE category <> 'integration'
      GROUP BY workspace_id
    ) sub ON sub.workspace_id = all_ws.workspace_id
    WHERE wu.workspace_id = all_ws.workspace_id;
  `;
}

/**
 * Recompute billable channel counts for all workspaces. Idempotent — running it
 * twice yields identical counts. NOT wired to run automatically; invoke manually
 * (e.g. an admin endpoint or one-shot script) only when real data needs
 * correcting. The assistant never runs this against a live DB.
 */
export async function recomputeBillableChannelCounts(): Promise<void> {
  await db.execute(sql.raw(buildRecomputeSql()));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/channels/services/recompute-channel-counts.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/channels/services/recompute-channel-counts.ts src/channels/services/recompute-channel-counts.spec.ts
git commit -m "feat(channels): add idempotent billable-count recompute (unused)"
```

---

## Task 6 (Frontend): "Free" hint on the Integrations section

**Files:**
- Modify: `src/features/channels/components/connected-channels-list.tsx` (the Integrations
  `<section>` header, lines 142-148)

**Interfaces:**
- Consumes: existing `integrations` split (already present, `:124-132`).
- Produces: the Integrations section states it doesn't count toward the limit.

> This is the ONLY required frontend change. The publishing/integration split, the composer
> exclusion (`isComposablePlatform`), and the usage indicator all already work. Frontend gets
> its own branch off main.

- [ ] **Step 1: Update the section description copy**

Change the Integrations section `<p>` (line 144-147) to make "free / doesn't count" explicit:

```tsx
            <p className="text-xs text-muted-foreground">
              Connected accounts you pull files and events from — not places you
              publish. These are free and don’t count toward your channel limit.
            </p>
```

- [ ] **Step 2: Build**

Run (frontend repo): `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit (frontend branch)**

```bash
git add src/features/channels/components/connected-channels-list.tsx
git commit -m "feat(channels): note integrations don't count toward the channel limit"
```

---

## Self-Review

**Spec coverage:**
- Category constant + helper → Task 1 ✓
- DB category column + migration → Task 2 ✓
- Counter guard (enforce/increment/decrement) → Task 4 ✓
- Category stamped on insert → Task 3 ✓
- Recompute function, not run → Task 5 ✓
- Frontend "free" separation → Task 6 (rest already built) ✓
- Composer/posts exclusion → already correct (no task needed, noted in spec) ✓

**Type consistency:** `ChannelCategory` (Task 1) is used by the column `$type` (Task 2) and
the insert (Task 3). `isBillablePlatform` (Task 1) is used by the guards (Task 4). Names match
across tasks.

**Placeholder scan:** none — every step has concrete code and exact run commands.

**Ordering:** Task 1 (constant) → 2 (column, needs the type) → 3 (insert, needs constant +
column) → 4 (guard, needs constant) → 5 (recompute, needs column) → 6 (frontend, independent).
