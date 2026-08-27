# Campaign Slot Time Edit + Past-Due Warnings — Design Spec

**Date:** 2026-08-16
**Branches:** `feat/campaign-slot-time-edit` (both `socialmedia-workspace` and `socialmedia-frontend-campaigns`, each off `main` — which now includes messaging + launched-slot-edit)
**Type:** Architectural (new backend time-move capability + FE time picker + a new time-aware past-due model surfaced across preflight, slot badges, and the days column)

---

## 1. Problem

Two related gaps:

1. **A slot's time can't be changed after it's added.** Time is chosen once at add-time (bulk = `schedule.defaultTime`; drip = pick from `schedule.times`) and is baked into the slot key (`${channelId}@${time}`). `updateEvent`'s `time` is a MATCHER only. The only way to "move" a slot today is remove+add, which BLANKS the authored content.

2. **Past-due slots are invisible until it's too late.** The backend computes past-due correctly (timezone-aware, in `computeSlotSchedule`) and silently marks a past-due slot `skipped` at launch — but the FRONTEND never compares a slot's date+time+timezone to "now". `isSchedulable` is date-only; preflight has no past-due check; slot badges and the days "N/M ready" count ignore time. User's case: a 5:00 PM slot, now 5:26 PM → the slot shows a normal "Pending" badge, passes preflight, launches, and is silently skipped.

## 2. Scope (approved with user)

- **Editable slot time (pre-launch):** in the composer, the slot's time becomes editable via a time picker. Changing it MOVES the slot (preserves content). Backend: extend `updateEvent` with an optional `newTime` (content-preserving move); 409 on a unique-key collision.
- **Past-due surfaced in 3 places:** (a) a red "Past due" badge on the slot card (replacing the neutral Pending look), (b) a launch **preflight blocker** that names the offending slots, (c) a past-due indicator in the Days column.
- **Launch rule: BLOCK until fixed.** If any *ready* (would-otherwise-publish) slot is past-due, the Launch button is disabled; the user must change its time (now possible) or remove it. (Confirmed with user, understanding this also blocks a campaign that has future slots alongside a past-due one — acceptable because both escape hatches exist.)
- Time comparison is **timezone-correct** (slot date + time + `schedule.timezone` → absolute instant vs now).
- Out of scope (deferred, documented): surfacing blackout/weekend/wrong-weekday skips (already handled by hiding the day — no content loss); post-launch time editing of an already-scheduled slot (this effort's time edit is pre-launch/draft; a launched campaign's composer time field stays read-only, consistent with the launched-slot-edit effort); a launch "these slots were skipped" response summary (nice-to-have, not needed once past-due is blocked pre-launch).

## 3. Key facts (verified in code)

**Backend (`socialmedia-workspace`):**
- `campaign_slot_content` unique index `(campaignId, date, channelId, time)` — time is part of the key (`campaigns.schema.ts:217-221`). `time` is `varchar(5)` NOT NULL.
- `updateEvent` (`campaigns.service.ts:1334-1430`) merges content only; `dto.time` matches, never mutates. No `.set({ time })` anywhere.
- `computeSlotSchedule` (`campaign-schedule.util.ts:71-100`) is timezone-correct (native `Intl.DateTimeFormat` offset, DST-aware). Past-due rule: `scheduledAt >= now → due, else pastDue` (`:92-96`). `schedule.timezone` is the zone.
- `assertLaunchedSlotEditable` + `cancelAndClearSlotPost` exist (from launched-slot-edit) — a launched-campaign time move would reuse them, but that's OUT of scope here (pre-launch only).
- `ConflictException` 409 precedent exists (`:1273, :988, :1378, :1469`).

