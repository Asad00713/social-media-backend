# Launched-Campaign Slot View & Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a launched campaign, let users open published slots read-only in the composer and truly edit still-scheduled slots (edits actually re-publish), while fixing the live bug where post-launch edits silently publish stale content.

**Architecture:** Backend-first. A shared guard classifies each slot edit on a launched (`active`) campaign as read-only (409) or editable-with-re-materialize. The editable path reuses the proven `pause` primitive (cancel job → race-safe `posts` delete → re-enqueue) per single slot. Frontend makes launched slots selectable and drives the composer into read-only vs editable mode by the slot's `runtime.slotStatus`.

**Tech Stack:** NestJS + Drizzle + BullMQ (backend, `socialmedia-workspace`); Vite + React 19 + TS + Tailwind 3 + shadcn + TanStack Query (frontend, worktree `socialmedia-frontend-campaigns`). Both on branch `feat/launched-slot-edit` off `main`.

**Spec:** `socialmedia-workspace/docs/superpowers/specs/2026-08-16-launched-slot-edit-design.md`

## Global Constraints

- **NO DB migration** — all changes are logic + existing columns (`campaign_slot_content.slotStatus/postId/jobId`, `campaigns.status`).
- **Draft-campaign behaviour byte-for-byte unchanged** — guards only engage when `campaign.status === 'active'`.
- **Reuse the `pause` primitive's race-safe delete:** `db.delete(posts).where(and(eq(posts.id, postId), eq(posts.status, 'scheduled')))` — NEVER delete an in-flight (`publishing`) post. A 0-row delete means the post already fired → 409, abort the edit.
- **Editable slot statuses** = `pending`, `scheduled`. **Read-only** = `publishing`, `published`, `failed`, `skipped`.
- **shadcn-only UI**, theme tokens only (no hex, no arbitrary Tailwind colors).
- **Never** `git add .`/`-A`. FE `.env` is git-tracked with secrets; BE `.env` gitignored with secrets. Surgical `git add <path>` only.
- Messaging effort (`feat/campaign-messaging-channels`) is now MERGED into main and this branch was rebased onto it — so `MessageComposer` (`src/features/campaigns/components/create/steps/composers/message-composer.tsx`) and the `'message'` post type EXIST on this branch. The read-only prop must thread through `ChannelDayComposer` AND `MessageComposer` (a launched Slack/Discord slot renders read-only too: destination picker disabled, message textarea read-only, no media add/remove).

---

## BACKEND (all backend tasks before frontend)

### Task 1: `assertSlotEditable` guard helper + reusable single-slot cancel

**Files:**
- Modify: `socialmedia-workspace/src/campaigns/campaigns.service.ts` (add private helpers)
- Test: `socialmedia-workspace/src/campaigns/campaigns.service.spec.ts` (extend)

**Interfaces:**
- Produces:
  - `private assertLaunchedSlotEditable(campaignStatus: string, slotStatus: string): void` — throws `ConflictException` if `campaignStatus === 'active'` AND `slotStatus ∈ {publishing, published, failed, skipped}`; no-op otherwise. Consumed by Tasks 2, 3, 4.
  - `private async cancelAndClearSlotPost(slot: { jobId: string | null; postId: string | null }): Promise<boolean>` — cancels the job (if any) and deletes the `posts` row guarded on `status='scheduled'`; returns `true` if safe to proceed, `false` if the post already fired (0-row delete). Consumed by Tasks 2, 4.

**Context:** `campaigns.service.ts` imports: `ConflictException` from `@nestjs/common` (add to the existing import), `posts` from `../drizzle/schema/posts.schema`, `and`/`eq` from `drizzle-orm` (already imported), `this.publishing.cancelSlotJob`. The `pause` method (`:975-1012`) is the exact template for `cancelAndClearSlotPost`.

