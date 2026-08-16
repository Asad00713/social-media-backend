# Launched-Campaign Slot View & Edit — Design Spec

**Date:** 2026-08-16
**Branches:** `feat/launched-slot-edit` (both `socialmedia-workspace` and `socialmedia-frontend-campaigns`, each off `main`)
**Type:** Architectural (new backend edit-after-launch capability + status guards + composer read-only/edit modes; also fixes a live data-integrity bug)

---

## 1. Problem

Once a campaign (bulk or drip) is launched, its builder becomes an all-read-only status grid — **no slot can be opened at all** (`ChannelsColumn` renders launched slots as non-clickable `<div>` tiles; `ComposerColumn` never receives `isLaunched` because you can't select a slot). Two gaps + one live bug:

1. **Can't inspect published posts.** After launch you cannot see what actually went out for a slot (caption/media/when).
2. **Can't edit a not-yet-fired slot.** A slot still `scheduled` (job enqueued, not fired) should be editable before it fires — today it's frozen.
3. **🐞 Live bug — edits silently publish stale content.** `updateEvent`/`addEvent`/`removeEvent` have **no campaign-status guard** — they run on a launched (`active`) campaign exactly as on a draft, but only mutate `campaign_slot_content.content`. They never touch the already-materialized `posts` row or the enqueued BullMQ job (job payload is just `{ postId }`; the worker republishes the frozen `posts` snapshot). So editing a launched campaign's slot returns HTTP 200 with the new caption, but the job fires the OLD content. `removeEvent` is worse: it deletes the slot row but does **not** cancel the job or delete the `posts` row → the post still publishes, and slot↔status linkage is orphaned.

## 2. Scope (approved with user)

- **Published slots → read-only in the composer.** Clicking a `published`/`publishing`/`failed`/`skipped` slot opens the normal composer but fully read-only, with a status badge + published-at.
- **Scheduled/pending slots → truly editable.** Editing + saving a still-`scheduled` slot on a launched campaign must actually take effect: cancel the enqueued job, delete the not-yet-fired `posts` row, re-materialize from the new content (new `postId`/`jobId`), so the NEW content fires.
- **Fix the live bug** as part of this: add campaign-status + slot-status guards to `updateEvent`/`addEvent`/`removeEvent` so a launched campaign can never silently publish stale content or orphan a job.
- **Draft campaigns: behaviour unchanged** (byte-for-byte).

## 3. Key facts the design rests on (verified in code)

- **Per-slot runtime status** is authoritative: `campaign_slot_content.slotStatus ∈ {pending, scheduled, publishing, published, failed, skipped}` (`campaigns.schema.ts`). Frontend already exposes it as `content.runtime.slotStatus` and maps it in `slot-runtime-config.tsx`. A slot is **still editable** iff `slotStatus ∈ {pending, scheduled}` (`scheduled` = enqueued-not-fired). `publishing`/`published`/`failed` mean the job has fired → read-only.
- **`pause` is the exact reusable primitive** (`campaigns.service.ts:975-1012`): for each `scheduled` slot it does `cancelSlotJob(jobId)` → `db.delete(posts).where(id = postId AND status = 'scheduled')` → reset slot. **The `posts.status = 'scheduled'` guard is critical race-safety** — never delete a post that's already flipped to `publishing` (mid-flight). The edit path reuses this exact pattern for a SINGLE slot.
- **The launch loop** (`campaigns.service.ts:942-957`) shows the re-materialize call: `publishing.materializeAndEnqueue({ workspaceId, createdById, campaignId, date, channelId, time, content, platform, scheduledAt })` → then store `{ postId, jobId, scheduledAt, slotStatus: 'scheduled' }` on the slot. `materializeAndEnqueue` is idempotent per `(campaign,date,channel,time)` job id — re-enqueue with the same key is safe after the old job is cancelled.
- **`computeSlotSchedule(schedule, slotKeys, now)`** returns the `scheduledAt` for a slot (used at launch); the edit path recomputes it for the edited slot to re-enqueue at the correct fire time. If the slot's fire time is now past-due, the edit path skips re-enqueue and marks the slot `skipped` (same rule as launch).
- **Campaign status** = `draft | scheduled | active | paused | completed | failed`; "launched" = `status === 'active'` (+ `launchedAt`). `launch` guards against re-launch (`:898`). The edit guards key on `status === 'active'` (launched) + the slot's own `slotStatus`.
- **Frontend:** `EventComposer` (the composer) does NOT receive `isLaunched`; `ComposerColumn` doesn't pass it; `ChannelsColumn` renders launched slots as non-clickable tiles (`:408-417`). All three need changes.

## 4. Design — two layers, backend-first

### Layer 1 — Backend

**1a. Add campaign-status + slot-status guards to the three event methods** (`campaigns.service.ts`). Shared helper `assertSlotEditable(campaign, slot)`:
- If `campaign.status !== 'active'` (draft/scheduled/paused/etc.) → allow freely (existing behaviour, unchanged).
- If `campaign.status === 'active'` (launched):
  - Slot `slotStatus ∈ {publishing, published, failed}` → throw `ConflictException` (409) "This post has already been published and can't be edited." (`skipped` also read-only → 409 "This post was skipped.")
  - Slot `slotStatus ∈ {pending, scheduled}` → editable, but the mutation MUST re-materialize (see 1b).

**1b. Re-materialize on edit of a launched, still-`scheduled` slot.** After merging the new content in `updateEvent` (and after content is created/changed in `addEvent`), if `campaign.status === 'active'` and the slot's prior `slotStatus === 'scheduled'`:
  1. `cancelSlotJob(slot.jobId)` (if jobId).
  2. `db.delete(posts).where(id = slot.postId AND status = 'scheduled')` — the race-safe guard from `pause`. If the delete removes 0 rows (post already `publishing`), ABORT the edit with 409 (it fired between the read and the delete) — do not leave a half-edited state.
  3. Recompute `scheduledAt` via `computeSlotSchedule`. If past-due → set slot `skipped`, don't re-enqueue. Else `materializeAndEnqueue(... new content ...)` → store new `{ postId, jobId, scheduledAt, slotStatus: 'scheduled' }`.
  - A `pending` slot (launched but never materialized — e.g. was past-due at launch) just updates content; nothing to cancel/re-enqueue.

**1c. `removeEvent` on a launched, still-`scheduled` slot.** Before deleting the slot row: `cancelSlotJob` + guarded `posts` delete (same as 1b steps 1-2). Then delete the slot row. For `publishing`/`published`/`failed` → 409 (can't remove a fired slot). Draft → unchanged.

**1d. Wrap 1b/1c per-slot mutations so partial failure is visible** — if `cancelSlotJob` throws, surface it (don't swallow) rather than leaving the slot pointing at a cancelled-but-not-really job. (Reuse `cancelSlotJob`'s existing warn-on-failure, but the re-materialize must not proceed on a failed cancel — order: cancel → delete(guarded) → re-enqueue.)

**1e. DTO/response:** no shape change needed — `updateEvent`/`removeEvent` already return the reassembled `CampaignDto` with fresh per-slot `slotStatus`/`postId`/`jobId`, so the frontend sees the new state after a re-materialize. Confirm `assembleCampaign` includes `runtime` (slotStatus etc.) — it does (frontend reads `content.runtime`).

### Layer 2 — Frontend

**2a. Make launched slots selectable again** (`ChannelsColumn`). Currently launched → non-clickable tile. Change: launched slots ARE clickable (open in composer), but the composer decides read-only vs editable by the slot's `runtime.slotStatus`. Keep the runtime status badge + published/scheduled timestamp on the card (already there). Remove the "no click" restriction; keep delete affordance ONLY for editable (`pending`/`scheduled`) slots on a launched campaign (published slots: no delete).

**2b. Pass `isLaunched` (and the slot's editability) into the composer** (`ComposerColumn` → `EventComposer`). `EventComposer` computes `isEditable = !isLaunched || slotStatus ∈ {pending, scheduled}`.

**2c. Read-only composer mode** (`EventComposer` + `ChannelDayComposer`). When `!isEditable`:
  - Render the composer with all inputs disabled/read-only (caption, media, platform options, destination for messaging) — reuse the existing composer but in a read-only state (pass a `readOnly` prop down through `ChannelDayComposer`/`MessageComposer`/`ManualBody`).
  - Replace the Save row with a status strip: badge (Published/Publishing/Failed) + published-at / scheduled-at + `lastError` (for failed).
  - No AI lifecycle actions, no destination picker interactivity.

**2d. Editable launched slot** (`scheduled`/`pending`). Composer behaves like a draft slot (full edit + Save), BUT Save triggers the re-materialize on the backend (transparent to the UI — same `updateEvent` mutation). Add a subtle note near Save: "Editing reschedules this post" so the user knows a save re-queues it. On save success, the returned slot may flip to `skipped` (if it became past-due) — surface that (toast: "This post's time has passed; it's now skipped.").

**2e. Delete on launched editable slot.** Wire `removeEvent` (now backend-guarded) — allowed only for `pending`/`scheduled`; the trash affordance is hidden for read-only slots.

## 5. Data flow (edit a scheduled slot on a launched campaign)

```
User opens launched campaign → clicks a 'scheduled' slot → EventComposer (editable) →
  edits caption/media → Save → updateEvent.mutate(patch)
Backend updateEvent: assertSlotEditable → status active + slot scheduled →
  merge content → cancelSlotJob(old jobId) → delete(posts where id=old AND status='scheduled')
    (0 rows deleted → 409 "just started publishing")
  → computeSlotSchedule → (past-due? slot='skipped' : materializeAndEnqueue(new content)
    → store new postId/jobId/scheduledAt, slotStatus='scheduled')
  → return CampaignDto (fresh runtime)
Frontend: composer reflects new saved state; if skipped, toast.
```

## 6. Error handling

- Edit/remove a `published`/`publishing`/`failed`/`skipped` slot on a launched campaign → **409**, surfaced as a toast ("Already published — can't edit"). Composer shows read-only so this shouldn't be reachable via UI, but the guard is defence-in-depth for concurrent tabs.
- Post fired between read and delete (0-row delete) → **409**, toast "This post just started publishing; reload to see its status."
- `cancelSlotJob` fails → do NOT re-enqueue; surface the error; slot left in its prior consistent state.
- Past-due after edit → slot `skipped`, toast informs the user.
- Draft campaign edits → unchanged, no guards trip.

## 7. Testing

- **Backend:** `assertSlotEditable` (draft allows; active+published→409; active+scheduled→ok). `updateEvent` on active+scheduled: cancels job, deletes guarded post, re-materializes with new content, stores new ids. `updateEvent` when post already `publishing` (0-row delete) → 409. `updateEvent` past-due after edit → slot `skipped`, no enqueue. `removeEvent` on active+scheduled cancels+deletes+removes; on published→409. Draft path unchanged (existing tests green). Mock `publishing.materializeAndEnqueue`/`cancelSlotJob`.
- **Frontend:** launched slot is selectable; read-only composer for published (inputs disabled, status strip, no Save/delete); editable composer for scheduled (Save present, "reschedules" note); delete hidden for read-only. `isEditable` computation. Existing draft-composer behaviour unchanged.
- **Build:** `npm run build` green both repos.

## 8. Global constraints

- **shadcn-only** UI, theme tokens only (no hex/arbitrary Tailwind colors).
- **Never** `git add .`/`-A` — surgical `git add <path>` only (FE `.env` git-tracked with secrets; BE `.env` gitignored with secrets).
- Commit/push only when the user explicitly asks.
- Assistant runs **no** `db:*`/`psql`/migration commands — **no migration is needed** (all changes are logic + existing columns).
- **Draft-campaign behaviour byte-for-byte unchanged.**
- Backend-first (Layer 1 before Layer 2).
- Reuse the `pause` primitive's race-safe `posts.status = 'scheduled'` delete guard — never delete an in-flight post.
- Independent of the messaging effort (`feat/campaign-messaging-channels`, already pushed) — this branches off `main`. The read-only composer must also cover the messaging composer path (a launched Slack/Discord slot shows read-only), but do not depend on messaging being merged; if messaging isn't on main yet, the `MessageComposer` read-only handling lands with whichever merges second (note in plan).
