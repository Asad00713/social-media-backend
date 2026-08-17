# Launched-Campaign Slot Time Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow changing a still-`scheduled` slot's time on a launched (`active`) campaign/drip — cancelling the enqueued job and re-enqueueing at the NEW time — while blocking moves to an already-past time (draft and launched alike).

**Architecture:** One backend method (`updateEvent`) changes: relax the launched 409 for the time-move path, add a past-time block that reuses `computeSlotSchedule`, and fix a stale `slot.time` so the re-enqueued job fires at the new time. One small frontend addition: a "Saving reschedules this post." note in the time-edit popover when the campaign is active and the slot is scheduled.

**Tech Stack:** Backend — NestJS, Drizzle ORM (Postgres), BullMQ, class-validator, Jest. Frontend — Vite 8 + React 19 + TypeScript + Tailwind 3 + shadcn (basecn/base-ui), TanStack Query v5.

**Spec:** `docs/superpowers/specs/2026-08-16-launched-slot-time-edit-design.md`

## Global Constraints

- **NO DB migration** — logic + existing columns only.
- **shadcn-only** UI, theme tokens only (the FE note uses `text-muted-foreground`; no hex / arbitrary Tailwind colors).
- **Never** `git add .` / `git add -A` — surgical `git add <path>` only (FE `.env` is git-TRACKED with secrets; BE `.env` is gitignored with secrets — never stage/expose either).
- Commit/push only when the user explicitly asks; each task ends with a `git add <specific paths>` + commit, but do NOT push.
- The implementer runs **no** `db:*` / `psql` / migration commands.
- **Reuse `computeSlotSchedule`** for the past-time check so the block/skip boundary matches launch exactly — never a hand-rolled naive local-time compare.
- **Backend-first** (Task 1-2 before Task 3).
- Draft-campaign behaviour unchanged **except** past-time moves are now blocked (was: allowed-then-skipped-at-launch).
- Branch `feat/launched-slot-time-edit` in both repos, off `main` (BE base `69ae97c`, FE base `3f664cc`).

---

### Task 1: Backend — relax launched guard + block past-time moves

**Files:**
- Modify: `src/campaigns/campaigns.service.ts` (`updateEvent`, the `movingTime` block ~1367-1393, plus capture `getOne` result at ~1340; local-interface comment at ~144)
- Test: `src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `computeSlotSchedule(schedule, slots, now)` (already imported in this file — it's used in the re-materialize block); `ConflictException` (already imported); `campaign.schedule` from `getOne`.
- Produces: `updateEvent` no longer 409s a launched campaign's `newTime` move; instead a past `newTime` (draft or launched) → 409 "already passed". The re-materialize block (Task 2) then runs for a launched scheduled move.

**Design note (read before coding):** The `movingTime` block currently does `if (campaignStatus === 'active') throw ...` then a collision check. Replace the launched-throw with a **past-time** check (applies to both draft and launched) placed BEFORE the collision check. Reuse `computeSlotSchedule` with a single `(dto.date, dto.newTime)` slot: if it lands in `pastDue`, throw. `assertLaunchedSlotEditable` (already called at ~1365) still 409s a launched published/fired/skipped slot, so only `scheduled`/`pending` reach this block on a launched campaign — no extra status guard needed here.

- [ ] **Step 1: Write the failing tests**

Add to `src/campaigns/campaigns.service.spec.ts`. First READ the existing spec's `db`/Drizzle mock harness (the `describe('updateEvent — newTime move')` block ~1986 and `loadServiceWithFakeDb` helper) and reuse it exactly — do not invent a new style. The suite mocks `computeSlotSchedule`? Check: if `computeSlotSchedule` is the real imported function, the fake `now`/`schedule.timezone` in fixtures must make a "past" time actually past. If the suite mocks `publishing.materializeAndEnqueue`/`cancelSlotJob`, reuse those mocks.

Add these cases (this task covers the guard/past-time; Task 2 covers the successful re-enqueue):

```ts
// In describe('updateEvent — newTime move', ...) or a sibling describe:

it('throws ConflictException when newTime is in the past (draft campaign)', async () => {
  // draft campaign, slot @ '17:00', dto.newTime a time already passed for dto.date
  // (build the fixture so computeSlotSchedule returns it in pastDue — e.g. a past
  // date/time relative to the test's `now`, in schedule.timezone).
  // Assert: rejects toThrow(/already passed/i); no db.update writing time; no re-enqueue.
})

it('throws ConflictException when newTime is in the past (launched/active campaign)', async () => {
  // campaign.status='active', slot.slotStatus='scheduled', dto.newTime in the past.
  // Assert: rejects toThrow(/already passed/i); no cancelSlotJob, no materializeAndEnqueue.
})

it('does NOT throw the launched-409 for a future newTime move on an active scheduled slot', async () => {
  // campaign.status='active', slot.slotStatus='scheduled', dto.newTime a FUTURE time,
  // target free. Assert: does NOT reject with the old "Change this post's time before
  // launching" message (that guard is gone). (The full re-enqueue assertions live in Task 2;
  // here just assert it no longer throws that specific 409.)
})
```

Also UPDATE (do not just delete) the existing `it('throws ConflictException when the campaign is launched (active) and newTime is set')` (~2062) — its premise is now inverted. Rename/repurpose it into the "does NOT throw the launched-409" test above (or delete it and rely on the new one). Note in the report which you did.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- campaigns.service`
Expected: the new past-time cases FAIL (no past-time check exists yet); the "does NOT throw launched-409" case FAILS (the 409 still fires today).

- [ ] **Step 3: Capture the `getOne` result**