- [ ] **Step 1: Write the failing test.** In `campaigns.service.spec.ts`, add unit tests for `assertLaunchedSlotEditable` (call it via a tiny cast to access the private, or test through `updateEvent` in Task 2 — prefer a direct private-method test here). Cases:
  - `assertLaunchedSlotEditable('draft', 'published')` → does NOT throw (draft unguarded).
  - `assertLaunchedSlotEditable('active', 'scheduled')` → does NOT throw.
  - `assertLaunchedSlotEditable('active', 'pending')` → does NOT throw.
  - `assertLaunchedSlotEditable('active', 'published')` → throws `ConflictException`.
  - `assertLaunchedSlotEditable('active', 'publishing')` → throws.
  - `assertLaunchedSlotEditable('active', 'failed')` → throws.
  - `assertLaunchedSlotEditable('active', 'skipped')` → throws.

```ts
// access private via cast
const svc = /* constructed service */;
const call = (cs: string, ss: string) => (svc as any).assertLaunchedSlotEditable(cs, ss);
expect(() => call('draft', 'published')).not.toThrow();
expect(() => call('active', 'scheduled')).not.toThrow();
expect(() => call('active', 'published')).toThrow(ConflictException);
// ...etc
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `cd socialmedia-workspace && npx jest src/campaigns/campaigns.service.spec.ts -t assertLaunchedSlotEditable`
Expected: FAIL (method undefined).

- [ ] **Step 3: Implement both helpers.**

```ts
private assertLaunchedSlotEditable(campaignStatus: string, slotStatus: string): void {
  if (campaignStatus !== 'active') return; // draft/scheduled/paused/etc. — unguarded
  const readOnly = ['publishing', 'published', 'failed', 'skipped'];
  if (readOnly.includes(slotStatus)) {
    throw new ConflictException(
      slotStatus === 'skipped'
        ? 'This post was skipped and can no longer be edited.'
        : 'This post has already been published and can no longer be edited.',
    );
  }
}

/** Cancels the enqueued job and deletes the not-yet-fired posts row for one
 *  slot (mirrors `pause`, race-safe on posts.status='scheduled'). Returns
 *  false if the post already flipped to publishing (0 rows deleted) — the
 *  caller must abort with 409 rather than re-materialize a fired post. */
private async cancelAndClearSlotPost(slot: {
  jobId: string | null;
  postId: string | null;
}): Promise<boolean> {
  if (slot.jobId) await this.publishing.cancelSlotJob(slot.jobId);
  if (slot.postId) {
    const deleted = await db
      .delete(posts)
      .where(and(eq(posts.id, slot.postId), eq(posts.status, 'scheduled')))
      .returning({ id: posts.id });
    if (deleted.length === 0) return false; // already publishing/published
  }
  return true;
}
```

**Note for implementer:** confirm `ConflictException` is added to the `@nestjs/common` import; confirm `posts` schema import exists (add if missing); confirm `.returning()` is supported by this Drizzle/pg setup (it is — used elsewhere). If `db.delete(...).returning()` isn't available in this driver, use `.rowCount`-style check the project already uses; grep for an existing guarded delete to match the idiom.

- [ ] **Step 4: Run tests to verify pass.**

Run: `cd socialmedia-workspace && npx jest src/campaigns/campaigns.service.spec.ts -t assertLaunchedSlotEditable`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/campaigns/campaigns.service.ts src/campaigns/campaigns.service.spec.ts
git commit -m "feat(campaigns): slot-edit guard + single-slot cancel-and-clear helper (launched safety)"
```

---

### Task 2: `updateEvent` — guard + re-materialize on launched scheduled slots

**Files:**
- Modify: `socialmedia-workspace/src/campaigns/campaigns.service.ts` (`updateEvent`, `:1272-1308`)
- Test: `socialmedia-workspace/src/campaigns/campaigns.service.spec.ts` (extend)

**Interfaces:**
- Consumes: `assertLaunchedSlotEditable`, `cancelAndClearSlotPost` (Task 1); `computeSlotSchedule` (`../campaigns/campaign-schedule.util` — already imported/used in `launch`); `publishing.materializeAndEnqueue`; `resolveSlotChannels`/`loadCreatedById` (used in `launch`).

