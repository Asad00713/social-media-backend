# Drip Campaign Type — Design

**Date:** 2026-08-14
**Repos:** `socialmedia-workspace` (backend, primary) + `socialmedia-frontend` (frontend, follow-up)
**Status:** Spec — ready for implementation plan
**Related:** Campaigns Phase 1/2 (bulk), `[[project_campaigns_backend_phase1]]`, `[[project_campaigns_phase2_frontend]]`

## Goal

Make the **Drip** campaign type work create→publish, reusing the bulk
campaign's existing builder / launch / publish path as much as possible. A drip
campaign fires on a recurring **weekday + time** cadence (e.g. Mon/Wed/Fri at
9:00 and 17:00) between a start and end date, up to an optional post cap — the
industry-standard queue model (Buffer/Hootsuite: each time-slot is its own
post).

## What already exists (verified, file:line)

- **Schema types are defined** — `CampaignScheduleDripJson` (`campaigns.schema.ts:57-66`):
  `{ type:'drip', startDate, endDate: string|null, weekdays: number[], times: string[], timezone, blackoutDates, maxPostCount? }`. `CAMPAIGN_TYPES` includes `'drip'` (`:18`).
- **`computeNextRun` handles drip** — `scanWeekdayWindow` (`campaigns.service.ts:243-257,292-331`) already walks weekdays+times for display. **This is what the earlier manual test exercised** — create + next-run work.
- **The gaps:**
  1. **No `CreateDripCampaignDto`** — the only create DTO/endpoint is
     `CreateSimpleCampaignDto` → `createSimple()` which hardcodes `type:'bulk'`
     (`campaigns.service.ts:614-615`, `campaigns.controller.ts:68-76`).
  2. **`computeSlotSchedule` skips drip** — the *publishing* scheduler treats
     anything `!== 'bulk'` as "nothing-due" (`campaign-schedule.util.ts:73-76`).
     So a drip would never materialize/publish real posts.
  3. **Slot model is single-time** — `campaign_slot_content` unique key is
     `(campaignId, date, channelId)` (`campaigns.schema.ts:207-210`): one slot per
     day+channel, one implicit time. Drip needs **multiple times per day**.
  4. **Frontend day-derivation ignores weekdays** — `campaignDaySummaries` →
     `enumerateWindow(start,end)` + `isSchedulable` only honours `bulk &&
     skipWeekends` (`campaign-days.ts:19-24`, `campaign-dates.ts:36`); a drip would
     wrongly show *every* day, not just its weekdays.

## Settled decisions

