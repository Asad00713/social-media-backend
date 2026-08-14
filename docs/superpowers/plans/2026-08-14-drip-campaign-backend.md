# Drip Campaign Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Drip campaign type work create→publish on the backend, reusing the bulk launch/publish path, with true multi-time slots (Buffer model).

**Architecture:** Add a `time` dimension to `campaign_slot_content` (bulk defaults to its `defaultTime`, so bulk is unchanged). On drip create, materialize `campaign_days` for every weekday-matching date in `[start,end]`. Teach the publishing scheduler (`computeSlotSchedule`) and launch/resume to schedule each slot at its own `(date,time)`. Add `CreateDripCampaignDto` + a `/drip` create route.

**Tech Stack:** NestJS, Drizzle ORM (Postgres/Neon→Railway), class-validator, BullMQ, Jest.

**Spec:** `docs/superpowers/specs/2026-08-14-drip-campaign-type-design.md`

## Global Constraints

- **Backend-only.** Frontend (Layer 3) is a separate follow-up turn; do NOT touch `socialmedia-frontend*` in this plan.
- **Bulk stays byte-for-byte behaviourally unchanged.** Every existing bulk test must still pass. The `time` column defaults bulk slots to their schedule's `defaultTime`; bulk callers of `addEvent`/scheduler omit `time` and get that default.
- **No committed Drizzle migration** (mirrors `project_campaigns_backend_phase1`). Ship one idempotent SQL script under `docs/superpowers/` that the USER applies to local + Railway prod. The implementer runs NO `db:*` / `psql` / migration commands and does not touch the live DB.
- **Never `git add -A` / `git add .`** — backend `.env` is gitignored with live secrets. Stage only the exact files each task lists.
- **`endDate` REQUIRED** for drip v1 (finite materialization; no rolling job).
- **Multi-time = true multi-slot**: each `(campaignId, date, channelId, time)` is one slot / one post. `maxPostCount` caps **slots** (date×time), not days.
- **Timezone:** reuse `wallClockToUtc` from `campaign-schedule.util.ts`; add no new tz logic.
- Prettier: single quotes, trailing commas. `class-validator` DTOs with the existing `ValidationPipe` (whitelist + forbidNonWhitelisted).

---

## File Structure

- `src/drizzle/schema/campaigns.schema.ts` — add `time` column + swap unique index on `campaignSlotContent`.
- `docs/superpowers/2026-08-14-drip-slot-time-migration.sql` — idempotent migration script (NEW, user-applied).
- `src/campaigns/campaign-schedule.util.ts` — drip branch in `computeSlotSchedule`, keyed on `(date,time)` pairs.
- `src/campaigns/campaign-schedule.util.spec.ts` — drip + multi-time tests.
- `src/campaigns/campaign-publishing.service.ts` — `time` in `MaterializeInput`, jobId, and slot metadata.
- `src/campaigns/dto/campaigns.dto.ts` — `CreateDripCampaignDto`; `time?` on `AddEventDto`/`RemoveEventDto`/`UpdateEventDto`.
- `src/campaigns/campaigns.service.ts` — `createDrip`, drip materialization, `time`-aware slot methods, launch/resume per-slot scheduling.
- `src/campaigns/campaigns.service.spec.ts` — createDrip + materialization + bulk-unchanged tests.
- `src/campaigns/campaigns.controller.ts` — `POST .../drip` route.

---

### Task 1: Schema — add `time` to slot content + migration script

**Files:**
- Modify: `src/drizzle/schema/campaigns.schema.ts:186-211` (`campaignSlotContent` table + unique index)
- Create: `docs/superpowers/2026-08-14-drip-slot-time-migration.sql`

**Interfaces:**
- Produces: `campaignSlotContent.time` column (`varchar(5)`, NOT NULL, `HH:mm`); unique index `campaign_slot_content_campaign_date_channel_time_uq` on `(campaignId, date, channelId, time)`.

- [ ] **Step 1: Add the column + swap the unique index in the Drizzle schema**

In `campaignSlotContent` (`campaigns.schema.ts`), add after the `channelId` line:

```ts
    time: varchar('time', { length: 5 }).notNull(), // HH:mm — slot's fire time
```

Replace the `uqCampaignDateChannel` index block with:

```ts
  (t) => ({
    uqCampaignDateChannelTime: uniqueIndex(
      'campaign_slot_content_campaign_date_channel_time_uq',
    ).on(t.campaignId, t.date, t.channelId, t.time),
  }),
```