**Context:** `updateEvent` currently reads the slot, merges `dto.patch` into `slot.content`, writes it back. It must now: (a) also load the campaign row's `status` (it only has `getOne` returning a DTO — read the raw `campaigns` row for `status`, or add `status` to what `getOne` exposes; simplest: a small `db.select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.id, id))`); (b) call the guard with `(campaign.status, slot.slotStatus)`; (c) for a launched `scheduled` slot, after writing merged content, re-materialize.

- [ ] **Step 1: Write failing tests.** Cases (mock `publishing.materializeAndEnqueue` → `{postId:'p2', jobId:'j2'}`, `cancelSlotJob`, and the db calls following the spec's existing mocking style):
  - Draft campaign: `updateEvent` merges content, does NOT call cancel/materialize (unchanged behaviour).
  - Active campaign + slot `published`: throws `ConflictException`, no content write.
  - Active + slot `scheduled`, not past-due: merges content → calls `cancelAndClearSlotPost` (cancel + delete) → `materializeAndEnqueue` with the MERGED content → stores new `postId/jobId/scheduledAt`, slotStatus `scheduled`.
  - Active + slot `scheduled` but post already publishing (cancelAndClearSlotPost returns false): throws `ConflictException`, does not re-enqueue.
  - Active + slot `scheduled`, edited slot now past-due (computeSlotSchedule returns it in `pastDue`): sets slotStatus `skipped`, does NOT re-enqueue.
  - Active + slot `pending`: merges content, no cancel/materialize (nothing enqueued yet).

- [ ] **Step 2: Run — verify fail.**

Run: `cd socialmedia-workspace && npx jest src/campaigns/campaigns.service.spec.ts -t updateEvent`
Expected: FAIL.

- [ ] **Step 3: Implement.** After the existing slot lookup + before/around the content write:

```ts
// Load campaign status (raw row) for the launched-edit guard.
const [camp] = await db
  .select({ status: campaigns.status })
  .from(campaigns)
  .where(eq(campaigns.id, id));
const campaignStatus = camp?.status ?? 'draft';

this.assertLaunchedSlotEditable(campaignStatus, slot.slotStatus);

const mergedContent: ChannelDayContentJson = { ...slot.content, ...dto.patch };

await db
  .update(campaignSlotContent)
  .set({ content: mergedContent, updatedAt: new Date() })
  .where(eq(campaignSlotContent.id, slot.id));

// Launched + still-scheduled: the enqueued post is stale — cancel & re-enqueue
// from the merged content so the NEW content actually fires.
if (campaignStatus === 'active' && slot.slotStatus === 'scheduled') {
  const safe = await this.cancelAndClearSlotPost({ jobId: slot.jobId, postId: slot.postId });
  if (!safe) {
    throw new ConflictException(
      'This post just started publishing and can no longer be edited. Reload to see its status.',
    );
  }
  const createdById = await this.loadCreatedById(id);
  const channelMap = await this.resolveSlotChannels([slot.channelId]);
  const platform = channelMap.get(slot.channelId);
  const { due, pastDue } = computeSlotSchedule(
    // reload the campaign schedule for computeSlotSchedule
    (await this.getOne(workspaceId, id)).schedule,
    [{ date: slot.date, time: slot.time }],
    new Date(),
  );
  const scheduledAt = due[0]?.scheduledAt;
  const isPastDue = pastDue.length > 0 || !scheduledAt;
  if (!platform || isPastDue) {
    await db
      .update(campaignSlotContent)
      .set({
        slotStatus: 'skipped',
        postId: null,
        jobId: null,
        scheduledAt: null,
        updatedAt: new Date(),
      })
      .where(eq(campaignSlotContent.id, slot.id));
  } else {
    const { postId, jobId } = await this.publishing.materializeAndEnqueue({
      workspaceId,
      createdById,
      campaignId: id,
      date: slot.date,
      channelId: slot.channelId,
      time: slot.time,
      content: mergedContent,
      platform,
      scheduledAt,
    });
    await db
      .update(campaignSlotContent)
      .set({ postId, jobId, scheduledAt, slotStatus: 'scheduled', updatedAt: new Date() })
      .where(eq(campaignSlotContent.id, slot.id));
  }
}
```

**Note for implementer:** the existing `updateEvent` already touches `campaigns.updatedAt` at the end — keep that. Confirm `campaigns` schema + `computeSlotSchedule` + `loadCreatedById`/`resolveSlotChannels` imports are present (all used by `launch`). If `slot` from the initial `select()` doesn't include `slotStatus`/`postId`/`jobId`/`time`, change the select to the full row (`.select()` already returns all columns — verify). Match the exact `materializeAndEnqueue` input shape from `launch` (`:942`).

- [ ] **Step 4: Run tests — pass.**

Run: `cd socialmedia-workspace && npx jest src/campaigns && npm run build`
Expected: campaigns tests PASS; build exit 0.

- [ ] **Step 5: Commit.**

```bash
git add src/campaigns/campaigns.service.ts src/campaigns/campaigns.service.spec.ts
git commit -m "fix(campaigns): re-materialize on edit of a launched scheduled slot (was publishing stale content)"
```

---

### Task 3: `addEvent` — guard on launched campaigns

**Files:**
- Modify: `socialmedia-workspace/src/campaigns/campaigns.service.ts` (`addEvent`, `:1210-1267`)
- Test: `socialmedia-workspace/src/campaigns/campaigns.service.spec.ts` (extend)

**Interfaces:**
- Consumes: `assertLaunchedSlotEditable` (Task 1).

**Context:** `addEvent` adds a NEW slot (or resets an existing one to empty content). On a launched campaign, adding a brand-new slot that never gets materialized would sit `pending` and never publish (launch already happened) — confusing. Decision: on a launched (`active`) campaign, **block adding a new slot** (409 "Add posts before launching, or edit an existing scheduled post."). Editing/re-adding over an existing slot is covered by `updateEvent`. This keeps `addEvent` simple and avoids a materialize-on-add path.

- [ ] **Step 1: Write failing tests.**
  - Draft campaign: `addEvent` works unchanged (inserts slot).
  - Active campaign: `addEvent` throws `ConflictException` (no insert).

- [ ] **Step 2: Run — verify fail.**

Run: `cd socialmedia-workspace && npx jest src/campaigns/campaigns.service.spec.ts -t addEvent`
Expected: FAIL.

- [ ] **Step 3: Implement.** Near the top of `addEvent`, after `getOne`/campaign load, read the campaign status and block if launched:

```ts
const [camp] = await db
  .select({ status: campaigns.status })
  .from(campaigns)
  .where(eq(campaigns.id, id));
if ((camp?.status ?? 'draft') === 'active') {
  throw new ConflictException(
    'This campaign is already launched — you can edit scheduled posts but not add new ones.',
  );
}
```

(Place BEFORE any slot insert/mutation.)

- [ ] **Step 4: Run tests + build.**

Run: `cd socialmedia-workspace && npx jest src/campaigns && npm run build`
Expected: PASS + exit 0.

- [ ] **Step 5: Commit.**

```bash
git add src/campaigns/campaigns.service.ts src/campaigns/campaigns.service.spec.ts
git commit -m "feat(campaigns): block adding new slots to a launched campaign"
```

---

### Task 4: `removeEvent` — guard + cancel job before delete

**Files:**
- Modify: `socialmedia-workspace/src/campaigns/campaigns.service.ts` (`removeEvent`, `:1310-1335`)
- Test: `socialmedia-workspace/src/campaigns/campaigns.service.spec.ts` (extend)

**Interfaces:**
- Consumes: `assertLaunchedSlotEditable`, `cancelAndClearSlotPost` (Task 1).

**Context:** current `removeEvent` deletes the slot row with NO guard and NO job cancel → on a launched campaign it orphans the enqueued job (post still fires) and breaks status tracking. Fix: load the slot first; guard; for a launched `scheduled` slot, cancel+clear the post before deleting the slot row.

- [ ] **Step 1: Write failing tests.**
  - Draft: `removeEvent` deletes the slot (unchanged).
  - Active + slot `published`: throws `ConflictException`, no delete.
  - Active + slot `scheduled`: calls `cancelAndClearSlotPost` (cancel + delete post) THEN deletes the slot row.
  - Active + slot `scheduled` but post already publishing (returns false): throws `ConflictException`, slot NOT deleted.

- [ ] **Step 2: Run — verify fail.**

Run: `cd socialmedia-workspace && npx jest src/campaigns/campaigns.service.spec.ts -t removeEvent`
Expected: FAIL.

- [ ] **Step 3: Implement.** Change `removeEvent` to load the slot (currently it deletes by match without selecting). Read the slot row (with `slotStatus/postId/jobId`) + campaign status; guard; cancel+clear if launched scheduled; then delete:

```ts
async removeEvent(workspaceId: string, id: string, dto: RemoveEventDto): Promise<CampaignDto> {
  await this.getOne(workspaceId, id);

  const [slot] = await db
    .select()
    .from(campaignSlotContent)
    .where(
      and(
        eq(campaignSlotContent.campaignId, id),
        eq(campaignSlotContent.date, dto.date),
        eq(campaignSlotContent.channelId, dto.channelId),
        ...(dto.time ? [eq(campaignSlotContent.time, dto.time)] : []),
      ),
    );

  if (slot) {
    const [camp] = await db
      .select({ status: campaigns.status })
      .from(campaigns)
      .where(eq(campaigns.id, id));
    const campaignStatus = camp?.status ?? 'draft';
    this.assertLaunchedSlotEditable(campaignStatus, slot.slotStatus);

    if (campaignStatus === 'active' && slot.slotStatus === 'scheduled') {
      const safe = await this.cancelAndClearSlotPost({ jobId: slot.jobId, postId: slot.postId });
      if (!safe) {
        throw new ConflictException(
          'This post just started publishing and can no longer be removed.',
        );
      }
    }

    await db.delete(campaignSlotContent).where(eq(campaignSlotContent.id, slot.id));
  }

  await db.update(campaigns).set({ updatedAt: new Date() }).where(eq(campaigns.id, id));
  await this.refreshChannelCache(id);
  return this.assembleCampaign(id);
}
```

(Preserves the "no slot found → still returns campaign" tolerance by guarding the whole block on `if (slot)`.)

- [ ] **Step 4: Run tests + build.**

Run: `cd socialmedia-workspace && npx jest src/campaigns && npm run build`
Expected: PASS + exit 0.

- [ ] **Step 5: Commit.**

```bash
git add src/campaigns/campaigns.service.ts src/campaigns/campaigns.service.spec.ts
git commit -m "fix(campaigns): cancel job + guard on removing a launched scheduled slot (was orphaning the post)"
```

---

## FRONTEND (after backend tasks complete)

> Worktree `socialmedia-frontend-campaigns`, branch `feat/launched-slot-edit`. Run FE commands with `cd socialmedia-frontend-campaigns`.

### Task 5: Make launched slots selectable + editability helper

**Files:**
- Create: `src/features/campaigns/utils/slot-editability.ts` (+ test)
- Modify: `src/features/campaigns/components/builder/bonzo/channels-column.tsx` (launched slots clickable; delete only for editable)

**Interfaces:**
- Produces: `isSlotEditable(content: ChannelDayContent, isLaunched: boolean): boolean` — `!isLaunched || (runtime?.slotStatus ?? 'pending') ∈ {pending, scheduled}`. Consumed by Tasks 5, 6.

- [ ] **Step 1: Write failing test.** `slot-editability.spec.ts`:
  - not launched → always editable (any status).
  - launched + no runtime → editable (treated pending).
  - launched + `scheduled` → editable.
  - launched + `pending` → editable.
  - launched + `published`/`publishing`/`failed`/`skipped` → NOT editable.

- [ ] **Step 2: Run — fail.**

Run: `cd socialmedia-frontend-campaigns && npx vitest run src/features/campaigns/utils/slot-editability.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement helper.**

```ts
import type { ChannelDayContent } from '../types/slot-content'

const EDITABLE_RUNTIME = new Set(['pending', 'scheduled'])

/** A slot is editable when the campaign isn't launched, or (launched) the
 *  slot hasn't fired yet (pending/scheduled). published/publishing/failed/
 *  skipped are read-only. */
export function isSlotEditable(content: ChannelDayContent, isLaunched: boolean): boolean {
  if (!isLaunched) return true
  return EDITABLE_RUNTIME.has(content.runtime?.slotStatus ?? 'pending')
}
```

- [ ] **Step 4: Make launched slots clickable in `channels-column.tsx`.** Currently launched slots render a non-clickable `<div>` (`:408-417`) with no delete. Change: render the SAME clickable `<button onClick={onSelectSlot}>` used for draft slots for ALL slots; keep the runtime status badge + timestamp (already present) in the card. Show the delete (trash) affordance only when `isSlotEditable(content, isLaunched)` is true (draft slots: always; launched: only pending/scheduled). Do NOT change the card's status badge/timestamp rendering.

- [ ] **Step 5: Run tests + build.**

Run: `cd socialmedia-frontend-campaigns && npx vitest run src/features/campaigns && npm run build`
Expected: PASS + exit 0.

- [ ] **Step 6: Commit.**

```bash
git add src/features/campaigns/utils/slot-editability.ts src/features/campaigns/utils/slot-editability.spec.ts src/features/campaigns/components/builder/bonzo/channels-column.tsx
git commit -m "feat(campaigns): launched slots open in the composer; delete only for still-editable slots"
```

---

### Task 6: Read-only composer mode + editable launched slot

**Files:**
- Modify: `src/features/campaigns/components/builder/bonzo/composer-column.tsx` (pass isLaunched)
- Modify: `src/features/campaigns/components/builder/campaign-builder-view.tsx` (pass isLaunched to ComposerColumn)
- Modify: `src/features/campaigns/components/builder/event-composer.tsx` (read-only vs editable; status strip)
- Modify: `src/features/campaigns/components/create/steps/composers/channel-day-composer.tsx` (thread a `readOnly` prop to disable inputs)

**Interfaces:**
- Consumes: `isSlotEditable` (Task 5); `resolveSlotBadge`/`SLOT_RUNTIME_CONFIG` (`constants/slot-runtime-config.tsx`) for the status strip.

**Context:** `campaign-builder-view.tsx` already computes `isLaunched` (`isCampaignLaunched(campaign)`) and passes it to `ChannelsColumn` but NOT to `ComposerColumn`. Thread it through. `EventComposer` (`event-composer.tsx`) computes the stored slot + draft; it must switch to a read-only presentation when the slot isn't editable.

- [ ] **Step 1: Thread `isLaunched` to the composer.** In `campaign-builder-view.tsx`, pass `isLaunched` to BOTH `<ComposerColumn>` instances (narrow drill-down + desktop). In `composer-column.tsx`, accept `isLaunched?: boolean` and forward to `<EventComposer>`.

- [ ] **Step 2: `EventComposer` editability.** Accept `isLaunched?: boolean`. Compute `const editable = isSlotEditable(stored ?? draftAsContent, isLaunched ?? false)` (use the STORED content's runtime status — a launched published slot is read-only regardless of draft). When `!editable`:
  - Render the composer body via `ChannelDayComposer` with a new `readOnly` prop (Step 4) so all inputs are disabled.
  - Replace the Save row with a status strip: the runtime badge (`resolveSlotBadge(stored)`), the published-at (`stored.runtime?.publishedAt`) or scheduled-at, and `stored.runtime?.lastError` for failed (in `text-destructive`). No Save button, no AI actions, no delete.
  - Theme tokens only.
  When `editable` AND `isLaunched`: keep the normal editable composer + Save, and add a subtle inline note near Save: "Saving reschedules this post." (muted text). On the `updateEvent` mutation success, if the returned slot's `runtime.slotStatus === 'skipped'`, `toast("This post's time has passed — it's now skipped.")`.

- [ ] **Step 3: Build the status strip + wire.** Use a shadcn `Badge` for the status; muted text for timestamps; `text-destructive` for errors. Keep it inside `EventComposer`'s existing pinned-top-bar layout so it reads consistently.

- [ ] **Step 4: `readOnly` prop through `ChannelDayComposer` AND `MessageComposer`.** Add `readOnly?: boolean` to `ChannelDayComposer` props; when true, disable the mode strip, post-type tabs, and pass `disabled`/`readOnly` to the body editors (`ManualBody`'s `EditorCard`/text/media, poll, thread). The simplest robust approach: when `readOnly`, render the body but wrap it so inputs are non-interactive (e.g. `EditorCard` `readOnly` / disabled textareas, `pointer-events-none` on media pickers with an explicit disabled visual — but PREFER real `disabled`/`readOnly` attributes over `pointer-events-none` for a11y). Confirm `EditorCard` supports a read-only/disabled prop; if not, gate the interactive affordances (add-media, template, AI) off and set the textarea `readOnly`. Non-readonly path unchanged.
  **Also thread `readOnly` into `MessageComposer`** (`create/steps/composers/message-composer.tsx`, from the merged messaging effort — `ChannelDayComposer` routes Slack/Discord slots there via its `platformCfg.default === 'message'` early-return): when `readOnly`, disable the `DestinationPicker` (Select disabled), make the message `Textarea` read-only, and hide/disable the media attach/replace/remove `Button`s — so a launched Slack/Discord published slot is inspectable but not editable. Thread the prop through the early-return call in `ChannelDayComposer` too. Non-readonly messaging path unchanged.

- [ ] **Step 5: Run tests + build.**

Run: `cd socialmedia-frontend-campaigns && npx vitest run src/features/campaigns && npm run build`
Expected: PASS + exit 0.

- [ ] **Step 6: Commit.**

```bash
git add src/features/campaigns/components/builder/bonzo/composer-column.tsx src/features/campaigns/components/builder/campaign-builder-view.tsx src/features/campaigns/components/builder/event-composer.tsx src/features/campaigns/components/create/steps/composers/channel-day-composer.tsx
git commit -m "feat(campaigns): read-only composer for published slots; editable + reschedule note for scheduled slots on launched campaigns"
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** guard+bug-fix = Tasks 1-4 (backend); view/edit UX = Tasks 5-6 (frontend). §4 Layer 1 → Tasks 1-4; Layer 2 → Tasks 5-6.
- **Type consistency:** editable-status set = `{pending, scheduled}` everywhere (backend `assertLaunchedSlotEditable` read-only list is the complement; frontend `isSlotEditable` uses the same two). The re-materialize `materializeAndEnqueue` input shape matches `launch` (`:942`) exactly.
- **Draft unchanged:** every guard early-returns when `campaign.status !== 'active'`; every re-materialize block is gated on `campaignStatus === 'active'`.
- **Race safety:** `cancelAndClearSlotPost` returns false on a 0-row `status='scheduled'` delete → caller 409s. Never re-materialize a fired post.
- **Verify-at-implementation flags:** `ConflictException`/`posts`/`campaigns` imports present; `.returning()` support (else match existing guarded-delete idiom); `slot` select returns full row incl. `slotStatus/postId/jobId/time`; `EditorCard` read-only/disabled support (Task 6 Step 4); `MessageComposer` NOT referenced (messaging not on this branch).
- **No migration.** No DTO shape change (responses already carry runtime).