In `updateEvent`, change line ~1340 from:
```ts
    await this.getOne(workspaceId, id);
```
to:
```ts
    const campaign = await this.getOne(workspaceId, id);
```
(`campaign.schedule` is used by the past-time check below and by Task 2's re-materialize.)

- [ ] **Step 4: Replace the launched-throw with a past-time block**

In the `movingTime` block (currently starts ~1370 `const movingTime = ...`), replace the `if (campaignStatus === 'active') throw ...` with a past-time check, keeping the existing collision check after it:

```ts
    const movingTime = !!dto.newTime && dto.newTime !== slot.time;
    if (movingTime) {
      // Block moving to a time that has already passed — draft & launched alike.
      // Reuse the launch due/past-due split so the boundary is identical.
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
      // Collision: another slot already occupies the target time.
      const [clash] = await db
        .select({ id: campaignSlotContent.id })
        .from(campaignSlotContent)
        .where(
          and(
            eq(campaignSlotContent.campaignId, id),
            eq(campaignSlotContent.date, dto.date),
            eq(campaignSlotContent.channelId, dto.channelId),
            eq(campaignSlotContent.time, dto.newTime!),
          ),
        );
      if (clash) {
        throw new ConflictException(
          'A post already exists for this channel at that time on this day.',
        );
      }
    }
```

(The collision `db.select` block is unchanged from what's already there — keep it verbatim; only the leading `if (campaignStatus === 'active') throw` is removed and the past-time check added above it.)

- [ ] **Step 5: Update the stale comment**

In `src/campaigns/campaigns.service.ts:144` (the local `UpdateEventDto` interface), change the `newTime` comment from `// HH:mm — content-preserving move to this time (pre-launch only)` to:
```ts
  newTime?: string; // HH:mm — content-preserving time move (blocked if past; re-enqueues a launched scheduled slot)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test -- campaigns.service`
Expected: the three new/updated cases PASS; the rest of the campaigns suite stays green (the draft future-move, draft collision, no-newTime cases). Note: Task 2's re-enqueue assertions may still be failing/absent — that's expected; this task only makes the guard/past-time behaviour correct.

- [ ] **Step 7: Verify the backend compiles**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/campaigns/campaigns.service.ts src/campaigns/campaigns.service.spec.ts
git commit -m "feat(campaigns): allow launched scheduled time move; block past-time moves"
```

---

### Task 2: Backend — fix stale `slot.time`, re-enqueue at the new time

**Files:**
- Modify: `src/campaigns/campaigns.service.ts` (`updateEvent` re-materialize block ~1406-1454)
- Test: `src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `dto.newTime` / `slot.time`; `campaign.schedule` (captured in Task 1 Step 3); `cancelAndClearSlotPost`, `computeSlotSchedule`, `publishing.materializeAndEnqueue` (all existing).
- Produces: on a launched `scheduled` slot with a `newTime` move, the re-materialized job is enqueued at the **new** time.

**Design note (the bug):** The re-materialize block reads `slot.time` at two points — `computeSlotSchedule([{ date: slot.date, time: slot.time }], ...)` (~1421) and `materializeAndEnqueue({ time: slot.time })` (~1447). After a move, the DB row's `time` was updated (in the content `.set`) but the local `slot.time` variable is stale (still the OLD time). Introduce `const effectiveTime = movingTime ? dto.newTime! : slot.time;` and use it at both points. Also reuse `campaign.schedule` instead of the second `await this.getOne(...)` at ~1420 (Task 1 captured `campaign`).

- [ ] **Step 1: Write the failing test**

Add to `src/campaigns/campaigns.service.spec.ts` — the successful launched move (this is the case with no existing coverage):

```ts
it('active + scheduled + future newTime: cancels the old job and re-enqueues at the NEW time', async () => {
  // campaign.status='active', slot.slotStatus='scheduled', slot.time='17:00',
  // slot.jobId/postId set. dto.newTime='20:00' (future, target free).
  // Mock cancelSlotJob + materializeAndEnqueue.
  // Act: await service.updateEvent(...)
  // Assert:
  //   - cancelAndClearSlotPost path ran: cancelSlotJob called with the OLD jobId,
  //     posts delete guarded by status='scheduled'.
  //   - publishing.materializeAndEnqueue was called with time: '20:00' (the NEW time) —
  //     NOT '17:00'. THIS is the stale-slot.time guard.
  //   - the slot row is updated with the new postId/jobId/scheduledAt and slotStatus='scheduled'.
  //   - computeSlotSchedule (if real) was evaluated against '20:00' so scheduledAt matches 20:00.
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- campaigns.service`
Expected: FAIL — today `materializeAndEnqueue` would be called with `'17:00'` (stale) even if the guard were relaxed; assert on `'20:00'` fails.

- [ ] **Step 3: Introduce `effectiveTime` and use it in the re-materialize block**

In `updateEvent`, right after the content+time `.set(...)` (~line 1404, before the `if (campaignStatus === 'active' && slot.slotStatus === 'scheduled')` block), add:
```ts
    const effectiveTime = movingTime ? dto.newTime! : slot.time;
```
Then inside the re-materialize block:
- Replace `(await this.getOne(workspaceId, id)).schedule` (~1420) with `campaign.schedule`.
- Replace `[{ date: slot.date, time: slot.time }]` (~1421) with `[{ date: slot.date, time: effectiveTime }]`.
- Replace `time: slot.time,` in the `materializeAndEnqueue({ ... })` call (~1447) with `time: effectiveTime,`.

Leave everything else in the block unchanged (the `skipped` branch, the destination, the final `.set` storing new ids).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- campaigns.service`
Expected: PASS — `materializeAndEnqueue` now called with `'20:00'`. All Task-1 cases stay green.

- [ ] **Step 5: Verify the backend compiles**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/campaigns/campaigns.service.ts src/campaigns/campaigns.service.spec.ts
git commit -m "fix(campaigns): re-enqueue launched slot move at the NEW time (stale slot.time)"
```

---

### Task 3: Frontend — "reschedules this post" note in the time-edit popover

**Files:**
- Modify: `src/features/campaigns/components/builder/bonzo/channels-column.tsx` (`SlotActionsMenu` + its call site)

**Interfaces:**
- Consumes: `campaign.status`; the row's `content.runtime?.slotStatus`.
- Produces: the time-edit `PopoverContent` shows "Saving reschedules this post." only when the campaign is active AND the slot is `scheduled`.

**Design note:** `SlotActionsMenu` currently receives `accountName`, `time`, `canEditTime`, `onEditTime`, `isSavingTime`, `onDelete`. Add a `rescheduleOnSave: boolean` prop. Compute it at the call site (inside the row `.map`) as `campaign.status === 'active' && content.runtime?.slotStatus === 'scheduled'`. Render the note inside `PopoverContent`, under the picker (before or after the Cancel/Save row — put it under the header, above the buttons).

- [ ] **Step 1: Add the `rescheduleOnSave` prop to `SlotActionsMenu`**

In `SlotActionsMenuProps` (interface), add:
```ts
  /** True when saving will cancel + re-enqueue a live job (active campaign,
   *  still-scheduled slot) — surfaces a heads-up in the popover. */
  rescheduleOnSave: boolean
```
Accept it in the destructured params of `SlotActionsMenu`.

- [ ] **Step 2: Render the note in `PopoverContent`**

Inside the `<PopoverContent ...>`, after the `<p>Edit post time</p>` header and before the `<div className="flex justify-end gap-2">` button row, add:
```tsx
        {rescheduleOnSave && (
          <p className="text-[11px] text-muted-foreground">
            Saving reschedules this post.
          </p>
        )}
```

- [ ] **Step 3: Pass `rescheduleOnSave` at the call site**

At the `<SlotActionsMenu ... />` call (inside the row `.map`, where `content` is in scope), add the prop:
```tsx
                      rescheduleOnSave={
                        campaign.status === 'active' &&
                        content.runtime?.slotStatus === 'scheduled'
                      }
```

- [ ] **Step 4: Verify the frontend compiles**

Run: `npm run build`
Expected: PASS (`tsc -b && vite build`).

- [ ] **Step 5: Lint the touched file**

Run: `npx eslint src/features/campaigns/components/builder/bonzo/channels-column.tsx`
Expected: no errors (no unused props/vars).

- [ ] **Step 6: Commit**

```bash
git add src/features/campaigns/components/builder/bonzo/channels-column.tsx
git commit -m "feat(campaigns): note that saving reschedules a launched scheduled slot"
```

---

### Task 4: Full build + test gate (both repos)

**Files:** none (verification task).

- [ ] **Step 1: Backend build + campaigns tests**

In `socialmedia-workspace`:
Run: `npm run build` → Expected: PASS.
Run: `npm run test -- campaigns` → Expected: PASS (all campaigns specs, including the new launched-move + past-time cases).

- [ ] **Step 2: Frontend build**

In `socialmedia-frontend`:
Run: `npm run build` → Expected: PASS.
Run: `npm run test -- --run` → Expected: PASS (existing suite green; no new FE tests required, but nothing regresses).

- [ ] **Step 3: Ledger the result**

Record both outcomes in the SDD ledger. No commit.

---

## Self-Review

**1. Spec coverage:**
- Spec §2 "Launched + scheduled → time editable, cancel + re-enqueue at NEW time" → Task 1 (guard relax) + Task 2 (re-enqueue + stale fix). ✅
- Spec §2 "Past-time moves BLOCKED (draft & launched)" → Task 1 Step 4 (past-time check via `computeSlotSchedule`). ✅
- Spec §2 "collision / race / read-only guards unchanged" → Task 1 keeps the collision check verbatim; `cancelAndClearSlotPost` false-return 409 and `assertLaunchedSlotEditable` are untouched. ✅
- Spec §2/§4.2 "FE reschedule note" → Task 3. ✅
- Spec §7 testing (replace launched-409, past-time draft+launched, successful launched move asserting NEW time, collision, race) → Task 1 + Task 2 tests. ✅

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Test-case bodies describe exact arrange/assert; the implementer is told to reuse the existing mock harness and read it first (the one thing that can't be transcribed blind is the fixture-builder shape, which the plan points at explicitly).

**3. Type consistency:**
- `effectiveTime` defined in Task 2, used at the two re-materialize points in Task 2. ✅
- `campaign` captured in Task 1 Step 3, reused in Task 1 (past-time check) and Task 2 (re-materialize schedule). Both tasks touch the same method — Task 2 depends on Task 1's `campaign` capture; noted in Task 2's design note. ✅
- `rescheduleOnSave: boolean` added to props + call site within Task 3. ✅
- `computeSlotSchedule(schedule, [{date, time}], now)` signature identical to its existing use in the re-materialize block. ✅

Plan is internally consistent and covers the spec.
