# Maestro Row E — "Continue a stopped turn"

Status: **PLAN — awaiting approval.** No code written yet.
Date: 2026-11-23. Researched against both repos (code, not just the spec).

## The gap

When a user presses **Stop** mid-turn, Maestro saves the partial answer and
shows a "You stopped this early" strip — but there is **no way to continue** that
turn. The E1/E2 screens draw a **Continue** button on that strip. Resume does
not exist in either repo.

## What exists today (verified)

**Backend** (`socialmedia-workspace-qui/src/maestro/`)
- `maestro.controller.ts:251-297` — SSE turn. On client close it aborts an
  `AbortController`; the `for await` loop `break`s (line ~282), which `.return()`s
  the service generator, tearing it down at its current `yield`.
- `maestro.service.ts:739-1336` — `streamMessage()` is the turn generator:
  auth/membership → BYOK/key → pre-turn budget gate (`checkBudget`, ~836) →
  persist USER message (`addMessage`, ~853) → load last 20 messages as history
  (~896-951, replayed as plain text with attachment-URL + `[[ref:id]]` notes) →
  build tools + prompt → `runtime.run(input)` loop (AgentEvent→SSE).
- **Stop-save (the `929b0dd` fix), ~1303-1335** — in `finally`, guarded
  `if (signal.aborted && !savedAssistant && partialText.trim())`, saves the
  partial assistant text with metadata `{ maestroStopped: true }`. Confirmed: the
  save is NOT skipped by an early service `break`; it is rescued in `finally`
  because the generator teardown skips everything after the loop. **No
  `message_complete`/`done` is emitted on abort, so the client never learns the
  DB id of the saved partial row.**
- Persistence via shared chatbot tables (`ConversationService.addMessage(...)`).
  `stopped` is just a metadata flag — **no Maestro-specific message table.**
- Metering: `tokens.recordUsage(...)` (~1267). **A stopped turn is torn down
  before metering runs — a stop is currently free.**
- `runHeadlessTurn` (400-455) reuses `streamMessage` for the Telegram/WhatsApp
  bridge → any new `streamMessage` param must be optional.

**Frontend** (`socialmedia-frontend-maestro/src/features/maestro/`)
- `hooks/use-maestro-chat.ts` `stop()` (882-907): aborts; for each unfinished
  assistant message, `hasAnswerText(blocks)` → mark `{status:'done',stopped:true}`
  else drop the empty row. **A live-stopped message has NO `serverId`** (set only
  by `onComplete`, which never fires on abort). `hydrateStored` (378-449) DOES
  set `serverId` + `stopped` from `metadata.maestroStopped` on reload.
- `components/stopped-strip.tsx` — muted strip, "You stopped this early". Its doc
  comment says Continue + "4 of 10" are omitted because resume doesn't exist. **No
  Continue button.**
- `agent-message.tsx:210` — `{message.stopped && <StoppedStrip />}`.
- `regenerate()` / `retryLast()` already re-run the last user message through
  `runStream` — the "re-send to the endpoint" plumbing exists.

## Recommended "Continue" semantics

**A continuation turn (option b):** a normal agent turn whose input already
contains the partial answer as the preceding assistant message (history replay
includes the saved `maestroStopped` row), plus a **synthetic continuation
instruction** telling the model to resume, not restart. Reject: (a) re-run from
scratch (wasteful, can diverge); (c) true SDK stream resumption (impossible — the
generator was torn down).

**What gets sent:** `streamMessage` with a new optional flag
`continueFromMessageId` (the stopped assistant row's id). When set:
- do NOT persist a new user message;
- load history as normal (the partial is the last assistant turn);
- append to the agent input only a synthetic user turn: *"Continue your previous
  reply from where it stopped. Do not repeat text you already wrote."* (not
  persisted — the transcript stays clean; the screen shows the answer growing,
  not a "continue" bubble).

**Append vs new message — APPEND into the same assistant row** (E2 shows the list
continuing under the same Maestro header, strip → spinner → resumed text). On
completion, UPDATE the stopped row: `content = partial + continuation`, clear
`maestroStopped`. If the continuation is itself stopped, re-set `maestroStopped`
on the longer text (Continue is repeatable).

## Backend changes

1. `streamMessage` optional param `continueFromMessageId?: string`.
2. New branch (after membership/budget/auth, before the user-message persist):
   fetch the target via `conversations.getRecentMessages(...)`; require role
   `assistant`, `metadata.maestroStopped === true`, same conversation (reuse the
   `resolveApproval` scoping ~580-587); else fall through to error. Skip the user
   `addMessage`. Set the synthetic continuation instruction as the input.