- [ ] **Step 2: Write the idempotent migration SQL**

Create `docs/superpowers/2026-08-14-drip-slot-time-migration.sql`:

```sql
-- Drip campaign multi-time slots: add `time` to campaign_slot_content.
-- Idempotent — safe to re-run. Apply to local + Railway prod BEFORE deploying.
BEGIN;

-- 1. Add the column nullable so the backfill can run.
ALTER TABLE campaign_slot_content
  ADD COLUMN IF NOT EXISTS "time" varchar(5);

-- 2. Backfill existing (bulk) slots with their campaign's schedule default time.
--    schedule is jsonb; bulk schedules carry `defaultTime`.
UPDATE campaign_slot_content sc
SET "time" = COALESCE(c.schedule ->> 'defaultTime', '09:00')
FROM campaigns c
WHERE sc.campaign_id = c.id
  AND sc."time" IS NULL;

-- 3. Any orphan/edge rows with still-null time → safe default.
UPDATE campaign_slot_content SET "time" = '09:00' WHERE "time" IS NULL;

-- 4. Enforce NOT NULL.
ALTER TABLE campaign_slot_content ALTER COLUMN "time" SET NOT NULL;

-- 5. Swap the unique index to include time.
DROP INDEX IF EXISTS campaign_slot_content_campaign_date_channel_uq;
CREATE UNIQUE INDEX IF NOT EXISTS
  campaign_slot_content_campaign_date_channel_time_uq
  ON campaign_slot_content (campaign_id, "date", channel_id, "time");

COMMIT;
```

- [ ] **Step 3: Verify the schema compiles**

Run: `npm run build`
Expected: PASS (tsc clean; the new column is referenced by later tasks).

- [ ] **Step 4: Commit**

```bash
git add src/drizzle/schema/campaigns.schema.ts docs/superpowers/2026-08-14-drip-slot-time-migration.sql
git commit -m "feat(campaigns): add time column to slot content for multi-time drip slots"
```

> **Note for controller:** after this task, PAUSE and tell the user the SQL script must be applied to local + prod before the launch/publish tasks can be smoke-tested. Implementation of later tasks does NOT require the DB (unit tests use mocks), so continue building; only live testing is gated.

---

### Task 2: `computeSlotSchedule` — drip branch on (date,time) pairs

**Files:**
- Modify: `src/campaigns/campaign-schedule.util.ts:65-97`
- Test: `src/campaigns/campaign-schedule.util.spec.ts`

**Interfaces:**
- Consumes: `CampaignScheduleJson` (bulk|drip|evergreen), `wallClockToUtc(date,time,tz)`.
- Produces: new signature `computeSlotSchedule(schedule, slots, now)` where `slots: { date: string; time: string }[]` and the return is `{ due: SlotSchedule[]; pastDue: { date: string; time: string }[] }` with `SlotSchedule = { date, time, scheduledAt }`. **Bulk callers pass one `{date, time}` per date using the resolved bulk time.** This makes the function slot-oriented so multi-time drip works and bulk is a 1-time-per-date special case.

- [ ] **Step 1: Write failing tests for the drip branch**

Add to `campaign-schedule.util.spec.ts` a `drip()` helper and cases:

```ts
function drip(overrides: Partial<Extract<CampaignScheduleJson, { type: 'drip' }>> = {}) {
  return {
    type: 'drip' as const,
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    weekdays: [1, 3, 5], // Mon/Wed/Fri
    times: ['09:00', '17:00'],
    timezone: 'UTC',
    blackoutDates: [],
    ...overrides,
  };
}

describe('computeSlotSchedule — drip', () => {
  const now = new Date('2026-09-01T00:00:00Z');

  it('schedules each (date,time) slot at its own UTC instant', () => {
    const { due, pastDue } = computeSlotSchedule(
      drip(),
      [
        { date: '2026-09-02', time: '09:00' }, // Wed
        { date: '2026-09-02', time: '17:00' },
      ],
      now,
    );
    expect(pastDue).toEqual([]);
    expect(due).toHaveLength(2);
    expect(due[0].scheduledAt.toISOString()).toBe('2026-09-02T09:00:00.000Z');
    expect(due[1].scheduledAt.toISOString()).toBe('2026-09-02T17:00:00.000Z');
  });

  it('marks a past-due slot pastDue, keeps a future slot due', () => {
    const midday = new Date('2026-09-02T12:00:00Z');
    const { due, pastDue } = computeSlotSchedule(
      drip(),
      [
        { date: '2026-09-02', time: '09:00' }, // past
        { date: '2026-09-02', time: '17:00' }, // future
      ],
      midday,
    );
    expect(pastDue).toEqual([{ date: '2026-09-02', time: '09:00' }]);
    expect(due).toHaveLength(1);
    expect(due[0].time).toBe('17:00');
  });

  it('excludes blackout dates', () => {
    const { due, pastDue } = computeSlotSchedule(
      drip({ blackoutDates: ['2026-09-02'] }),
      [{ date: '2026-09-02', time: '09:00' }],
      now,
    );
    expect(due).toEqual([]);
    expect(pastDue).toEqual([]); // blackout = excluded, not past-due
  });

  it('honors timezone (Asia/Karachi +5)', () => {
    const { due } = computeSlotSchedule(
      drip({ timezone: 'Asia/Karachi' }),
      [{ date: '2026-09-02', time: '09:00' }],
      new Date('2026-09-01T00:00:00Z'),
    );
    expect(due[0].scheduledAt.toISOString()).toBe('2026-09-02T04:00:00.000Z');
  });
});
```

