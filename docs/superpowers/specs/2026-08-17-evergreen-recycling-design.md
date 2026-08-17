# Evergreen Recycling — Design Spec

**Date:** 2026-08-17
**Status:** Draft for review
**Author:** brainstorming session (Claude + user)
**Repos:** `socialmedia-workspace` (NestJS backend), `socialmedia-frontend` (Vite/React frontend)

---

## 1. Summary

Evergreen Recycling is a new campaign **type** that auto-rotates a pool of timeless
posts on a repeating schedule, **forever, until paused** — unlike Bulk (finite date
range) and Drip (finite, bounded by `endDate`). Content is organized into
**categories** (buckets), each with its own posting schedule and its own rotating
queue. When a category's time-slot fires, the engine picks the next-due post from
that category, publishes it (with a fresh AI-generated variation), and returns it to
the back of the queue to be recycled again later.

It is delivered as a **fourth mental model** in the campaigns module, reusing the
existing publish path (BullMQ `post-publishing` queue, `materializeAndEnqueue`,
`PostTarget.destination` for Slack/Discord) but introducing **new persistence and a
new recurring-rotation engine** — because no existing engine re-fires after publish,
and the date-keyed slot model does not fit a dateless rotating pool.

### Four differentiators (all in v1)

| # | Differentiator | Reuse | New work |
|---|----------------|-------|----------|
| D1 | **AI variations** — each recycle publishes a fresh text variation | `GroqService.generateVariations()` already exists | variation storage + rotation-time selection |
| D2 | **Performance-aware recycling** — strong posts recycle more, weak auto-retire | `post_metric_snapshots` + `analytics.service` | a per-post performance score + weighting in the picker |
| D3 | **Freshness / staleness guard** — flag stale posts ("2025…") before recycle | Groq LLM | a staleness check + a `stale` flag on the post |
| D4 | **Messaging channels** — Slack/Discord in the rotation too | `PostTarget.destination` already carries chat destinations | none beyond wiring |

Each differentiator **degrades gracefully**: AI down → publish the base post; no
metrics yet → neutral weighting; staleness check fails → don't block, just don't
flag. The rotation core never depends on any of them succeeding.

---

## 2. Goals & non-goals

### Goals
- A category-based evergreen engine that recycles a post pool indefinitely.
- Distinct, library+queue UX (not the calendar/day-slot builder).
- All four differentiators, each graceful.
- Reuse the campaigns publish path; keep Bulk/Drip byte-for-byte unchanged.
- Messaging (Slack/Discord) channels supported alongside social platforms.

