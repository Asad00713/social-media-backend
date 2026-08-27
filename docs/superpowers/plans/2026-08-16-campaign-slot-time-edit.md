# Campaign Slot Time Edit + Past-Due Warnings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user change a campaign/drip slot's time before launch (content-preserving move), and surface past-due slots (time already passed) with a red badge, a launch-blocking preflight blocker, and a Days-column marker.

**Architecture:** Two layers, backend-first. **Backend:** `updateEvent` gains an optional `newTime` that moves a slot's `time` column (preserving merged content), rejecting a collision or a launched campaign with a 409. **Frontend:** a new timezone-correct `isSlotPastDue` util (mirrors the backend's `wallClockToUtc`), a `TimePickerSelect` wired into the composer that calls `updateEvent` with `newTime`, a red "Past due" slot badge, a `pastDue` preflight blocker that disables Launch, and a Days-column past-due marker.

**Tech Stack:** Backend — NestJS, Drizzle ORM (Postgres), class-validator, Jest. Frontend — Vite 8 + React 19 + TypeScript + Tailwind 3 + shadcn (wraps @base-ui/basecn), TanStack Query v5, Vitest, react-router.

**Spec:** `docs/superpowers/specs/2026-08-16-campaign-slot-time-edit-design.md`

## Global Constraints