Also update the EXISTING bulk tests: they call `computeSlotSchedule(bulk(), ['2026-09-02'], now)` with a `string[]`. Change those call sites to pass `[{ date: '2026-09-02', time: '09:00' }]` (the resolved bulk time — `perDayTimes[date] ?? defaultTime`), and assert `due[0].date`/`scheduledAt` as before (add `time` to assertions where natural). This keeps bulk coverage green under the new signature.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- campaign-schedule.util`
Expected: FAIL (new signature/branch not implemented).

- [ ] **Step 3: Rewrite `computeSlotSchedule` slot-oriented**

Replace the body (`campaign-schedule.util.ts:65-97`) with:

```ts
export interface SlotSchedule {
  date: string; // yyyy-MM-dd
  time: string; // HH:mm
  scheduledAt: Date;
}

export interface SlotKey {
  date: string;
  time: string;
}

export function computeSlotSchedule(
  schedule: CampaignScheduleJson,
  slots: SlotKey[],
  now: Date,
): { due: SlotSchedule[]; pastDue: SlotKey[] } {
  const due: SlotSchedule[] = [];
  const pastDue: SlotKey[] = [];

  // Bulk & drip share the same per-slot logic now: each slot has an explicit
  // (date, time); we exclude blackout/weekend and split due vs past-due.
  // Evergreen has no endDate bound here; treat like drip within the window.
  const blackout = new Set(schedule.blackoutDates ?? []);
  const skipWeekends = schedule.type === 'bulk' && schedule.skipWeekends;

  for (const slot of slots) {
    if (blackout.has(slot.date)) continue; // excluded, not counted past-due
    if (skipWeekends && isWeekend(slot.date)) continue;

    const at = wallClockToUtc(slot.date, slot.time, schedule.timezone);
    if (!at) continue;

    if (at.getTime() >= now.getTime()) {
      due.push({ date: slot.date, time: slot.time, scheduledAt: at });
    } else {
      pastDue.push({ date: slot.date, time: slot.time });
    }
  }

  return { due, pastDue };
}
```

(The old `perDayTimes`/`defaultTime` resolution moves OUT of this function into the caller, which now passes an explicit time per slot. `isWeekend` and `wallClockToUtc` already exist in this file.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- campaign-schedule.util`
Expected: PASS (drip + bulk).

- [ ] **Step 5: Commit**

```bash
git add src/campaigns/campaign-schedule.util.ts src/campaigns/campaign-schedule.util.spec.ts
git commit -m "feat(campaigns): slot-oriented schedule computation with drip multi-time support"
```

---

### Task 3: Publishing service — `time` in jobId, input, metadata

**Files:**
- Modify: `src/campaigns/campaign-publishing.service.ts:10-19,34-37,49-82`

**Interfaces:**
- Consumes: nothing new.
- Produces: `MaterializeInput` gains `time: string`; `buildJobId(campaignId, date, channelId, time)`; post metadata `campaignSlot` gains `time`.

- [ ] **Step 1: Add `time` to `MaterializeInput`**

In the `MaterializeInput` interface (`:10-19`) add after `channelId`:

```ts
  time: string; // HH:mm — the slot's fire time; disambiguates multi-time slots
```

- [ ] **Step 2: Make the job id include `time`**

Replace `buildJobId` (`:34-37`):