### Non-goals (v1)
- Cross-category rotation balancing / global smart-scheduler beyond per-category schedules.
- A/B testing of variations with automated winner selection (D2 informs, doesn't auto-optimize copy).
- Best-time-to-post AI slot suggestions.
- Two-way sync of edits back into a shared media library (evergreen posts are their own pool; can reference library media but are authored in-place).
- Importing an existing campaign's posts into an evergreen pool (manual add / library pick only).

---

## 3. Core concepts & data model

Evergreen introduces **its own tables** rather than reusing `campaign_days` /
`campaign_slot_content`, because those are keyed on a concrete `date` — evergreen
posts are **dateless** pool members that fire on a repeating schedule. The parent
`campaigns` row is still used (type `'evergreen'`, `status`, `channel_ids`,
`platforms`, `schedule` jsonb) so evergreen shows up in the same list, status
counts, and lifecycle actions.

### 3.1 `campaign_evergreen_categories`

A bucket with its own schedule and rotation cursor.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `campaign_id` | uuid NOT NULL → `campaigns.id` cascade | |
| `name` | varchar(120) NOT NULL | "Tips", "Quotes" |
| `color` | varchar(20) NOT NULL | one of a fixed token set (see §6.4) |
| `schedule` | jsonb NOT NULL `$type<EvergreenCategoryScheduleJson>()` | `{ weekdays: number[]; times: string[] }` — per-category rhythm |
| `channel_ids` | jsonb `$type<string[]>()` NOT NULL default `[]` | which of the campaign's channels this category posts to |
| `seasonal` | jsonb `$type<{ startDate: string; endDate: string } \| null>()` default null | auto activate/deactivate window (D-seasonal) |
| `is_active` | boolean NOT NULL default true | manual on/off, independent of seasonal |
| `rotation_cursor` | integer NOT NULL default 0 | monotonic counter; picker uses it for round-robin fallback |
| `sort_order` | integer NOT NULL default 0 | rail ordering |
| `created_at` / `updated_at` | timestamptz | |

Unique index: `(campaign_id, name)`.

### 3.2 `campaign_evergreen_posts`

A pool member. Belongs to exactly one category.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `campaign_id` | uuid NOT NULL → `campaigns.id` cascade | denormalized for scoping/queries |
| `category_id` | uuid NOT NULL → `campaign_evergreen_categories.id` cascade | |
| `content` | jsonb NOT NULL `$type<ChannelDayContentJson>()` | **reuses the existing slot content shape** — caption, media, poll, threadParts, templateIds, destination, platformSpecific. This is deliberate: the publish path already speaks this shape. |
| `variations` | jsonb NOT NULL `$type<EvergreenVariationJson[]>()` default `[]` | D1 — `{ id; caption; media?: MediaJson[]; source: 'ai' \| 'manual' }[]` |
| `recycle_policy` | jsonb NOT NULL `$type<RecyclePolicyJson>()` | `{ mode: 'forever' \| 'maxCount' \| 'expiry'; maxCount?: number; expiryDate?: string }` (SmarterQueue parity) |
| `min_gap_hours` | integer NOT NULL default 0 | D — "minimum time to recycle": don't re-fire within N hours |
| `recycled_count` | integer NOT NULL default 0 | how many times published |
| `last_published_at` | timestamptz | for min-gap + rotation ordering |
| `performance_score` | real | D2 — nullable; 0–1 computed from snapshots; null = unscored (neutral) |
| `is_stale` | boolean NOT NULL default false | D3 — set by freshness guard |
| `stale_reason` | text | e.g. `mentions "2025"` |
| `status` | varchar(20) NOT NULL default `'active'` `$type<EvergreenPostStatus>()` | `'active' \| 'paused' \| 'retired'` — retired = removed from rotation, kept for history |
| `created_at` / `updated_at` | timestamptz | |

Indexes: `(category_id, status)`, `(campaign_id)`.

`EvergreenPostStatus = ['active','paused','retired']`. A post is **eligible** for a
fire when: `status='active'` AND category `is_active` (and within seasonal window) AND
not expired by `recycle_policy` AND `min_gap_hours` satisfied.

### 3.3 `campaign_evergreen_occurrences`

An append-only log of each fire — the bridge to a real `posts` row, and the record
the rotation driver reads to know "what fired and when."

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `campaign_id` | uuid NOT NULL → `campaigns.id` cascade | |
| `category_id` | uuid NOT NULL → `campaign_evergreen_categories.id` cascade | |
| `post_id_ref` | uuid NOT NULL → `campaign_evergreen_posts.id` cascade | which pool post fired |
| `variation_id` | varchar(64) | which variation was used (null = base) |
| `channel_id` | varchar(255) NOT NULL | |
| `scheduled_at` | timestamptz NOT NULL | the fire instant |
| `slot_status` | varchar(20) NOT NULL default `'scheduled'` `$type<CampaignSlotStatus>()` | **reuses `CAMPAIGN_SLOT_STATUSES`** |
| `posts_row_id` | uuid | link to materialized `posts` row (not FK) |
| `job_id` | varchar(160) | BullMQ job id |
| `published_at` | timestamptz | |
| `last_error` | text | |
| `created_at` | timestamptz | |

Indexes: `(campaign_id, scheduled_at desc)`, `(post_id_ref)`, `(job_id)`.

### 3.4 Reused / unchanged
- `campaigns` row (type `'evergreen'`), `CampaignScheduleEvergreenJson` (already exists: `weekdays`, `times`, `timezone`, `blackoutDates`, `loop`, `startDate`). The **campaign-level** schedule is the default; per-category schedules override which weekdays/times each bucket uses.
- `posts` + `PostTarget` (with `destination`) — the materialized publish artifact.
- `post_metric_snapshots` — read by D2.
- BullMQ `post-publishing` queue + `PostPublishProcessor` — unchanged.

---

## 4. Rotation engine (the genuinely new part)

No existing engine re-fires after publish, so evergreen needs a **recurring driver**.

### 4.1 Approach: per-fire re-enqueue (chosen) vs cron sweep

**Chosen: per-fire re-enqueue.** When an occurrence publishes, the engine immediately
computes the category's **next** fire instant (next matching weekday+time ≥ now, in
tz) and enqueues the next occurrence as a one-shot delayed job — same mechanism the
rest of the campaigns engine already uses (`materializeAndEnqueue` style, one delayed
job per fire, deterministic `jobId`). This keeps evergreen on the **existing
`post-publishing` infrastructure** with zero new queue and no cron service.