- **NO DB migration** — `campaign_slot_content.time` (`varchar(5)` NOT NULL) and the unique index `(campaignId, date, channelId, time)` already exist; this is logic-only.
- **shadcn-only** UI; theme tokens only. Past-due styling uses `text-destructive` / `bg-destructive/…` tokens — no hex, no arbitrary Tailwind colors (`bg-red-500` etc.).
- **Never** `git add .` / `git add -A` — surgical `git add <path>` only (FE `.env` is git-TRACKED with secrets; BE `.env` is gitignored with live secrets — never stage/commit/expose either).
- Commit/push only when the user explicitly asks; this plan's tasks each end with a `git add <specific paths>` + commit, but do NOT push.
- The implementer runs **no** `db:*` / `psql` / migration commands.
- **Draft-campaign non-time-edit behaviour must stay unchanged**; bulk/social slot rendering unchanged except the added time picker + past-due badge. Byte-for-byte for anything not touched.
- Past-due comparison must be **timezone-correct** (mirror backend `wallClockToUtc`), never server-local-naive. A slot exactly at `now` counts as NOT past-due (`>= now → not past-due`, matching the backend's `computeSlotSchedule`).
- Branch `feat/campaign-slot-time-edit` in both repos, off `main` (which already contains messaging + launched-slot-edit).

---

### Task 1: Backend — `newTime` on `UpdateEventDto`

**Files:**
- Modify: `src/campaigns/dto/campaigns.dto.ts:187-200` (the `UpdateEventDto` class)

**Interfaces:**
- Consumes: nothing new.
- Produces: `UpdateEventDto.newTime?: string` (optional, `HH:mm`-validated) — consumed by Task 2 (`updateEvent`) and set by the frontend (Task 7).

- [ ] **Step 1: Add the `newTime` field to `UpdateEventDto`**

In `src/campaigns/dto/campaigns.dto.ts`, the existing `UpdateEventDto` ends with the `time?` matcher field. Add `newTime` right after it, using the same `@Matches` pattern already used for `time`:

```ts
export class UpdateEventDto {
  @IsDateString()
  date: string;

  @IsString()
  channelId: string;

  @IsObject()
  patch: Partial<ChannelDayContentJson>;

  @IsOptional()
  @Matches(/^\d{2}:\d{2}$/, { message: 'time must be HH:mm' })
  time?: string;

  // Optional content-preserving time move: when present and different from the
  // matched slot's current `time`, updateEvent moves the slot to this time.
  @IsOptional()
  @Matches(/^\d{2}:\d{2}$/, { message: 'newTime must be HH:mm' })
  newTime?: string;
}
```

(`@IsOptional`, `@Matches`, `@IsObject`, `@IsString`, `@IsDateString` are already imported in this file — the existing `time?` field uses `@IsOptional` + `@Matches`.)

- [ ] **Step 2: Verify the backend compiles**

Run: `npm run build`
Expected: PASS (no type errors). Confirms the DTO change is well-formed before wiring logic.

- [ ] **Step 3: Commit**

```bash
git add src/campaigns/dto/campaigns.dto.ts
git commit -m "feat(campaigns): add optional newTime to UpdateEventDto for slot time move"
```

---

### Task 2: Backend — `updateEvent` handles the `newTime` move

**Files:**
- Modify: `src/campaigns/campaigns.service.ts:1334-1430` (the `updateEvent` method)
- Test: `src/campaigns/campaigns.service.spec.ts` (add cases; file already exists with the campaigns suite)

**Interfaces:**
- Consumes: `UpdateEventDto.newTime` (Task 1); existing helpers `assertLaunchedSlotEditable(campaignStatus, slotStatus)`, `cancelAndClearSlotPost({jobId, postId})`; Drizzle `campaignSlotContent` table; `ConflictException` (already imported).
- Produces: no signature change — `updateEvent` still returns `Promise<CampaignDto>`; behaviour extended so a `newTime` differing from the slot's current time moves the slot's `time` column (content preserved) or 409s.

**Design note (ordering — read before coding):** The current method (1) finds the slot by `(campaignId, date, channelId, time?)`, (2) loads campaign status, (3) `assertLaunchedSlotEditable`, (4) merges content + writes it, (5) if `active` + `scheduled`, re-materializes. The `newTime` move must be handled as a REJECTION on a launched campaign (per spec: pre-launch only) and as a pure `time`-column update otherwise. Insert the `newTime` handling **after** `assertLaunchedSlotEditable` and **before** the existing content write, so the single `.set(...)` writes both `time` and merged `content` together. The launched re-materialize block below is unaffected: a launched campaign with `newTime` is rejected before it, and a `newTime`-less update flows through unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `src/campaigns/campaigns.service.spec.ts`. Follow the existing spec's mocking style for `db` (the campaigns suite already mocks the Drizzle `db` query builder — reuse that harness; if the suite has a `updateEvent` describe block, add these there, otherwise add a new `describe('updateEvent — newTime move', ...)`). The four cases:

```ts
describe('updateEvent — newTime move', () => {
  it('moves the slot to newTime and preserves merged content when the target time is free', async () => {
    // Arrange: a draft campaign, one slot at 17:00 with content { caption: 'hi' }.
    // No slot exists at 18:00. dto = { date, channelId, patch: { caption: 'bye' }, time: '17:00', newTime: '18:00' }.
    // Act: await service.updateEvent(workspaceId, campaignId, dto)
    // Assert: db.update(campaignSlotContent).set was called with an object whose
    //   time === '18:00' and content.caption === 'bye' (merged patch preserved).
  })

  it('throws ConflictException when a slot already exists at newTime', async () => {
    // Arrange: draft campaign, slot at 17:00, AND an existing slot at 18:00 for the same (campaign,date,channel).
    // dto newTime = '18:00'.
    // Act/Assert: expect(service.updateEvent(...)).rejects.toBeInstanceOf(ConflictException)
    //   and no db.update writing time:'18:00' happened.
  })

  it('throws ConflictException when the campaign is launched (active) and newTime is set', async () => {
    // Arrange: campaign.status = 'active', slot at 17:00 (slotStatus 'scheduled'). dto newTime = '18:00'.
    // Act/Assert: rejects with ConflictException; the slot's time is not moved.
  })

  it('leaves content-only behaviour unchanged when newTime is absent', async () => {
    // Arrange: draft campaign, slot at 17:00. dto = { date, channelId, patch: { caption: 'x' }, time: '17:00' } (no newTime).
    // Act: updateEvent
    // Assert: db.update(...).set called with content.caption === 'x' and NO `time` key in the set payload
    //   (or time unchanged at '17:00') — i.e. same as today.
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- campaigns.service`
Expected: the four new cases FAIL (the move/collision/launched-reject logic doesn't exist yet; the "unchanged" case may pass already — that's fine, it's a guard against regression).

- [ ] **Step 3: Implement the `newTime` handling in `updateEvent`**

In `src/campaigns/campaigns.service.ts`, `updateEvent`, insert a block after `this.assertLaunchedSlotEditable(campaignStatus, slot.slotStatus);` (line ~1364) and before `const mergedContent = ...`. Then fold `time` into the existing content-write `.set(...)`:

```ts
    this.assertLaunchedSlotEditable(campaignStatus, slot.slotStatus);

    // Content-preserving time move. Pre-launch only: moving a launched slot
    // would need a re-materialize at the new fire time (out of scope here), so
    // reject it with a clear 409 — the picker is disabled there anyway.
    const movingTime = !!dto.newTime && dto.newTime !== slot.time;
    if (movingTime) {
      if (campaignStatus === 'active') {
        throw new ConflictException(
          'Change this post’s time before launching the campaign.',
        );
      }
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

    const mergedContent: ChannelDayContentJson = { ...slot.content, ...dto.patch };

    await db
      .update(campaignSlotContent)
      .set({
        content: mergedContent,
        ...(movingTime ? { time: dto.newTime! } : {}),
        updatedAt: new Date(),
      })
      .where(eq(campaignSlotContent.id, slot.id));
```

The existing `if (campaignStatus === 'active' && slot.slotStatus === 'scheduled')` re-materialize block that follows stays untouched — it can't run alongside a `movingTime` path because `movingTime` on an `active` campaign already threw above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- campaigns.service`
Expected: all four new cases PASS; the rest of the campaigns suite stays green.

- [ ] **Step 5: Verify the backend compiles**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/campaigns/campaigns.service.ts src/campaigns/campaigns.service.spec.ts
git commit -m "feat(campaigns): move a slot's time via updateEvent newTime (409 on collision/launched)"
```

---

### Task 3: Frontend — thread `newTime` through the API + mutation hook

**Files:**
- Modify: `src/features/campaigns/api/campaigns.api.ts:129-142` (the `updateEvent` API wrapper)
- Modify: `src/features/campaigns/hooks/use-campaign-event-mutations.ts:59-73` (the `updateEvent` mutation)

**Interfaces:**
- Consumes: nothing new from earlier tasks (the backend accepts `newTime`).
- Produces: `campaignsApi.updateEvent(workspaceId, id, date, channelId, patch, time?, newTime?)` and the `updateEvent` mutation's variables gain optional `newTime?: string` — consumed by Task 7 (composer) and Task 8 (composer wiring).

- [ ] **Step 1: Add `newTime` to the API wrapper**

In `src/features/campaigns/api/campaigns.api.ts`, extend `updateEvent` (currently takes `time?` last):

```ts
  updateEvent: (
    workspaceId: string,
    id: string,
    date: string,
    channelId: string,
    patch: Partial<ChannelDayContent>,
    time?: string,
    newTime?: string,
  ) =>
    apiClient.patch<Campaign>(`${base(workspaceId)}/${id}/events`, {
      date,
      channelId,
      patch,
      ...(time ? { time } : {}),
      ...(newTime ? { newTime } : {}),
    }),
```

- [ ] **Step 2: Add `newTime` to the mutation variables**

In `src/features/campaigns/hooks/use-campaign-event-mutations.ts`, extend the `updateEvent` mutation:

```ts
  const updateEvent = useMutation({
    mutationFn: ({
      date,
      channelId,
      patch,
      time,
      newTime,
    }: {
      date: string
      channelId: string
      patch: Partial<ChannelDayContent>
      time?: string
      newTime?: string
    }) =>
      campaignsApi.updateEvent(workspaceId, campaignId, date, channelId, patch, time, newTime),
    onSuccess: onDone,
    onError: onFail,
  })
```

- [ ] **Step 3: Verify the frontend compiles**

Run: `npm run build`
Expected: PASS (types line up; no consumer passes `newTime` yet).

- [ ] **Step 4: Commit**

```bash
git add src/features/campaigns/api/campaigns.api.ts src/features/campaigns/hooks/use-campaign-event-mutations.ts
git commit -m "feat(campaigns): thread optional newTime through updateEvent api + mutation"
```

---

### Task 4: Frontend — `isSlotPastDue` timezone-correct util

**Files:**
- Create: `src/features/campaigns/utils/slot-timing.ts`
- Test: `src/features/campaigns/utils/slot-timing.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `isSlotPastDue(date: string, time: string, timezone: string, now: Date): boolean` — consumed by Tasks 5 (preflight), 6 (days), 8 (badge). Returns `true` when the slot's absolute instant is strictly before `now`; a slot exactly at `now` is NOT past-due.

**Design note:** Mirror the backend's `wallClockToUtc` (`campaign-schedule.util.ts:47-63`): treat the wall-clock as UTC first, measure the zone's offset at that instant via `Intl.DateTimeFormat`, then subtract the offset. This keeps FE past-due detection consistent with what the backend will actually do at launch (DST-correct, no library).

- [ ] **Step 1: Write the failing tests**

Create `src/features/campaigns/utils/slot-timing.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isSlotPastDue } from './slot-timing'

describe('isSlotPastDue', () => {
  // Reference now: 2026-08-16T12:00:00Z
  const now = new Date('2026-08-16T12:00:00Z')

  it('is true when the slot instant is before now (UTC zone)', () => {
    // 2026-08-16 11:00 UTC < 12:00 UTC now
    expect(isSlotPastDue('2026-08-16', '11:00', 'UTC', now)).toBe(true)
  })

  it('is false when the slot instant is after now (UTC zone)', () => {
    expect(isSlotPastDue('2026-08-16', '13:00', 'UTC', now)).toBe(false)
  })

  it('is false when the slot instant is exactly now', () => {
    // 12:00 UTC === now → NOT past due (matches backend >= now → due)
    expect(isSlotPastDue('2026-08-16', '12:00', 'UTC', now)).toBe(false)
  })

  it('respects the timezone offset (Asia/Karachi = UTC+5)', () => {
    // 16:00 in Karachi (UTC+5) === 11:00 UTC < 12:00 UTC now → past due
    expect(isSlotPastDue('2026-08-16', '16:00', 'Asia/Karachi', now)).toBe(true)
    // 18:00 in Karachi === 13:00 UTC > now → not past due
    expect(isSlotPastDue('2026-08-16', '18:00', 'Asia/Karachi', now)).toBe(false)
  })

  it('returns false for a malformed date or time (never falsely blocks)', () => {
    expect(isSlotPastDue('not-a-date', '11:00', 'UTC', now)).toBe(false)
    expect(isSlotPastDue('2026-08-16', 'bad', 'UTC', now)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- slot-timing`
Expected: FAIL with "Cannot find module './slot-timing'" (the file doesn't exist yet).

- [ ] **Step 3: Implement `isSlotPastDue`**

Create `src/features/campaigns/utils/slot-timing.ts`:

```ts
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_RE = /^(\d{2}):(\d{2})$/

/** Minutes to add to a UTC wall-clock to reach the given zone's local time at
 *  `at` (i.e. the zone's offset from UTC in minutes). Mirrors the backend's
 *  zoneOffsetMinutes in campaign-schedule.util.ts. */
function zoneOffsetMinutes(timeZone: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = dtf.formatToParts(at)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    // Intl can emit '24' for midnight in some engines — normalize to 0.
    get('hour') % 24,
    get('minute'),
    get('second'),
  )
  return Math.round((asUtc - at.getTime()) / 60000)
}

/** Absolute UTC instant of a wall-clock `date` + `HH:mm` interpreted in
 *  `timeZone`. Returns null for malformed input. Mirrors the backend's
 *  wallClockToUtc so FE past-due detection matches launch behaviour. */
function wallClockToUtc(date: string, time: string, timeZone: string): Date | null {
  const d = DATE_RE.exec(date)
  const t = TIME_RE.exec(time)
  if (!d || !t) return null
  const [, y, mo, da] = d
  const [, hh, mm] = t
  const naiveUtcMs = Date.UTC(+y, +mo - 1, +da, +hh, +mm, 0, 0)
  let offsetMin = 0
  try {
    offsetMin = zoneOffsetMinutes(timeZone, new Date(naiveUtcMs))
  } catch {
    offsetMin = 0 // invalid zone → UTC fallback
  }
  return new Date(naiveUtcMs - offsetMin * 60000)
}

/** True when the slot's absolute instant is strictly before `now`. A slot
 *  exactly at `now` is NOT past-due (matches backend `>= now → due`). A
 *  malformed date/time is treated as NOT past-due so a bad value never
 *  falsely blocks a launch. */
export function isSlotPastDue(
  date: string,
  time: string,
  timezone: string,
  now: Date,
): boolean {
  const at = wallClockToUtc(date, time, timezone)
  if (!at) return false
  return at.getTime() < now.getTime()
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- slot-timing`
Expected: all cases PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/campaigns/utils/slot-timing.ts src/features/campaigns/utils/slot-timing.spec.ts
git commit -m "feat(campaigns): add timezone-correct isSlotPastDue util (mirrors backend wallClockToUtc)"
```

---

### Task 5: Frontend — `pastDue` preflight blocker

**Files:**
- Modify: `src/features/campaigns/utils/preflight.ts:60-127` (`computePreflight` + a new `findPastDueReadySlots` helper)
- Modify: `src/features/campaigns/components/builder/builder-header.tsx:236` (call site)
- Modify: `src/features/campaigns/components/builder/preflight-summary.tsx:18` (call site)
- Test: `src/features/campaigns/utils/preflight.spec.ts` (add a `pastDue` describe block)

**Interfaces:**
- Consumes: `isSlotPastDue` (Task 4); the campaign's `schedule.timezone` (present on every schedule variant — `campaign.ts:51/70/84`); `parseSlotKey`, `isChannelDayFilled`, `parseISODate`, `format` (already imported in `preflight.ts`).
- Produces: `computePreflight(campaign, channelNameById?, now?)` — a new optional third param `now: Date = new Date()`. When any *filled* (would-publish) slot is past-due, a `{ id: 'pastDue', label, hint }` blocker is appended. Consumed by the two call sites (they gate Launch on `blockers.length > 0` — no call-site logic change needed beyond passing `now`).

**Design note:** Model `findPastDueReadySlots` on the existing `findMissingDestinationSlots` (`preflight.ts:36-49`) — same iteration over `slotContent` → `channelContent`, same `parseSlotKey(key).channelId`, but the gate is `isChannelDayFilled(content) && isSlotPastDue(date, parseSlotKey(key).time, tz, now)`. Only *filled* slots count: an empty/unfilled past-due slot wouldn't publish anyway, so it must NOT block launch (that would trap the user with an un-fixable blocker on a slot they never authored). Skip `day.skip` days.

- [ ] **Step 1: Write the failing tests**

Add to `src/features/campaigns/utils/preflight.spec.ts` (the file already builds a `campaign` fixture — reuse its fixture builder / shape; the existing messaging-destination tests show the exact `slotContent` → `channelContent` shape to construct). Add:

```ts
describe('computePreflight — past-due blocker', () => {
  // now anchored well after the past slot, before the future slot
  const now = new Date('2026-08-16T12:00:00Z')

  it('blocks launch when a filled slot is past-due', () => {
    // Build a campaign (timezone 'UTC') with one FILLED slot at date 2026-08-16, time '11:00'
    // (key `ch1@11:00`) — 11:00 UTC < now. Everything else valid (name, channels).
    const blockers = computePreflight(campaign, { ch1: '#general' }, now)
    expect(blockers.some((b) => b.id === 'pastDue')).toBe(true)
    // label names the channel + time
    const pd = blockers.find((b) => b.id === 'pastDue')!
    expect(pd.label).toMatch(/#general/)
  })

  it('does not block when the only past-due slot is unfilled (empty caption + no media)', () => {
    // Same date/time but the slot content is empty → wouldn't publish → not a blocker.
    const blockers = computePreflight(campaign, {}, now)
    expect(blockers.some((b) => b.id === 'pastDue')).toBe(false)
  })

  it('does not block when all filled slots are in the future', () => {
    // Filled slot at time '13:00' (13:00 UTC > now) → no pastDue blocker.
    const blockers = computePreflight(campaign, {}, now)
    expect(blockers.some((b) => b.id === 'pastDue')).toBe(false)
  })

  it('summarizes extra past-due slots with a (+N more) suffix', () => {
    // Two filled past-due slots → label ends with "(+1 more)".
    const blockers = computePreflight(campaign, { ch1: '#general', ch2: '#random' }, now)
    const pd = blockers.find((b) => b.id === 'pastDue')!
    expect(pd.label).toMatch(/\+1 more/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- preflight`
Expected: the four new cases FAIL (no `pastDue` blocker exists; `computePreflight` ignores its third arg).

- [ ] **Step 3: Implement `findPastDueReadySlots` + the blocker**

In `src/features/campaigns/utils/preflight.ts`:

Add the import at the top (next to the existing `./slot-key` import):

```ts
import { isSlotPastDue } from './slot-timing'
```

Add the helper (after `findMissingDestinationSlots`):

```ts
interface PastDueSlot {
  channelId: string
  date: string
  time: string
}

/** Every filled (would-publish) slot whose time has already passed, in
 *  slotContent key-iteration order. Only filled slots count — an unfilled
 *  past-due slot wouldn't publish, so it must not trap the launch. */
function findPastDueReadySlots(campaign: Campaign, now: Date): PastDueSlot[] {
  const tz = campaign.schedule.timezone
  const found: PastDueSlot[] = []
  for (const [date, day] of Object.entries(campaign.slotContent)) {
    if (day.skip) continue
    for (const [key, content] of Object.entries(day.channelContent)) {
      if (!isChannelDayFilled(content)) continue
      const { channelId, time } = parseSlotKey(key)
      if (!time) continue // legacy/bulk-without-time key — can't evaluate
      if (isSlotPastDue(date, time, tz, now)) {
        found.push({ channelId, date, time })
      }
    }
  }
  return found
}
```

Change the signature and append the blocker (before `return blockers`):

```ts
export function computePreflight(
  campaign: Campaign,
  channelNameById: Record<string, string> = {},
  now: Date = new Date(),
): PreflightBlocker[] {
  // ...existing blockers unchanged...

  const pastDueSlots = findPastDueReadySlots(campaign, now)
  if (pastDueSlots.length > 0) {
    const [first] = pastDueSlots
    const channelName = channelNameById[first.channelId] ?? 'this channel'
    const dateLabel = format(parseISODate(first.date), 'MMM d')
    const extra = pastDueSlots.length - 1
    blockers.push({
      id: 'pastDue',
      label:
        extra > 0
          ? `Past due: ${channelName} on ${dateLabel} (+${extra} more)`
          : `Past due: ${channelName} on ${dateLabel}`,
      hint: 'This post’s time has already passed. Change its time or remove it before launching.',
    })
  }

  return blockers
}
```

- [ ] **Step 4: Pass `now` at the two call sites**

In `src/features/campaigns/components/builder/builder-header.tsx:236`, change:

```ts
  const blockers = computePreflight(campaign, channelNameById)
```
to:
```ts
  const blockers = computePreflight(campaign, channelNameById, new Date())
```

In `src/features/campaigns/components/builder/preflight-summary.tsx:18`, change:

```ts
  const blockers = computePreflight(campaign, channelNameById)
```
to:
```ts
  const blockers = computePreflight(campaign, channelNameById, new Date())
```

(Both compute `blockers` on every render, so `new Date()` re-evaluates each render — a slot ticking past its time flips the button to disabled on the next render/refetch. No timer needed for this task; the existing query invalidation already re-renders on data changes.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -- preflight`
Expected: the four new cases PASS; the existing preflight tests (name/channels/content/notifications/destination) stay green — they call `computePreflight` with 1-2 args, and `now` defaults to `new Date()`, which won't retroactively make their fixture slots past-due (their fixtures use far-future or unfilled slots — verify none of them use a filled past-date slot; if one does, it was already relying on time-blindness — pass an explicit future `now` there to keep it green and note it in the report).

- [ ] **Step 6: Verify the frontend compiles**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/features/campaigns/utils/preflight.ts src/features/campaigns/utils/preflight.spec.ts src/features/campaigns/components/builder/builder-header.tsx src/features/campaigns/components/builder/preflight-summary.tsx
git commit -m "feat(campaigns): block launch when a filled slot is past-due (preflight blocker)"
```

---

### Task 6: Frontend — Days-column past-due marker

**Files:**
- Modify: `src/features/campaigns/utils/campaign-days.ts` (`DaySummary` + `campaignDaySummaries`)
- Modify: `src/features/campaigns/components/builder/bonzo/days-column.tsx` (render the marker)
- Test: `src/features/campaigns/utils/campaign-days.spec.ts` (create if absent, or add a describe block if present)

**Interfaces:**
- Consumes: `isSlotPastDue` (Task 4); `campaign.schedule.timezone`; existing `parseSlotKey`, `isChannelDayFilled`.
- Produces: `DaySummary` gains `hasPastDue: boolean`; `campaignDaySummaries(campaign, now?)` gains an optional `now: Date = new Date()`. Consumed by `days-column.tsx`.

**Design note:** `campaignDaySummaries` already iterates `day.channelContent` and computes `readyCount` via `isChannelDayFilled`. Add a parallel `hasPastDue` = "any filled slot on this day whose time is past-due". Reuse the same filled gate so the marker and the preflight blocker agree.

- [ ] **Step 1: Write the failing test**

Create/extend `src/features/campaigns/utils/campaign-days.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { campaignDaySummaries } from './campaign-days'

describe('campaignDaySummaries — hasPastDue', () => {
  const now = new Date('2026-08-16T12:00:00Z')

  it('marks a day with a filled past-due slot', () => {
    // campaign timezone 'UTC', window includes 2026-08-16, a filled slot at '11:00'.
    const [day] = campaignDaySummaries(campaign, now).filter((d) => d.date === '2026-08-16')
    expect(day.hasPastDue).toBe(true)
  })

  it('does not mark a day whose filled slots are all in the future', () => {
    // filled slot at '13:00'
    const [day] = campaignDaySummaries(campaign, now).filter((d) => d.date === '2026-08-16')
    expect(day.hasPastDue).toBe(false)
  })

  it('does not mark a day whose past-due slot is unfilled', () => {
    const [day] = campaignDaySummaries(campaign, now).filter((d) => d.date === '2026-08-16')
    expect(day.hasPastDue).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- campaign-days`
Expected: FAIL (`hasPastDue` doesn't exist on `DaySummary`).

- [ ] **Step 3: Implement `hasPastDue`**

In `src/features/campaigns/utils/campaign-days.ts`:

Add the import:
```ts
import { isSlotPastDue } from './slot-timing'
```

Add `hasPastDue: boolean` to the `DaySummary` interface (after `channelIds`).

Change the signature and compute it inside the `.map`:
```ts
export function campaignDaySummaries(
  campaign: Campaign,
  now: Date = new Date(),
): DaySummary[] {
  const s = campaign.schedule
  const tz = s.timezone
  // ...existing days filter unchanged...
  return days.map((date) => {
    const day = campaign.slotContent[date]
    // ...existing channelIds / entries / total / readyCount / skipped / status...
    const hasPastDue = day
      ? Object.entries(day.channelContent).some(([key, c]) => {
          if (!isChannelDayFilled(c)) return false
          const { time } = parseSlotKey(key)
          return !!time && isSlotPastDue(date, time, tz, now)
        })
      : false
    return { date, readyCount, total, skipped, status, channelIds, hasPastDue }
  })
}
```

- [ ] **Step 4: Render the marker in the Days column**

In `src/features/campaigns/components/builder/bonzo/days-column.tsx`, find where each day's `readyCount`/`status` is rendered (the "N/M ready" text and status dot). Add a past-due marker for `day.hasPastDue` using theme tokens only — a small destructive dot + "past due" text alongside the existing summary. Example (adapt to the file's actual per-day markup — read it first and match its structure):

```tsx
{day.hasPastDue && (
  <span className="inline-flex items-center gap-1 text-[10px] font-medium text-destructive">
    <span className="size-1.5 rounded-full bg-destructive" />
    Past due
  </span>
)}
```

Keep the existing ready/partial/empty/skipped states unchanged.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -- campaign-days`
Expected: PASS.

- [ ] **Step 6: Verify the frontend compiles**

Run: `npm run build`
Expected: PASS (every `campaignDaySummaries` call still type-checks — the new `now` param is optional; the new `DaySummary.hasPastDue` is populated everywhere the summaries are built).

- [ ] **Step 7: Commit**

```bash
git add src/features/campaigns/utils/campaign-days.ts src/features/campaigns/utils/campaign-days.spec.ts src/features/campaigns/components/builder/bonzo/days-column.tsx
git commit -m "feat(campaigns): mark days with a past-due filled slot in the Days column"
```

---

### Task 7: Frontend — "Past due" badge on the slot card

**Files:**
- Modify: `src/features/campaigns/components/builder/bonzo/channels-column.tsx` (badge render ~line 341-350, inside the `.map` at ~line 265)
- Test: `src/features/campaigns/components/builder/bonzo/channels-column.spec.tsx` (create if absent — a focused render test; if the project has no component-test harness for this file, cover the badge decision via a tiny exported pure helper instead — see Step 3 note)

**Interfaces:**
- Consumes: `isSlotPastDue` (Task 4); `campaign.schedule.timezone`; `isLaunched` prop (already on `ChannelsColumn`); `isChannelDayFilled`; the per-row `time` + `content` already destructured in the `.map`.
- Produces: a red "Past due" badge rendered next to the time badge for a NON-launched campaign's filled, past-due slot.

**Design note:** Only for `!isLaunched` (a launched campaign shows the real runtime badge — never touch that path). The badge appears when the slot is filled AND past-due. Place it right after the existing time badge (`channels-column.tsx:341-349`), before `{statusBadge}`. Use `text-destructive` tokens. Add a Tooltip (the file already imports `Tooltip`/`TooltipContent`/`TooltipTrigger`/`TooltipProvider`, and the row is already inside a `TooltipProvider`).

- [ ] **Step 1: Compute `isPastDue` per row**

Inside the `.map(([rowSlotKey, content]) => { ... })` block (~line 265), after `const mediaCount = content.media.length`, add:

```ts
              const isFilledForTiming = isChannelDayFilled(content)
              const isPastDue =
                !isLaunched &&
                isFilledForTiming &&
                !!time &&
                isSlotPastDue(selectedDate, time, campaign.schedule.timezone, new Date())
```

`selectedDate` is the day being rendered (it's the guard on this branch — the rows belong to `selectedDate`). Add the imports at the top of the file:

```ts
import { isChannelDayFilled } from '../../../types/slot-content'
import { isSlotPastDue } from '../../../utils/slot-timing'
```

(Verify the relative path for `slot-content` matches the file's existing imports — `channels-column.tsx` already imports from `'../../../constants/...'` and `'../../../utils/...'`, so `slot-content` is `'../../../types/slot-content'`.)

- [ ] **Step 2: Render the badge**

Right after the time badge block (`channels-column.tsx:341-349`, the `{!isBulk && time && (<Badge>…</Badge>)}`) and before `{statusBadge}`, add:

```tsx
                      {isPastDue && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Badge
                                variant="secondary"
                                className="shrink-0 gap-1 px-1.5 font-normal text-destructive"
                              >
                                <Clock className="size-2.5" />
                                Past due
                              </Badge>
                            }
                          />
                          <TooltipContent side="top">
                            This time has passed — change it or remove this post before launching.
                          </TooltipContent>
                        </Tooltip>
                      )}
```

(`Badge`, `Clock`, `Tooltip`, `TooltipTrigger`, `TooltipContent` are all already imported in this file. The `TooltipTrigger render={...}` pattern is the basecn idiom already used at line 300-310.)

- [ ] **Step 3: Add a test**

Prefer a focused render test if `channels-column` already has a `.spec.tsx` sibling or the project renders components in Vitest with `@testing-library/react`. Assert: rendering `ChannelsColumn` with a non-launched campaign whose selected day has a filled slot at a past time shows "Past due"; a future-time slot does not; a launched campaign never shows it.

If there is **no** existing component-test harness for this column (check for other `*.spec.tsx` under `components/builder/`), do NOT stand one up just for this — instead extract the badge decision into a tiny exported pure function in `slot-timing.ts` and unit-test that:

```ts
// in slot-timing.ts
export function shouldShowPastDueBadge(
  isLaunched: boolean,
  isFilled: boolean,
  date: string,
  time: string,
  timezone: string,
  now: Date,
): boolean {
  return !isLaunched && isFilled && !!time && isSlotPastDue(date, time, timezone, now)
}
```
and call it from `channels-column.tsx` (`const isPastDue = shouldShowPastDueBadge(isLaunched, isChannelDayFilled(content), selectedDate, time, campaign.schedule.timezone, new Date())`). Then test `shouldShowPastDueBadge` in `slot-timing.spec.ts` (launched → false; unfilled → false; future → false; filled past draft → true). **Ruling for the implementer:** pick whichever matches the repo's existing test conventions; record which you chose in the report.

- [ ] **Step 4: Run the tests**

Run: `npm run test -- channels-column` (or `slot-timing` if you took the pure-helper route)
Expected: PASS.

- [ ] **Step 5: Verify the frontend compiles**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/campaigns/components/builder/bonzo/channels-column.tsx src/features/campaigns/utils/slot-timing.ts src/features/campaigns/utils/slot-timing.spec.ts
git commit -m "feat(campaigns): show a red Past due badge on filled past-due draft slots"
```

(Adjust the staged paths to exactly the files you touched — do NOT stage a `.spec.tsx` you didn't create.)

---

### Task 8: Frontend — time picker in the composer (the move UI)

**Files:**
- Modify: `src/features/campaigns/components/builder/event-composer.tsx` (add the `TimePickerSelect` to the editable branches' identity block + a `handleTimeChange` that calls `updateEvent` with `newTime`)
- Test: covered by the mutation-call assertion below (or a focused render test if a composer harness exists)

**Interfaces:**
- Consumes: `TimePickerSelect` (`src/features/inbox/components/composer/time-picker-select.tsx` — `hour24`, `minute`, `onChange({hour24, minute})`); the `updateEvent` mutation's new `newTime` var (Task 3); `slotKey` (already imported); the `time` prop + `onSelectSlot` re-selection.
- Produces: user picks a time → `updateEvent.mutate({ date, channelId, time: <old>, patch: draft, newTime: <picked HH:mm> })`; on success re-selects the moved slot; on 409 toasts the server message.

**Design note (scope discipline — read carefully):** The composer has three render branches: read-only (`!editable`, ~line 180), AI-review (~line 234), and normal editable (~line 296). The time picker belongs ONLY in the **editable** branches (AI-review and normal) — never in the read-only branch (a launched/published slot's time must stay fixed). Put it in the shared `identity` block? No — `identity` is reused by the read-only branch too. Instead render the picker as a small row directly under the identity line, in the AI-review and normal branches only. Keep it OUT of the read-only branch entirely.

The picker also needs the slot re-selected after a move (the slot key changes from `channelId@oldTime` to `channelId@newTime`, so the composer's `time` prop would otherwise point at a now-missing slot). Call `onSelectSlot` — but `EventComposer` doesn't currently receive it. Check `ComposerColumn` (the parent): if it already knows the selected slot key, thread an `onTimeChanged?(newKey: string)` callback down, or have `EventComposer` accept the parent's slot-selection setter. **Ruling for the implementer:** the cleanest wiring is to add an optional `onSlotMoved?: (newSlotKey: string) => void` prop to `EventComposer`, call it in the mutation's `onSuccess`, and have `ComposerColumn` pass its existing "select slot" handler. Read `composer-column.tsx` first to confirm the handler's name; if the parent selects by slot key, this is a one-line pass-through.

- [ ] **Step 1: Read the parent to confirm slot-selection wiring**

Read `src/features/campaigns/components/builder/composer-column.tsx` (or wherever `EventComposer` is rendered — grep `EventComposer`) to find how the selected slot key is set. Note the setter's name for Step 3.

- [ ] **Step 2: Add a `parseHHmm` helper + the time-change handler in `event-composer.tsx`**

Near the top of the component (after `const stored = ...`), add a local parse of the current `time` into hour/minute for the picker, and a handler:

```ts
  // Current slot time → hour24/minute for the picker. `time` is 'HH:mm'.
  const [th, tm] = time.split(':').map(Number)
  const hour24 = Number.isFinite(th) ? th : 9
  const minute = Number.isFinite(tm) ? tm : 0

  function handleTimeChange(next: { hour24: number; minute: number }) {
    const newTime = `${String(next.hour24).padStart(2, '0')}:${String(next.minute).padStart(2, '0')}`
    if (newTime === time) return
    mutations.updateEvent.mutate(
      { date, channelId, time, newTime, patch: { ...draft } },
      {
        onSuccess: () => onSlotMoved?.(slotKey(channelId, newTime)),
        onError: (err: unknown) => {
          // Server 409 (collision / launched) — surface its message; the picker
          // reverts to the old time on the next render since the move didn't take.
          const message =
            err instanceof Error ? err.message : 'Could not change the time.'
          toast.error(message)
        },
      },
    )
  }
```

Add the `onSlotMoved` prop to `EventComposerProps`:
```ts
  /** Called after a successful time move so the parent can re-select the slot
   *  at its new key (the slot key encodes the time). */
  onSlotMoved?: (newSlotKey: string) => void
```
and accept it in the destructured params (with the other props).

- [ ] **Step 3: Render `TimePickerSelect` in the two editable branches**

Import it at the top:
```ts
import { TimePickerSelect } from '@/features/inbox/components/composer/time-picker-select'
```

In the **normal editable** branch (the final `return`, ~line 296) and the **AI-review** branch (~line 234), add a compact time-picker row directly under the pinned top bar (after the `identity`/Save bar `</div>`, before the authoring surface). Example for the normal branch:

```tsx
      {/* Editable slot time — moving it reschedules where this post fires. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-4 py-2">
        <span className="text-[11px] font-medium text-muted-foreground">Time</span>
        <TimePickerSelect
          hour24={hour24}
          minute={minute}
          onChange={handleTimeChange}
          className="max-w-[220px]"
        />
      </div>
```

Wire the parent (`composer-column.tsx`) to pass `onSlotMoved={<its slot-select setter>}` — using the setter name found in Step 1 (e.g. `onSlotMoved={setSelectedSlotKey}` or `onSlotMoved={handleSelectSlot}`).

Do NOT add the picker to the read-only branch (`if (!editable)`, ~line 180).

- [ ] **Step 4: Verify the frontend compiles + existing tests green**

Run: `npm run build`
Expected: PASS.
Run: `npm run test -- campaigns`
Expected: existing campaigns FE tests stay green.

- [ ] **Step 5: Commit**

```bash
git add src/features/campaigns/components/builder/event-composer.tsx src/features/campaigns/components/builder/composer-column.tsx
git commit -m "feat(campaigns): edit a slot's time in the composer (time picker → newTime move)"
```

(Stage only the files you actually touched — confirm the parent file's real name from Step 1.)

---

### Task 9: Full build + test gate (both repos)

**Files:** none (verification task).

**Interfaces:** none.

- [ ] **Step 1: Backend build + tests**

In `socialmedia-workspace`:
Run: `npm run build` → Expected: PASS.
Run: `npm run test -- campaigns` → Expected: PASS (all campaigns specs, including the new `newTime` cases).

- [ ] **Step 2: Frontend build + tests**

In `socialmedia-frontend-campaigns`:
Run: `npm run build` → Expected: PASS.
Run: `npm run test` → Expected: PASS (slot-timing, preflight, campaign-days, and whatever composer/channels-column tests were added; existing suites green).

- [ ] **Step 3: Ledger the result**

Record both build/test outcomes in the SDD ledger. No commit (nothing changed).

---

## Self-Review

**1. Spec coverage:**
- Spec §2 "Editable slot time (pre-launch)" → Tasks 1, 2 (backend `newTime` move + 409s), 3, 8 (FE picker + wiring). ✅
- Spec §2 "Past-due in 3 places: red badge / preflight blocker / days indicator" → Task 7 (badge), Task 5 (preflight), Task 6 (days). ✅
- Spec §2 "Launch rule: BLOCK until fixed" → Task 5 (the `pastDue` blocker feeds the existing `blockers.length > 0` launch gate at `builder-header.tsx:237`). ✅
- Spec §2 "timezone-correct comparison" → Task 4 (`isSlotPastDue` mirrors `wallClockToUtc`). ✅
- Spec §4.1a/1b (DTO + move + collision 409 + launched 409) → Tasks 1, 2. ✅
- Spec §4.2c (past-due util), 2d (badge), 2e (blocker), 2f (days), 2a/2b (picker + api) → Tasks 4, 7, 5, 6, 8, 3. ✅
- Spec §7 testing (backend move/collision/launched/no-newTime; FE isSlotPastDue/preflight/badge/picker) → Tasks 2, 4, 5, 6, 7. ✅

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". The two rulings-for-implementer (Task 7 test strategy, Task 8 parent-wiring name) are explicit decision points with a stated default + a "confirm from the file" instruction, not vague placeholders — they exist because the exact parent handler name can't be known without reading `composer-column.tsx`, and the plan tells the implementer to read it and which default to take.

**3. Type consistency:**
- `isSlotPastDue(date, time, timezone, now)` — same 4-arg signature in Tasks 4, 5, 6, 7. ✅
- `computePreflight(campaign, channelNameById?, now?)` — third param added in Task 5; both call sites updated in the same task. ✅
- `campaignDaySummaries(campaign, now?)` + `DaySummary.hasPastDue` — added and consumed within Task 6. ✅
- `updateEvent(..., time?, newTime?)` — API (Task 3) → mutation var `newTime?` (Task 3) → composer call (Task 8). ✅
- `UpdateEventDto.newTime?` (Task 1) consumed by `updateEvent` (Task 2). ✅
- `onSlotMoved?: (newSlotKey: string) => void` — defined + called in Task 8, passed by the parent in the same task. ✅

Plan is internally consistent and fully covers the spec.