```ts
  /** Deterministic per-(campaign,date,channel,time) job id → idempotent
   *  enqueue. Time is REQUIRED in the key so two same-day/same-channel drip
   *  slots (e.g. 09:00 and 17:00) don't collide onto one job id. */
  buildJobId(
    campaignId: string,
    date: string,
    channelId: string,
    time: string,
  ): string {
    return `campaign-${campaignId}-${date}-${channelId}-${time}`;
  }
```

- [ ] **Step 3: Thread `time` through `materializeAndEnqueue`**

In `materializeAndEnqueue` (`:49-82`): pass `input.time` into `buildJobId(...)`, and add `time: input.time` to the `campaignSlot` metadata object (`:73`).

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: PASS. (Callers in `campaigns.service.ts` are updated in Task 5; if the build flags the missing `time` arg there, that's expected and fixed in Task 5 — build this task in isolation by temporarily confirming only this file's types via `npx tsc --noEmit` is NOT required; a red build here from the caller is acceptable and resolved in Task 5. If you prefer green-at-every-commit, do Steps 1-3 here and defer the commit to fold into Task 5. Ruling left to executor; default: proceed and let Task 5 restore green.)

- [ ] **Step 5: Commit** (if green in isolation; otherwise fold into Task 5)

```bash
git add src/campaigns/campaign-publishing.service.ts
git commit -m "feat(campaigns): include slot time in campaign job id, input and metadata"
```

---

### Task 4: DTOs — `CreateDripCampaignDto` + `time` on event DTOs

**Files:**
- Modify: `src/campaigns/dto/campaigns.dto.ts`

**Interfaces:**
- Produces: `CreateDripCampaignDto`; `AddEventDto.time?`, `RemoveEventDto.time?`, `UpdateEventDto.time?` (all optional `HH:mm`, default resolved in the service).

- [ ] **Step 1: Add `CreateDripCampaignDto`**

After `CreateSimpleCampaignDto` (`:43`), add:

```ts
export class CreateDripCampaignDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsDateString()
  startDate: string; // yyyy-MM-dd

  @IsDateString()
  endDate: string; // yyyy-MM-dd — REQUIRED in v1 (finite materialization)

  @IsString()
  timezone: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  weekdays: number[]; // 0=Sun … 6=Sat

  @IsArray()
  @ArrayNotEmpty()
  @Matches(/^\d{2}:\d{2}$/, { each: true, message: 'each time must be HH:mm' })
  times: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  maxPostCount?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  blackoutDates?: string[];
}
```

Add the missing imports to the top `class-validator` import (`:1-11`): `ArrayNotEmpty`, `IsInt`, `Min`, `Max`.

- [ ] **Step 2: Add optional `time` to the event DTOs**

To `AddEventDto` (`:123-137`), `RemoveEventDto` (`:150-156`), and `UpdateEventDto` (`:139-148`) add:

```ts
  @IsOptional()
  @Matches(/^\d{2}:\d{2}$/, { message: 'time must be HH:mm' })
  time?: string;
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/campaigns/dto/campaigns.dto.ts
git commit -m "feat(campaigns): add CreateDripCampaignDto and optional slot time on event DTOs"
```

---

### Task 5: Service — `createDrip`, materialization, time-aware slots + launch/resume

**Files:**
- Modify: `src/campaigns/campaigns.service.ts` (`createSimple` neighbourhood ~607, `addEvent`/`updateEvent`/`removeEvent`, `launch` ~760-834, `resume` ~882+, `computeSlotSchedule` call sites)
- Test: `src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `CreateDripCampaignDto`, `computeSlotSchedule(schedule, SlotKey[], now)` (Task 2), `materializeAndEnqueue({ ..., time })` (Task 3).
- Produces: `createDrip(workspaceId, userId, dto): Promise<CampaignDto>`; `addEvent`/`removeEvent`/`updateEvent` carry `time` (defaulting to the schedule's resolved time); launch/resume schedule per slot's own `(date,time)`.

- [ ] **Step 1: Write failing service tests**

In `campaigns.service.spec.ts` add a `createDrip` describe. Follow the file's existing mocking style (it mocks `db`). Assert:
- `createDrip` inserts a campaign with `type:'drip'` and a drip schedule JSON built from the DTO.
- It creates `campaign_days` rows ONLY for dates in `[start,end]` whose weekday ∈ `weekdays`, excluding `blackoutDates`.
- With `maxPostCount = N`, at most N **slots' worth** of days are materialized — i.e. `ceil(N / times.length)` days (document + assert this exact rule).
- A control test: `createSimple` still inserts `type:'bulk'` and materializes no days (unchanged).

(Match the spec file's existing assertions/mocks; if the current suite doesn't unit-test day-materialization for bulk, mirror whatever seam it uses — e.g. spy on the `db.insert(campaignDays)` builder.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- campaigns.service`
Expected: FAIL (`createDrip` not defined).

