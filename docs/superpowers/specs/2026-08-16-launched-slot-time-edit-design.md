# Launched-Campaign Slot Time Edit — Design Spec

**Date:** 2026-08-16
**Branches:** `feat/launched-slot-time-edit` (both `socialmedia-workspace` and `socialmedia-frontend`, each off `main`)
**Type:** Architectural (relax the launched-campaign time-move guard + re-enqueue at the new time + block past-time moves; small FE messaging add)

---

## 1. Problem

A campaign/drip slot's time can be changed before launch (the `updateEvent` `newTime` move). But once the campaign is **launched** (`status === 'active'`), a still-`scheduled` slot's time **cannot** be changed: `updateEvent` throws a hard 409 ("Change this post's time before launching the campaign.") the moment `newTime` is set on an active campaign — even though:

- The per-slot **⋮ menu with "Edit time" already renders** for `scheduled` slots on a launched campaign (frontend `isSlotEditable` returns true for `pending`/`scheduled`), so the user is offered an action the backend then rejects — a confusing dead end.
- The exact mechanism needed (cancel the enqueued BullMQ job + re-materialize) **already exists** for launched **content** edits in the same method's re-materialize block — it just re-enqueues at the slot's *old* time.

Two more gaps this surfaces:

- **🐞 Stale `slot.time` in re-enqueue.** In the re-materialize block, `computeSlotSchedule(...)` and `materializeAndEnqueue({ time: slot.time })` both read the local `slot.time` variable. After a `newTime` move the DB row's `time` is updated, but the local `slot.time` is **not** reassigned — so if the launched move were simply allowed today, the job would silently re-enqueue at the OLD time while the DB/UI show the new time. This is unreachable today (the 409 guards it), but becomes a live, worst-case bug the moment the guard is relaxed.
- **Past-time moves are not blocked.** Today a user can move a slot to a time that's already passed; at launch it's silently marked `skipped`. Per product decision, a past-time move should be **blocked outright** (draft and launched alike), not silently skipped.

## 2. Scope (approved with user)