- **Why not a cron sweep:** a periodic sweep ("every 5 min, find categories due now")
  introduces a new scheduled worker, double-fire risk on overlap, and clock drift. The
  per-fire chain reuses BullMQ's delay precision and the existing processor.
- **Cost:** the chain must be *self-healing* — if a fire fails or a job is lost, the
  next fire won't be scheduled. Mitigation: **launch enqueues the first fire per
  category**, and a lightweight **reconcile on campaign read/resume** re-arms any
  category whose next occurrence is missing (idempotent via deterministic job id). A
  safety **daily reconcile cron** (one, cheap, workspace-agnostic) re-arms any active
  evergreen category with no future `scheduled` occurrence — belt-and-suspenders
  against a broken chain. This is the one new scheduled job.

### 4.2 The picker (what fires next)

When a category's slot fires, `pickNextPost(categoryId, now)`:
1. Load **eligible** posts (§3.2 eligibility).
2. If none eligible → **skip** this fire (log occurrence `slot_status='skipped'`,
   reason "no eligible posts"), still enqueue the next fire. Never crash, never leave
   the chain dead.
3. Rank eligible posts by a **recycle-priority score**:
   - base: **least-recently-published first** (oldest `last_published_at`, nulls first) — the round-robin heart.
   - D2 weighting: multiply priority by `(0.5 + performance_score)` when `performance_score` is non-null (strong posts surface sooner; weak ones sink). Null score = neutral (`× 1.0`). **Never** excludes a post solely on score — only `recycle_policy`/`status` retire.
4. Pick the top post. Increment `rotation_cursor`.
5. D1: choose a variation — rotate through `variations` by `recycled_count % (variations.length+1)` (0 = base caption, then each variation). Deterministic, so successive recycles visibly differ.
6. D3: if `is_stale`, still publish (staleness never blocks), but the occurrence and the post card surface the flag; the freshness guard runs on a separate cadence (§4.4), not at fire time (keep fire fast).

### 4.3 Fire → publish (reuses existing path)

`fireOccurrence(occurrence)`:
1. Resolve post + chosen variation → build a `ChannelDayContentJson` (caption swapped to the variation).
2. Call the existing **`materializeAndEnqueue`**-equivalent to insert a `posts` row + enqueue `publish-post`. (Evergreen fires *immediately* on its own scheduled instant, so `scheduledAt = now`; the delayed job is effectively immediate.) Carry `destination` for messaging channels (D4).
3. Write `posts_row_id` + `job_id` onto the occurrence.
4. `bumpPost`: `recycled_count += 1`, `last_published_at = now`.
5. **Enqueue the category's next fire** (§4.1) — the recurrence step.
6. Occurrence `slot_status` tracks via the existing `CampaignStatusSyncListener` (published/failed), same as bulk/drip slots.

### 4.4 Freshness guard (D3) & performance scoring (D2) cadence
- **Performance score:** a scheduled job (reuse `channel-snapshots` cadence or a small periodic task) recomputes `performance_score` per evergreen post from its occurrences' `posts` → `post_metric_snapshots` (normalized engagement vs. the pool). Runs off the hot path.
- **Freshness guard:** a low-frequency task (e.g. weekly, or on-demand from the UI "Check freshness" action) runs a cheap Groq check per active post; sets `is_stale`/`stale_reason`. Also offered as a **one-click per-post** action in the UI. Never auto-edits; only flags + suggests.

