# Channels vs Integrations Separation — Design

> **Status:** APPROVED 2026-08-06. Supersedes the 2026-07-26 draft. Ready for implementation.
> No live users yet (dev only) — the backfill is written but NOT run.

**Goal:** Stop non-publishing integrations (cloud storage, calendars) from consuming a
workspace's paid channel limit. A user on a 3-channel plan who connects Facebook +
Instagram + Google Drive must still be able to connect Twitter — Drive is an integration,
not a billable channel.

**Approach:** Approach A — categorize + keep the `channels_count` counter but change its
meaning to *billable-only*, backed by a persisted `category` column so the separation is a
real, queryable DB attribute. Functional separation in the service layer and a visible
split in the settings UI.

---

## Problem

Everything a user connects — social publishing accounts, cloud storage, calendars,
messaging apps — is stored in the single `social_media_channels` table, distinguished only
by a `platform` varchar. There is no category concept.

The plan limit is enforced against `workspace_usage.channels_count`, a **denormalized
counter** that `channel.service.ts` blindly increments by 1 on **every** `createChannel`
and decrements on delete, regardless of platform:
- `enforceChannelLimit(workspaceId)` — `channel.service.ts:178` (in createChannel), defined `:1297`
- `incrementChannelCount(workspaceId)` — `channel.service.ts:239` (in createChannel), defined `:1323`
- `decrementChannelCount(workspaceId)` — `channel.service.ts:661` (in deleteChannel), defined `:1336` (floors at 0 via `GREATEST(count-1,0)`)

> Line numbers verified against origin/main 2026-08-06. `deleteChannel` performs a **hard
> delete** (`.delete(socialMediaChannels)`) — there is no `is_active`/soft-delete column.

Consequence: connecting Google Drive, Dropbox, OneDrive, Google Photos, Google Calendar,
or Outlook Calendar eats a paid channel slot. On a 3-channel plan, FB + IG + Drive leaves
no room for Twitter.

`channels_count` is load-bearing across billing — read for limit enforcement, usage
display, the billing dashboard, plan-downgrade validation, and addon-removal validation
(`billing/services/usage.service.ts`, `dashboard.service.ts`, `plan-change.service.ts`,
`addon.service.ts`). That reach is exactly why Approach A wins: change what the counter
*counts* and every reader becomes correct without being touched.

---

## Taxonomy (the billable boundary)

| Category | Platforms | Billable? |
|---|---|---|
| **Social / publishing** | facebook, instagram, youtube, tiktok, pinterest, twitter, linkedin, threads, bluesky, mastodon, google_business, reddit | ✅ counts |
| **Messaging** | slack, telegram, discord, whatsapp | ✅ counts |
| **Cloud storage** | google_drive, google_photos, onedrive, dropbox | ❌ free integration |
| **Calendars** | google_calendar, outlook_calendar | ❌ free integration |

Billable set = **social ∪ messaging**. Integration set = **cloud storage ∪ calendars**.

> The category list must cover **every** member of `SUPPORTED_PLATFORMS`. A unit test is the
> tripwire: adding a new platform without a category fails the build.

### Maestro Bridge — explicit future carve-out (NOT in this effort)

Messaging connections that exist **only to talk to Maestro** (WhatsApp + Telegram today,
Slack future) are a separate concept and must not count as billable. They get their own
addon later. Today the bridge uses a central bot and creates no `social_media_channels`
rows, so it is already outside this counter. Rule to preserve: if a bridge connection ever
becomes a per-workspace row, it is billed under the Maestro addon, never the channel limit.
Out of scope here.

---

## Chosen architecture

### 1. Single source of truth — category constant

Defined once in the backend schema module next to `SUPPORTED_PLATFORMS`
(`src/drizzle/schema/channels.schema.ts`), mirrored in the frontend platform catalog.

```ts
export const CHANNEL_CATEGORY: Record<SupportedPlatform, 'social' | 'messaging' | 'integration'> = {
  facebook: 'social', instagram: 'social', youtube: 'social', tiktok: 'social',
  pinterest: 'social', twitter: 'social', linkedin: 'social', threads: 'social',
  bluesky: 'social', mastodon: 'social', google_business: 'social', reddit: 'social',
  slack: 'messaging', telegram: 'messaging', discord: 'messaging', whatsapp: 'messaging',
  google_drive: 'integration', google_photos: 'integration',
  onedrive: 'integration', dropbox: 'integration',
  google_calendar: 'integration', outlook_calendar: 'integration',
}

export function isBillablePlatform(p: SupportedPlatform): boolean {
  return CHANNEL_CATEGORY[p] !== 'integration'
}
```

### 2. DB-level separation — `category` column

Add a persisted `category` column to `social_media_channels` (`social` | `messaging` |
`integration`), populated from `CHANNEL_CATEGORY` at insert time. First-class, queryable
attribute — clean reporting and a seam for the future Maestro addon.

- **Considered and rejected:** a separate `integrations` table — would force rewrites of
  every query touching `social_media_channels` (analytics, inbox, composer, token refresh,
  schedulers). Over-kill. A category column achieves DB-level separation at a fraction of
  the blast radius.
