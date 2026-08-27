# Maestro — one task, one question surface: implementation plan

**Spec:** `docs/superpowers/specs/2026-08-27-maestro-question-turn-design.md`
**Branch:** `feat/maestro-question-turn` (same name in BOTH repos, off `main`)

Backend first, then frontend — per the workspace CLAUDE.md rule. Frontend work
starts only after the backend half is reviewed with the user.

---

## Task 0 — branches

```
# backend
cd socialmedia-workspace && git checkout main && git pull
git checkout -b feat/maestro-question-turn

# frontend (later, at Task 6)
cd socialmedia-frontend && git checkout main && git pull
git checkout -b feat/maestro-question-turn
```

---

## Backend

### Task 1 — cards carry their origin

`src/maestro/tools/confirm.ts`

- `confirmCard(...)` gains the originating tool name and the arguments it was
  called with, alongside today's summary and label.
- Keep the existing `kind: 'question'` shape so the frontend renders it
  unchanged — this is additive.
- The affirmative label must be identifiable later; carry it explicitly rather
  than re-deriving it by string matching.

Every outward tool that calls `confirmCard` passes its own name and args
(`slack.tools.ts` × 4, plus discord/telegram/whatsapp/post tools). Mechanical,
but do not skip any — a missed one silently keeps the old broken path.

**Green check:** `npx jest src/maestro/tools/confirm.spec.ts` (existing 14 tests
must still pass; extend them for the new fields).

### Task 2 — persist the origin

`src/maestro/services/maestro.service.ts` (~line 645)

`maestroQuestion` currently keeps only `questions[]`. Add the pending-action
record (tool + args + affirmative label) when the card came from a confirm gate.

`ask_user` questions have no pending action — that field stays absent, and the
frontend must treat it as optional.

### Task 3 — execute an approval without the model

`src/maestro/dto/send-message.dto.ts` — optional approval field: which message's
card is being answered, and the option chosen.

`src/maestro/services/maestro.service.ts` — before the runtime loop:

1. Load the referenced assistant message; verify it belongs to **this**
   conversation and user. Reject otherwise.
2. Confirm it carries a pending action and is not already resolved (an approval
   must not be replayable).
3. On an affirmative option: re-validate the stored args against that tool's
   own Zod schema, rebuild `ToolContext` **from the request**, and invoke the
   handler with `confirmed: true`.
4. On a negative option: run nothing, end with a short acknowledgement.
5. Persist the outcome so the card can render as resolved.

**Security, non-negotiable:** stored args are untrusted input. Never pass them
to a handler unvalidated, and never take `userId`/`workspaceId` from them.

The tool result then flows through the existing event path, so the frontend
needs no new event type for this.

### Task 4 — close the prose route

`src/maestro/prompt/system-prompt.ts`

- `CONFIRM_BEFORE_SEND_POLICY`: state that once the user has approved, the
  action is already performed — do not re-ask, do not narrate a pending
  approval.
- Questions with choices go through `ask_user`, never prose.

Prompt is the belt; Tasks 1–3 are the braces. The user asked for both.

### Task 5 — backend verification

```
npx jest src/maestro     # existing 78 + new
npm run test             # 4 pre-existing failures are unrelated; expect exactly those
npm run build
npx eslint <changed files>
```

New tests to add:
- Affirmative approval → the tool runs exactly once, no card re-emitted.
- Negative approval → nothing runs.
- Approval naming a message from **another** conversation → rejected.
- Approval whose stored args fail schema validation → rejected, nothing runs.
- Replayed approval on an already-resolved card → rejected.
- `ask_user` question (no pending action) → unchanged behaviour.

**Then STOP.** Present the backend to the user and propose the frontend plan
before writing frontend code (workspace CLAUDE.md rule 2).

---

## Frontend (after user approval)

### Task 6 — send the answer as data

`maestro-panel.tsx:143` currently flattens every card answer to plain text.
The card's answer must carry the structured approval instead; free-typed
messages keep today's path untouched.

`use-maestro-chat.ts` — thread the approval through `send`, and mark the card
resolved when the turn completes.

### Task 7 — one card holds question and answer

`question-card.tsx` — the locked state already collapses to a read-only line;
extend it to show the chosen answer.

`message-list.tsx` / `agent-message.tsx` — suppress the separate user bubble
for an answer that belongs to a card. Free-typed messages still render normally.

Follow the shadcn-only rule: no hand-rolled chrome, and check the MCP before
reaching for any new component.

### Task 8 — frontend verification

```
npm run build
npm run lint
```

Then live-test the exact reported flow: ask Maestro to send a Slack message,
answer the clarifying question, approve — and confirm it sends **once**, with no
second card, no "waiting for approval" prose, and the answer shown inside the
card.

---

## Notes and risks

- **Do not weaken the confirm gate.** It must still be impossible to perform an
  outward action without approval. This work changes how approval *returns*,
  never whether it is required.
- **Bridge surfaces have no cards.** Telegram/WhatsApp must keep working through
  the text path; the approval field is optional throughout.
- **Every outward tool must be updated in Task 1.** A missed call site keeps the
  old broken behaviour for that tool only — easy to overlook, so enumerate them.
- If a task turns out to need production code reshaped beyond this scope, stop
  and raise it rather than widening silently.