- **Launched + `scheduled` slot → time is editable.** Changing it cancels the enqueued job and re-enqueues at the NEW time (content preserved). Only `scheduled` (and `pending`) slots; `published`/`publishing`/`failed`/`skipped` stay read-only (already enforced by `assertLaunchedSlotEditable` + the FE menu gate).
- **Past-time moves are BLOCKED** (both draft and launched, for consistency): if `newTime` on the slot's date is already in the past (in the campaign's timezone), reject with a 409 "This time has already passed — pick a future time." The slot keeps its old time; nothing is lost. This replaces the prior "move-then-skip" behaviour for the *move* action. (Slots whose time passes *after* being set still show the existing "Past due" warning — that path is unchanged.)
- **Fix the stale `slot.time`** so the re-enqueued job fires at the new time.
- **Collision, race, and read-only guards unchanged:** target time already occupied → 409 (existing); post already publishing when the move lands → 409 "reload" (existing `cancelAndClearSlotPost` false-return); fired/read-only slot → 409 + no FE menu (existing).
- **Frontend:** add a "Saving reschedules this post." note inside the time-edit popover when the campaign is active and the slot is scheduled (mirrors the content-edit composer's existing note). No functional FE change — the mutation already wires `newTime` through regardless of launch state; the backend 409-relax is what enables it.
- Out of scope (unchanged): past-launch content-edit re-materialize (already shipped); the "Past due" badge/preflight/days-marker feature (unchanged); bulk vs drip distinction (both use the same slot `time` column).

## 3. Key facts (verified in code)

**Backend (`socialmedia-workspace`):**
- `updateEvent` (`campaigns.service.ts` ~1334-1460): find slot → `await this.getOne(workspaceId, id)` (result currently discarded, ~1340) → load raw `campaignStatus` → `assertLaunchedSlotEditable(campaignStatus, slot.slotStatus)` (1365) → `movingTime` block (1367-1393, currently 409s on `active`) → content+time `.set` (1395-1404) → re-materialize block (1406-1454, gated `active && slotStatus==='scheduled'`).
- `assertLaunchedSlotEditable` (~985-994): `campaignStatus !== 'active'` → return (unguarded); on active, `['publishing','published','failed','skipped']` → 409; `pending`/`scheduled` pass. **So the ONLY thing blocking a launched move today is the explicit `if (campaignStatus === 'active') throw` at ~1372, layered on top.**
- `cancelAndClearSlotPost({ jobId, postId })` (~1004-1015): cancels the BullMQ job, deletes the `posts` row only if still `status='scheduled'` (race-safe), returns `false` (→ caller 409s) if the post already flipped to publishing. Reusable as-is.
- Re-materialize block reads **`slot.time`** at line ~1421 (`computeSlotSchedule([{ date: slot.date, time: slot.time }], now)`) and ~1447 (`materializeAndEnqueue({ time: slot.time })`) — both STALE after a move (see §1).
- `computeSlotSchedule(schedule, slots, now)` (exported, `campaign-schedule.util.ts:71`): for each `(date, time)`, converts wall-clock→UTC in `schedule.timezone` (`wallClockToUtc`, internal/not exported, `:47`), and splits `due` (`at >= now`, with `scheduledAt`) vs `pastDue` (`at < now`). **Reusing this for the past-time check keeps the block/skip boundary identical to launch.**
- `UpdateEventDto.newTime?` exists in BOTH the class-validator DTO (`dto/campaigns.dto.ts:204-205`, `@Matches(/^\d{2}:\d{2}$/)`) and the local interface (`campaigns.service.ts:144`, comment says "pre-launch only" — now stale).
- Existing tests (`campaigns.service.spec.ts`): `describe('updateEvent — newTime move')` at ~1986 has a draft-move-succeeds test (~1991), a collision-409 (~2021), **a launched-409 (~2062) that this feature INVERTS**, and a no-newTime-unchanged (~2094). `describe('updateEvent')` at ~1722 has content-edit re-materialize tests (~1785, ~1838, ~1873) — the pattern to mirror.

**Frontend (`socialmedia-frontend`):**
- `SlotActionsMenu` in `channels-column.tsx` (~561+): gated `{canDelete && ...}` where `canDelete = isSlotEditable(content, isLaunched)`. `isSlotEditable` (`utils/slot-editability.ts:8-11`): `!isLaunched` → true; else `slotStatus ∈ {pending, scheduled}`. **So the ⋮ + "Edit time" already renders on a launched drip's scheduled slots.**
- `SlotActionsMenu`'s "Edit time" → `onEditTime(newTime)` → parent runs `updateEvent.mutate({ date, channelId, time, newTime, patch: content })` regardless of launch. `onError` toasts the server message. **The only blocker is the backend 409.**
- The time-edit `PopoverContent` (~653+) shows a static "Edit post time" header — no reschedule note. The content-edit composer (`event-composer.tsx:359-363`) DOES show "Saving reschedules this post." when `campaign.status === 'active'` — the pattern to mirror.
- FE `SlotActionsMenu` currently only knows `time`/`accountName`/`canEditTime`/handlers — it does NOT receive campaign status or the slot's runtime status, so the note needs those threaded in (or a precomputed boolean).

## 4. Design — backend-first

### Layer 1 — Backend (`campaigns.service.ts`)

**1a. Capture the schedule once.** Change `await this.getOne(workspaceId, id);` (~1340) to `const campaign = await this.getOne(workspaceId, id);` so `campaign.schedule` is available for the past-time check (and reused later instead of the second `getOne` at ~1420).

**1b. Relax the launched 409 + add the past-time block** in the `movingTime` block (~1371-1393). Replace the current `if (campaignStatus === 'active') throw ...` with a past-time guard that applies to BOTH draft and launched:

```ts
const movingTime = !!dto.newTime && dto.newTime !== slot.time;
if (movingTime) {
  // Block moving to a time that has already passed (draft & launched alike) —
  // reuse the launch-time due/past-due split so the boundary is identical.
  const { pastDue } = computeSlotSchedule(
    campaign.schedule,
    [{ date: dto.date, time: dto.newTime! }],
    new Date(),
  );
  if (pastDue.length > 0) {
    throw new ConflictException(
      'This time has already passed — pick a future time.',
    );
  }
  // Collision: another slot already occupies the target time (existing check).
  const [clash] = await db
    .select({ id: campaignSlotContent.id })
    .from(campaignSlotContent)
    .where(and(
      eq(campaignSlotContent.campaignId, id),
      eq(campaignSlotContent.date, dto.date),
      eq(campaignSlotContent.channelId, dto.channelId),
      eq(campaignSlotContent.time, dto.newTime!),
    ));
  if (clash) {
    throw new ConflictException(
      'A post already exists for this channel at that time on this day.',
    );
  }
}
```

Note: `assertLaunchedSlotEditable` (already called at ~1365) still 409s a launched `published`/`fired`/`skipped` slot before this block, so only `scheduled`/`pending` reach here on a launched campaign — no extra status guard needed.

**1c. Fix the stale `slot.time`.** After the content+time `.set`, compute the effective time once and use it in the re-materialize block instead of `slot.time`:

```ts
const effectiveTime = movingTime ? dto.newTime! : slot.time;
```
- Line ~1421: `[{ date: slot.date, time: effectiveTime }]`
- Line ~1447: `time: effectiveTime`
- Reuse `campaign.schedule` (from 1a) instead of the second `await this.getOne(...)` at ~1420.

The re-materialize block's own gate (`campaignStatus === 'active' && slot.slotStatus === 'scheduled'`) is already correct — it now runs for a launched move because 1b no longer 409s it. `computeSlotSchedule` with `effectiveTime` yields the correct `scheduledAt` (or, since 1b already blocked past times, `pastDue` will be empty here — the `isPastDue → skipped` branch is now effectively dead for a *move* but stays as a safety net for the content-only re-materialize path, which is fine).

**1d. Comment.** Update `campaigns.service.ts:144` local-interface comment: `newTime?: string; // HH:mm — content-preserving time move (blocked if past; re-enqueues on a launched scheduled slot)`.

### Layer 2 — Frontend (`channels-column.tsx`)

**2a. Reschedule note in the time-edit popover.** Thread a boolean into `SlotActionsMenu` — `rescheduleOnSave` — true when the campaign is active AND this slot is still `scheduled` (i.e., saving will cancel + re-enqueue a live job). Compute it at the call site from `campaign.status` + `content.runtime?.slotStatus`, pass it in, and render a muted note inside `PopoverContent` under the picker:

```tsx
{rescheduleOnSave && (
  <p className="text-[11px] text-muted-foreground">
    Saving reschedules this post.
  </p>
)}
```

Use theme tokens only. No other FE change — the past-time 409 and collision 409 already surface via the existing `onError` toast.

## 5. Data flow (move a launched scheduled slot)

```
Launched drip, scheduled slot @ 18:00 → ⋮ → Edit time → 20:00 → Save time
  → updateEvent.mutate({ date, channelId, time:'18:00', newTime:'20:00', patch: content })
Backend updateEvent:
  getOne → campaign (schedule)
  assertLaunchedSlotEditable(active, 'scheduled') → OK
  movingTime=true → computeSlotSchedule(schedule, [{date,'20:00'}], now)
    → pastDue empty? ok : 409 "time has already passed"
    → collision @ 20:00? 409 : ok
  .set({ content: merged, time:'20:00' })
  active && scheduled → cancelAndClearSlotPost(old job/post)
    → false (already publishing)? 409 "reload"
    → computeSlotSchedule(schedule, [{date, effectiveTime:'20:00'}], now) → scheduledAt
    → materializeAndEnqueue({ time:'20:00', content: merged, scheduledAt, ... }) → new postId/jobId
    → slot { postId, jobId, scheduledAt, slotStatus:'scheduled' }
  → CampaignDto (fresh)
Frontend: popover closes; card shows 20:00; the live job now fires at 20:00.
```

## 6. Error handling

- Past `newTime` (draft or launched) → 409 "This time has already passed — pick a future time."; slot keeps old time; toast.
- Target time occupied → 409 (existing message); toast; slot unchanged.
- Launched published/fired/skipped slot → 409 (existing, via `assertLaunchedSlotEditable`); also the FE menu isn't shown, so unreachable via UI.
- Post already publishing when the move lands → 409 "reload" (existing `cancelAndClearSlotPost` false-return); nothing half-applied beyond the content/time row write, which self-heals on reload.
- `newTime === slot.time` → no-op (existing `movingTime` false).

## 7. Testing

**Backend (`campaigns.service.spec.ts`):**
- **Replace** the existing `it('throws ConflictException when the campaign is launched (active) and newTime is set')` (~2062) — it now asserts the *opposite*. New positive test: active + `scheduled` slot + future `newTime` (target free) → cancels old job (`cancelSlotJob` called with old jobId), deletes guarded post, `materializeAndEnqueue` called with **`time: newTime`** (assert the NEW time, guarding the stale-`slot.time` fix), stores new postId/jobId, `slotStatus:'scheduled'`.
- New: active + scheduled + **past** `newTime` → 409 "already passed", no cancel/re-enqueue, slot untouched.
- New: draft + **past** `newTime` → 409 "already passed" (consistency).
- New: active + scheduled + future `newTime` but target **occupied** → 409 collision, no re-enqueue.
- New: active + scheduled + future `newTime` but `cancelAndClearSlotPost` returns false (post publishing) → 409 "reload".
- Keep green: draft future-move succeeds (~1991), draft collision (~2021), no-newTime content-only (~2094), content-edit re-materialize tests (~1785/1838/1873).

**Frontend:** `channels-column.tsx` builds; the `rescheduleOnSave` note renders only when active + scheduled. (No component-test harness under builder/ — cover the boolean via inspection / a small pure helper if one is introduced, per the existing convention.)

**Build:** `npm run build` green both repos (`nest build`; `tsc -b && vite build`).

## 8. Global constraints

- **NO DB migration** — logic + existing columns only.
- **shadcn-only** UI, theme tokens only (the note uses `text-muted-foreground`; no hex/arbitrary colors).
- **Never** `git add .`/`-A` — surgical `git add <path>` only (FE `.env` git-TRACKED with secrets; BE `.env` gitignored with secrets).
- Commit/push only when the user explicitly asks.
- Assistant runs **no** `db:*`/`psql`/migration commands.
- Backend-first (Layer 1 before Layer 2).
- Reuse `computeSlotSchedule` for the past-time check so the block/skip boundary matches launch exactly (never a hand-rolled naive local-time compare).
- Draft-campaign behaviour unchanged **except** past-time moves are now blocked (was: allowed-then-skipped-at-launch).
- Off `main` (which has the per-slot ⋮ menu + earlier slot-time-edit merged); independent branch/PR both repos.