- [ ] **Step 3: Implement `createDrip` + a `materializeDripDays` helper**

Add near `createSimple` (`:607`):

```ts
/** Every yyyy-MM-dd in [start,end] whose weekday ∈ weekdays, minus blackout,
 *  in chronological order. `maxPostCount` caps total SLOTS (days × times), so
 *  the day cap is ceil(maxPostCount / timesPerDay). */
private materializeDripDates(
  startDate: string,
  endDate: string,
  weekdays: number[],
  blackout: string[],
  timesPerDay: number,
  maxPostCount?: number,
): string[] {
  const wanted = new Set(weekdays);
  const skip = new Set(blackout);
  const out: string[] = [];
  let cursor = this.parseIsoDate(startDate);
  const end = this.parseIsoDate(endDate);
  if (!cursor || !end) return out;

  const dayCap =
    maxPostCount && timesPerDay > 0
      ? Math.ceil(maxPostCount / timesPerDay)
      : Infinity;

  // Guard against a pathological range; the schedule window is user-bounded.
  for (let i = 0; i < 3660 && cursor <= end && out.length < dayCap; i += 1) {
    const iso = this.toIsoDate(cursor);
    if (wanted.has(cursor.getDay()) && !skip.has(iso)) out.push(iso);
    cursor = this.addDays(cursor, 1);
  }
  return out;
}

async createDrip(
  workspaceId: string,
  userId: string,
  dto: CreateDripCampaignDto,
): Promise<CampaignDto> {
  const blackout = dto.blackoutDates ?? [];
  const schedule: CampaignScheduleJson = {
    type: 'drip',
    startDate: dto.startDate,
    endDate: dto.endDate,
    weekdays: [...dto.weekdays].sort((a, b) => a - b),
    times: [...dto.times].sort(),
    timezone: dto.timezone,
    blackoutDates: blackout,
    ...(dto.maxPostCount != null ? { maxPostCount: dto.maxPostCount } : {}),
  };

  const [row] = await db
    .insert(campaigns)
    .values({
      workspaceId,
      createdById: userId,
      name: dto.name,
      description: dto.description?.trim() ? dto.description.trim() : null,
      type: 'drip',
      status: 'draft',
      schedule,
      contentSource: 'manual',
      aiConfig: null,
      libraryTemplateIds: [],
      channelIds: [],
      platforms: [],
    })
    .returning();

  const dates = this.materializeDripDates(
    dto.startDate,
    dto.endDate,
    schedule.weekdays,
    blackout,
    schedule.times.length,
    dto.maxPostCount,
  );
  if (dates.length > 0) {
    await db
      .insert(campaignDays)
      .values(dates.map((date) => ({ campaignId: row.id, date })));
  }

  return this.assembleCampaign(row.id);
}
```