**Frontend (`socialmedia-frontend-campaigns`):**
- `TimePickerSelect` (`src/features/inbox/components/composer/time-picker-select.tsx`) — reusable shadcn hour/minute/AM-PM control. `TimesListField` + `parseHHmm`/`toHHmm` (`create/times-list-field.tsx`) as a model.
- Slot key `${channelId}@${time}`, helpers in `utils/slot-key.ts`.
- `isSchedulable` (`utils/campaign-dates.ts:32-44`) — DATE ONLY, no time/now.
- `computePreflight` (`utils/preflight.ts:60-127`) — blockers: name, channels, content, notifications, destination. NO past-due.
- Slot badges: authoring `slot-status-config.tsx` (`ready|draft|published|failed`) + runtime `slot-runtime-config.tsx` (`pending|…|skipped`). No past-due state.
- Days rollup `campaign-days.ts` (`readyCount` = filled only).
- `schedule.timezone` (IANA) on `campaign.ts:51/68/83`. FE has a timezone catalog (`constants/timezones.ts`) but never builds a zoned instant — this is NEW.
- Composer time flows through `event-composer.tsx` (prop, passed to `updateEvent` as matcher).

## 4. Design — two layers, backend-first

### Layer 1 — Backend: content-preserving time move

**1a. `UpdateEventDto` gains optional `newTime`** (`dto/campaigns.dto.ts`): `@IsOptional @Matches(/^\d{2}:\d{2}$/) newTime?: string`. When present, the slot identified by `(date, channelId, time)` is MOVED to `newTime`.

**1b. `updateEvent` handles `newTime`** (`campaigns.service.ts`): after finding the slot + merging content, if `dto.newTime` is set and differs from the slot's current time:
- Pre-check collision: does a slot already exist at `(campaignId, date, channelId, newTime)`? If yes → `ConflictException` "A post already exists for this channel at HH:mm on this day."
- `db.update(campaignSlotContent).set({ time: dto.newTime, content: mergedContent, updatedAt })` for the matched row.
- **Guard:** only allow the time move when the campaign is NOT launched (`status !== 'active'`) OR the slot is still `pending`/`scheduled` — reuse `assertLaunchedSlotEditable`. For a launched+scheduled slot, a time move would also need re-materialize; since that's out of scope this effort, REJECT a `newTime` on a launched campaign with a clear 409 ("Change the time before launching."). (Pre-launch is the whole target.)
- Draft campaign (the primary path): `slotStatus` is `pending`, `scheduledAt` null — a pure time-column update; launch recomputes everything from the new time. No re-enqueue needed.

**1c. Tests:** move to a free time → row's `time` updated, content preserved; move onto an occupied time → 409; move on a launched campaign → 409; `newTime` absent → existing content-only behaviour unchanged.

### Layer 2 — Frontend: time picker + past-due model

**2a. Time picker in the composer** (`event-composer.tsx`). Near the channel identity / time display, show the slot's time as an editable `TimePickerSelect` (reuse the inbox component). On change, call `updateEvent.mutate({ date, channelId, time: <oldTime>, patch: {...draft}, newTime: <picked> })`. On 409 (collision) → toast the server message. On success, the slot key changes → re-select the moved slot (`slotKey(channelId, newTime)`). Only editable when the slot is editable (not launched-and-published — reuse `isSlotEditable` from launched-slot-edit). Keep it available for bulk too (bulk slots currently hide the time badge — for editing, show the picker so a bulk slot's per-day time can be adjusted; if this complicates bulk's single-defaultTime model, gate the picker to drip/evergreen and note it — DECISION: show for all; a bulk per-day time override already exists in the schedule model as `perDayTimes`, but to keep scope tight, the time move here just changes the slot's `time` column, which launch honors regardless of schedule type).

**2b. `newTime` in the API + hook** (`campaigns.api.ts`, `use-campaign-event-mutations.ts`): thread an optional `newTime` through `updateEvent`.