- The constant *populates* the column on write, so they cannot drift.

> Drizzle migration required. Per repo rules the assistant does **not** run
> `db:generate` / `db:push` — the migration is authored in the plan and **the user runs it**.

### 3. Functional separation — guard the counter by category

In `channel.service.ts`:
- `createChannel`: call `enforceChannelLimit` and `incrementChannelCount` **only when
  `isBillablePlatform(dto.platform)`**. Integrations skip both — connecting an integration
  never checks or consumes the limit, even when the workspace is at its billable limit.
- `deleteChannel`: call `decrementChannelCount` **only when the deleted row was billable**
  (read the row's platform/category before delete).

Every existing `channels_count` reader (billing, dashboard, plan-change, addon) is left
untouched; the counter now means "billable channels" everywhere.

### 4. Backfill — recompute function, written but NOT run

There are **no live users** (dev only), so no counters need fixing today. Still, ship an
**idempotent recompute function** so production is safe when it arrives. It is NOT wired to
run automatically and the assistant does NOT execute it against any DB.

```sql
-- Recompute billable channel counts for all workspaces (idempotent).
UPDATE workspace_usage wu
SET channels_count = COALESCE(sub.cnt, 0), updated_at = now()
FROM (SELECT workspace_id FROM workspace_usage) all_ws
LEFT JOIN (
  SELECT workspace_id, count(*) AS cnt
  FROM social_media_channels
  WHERE category <> 'integration'
  GROUP BY workspace_id
) sub ON sub.workspace_id = all_ws.workspace_id
WHERE wu.workspace_id = all_ws.workspace_id;
```

> Note vs the 2026-07-26 draft: the old backfill filtered `is_active = true`. There is **no
> `is_active` column** — deletes are hard deletes — so that condition is dropped. Workspaces
> with zero billable channels are handled by the `LEFT JOIN` → `COALESCE(...,0)`.

Delivered as a reusable function (e.g. an admin-guarded endpoint or one-shot script). The
user triggers it if/when there is real data to correct.

### 5. Frontend — visible separation

Industry-standard pattern (Buffer/Hootsuite/Zapier-style): channels and integrations are
distinct concepts shown as **two clearly-separated sections on one settings page**, not a
single mixed list and not two separate nav pages (the integration list is small — 6 items).

**Most of the frontend split already exists** (built in an earlier session). Verified on
the frontend `main` 2026-08-06:
- `src/features/onboarding/constants.ts` has `MESSAGING_PLATFORMS`, `CLOUD_STORAGE_PLATFORMS`,
  `CALENDAR_PLATFORMS`, and `isComposablePlatform()` (`:199-205`).
- `src/features/channels/components/connected-channels-list.tsx` ALREADY splits connected
  rows into `publishing` vs `integrations` (`isIntegration()` = cloud ∪ calendar, `:82-86`,
  `:124-132`) and renders a separate **"Integrations"** section with its own heading +
  description (`:140-151`).
- `isComposablePlatform()` already excludes cloud storage, calendars, AND messaging from
  composable targets, so the **composer/posts publishing filter is already correct** — no
  change needed there.

So the remaining frontend work is small and cosmetic:
- Add a **"Free — doesn't count toward your channel limit"** hint to the Integrations
  section header (the section exists; it just doesn't say it's free).
- Confirm the usage indicator (`X / limit`) reflects the backend's now-corrected
  `channels_count` — this is automatic once the backend counts billable-only; frontend
  renders whatever the API returns, so **no frontend logic change** beyond the copy hint.
- (Optional, low value) add an `INTEGRATION_PLATFORMS` alias set so `isIntegration()` reads
  from one named set instead of unioning two — pure tidy-up, skip if not worth a task.

**The real work is BACKEND** — the counter still increments for every platform. That is what
this effort fixes.

---

## Out of scope

- Maestro Bridge addon/package and its billing (future, separate effort).
- Running the backfill (no live users) — the function ships unused.
- Live recompute-on-read / Approach B live-count (YAGNI, billing-risk).
- Any change to plan limits, prices, or the number of channels a plan grants.

## Testing notes

- Unit: `isBillablePlatform` / `CHANNEL_CATEGORY` covers every `SUPPORTED_PLATFORMS` member
  (tripwire: a new platform with no category fails the test).
- `createChannel`: integration connect does NOT call `enforceChannelLimit` or increment;
  billable connect does both. An at-limit workspace can still connect an integration.
- `deleteChannel`: decrement only for billable rows; deleting an integration leaves the
  counter unchanged.
- `category` column is populated correctly on insert for one platform of each category.
- Recompute function is idempotent (running twice yields the same counts).
- Full-stack consistency: frontend `CHANNEL_CATEGORY` mirror matches backend exactly.

## Branching

New effort → its own branch off `main` on **both** repos:
- Backend: `feat/channels-integrations-separation` (schema/service/billing).
- Frontend: matching branch (settings grouping + catalog mirror).