(`parseIsoDate`/`toIsoDate`/`addDays` already exist as private helpers in this service — reuse them, don't redefine.)

- [ ] **Step 4: Make slot methods time-aware**

In `addEvent`: resolve a slot time — `dto.time ?? resolveDefaultTime(existing.schedule)`, where a small helper returns `schedule.defaultTime` for bulk or `schedule.times[0]` for drip/evergreen. Insert the slot with that `time`. In `removeEvent`/`updateEvent`, match on `(date, channelId, time)` when a `time` is provided; when omitted (bulk callers), match on `(date, channelId)` — for bulk that's still unique. Add:

```ts
private resolveDefaultTime(schedule: CampaignScheduleJson): string {
  return schedule.type === 'bulk'
    ? schedule.defaultTime
    : (schedule.times[0] ?? '09:00');
}
```

- [ ] **Step 5: Update launch/resume to schedule per slot's own time**

In `launch` (`:787-826`) and the equivalent block in `resume`: replace the date-only schedule call. Build slot keys from the publishable slots (which now carry `time` — ensure `collectPublishableSlots` selects `campaignSlotContent.time`):

```ts
const slotKeys = publishable.map((s) => ({ date: s.date, time: s.time }));
const { due, pastDue } = computeSlotSchedule(campaign.schedule, slotKeys, new Date());
const dueByKey = new Map(due.map((d) => [`${d.date}|${d.time}`, d.scheduledAt]));
const pastDueSet = new Set(pastDue.map((p) => `${p.date}|${p.time}`));
```

Then in the per-slot loop, key on `${slot.date}|${slot.time}` instead of `slot.date`, and pass `time: slot.time` into `materializeAndEnqueue(...)`. Update `collectPublishableSlots`' returned shape to include `time` (select the column; add to the mapped object).

- [ ] **Step 6: Run the full campaigns suite**

Run: `npm test -- campaigns`
Expected: PASS (createDrip + materialization + all existing bulk tests still green).

- [ ] **Step 7: Full build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/campaigns/campaigns.service.ts src/campaigns/campaigns.service.spec.ts src/campaigns/campaign-publishing.service.ts
git commit -m "feat(campaigns): createDrip materialization + time-aware slots and launch"
```

---

### Task 6: Controller — `POST .../drip` route

**Files:**
- Modify: `src/campaigns/campaigns.controller.ts:17-27,64-76`
- Test: `src/campaigns/campaigns.controller.spec.ts` (if it asserts route wiring)

**Interfaces:**
- Consumes: `createDrip` (Task 5), `CreateDripCampaignDto` (Task 4).
- Produces: `POST /campaigns/workspaces/:workspaceId/drip`.

- [ ] **Step 1: Import + add the route**

Add `CreateDripCampaignDto` to the DTO import. Add after `createSimple` (`:76`):

```ts
  @Post('workspaces/:workspaceId/drip')
  @HttpCode(HttpStatus.CREATED)
  async createDrip(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: CreateDripCampaignDto,
  ) {
    return this.campaignsService.createDrip(workspaceId, user.userId, dto);
  }
```

(Route order: `/drip` is a fixed segment under `workspaces/:workspaceId`, distinct from `workspaces/:workspaceId/:id` — Nest matches the static `drip` route via method+path; the `:id` GET is a different verb/path, no collision. Verify the existing `status-counts` precedent.)

- [ ] **Step 2: Build + controller test**

Run: `npm test -- campaigns.controller && npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/campaigns/campaigns.controller.ts src/campaigns/campaigns.controller.spec.ts
git commit -m "feat(campaigns): POST /drip create route"
```

---

### Task 7: Full backend green + smoke checklist

**Files:** none (verification only).

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS (no regressions across the backend).

- [ ] **Step 2: Full build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Write the smoke note**

Append to the plan's ledger the manual smoke steps the USER runs after applying the SQL:
1. Apply `docs/superpowers/2026-08-14-drip-slot-time-migration.sql` to local + Railway prod.
2. `POST /campaigns/workspaces/:ws/drip` with weekdays `[1,3,5]`, times `['09:00','17:00']`, a 2-week window → campaign created, `campaign_days` only on Mon/Wed/Fri.
3. In the builder, fill a slot on one day/channel/time; `POST .../launch` → a real scheduled post appears at the right instant; a second time-slot on the same day/channel → a SECOND distinct post (job ids differ).
4. Confirm existing bulk campaigns still create/launch unchanged.

---

## Self-Review

- **Spec coverage:** Layer 1 (schema+migration) → Task 1. Layer 2 (scheduler drip, DTO, createDrip+materialize, launch/resume multi-time, route, tests) → Tasks 2-6. Multi-slot `time` key → Tasks 1,3,5. `maxPostCount` = slot-count → Task 5 Step 3. Bulk-unchanged → Tasks 2 (bulk tests updated), 5 (default-time resolution). Layer 3 (frontend) is explicitly out of this plan.
- **Placeholder scan:** all code steps carry real code; no TBD/"handle edge cases".
- **Type consistency:** `computeSlotSchedule(schedule, SlotKey[], now)` returns `{ due: SlotSchedule[]; pastDue: SlotKey[] }` — consumed with that shape in Task 5 Step 5. `buildJobId(...,time)` (Task 3) matches the call in Task 5. `MaterializeInput.time` (Task 3) matches `materializeAndEnqueue({...,time})` (Task 5). `resolveDefaultTime`/`materializeDripDates` defined once in Task 5 and reused.
- **Open ruling for executor:** Task 3's isolated build may go red until Task 5 restores green (caller not yet updated) — acceptable; fold Task 3's commit into Task 5 if green-per-commit is desired.