**2c. Past-due detection util** (`utils/campaign-dates.ts` or a new `utils/slot-timing.ts`): `isSlotPastDue(date, time, timezone, now)` → builds the absolute instant from `date`+`time`+`timezone` (zoned conversion mirroring the backend's `wallClockToUtc`: compute the zone offset via `Intl.DateTimeFormat` with `timeZone`, apply it) and returns `instant < now`. Unit-tested with fixed `now` + a couple of zones. This is the one genuinely new FE primitive.

**2d. Red "Past due" badge on the slot card** (`channels-column.tsx`): for a NON-launched campaign, if `isSlotPastDue(...)` and the slot isn't already published/skipped, show a `text-destructive` "Past due" badge (with a tooltip "This time has passed — change it or remove this post before launching") instead of the neutral status. Do not touch launched runtime badges.

**2e. Preflight blocker** (`preflight.ts` + `computePreflight`): add a `pastDue` blocker. Compute the set of *ready* (filled / would-publish) slots that are past-due; if non-empty, emit a blocker naming the first ("Past due: <channel> on <date> at <time> — change its time or remove it") + "(+N more)". Wire into `builder-header.tsx` launch gating (already blocks on `blockers.length > 0`) and `preflight-summary.tsx`. `computePreflight` needs `now` + the campaign schedule's timezone passed in (it already takes `channelNameById`; extend similarly).

**2f. Days column indicator** (`campaign-days.ts` + `days-column.tsx`): a day whose ready slots include a past-due one gets a past-due marker (e.g. a small destructive dot / "past due" text alongside "N/M ready"). Keep the existing ready/partial/empty/skipped states.

## 5. Data flow (change a slot's time)

```
User opens a draft campaign → selects a slot → composer shows time as TimePickerSelect (5:00 PM)
  → picks 6:00 PM → updateEvent.mutate({ date, channelId, time:'17:00', newTime:'18:00', patch })
Backend updateEvent: find slot @ 17:00 → newTime set + differs → collision check @ 18:00
  → (free) UPDATE set time='18:00', content=merged → return CampaignDto
  → (occupied) 409 "already a post at 6:00 PM"
Frontend: slot key now channelId@18:00 → re-select moved slot; badge/preflight recompute (no longer past-due)
```

## 6. Error handling

- Time collision (target time occupied) → 409, toast the message; picker reverts to the old time.
- `newTime` on a launched campaign → 409 "Change the time before launching."; the picker is disabled there anyway (defence-in-depth).
- Past-due ready slot present → Launch disabled + preflight blocker names it; user changes time or removes it.
- Timezone edge: a slot exactly at `now` counts as NOT past-due (matches backend's `>= now → due`).
- Draft campaign, all future slots → no change, no blockers.

## 7. Testing

- **Backend:** `updateEvent` newTime move (free → time updated + content preserved), collision → 409, launched → 409, no-newTime → unchanged. Reuse existing spec mocking style.
- **Frontend:** `isSlotPastDue` (fixed now, multiple zones, exactly-now = not past-due, future = not, past = yes). `computePreflight` pastDue blocker (ready past-due slot → blocker with name/time; future-only → none; unfilled past-due slot → NOT a blocker since it wouldn't publish anyway). Slot card renders "Past due" badge for a past-due draft slot. TimePickerSelect wired → updateEvent called with newTime. Launch disabled when a pastDue blocker exists. Existing preflight/badge tests stay green.
- **Build:** `npm run build` green both repos.

## 8. Global constraints

- **NO DB migration** (time column + index already exist; only logic).
- **shadcn-only** UI, theme tokens only (past-due badge uses `text-destructive`/`bg-destructive/…` tokens, no hex).
- **Never** `git add .`/`-A` — surgical (FE `.env` git-tracked; BE `.env` gitignored, both secrets).
- Commit/push only when the user explicitly asks.
- Assistant runs **no** `db:*`/`psql`/migration commands.
- **Draft-campaign non-time-edit behaviour unchanged**; bulk/social slot rendering unchanged except the added time picker + past-due badge.
- Past-due comparison must be timezone-correct (mirror backend `wallClockToUtc`), never server-local-naive.
- Off `main` (has messaging + launched-slot-edit merged); independent effort, its own branch/PR.