3. Append-on-complete persistence: `conversations.appendToMessage(messageId,
   extraText, { clearStopped, outputTokens })` (or inline `UPDATE` +
   `setMessageMetadata`). **No migration** — content UPDATE + metadata flag on the
   existing table.
4. Metering: a continuation is a real model call → meters normally. (The original
   stop still meters nothing; whether to meter the partial-at-stop is out of Row E
   scope.)
5. SSE: reuse `message_stream` / `message_complete` / `done`;
   `message_complete.messageId` returns the SAME updated row id.
6. Controller: accept `continueFromMessageId` on `SendMaestroMessageDto`, pass
   through (no new route).

## Frontend changes

1. `StoppedStrip` gains a **Continue** button (shadcn `Button variant="outline"
   size="sm"`, Hugeicons, theme tokens). Props `{ onContinue?, isContinuing? }`;
   while continuing → spinner + disabled. Keep "You stopped this early" (no
   target count, so no "4 of 10").
2. `agent-message.tsx:210` — pass `onContinue`/`isContinuing` down.
3. New `continueTurn(assistantId)` in `use-maestro-chat.ts`: set the row back to
   `streaming`, clear `stopped`, call a `runStream` variant posting
   `continueFromMessageId` and **appending** tokens onto the existing `blocks`
   (current `withText` replaces — continuation must concatenate; add an append
   mode or seed the accumulator with the kept text). On complete, parse the full
   concatenated text into blocks.
4. No new user bubble for Continue (the answer just grows).

## Smallest-correct scope

**Build first (satisfies E2 Continue):** the flag + target-row validation; the
synthetic instruction (reusing history replay); append-on-complete; the Continue
button → `continueTurn` → stream appending into the same row; normal metering.

**Defer:** E1's "resume after fix / Skip step" (resuming a mid-TOOL-stage turn —
materially bigger, needs plan-card step state); a real "N of M" count; metering
the partial-at-stop; a dedicated continue route / new SSE type.

## Decisions taken

### D1 — the assistant row is created UP FRONT and streamed into (2026-11-23)

**Decided: do it the standard way.** Mainstream assistants (ChatGPT, Claude)
emit the assistant message's id *before* the text streams — a `message_start`
event — and every later token, stop, continue, edit or regenerate refers to that
id. Our backend instead INSERTS the assistant row at the *end* of the turn, so a
live-stopped message has no id until the page is reloaded. That is the real
defect behind Row E's wrinkle; re-fetching the conversation on Continue would be
a workaround, not the standard.

So:
1. After the user message is persisted, insert an **empty assistant row**
   (`conversations.addMessage(convId, 'assistant', null, …)` — `content` is
   nullable, verified in `conversation.service.ts:132-152`).
2. Emit its id to the client in a new `message_start` SSE event.
3. On completion OR on the `finally` stop-rescue, **UPDATE** that row instead of
   inserting a new one.

Benefits beyond Row E: the stop-save stops being an insert-vs-insert race
(`savedAssistant` guard), and Continue gets the id for free — no extra fetch.

⚠ **New risk this introduces:** if a turn dies before any update (crash, process
restart), an **empty assistant row** is left behind and a reload would show an
empty bubble. Must be handled — either delete the row when a turn ends with no
content, or have `hydrateStored` skip assistant rows whose content is empty.
Decide during build; the hydrate-skip is the cheaper, safer default.

## Open questions (need the user before building)
2. **Overlap/repeat:** if the model re-greets or repeats on continue, the joined
   text reads badly. The instruction must be firm ("do not repeat"); de-dup of
   overlap deferred unless it proves necessary. Acceptable for MVP?
3. **Mid-tool / thinking-only stop:** nothing was saved and no strip shows, so
   there is nothing to Continue. Confirm that's intended (Continue only when
   partial ANSWER text streamed).
4. **Repeatable Continue:** re-set `maestroStopped` if the continuation is also
   stopped — recommend yes (cheap).
5. **Metering fairness:** original stop bills nothing; continuation bills its own
   tokens. Acceptable, or also meter the partial-at-stop? (Out of Row E scope.)
6. **Branching:** new feature on both repos → dedicated branch each (backend
   worktree is on `feat/maestro-open-questions` — branch off that or `main`?).

## Safety / constraints

- **No migration** (metadata flag + content UPDATE on existing tables). No
  `db:push`. Migrations hit prod per project rules.
- shadcn-only UI, Hugeicons (not lucide), theme tokens.
- The new `streamMessage` param stays optional so `runHeadlessTurn` (bridge) is
  unaffected.
