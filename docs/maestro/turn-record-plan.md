# Maestro — a persisted turn record (audit item #7)

Status: **PLAN — awaiting approval.** No code written yet.
Date: 2026-11-23. Written against the code, post-#1 (`6cc1d27a`) and post-#3
(`1f2ebf97`).

## The gap, restated from the code

A Maestro turn's state **is the generator's position**. There is no row that
says "a turn is running", so:

1. 🔥 **A crash or a Railway deploy mid-turn is undetectable.** The user message
   is on disk (`maestro.service.ts:864`), the assistant row is only inserted at
   the very end (`:1304`), and the stop-rescue in `finally` keys on
   `signal.aborted` — which a `SIGTERM`/`SIGKILL` **never sets**. The result on
   disk is a question with no answer and no trace that anything ever ran.
2. **A live-stopped message has no id.** `message_complete` is the only event
   that carries `messageId`, and it never fires on abort. This is exactly the
   blocker Row E's Continue hit (`row-e-continue-plan.md` → D1).
3. **No status.** Nothing distinguishes "running" from "finished" from "died".
   Resume, retry, pause and crash-recovery all need that distinction before any
   of them can be built.

## The decision: the assistant row IS the turn record

Row E's D1 already chose the standard shape — insert the assistant row **up
front**, emit its id, `UPDATE` it as the turn progresses. That single change
also answers #7, so they are one effort, not two.

**No new table.** `chat_messages.content` is nullable (`chatbot.schema.ts:79`)
and `metadata` is a free-form `jsonb` already carrying `maestroStopped`,
`maestroResolved`, `maestroRefs`, … Adding a status there costs **no migration**
— which matters, because migrations hit prod.

Rejected alternative — a dedicated `maestro_turns` table: cleaner in the
abstract, but it duplicates conversation scoping, needs a migration against
prod, and forces every read path (history replay, `getMessages`, the bridge) to
join. The row already exists and is already fetched; use it.

### Status lives in metadata

```ts
maestroTurn?: {
  status: 'running' | 'complete' | 'stopped' | 'failed';
  startedAt: string;   // ISO
  endedAt?: string;    // ISO, set by every terminal transition
  model: string;
}
```

`maestroStopped` **stays** as-is. It is read by the frontend (`hydrateStored`)
and by `stopped-strip.tsx`; re-deriving it from `status === 'stopped'` is a
separate cleanup, not this effort's job. Writing both keeps old rows readable
and the new field authoritative going forward.

## Backend changes

### 1. Insert the assistant row up front

After the user message is persisted (`:864`) and after the approval branch,
insert an empty assistant row and remember its id:

```ts
const turn = await this.conversations.addMessage(
  conversationId, 'assistant', null,
  { maestroTurn: { status: 'running', startedAt: new Date().toISOString(), model } },
  model,
);
```

### 2. Emit `message_start`

New `MaestroSseEvent` member:

```ts
| { event: 'message_start'; data: { messageId: string } }
```

Yielded immediately after the insert. This is the id every later stop, continue,
retry or edit refers to — the thing mainstream assistants emit and we did not.

### 3. The end of the turn UPDATES instead of INSERTS

`:1304`'s `addMessage` becomes an update of `turn.id`: content, metadata (merged
with `maestroTurn.status = 'complete'`, `endedAt`), `tokenCount`. Needs one new
method on `ConversationService`:

```ts
async updateMessage(
  messageId: string,
  fields: { content?: string | null; metadata?: Record<string, unknown>; tokenCount?: number },
)
```

(`setMessageMetadata` only replaces metadata; it cannot write content.)

`message_complete` keeps its shape and now returns the SAME id that
`message_start` announced.

### 4. The `finally` rescue updates the same row

`status: 'stopped'`, `maestroStopped: true`, content = partial. The
`savedAssistant` guard becomes "did the normal path already finalise this row",
and the insert-vs-insert double-write risk disappears entirely — there is only
one row now.

### 5. An empty turn must not leave an empty bubble

⚠ This is the risk D1 flagged. Three cases:

- **Turn produced nothing and ended cleanly** (no text, no media, no question):
  DELETE the row. Needs `ConversationService.deleteMessage(messageId)`.