1. **Backend-first** (CLAUDE.md Rule #1). Frontend create-form + builder tweaks
   are a **follow-up turn** after the backend is green.
2. **Create-time materialize.** On drip create, the backend enumerates every
   concrete `(date)` in `[start,end]` whose weekday ∈ `weekdays` (respecting
   `blackoutDates`, capped by `maxPostCount`), and creates the `campaign_days`
   rows up front. After that a drip campaign is shaped like a bulk one
   (concrete dates + slots), so builder/launch/publish reuse the bulk path.
3. **`endDate` REQUIRED (v1).** Finite date range → finite materialization. No
   rolling/BullMQ generation job in v1 (that's the only way an open-ended drip
   could work; deferred).
4. **Content = bulk-style.** Slots are created empty; the user fills each slot's
   content in the existing builder. No content pool / recycling (that's evergreen).
5. **Multi-time = true multi-slot (Buffer model).** Each `(date, channel, time)`
   is its own slot, its own content, its own post. Requires adding a `time`
   dimension to `campaign_slot_content`. This is the correct model — "one slot,
   same content at every time" was explicitly rejected as spammy/wrong.
6. **Bulk stays byte-for-byte unchanged.** The shared slot model gains an
   optional/defaulted `time`; bulk slots use the schedule's single `defaultTime`
   as their time, so bulk's `(date,channel)` becomes `(date,channel,defaultTime)`
   with no behavioural change. Every existing bulk test must still pass.
7. **Create dialog = type-switch.** Frontend reuses one create dialog with a
   Simple/Drip selector (follow-up turn).

## Architecture

### Layer 1 — Schema + migration (backend)

`campaign_slot_content` gains a **`time`** column (`varchar(5)`, `HH:mm`,
NOT NULL). The unique index changes:

- **From:** `campaign_slot_content_campaign_date_channel_uq (campaignId, date, channelId)`
- **To:** `campaign_slot_content_campaign_date_channel_time_uq (campaignId, date, channelId, time)`

**Backfill:** existing bulk slots get `time = <their campaign's schedule.defaultTime>`
(a data migration reading each slot's campaign). New index created after backfill.

`ChannelDayContentJson` is unchanged (content shape is per-slot regardless of time).

> **Migration hazard (from `[[project_campaigns_backend_phase1]]`):** the campaigns
> tables were applied to prod via hand-run SQL, and a migration file was
> deliberately *not* committed. This change MUST ship an idempotent SQL script
> (add column NULLable → backfill → set NOT NULL → swap unique index) that the
> user applies to local + Railway prod, mirroring that workflow. The plan writes
> the SQL; the assistant runs no `db:*` commands.

### Layer 2 — Backend service + DTO + publishing

- **`CreateDripCampaignDto`** — `name`, `description?`, `startDate`, `endDate`
  (required), `timezone`, `weekdays: number[]` (0–6, non-empty, each 0..6),
  `times: string[]` (non-empty, each `HH:mm`), `maxPostCount?` (positive int),
  `blackoutDates?: string[]`.
- **`createDrip(workspaceId, userId, dto)`** — insert campaign `type:'drip'` +
  drip schedule JSON; then enumerate materialization dates and insert
  `campaign_days` rows. (Does NOT pre-create slot-content rows — matching
  `createSimple`, which also starts with zero slots; the builder's `addEvent`
  creates slots. **But** `addEvent` must now carry a `time`, see below.)
- **`addEvent` / `updateEvent` / `removeEvent`** — gain a `time` field so the
  builder can add a slot for a specific (date, channel, time). For bulk callers
  that omit `time`, default it to the schedule's `defaultTime` — preserving the
  current bulk contract.
- **`collectPublishableSlots`** — already selects by campaign; now each row also
  carries `time`. The publishable filter is unchanged.
- **`computeSlotSchedule` drip branch** — replace the `!== 'bulk'` early-out
  with a real drip computation: for each due slot, `scheduledAt` = that slot's
  `(date, time)` in the schedule timezone (reuse `wallClockToUtc`). Bulk path
  unchanged. **The scheduler now keys on the slot's own `time`, not a single
  per-day time** — so multi-time works naturally per slot.
- **`launch` / `resume`** — already iterate `publishable` slots and call
  `computeSlotSchedule` per date. Adjust to pass/consume `time` so the correct
  `scheduledAt` is chosen per slot (not per date). One post per slot, as today.
- **New route** — `POST /campaigns/workspaces/:workspaceId/drip` → `createDrip`.
- **Tests** — `campaign-schedule.util.spec.ts`: drip due/past-due/timezone/
  multi-time cases. `campaigns.service.spec.ts`: createDrip materializes the
  right dates, respects weekdays/blackout/maxPostCount, and bulk is unaffected.

### Layer 3 — Frontend (follow-up turn, separate branch)

- **`isSchedulable` / day-derivation** — honour drip `weekdays` (and drip
  `blackoutDates`) so the builder shows only the campaign's real days.
- **Multi-slot in the builder** — a day can now hold multiple slots per channel
  (one per time). The Days column + day editor render/manage `(channel, time)`
  slots. (This is the largest FE change; detailed in the FE plan.)
- **Drip create dialog** — Simple/Drip type-switch: weekdays picker + times
  editor + start/end dates + optional max post count. Zod schema + `createDrip`
  API + hook.
- **Calendar spans** — already campaign-level (one bar per campaign, not per
  slot) via `[[project_calendar_campaign_spans]]`, so spans need no change; only
  verify the per-day chip count reflects multi-slot days.

## Error / edge / loading states

- **weekdays or times empty** → DTO validation rejects (422).
- **endDate < startDate** → reject.
- **No weekday in range falls on a `weekdays` entry** → zero materialized days;
  create still succeeds (empty draft), launch later refuses "no publishable
  content" (existing guard).
- **maxPostCount smaller than the natural count** → materialize only the first N
  dates (chronological); document that times-per-day count toward the cap or
  not (decision in plan — leaning: cap counts **slots**, i.e. date×time, to
  match "post count").
- **blackoutDates** → excluded from materialization, same as bulk.
- **Timezone/DST** → reuse `wallClockToUtc`; no new tz logic.
- **Bulk regression** → every existing bulk spec must stay green; the `time`
  default is the guard.

## Testing

- **Backend unit (Jest):** schedule-util drip cases (weekday match, multi-time
  ordering, past-due, blackout, tz), createDrip materialization (weekdays,
  maxPostCount, blackout, endDate bound), and a bulk-unchanged regression pass.
- **Backend build:** `npm run build` green in `socialmedia-workspace`.
- **Migration:** idempotent SQL script authored; applied by the user to local +
  prod out-of-band (assistant runs no `db:*`).
- **Frontend (follow-up):** build green; drip create → builder shows correct
  weekday×time slots → launch materializes posts on the calendar.

## Out of scope (v1)

- **Open-ended (no-endDate) drips** → needs a rolling BullMQ generation job.
- **Evergreen type** (`loop`/content recycling) — separate effort entirely.
- **Distinct AI-generated content per time-slot automation** — slots are filled
  manually/existing AI-mock path; no new automation.
- **Editing a live drip's cadence** (changing weekdays/times after launch) —
  v1 is create-time materialize; re-materialization on edit is deferred.

## Risks

- **Slot-model migration blast radius** — adding `time` to the slot key touches
  every slot query and the FE slot map. Mitigation: `time` defaults to bulk's
  `defaultTime`, bulk behaviour is pinned by its existing tests, and the FE
  change lands in a separate follow-up turn behind the green backend.
- **Prod migration parity** (from Phase 1) — no committed migration; a hand-run
  idempotent SQL script is the required path, applied by the user.
- **maxPostCount semantics** — "post count" vs "day count" ambiguity; the plan
  fixes it to slot-count (date×time) and tests it.