### 4.5 Lifecycle
- **launch**: validate ≥1 active category with ≥1 eligible post; enqueue first fire per active category; status → `active`.
- **pause**: cancel all future `scheduled` occurrences' jobs (reuse `cancelSlotJob`), delete their not-yet-published `posts` rows; status → `paused`. Pool + categories untouched.
- **resume**: re-arm first fire per active category; status → `active`.
- Evergreen **never auto-completes** (it's forever). `completed` only via explicit archive (future) — v1 has no completed state for evergreen; pausing is the stop.

---

## 5. Backend API (extends campaigns controller, workspace-scoped)

All under `campaigns/workspaces/:workspaceId/...`, `JwtAuthGuard`, return the
assembled `CampaignDto` (or category/post sub-DTOs where noted). New DTOs in
`dto/campaigns.dto.ts` (or a new `dto/evergreen.dto.ts`).

**Create**
- `POST /evergreen` → `CreateEvergreenCampaignDto { name; description?; startDate; timezone; channelIds; blackoutDates?; loop? }` → creates campaign (type evergreen), no categories yet. (`weekdays`/`times` live on categories, not the campaign default — but the campaign schedule keeps a sane default for `computeNextRun` display.)

**Categories**
- `POST /:id/evergreen/categories` → `{ name; color; schedule: { weekdays; times }; channelIds; seasonal? }`
- `PATCH /:id/evergreen/categories/:catId` → partial
- `DELETE /:id/evergreen/categories/:catId` (cascades pool posts; blocked/confirmed if it has posts)
- `PATCH /:id/evergreen/categories/:catId/active` → `{ isActive }`

**Pool posts**
- `POST /:id/evergreen/categories/:catId/posts` → `{ content: ChannelDayContent; recyclePolicy?; minGapHours? }`
- `PATCH /:id/evergreen/posts/:postId` → partial (content, policy, status)
- `DELETE /:id/evergreen/posts/:postId`
- `POST /:id/evergreen/posts/:postId/variations/generate` → D1, calls `GroqService.generateVariations` → appends AI variations
- `POST /:id/evergreen/posts/:postId/variations` → manual add `{ caption; media? }`
- `DELETE /:id/evergreen/posts/:postId/variations/:variationId`
- `POST /:id/evergreen/posts/:postId/freshness-check` → D3 on-demand → `{ isStale; staleReason }`

**Lifecycle**: reuse existing `POST /:id/{launch,pause,resume,duplicate}` (the service branches on `type==='evergreen'`).

**Read**: the assembled `CampaignDto` for an evergreen campaign includes `categories[]`
(each with its posts[] + computed `nextRunAt`) and an `upNext[]` array (the next N
scheduled occurrences across categories, for the Up-Next strip).

---

## 6. Frontend (UX — the distinct part)

New feature surface under `src/features/campaigns/` (same module, evergreen-specific
components). The **type-chooser card already exists** (emerald / Recycle icon /
"loops forever"); flipping it live = adding `'evergreen'` to `ACTIVE_TYPES` in
`new-campaign-type-chooser.tsx` once built.

### 6.1 Layout — Category-first + "Up Next" strip (approved)
A dedicated evergreen builder view (NOT the 3-column day/slot bonzo builder):
- **Top:** "Up Next" rotation strip — the next N occurrences (day/time · category · post preview), the live-autopilot signal that distinguishes evergreen from a calendar.
- **Left rail:** categories (color dot + schedule chip + post count + seasonal badge + active toggle). `＋ New category`.
- **Main:** selected category's post library as a **card grid**. Each card: caption preview + badges — `✎ N variations` (D1), `⚠ stale` (D3), `📈 top 10% / weak` (D2), `♻︎ recycled N×`. `＋ Add post`.

### 6.2 Post editor
Reuse the existing composer/event-composer building blocks where possible (same
`ChannelDayContent` shape). Adds: a **Variations** panel (list + "✨ Generate with AI"
+ manual add), a **Recycle policy** control (forever / max N / until date + min-gap),
and a **Freshness** row ("Check now" → flag + suggestion).

### 6.3 States (per CLAUDE.md Rule 4)
Every async surface: loading (skeleton cards / spinner-in-button), disabled, **empty**
(no categories → "Create your first category" CTA; category with no posts → "Add
evergreen posts" CTA; empty Up-Next → "Add posts to start the rotation"), **error**
(toast + inline). AI generate / freshness-check show in-button spinners and never
block the base flow on failure.

### 6.4 Theming
shadcn tokens only. Category colors from a **fixed token palette** (emerald/violet/
sky/amber/rose/cyan — mapped to `bg-*-500/10` + `text-*-600 dark:text-*-400`, reusing
the `ACCENT_CLASSES` pattern), never arbitrary hex. Evergreen accent stays emerald
(matches the existing type card).

### 6.5 FE data layer
- `types/evergreen.ts` — `EvergreenCategory`, `EvergreenPost`, `EvergreenVariation`, `RecyclePolicy`, `EvergreenOccurrence`, extend `Campaign` assembled shape with `categories`/`upNext`.
- `api/evergreen.api.ts` — typed wrappers for §5 endpoints (mirrors `campaigns.api.ts` style).
- `hooks/` — `use-evergreen-categories`, `use-evergreen-posts`, `use-evergreen-mutations` (React Query v5; settle-then-invalidate pattern already established).

---

## 7. Reuse map (minimizes blast radius → "zero breakage")

| Concern | Reused as-is | New |
|---------|--------------|-----|
| Publish a post | `materializeAndEnqueue`, `buildTargets`, `PostTarget.destination`, `post-publishing` queue, `PostPublishProcessor` | evergreen occurrence → materialize adapter |
| Post→slot status sync | `CampaignStatusSyncListener` (extend to update occurrences by `posts.metadata`) | occurrence metadata tag |
| Timezone / next-fire | `wallClockToUtc`, `zoneOffsetMinutes`, `computeNextRun` (already handles evergreen weekday+times) | `computeNextCategoryFire` (thin) |
| AI variations | `GroqService.generateVariations`, `AiTokenService.executeWithTokens` | wiring only |
| Metrics | `post_metric_snapshots`, `analytics.service` reads | performance-score task |
| Campaign list / status / lifecycle | `CampaignsService.list/getOne/launch/pause/resume/duplicate` | evergreen branches inside these |
| FE type-chooser, accent classes, composer | existing | evergreen builder view + editor panels |

**Bulk/Drip:** untouched. Evergreen branches are additive (`if type==='evergreen'`);
no shared code path is altered in a way that changes bulk/drip behavior. The
`campaign_slot_content` / `campaign_days` tables are **not** used by evergreen, so no
schema change to them.

---

## 8. Migrations
Three new tables (§3.1–3.3) + their indexes + the two new status enums
(`EvergreenPostStatus`). **Additive only** — no ALTER on existing tables. Generated
via `npm run db:generate`; **the user applies** migrations (assistant never runs
`db:*`).

---

## 9. Testing strategy
- **Rotation picker** (`pickNextPost`): unit tests — round-robin ordering, min-gap exclusion, expiry/maxCount retire, empty-eligible → skip-not-crash, D2 weighting monotonicity, D2 null-score neutrality.
- **Recurrence chain**: fire → next-fire enqueued at correct tz instant; failed fire still re-arms; reconcile re-arms a dead chain (idempotent, no double-fire).
- **Variation selection**: successive recycles cycle base→var1→var2→base.
- **Eligibility**: seasonal window, category inactive, post paused/retired.
- **Lifecycle**: launch arms one fire/category; pause cancels + deletes unpublished; resume re-arms.
- **Graceful degradation**: AI down → base caption publishes; no snapshots → neutral score; freshness error → not flagged, not blocked.
- **FE**: category/post/variation hooks; Up-Next rendering; empty/loading/error states; type-chooser activation.
- **Gates**: BE `nest build` + campaigns spec suite green; FE `tsc -b && vite build` + vitest green. Bulk/drip regression tests unchanged and passing.

---

## 10. Sequencing (informs the plan, not the plan itself)
1. Schema + migrations (3 tables, enums) — additive.
2. Categories + pool CRUD (service + controller + DTOs) — no rotation yet.
3. Rotation engine: picker + fire + per-fire re-enqueue + launch/pause/resume branches + reconcile cron.
4. D1 variations (generate + rotate at fire).
5. D4 messaging destinations in fire path (mostly free via `destination`).
6. D2 performance score task + picker weighting.
7. D3 freshness guard task + on-demand + flags.
8. FE: types + api + hooks.
9. FE: evergreen builder view (category rail + Up-Next + post grid).
10. FE: post editor (variations, policy, freshness) + empty/error states.
11. FE: activate type-chooser card.
12. Whole-branch review + build/test gates both repos.

Each of 1–11 is independently testable; 4–7 (differentiators) each degrade
gracefully so a partial merge is never broken.

---

## 11. Open questions resolved during brainstorming
- **Core model:** category-based buckets (not flat pool). ✅
- **v1 scope:** all four differentiators. ✅
- **BE approach:** extend the campaign engine (new tables + branches, reuse publish path). ✅
- **UX:** category-first + Up-Next strip. ✅
- **Recurrence:** per-fire re-enqueue + reconcile (one safety cron), reusing `post-publishing`. ✅ (design decision, not user-facing)