- **Turn was stopped with no text** (mid-tool / thinking-only): DELETE the row
  too — today nothing is saved in this case, so deleting keeps the behaviour
  identical and the transcript clean.
- **Crash** (no `finally` at all): the row stays `running` forever. Handled
  below.

Belt and braces: `hydrateStored` on the frontend already needs to skip assistant
rows with no content and no renderable metadata — cheap, and it protects against
any `running` row the sweeper has not yet reached.

### 6. The stranded-turn sweeper

This is the part that actually closes the crash hole, and it is the reason #7 is
worth doing now rather than later.

A cron that finds assistant rows with `maestroTurn.status === 'running'` and
`startedAt` older than a threshold, and marks them `failed` with
`endedAt = now`. The repo already has this exact pattern twice —
`stranded-post` sweeper and the scheduled-post reconciler — so this follows
established code, not a new idea.

✅ **Verified: the lock and the role gate are CENTRAL, not per-service.**
`common/scheduling/cron-lock.bootstrap.ts` and
`common/process-role/cron-role.gate.ts` wrap the `SchedulerRegistry` itself, so
a new sweeper needs only a **named** `@Cron` (as
`stranded-post-sweeper.service.ts:82` does: `@Cron('15 * * * *', { timeZone:
'UTC', name: 'strandedPostSweep' })`) and it is single-run and role-gated for
free. ⚠ The name is what the gate keys on — an unnamed `@Cron` would slip the
lock and run on every replica.

⚠ Must also register the service in a module's `providers` — the
`workspacePurge` incident (BE#264) was exactly this: a cron service with
passing unit tests that the container never built, so the cron never ran. The
spec must assert the provider is wired, not just that the method works.

Threshold: a turn is capped at `maxTurns: 8` and realistically ends within a few
minutes, so **15 minutes** is safely past any legitimate turn. A `failed` row
with partial content still renders; one with none gets deleted by the same pass.

### 7. `runHeadlessTurn` (the bridge)

It reuses `streamMessage`, so it inherits all of this for free — the row is
created and finalised the same way. Nothing optional to add. ⚠ Verify its
spec still passes; it asserts on the event stream.

## Frontend changes

Deliberately minimal this effort — the point is the backend record.

1. `maestro.api.ts`: add `message_start` to the SSE event union and
   `maestroTurn` to the metadata type.
2. `use-maestro-chat.ts`: on `message_start`, set `serverId` on the streaming
   assistant row. **This alone fixes the Row E blocker** — a live-stopped
   message now has its id.
3. `hydrateStored`: skip assistant rows with no content and nothing renderable
   (guards against a `running`/crashed row).

**Not in this effort:** the Continue button itself (that is Row E, which becomes
small once the id exists), and surfacing `failed` in the UI.

## Tests

Backend, in `maestro.service.spec.ts`:
- a turn emits `message_start` before any text, and its id equals
  `message_complete`'s id
- a completed turn leaves exactly ONE assistant row, `status: 'complete'`
- a stopped turn updates that same row to `stopped` + `maestroStopped`, and
  does not insert a second one
- a turn that produces nothing deletes its row
- metering still fires exactly once (the #1 regression guard must keep passing)

Sweeper spec: a `running` row older than the threshold becomes `failed`; a fresh
one is untouched; a `running` row with no content is deleted.

Frontend: `message_start` sets `serverId`; `hydrateStored` skips an empty
assistant row.

Mutation-test each, per project discipline.

## Order of work

1. `ConversationService.updateMessage` + `deleteMessage` (+ specs)
2. Up-front insert, `message_start`, finalise-by-update, empty-row delete
3. Frontend `message_start` → `serverId`, hydrate skip
4. The sweeper (cron, single-run lock, worker ROLE)

Steps 1–3 are one backend PR + one frontend PR. Step 4 can be the same backend
PR or a follow-up; it is independent of the SSE change.

## Safety / constraints

- **No migration.** Status rides in the existing `jsonb`. No `db:push`.
- The SSE change is **additive** — an older frontend ignoring `message_start`
  behaves exactly as today, so backend can merge first.
- Branch per effort, per repo.
