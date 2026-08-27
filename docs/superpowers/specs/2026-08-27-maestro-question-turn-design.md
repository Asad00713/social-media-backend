# Maestro — one task, one question surface

**Date:** 2026-08-27
**Status:** approved, not started
**Scope:** backend (`socialmedia-workspace`) + frontend (`socialmedia-frontend`)

---

## The problem, as seen

Asking the agent to send a Slack message produced this:

1. Agent asked *"What message would you like me to send to schedura-channel?"* — **as plain prose**, no options.
2. User answered. Agent showed a confirm card. User picked **"Yes, send it"**.
3. Agent asked **again** — a second confirm card — and wrote in prose *"All set! Waiting for your approval to send…"*, while the card above it already read **Answered**.

Three separate defects, plus one presentation problem, all in a single exchange.

---

## What is actually wrong

### 1. Approval reaches the model as ordinary chat text

When the user clicks an option, the frontend does exactly this
(`maestro-panel.tsx:143`):

```
onPickFollowup={(text) => send(text, model, null, agentSettings)}
```

The choice is flattened to the string `"Yes, send it"` and sent as if typed. Nothing tells the backend *this is the answer to that confirm card, re-run that tool with `confirmed: true`*. The model has to infer it, and Haiku did not.

This is the same failure the `confirm.ts` gate was written to solve, one step later in the loop. Its own docblock records why a prompt-only policy was insufficient there:

> a prompt-only policy only *asks* the model to confirm, so weaker models (e.g. Haiku) sometimes narrate "Confirm? (you should see buttons above)" in prose without ever calling ask_user

The outbound half was moved into code and it worked. The **return** half is still prose, so the same class of failure remains.

### 2. Questions are allowed to be prose

`ask_user` already says *"ALWAYS use this instead of writing choices as a bullet/numbered list in your text"* — and step 1 above still happened. Instruction alone is not holding.

### 3. Prose contradicts the card

The reply said *"Waiting for your approval"* while the card beside it said **Answered**. `CONFIRM_BEFORE_SEND_POLICY` line 158 already forbids exactly this.

### 4. The question and its answer are split apart

Today the card renders on the assistant turn, and the answer appears as a separate user bubble underneath. But *"send a message"* → *"which channel?"* → *"this one"* is *one* task, not three exchanges. The UI should read that way.

> Clarified by the user: this is about the **interaction**, not billing. "send the message" is one thing; the clarifying question inside it is not a separate conversation.

---

## Decisions

**Approval travels as data, not prose.** The user's answer to a card is sent as a structured field, and the backend acts on it directly.

**Enforcement lives in code *and* prompt.** Explicitly chosen by the user. The prompt states the rule so a well-behaved model does the right thing unprompted; the code makes the wrong thing impossible when it does not. Neither alone has held.

**Question and answer share one surface.** The card holds both; no separate user bubble for an answer that belongs to a card.

---

## Design

### A. Confirm cards carry their origin

When an outward tool returns `confirmCard(...)`, it also records **which tool** asked and **with what arguments**. Persisted in the assistant message's `maestroQuestion` metadata, which today keeps only the question text and options (`maestro.service.ts:645`).

Without this, an approval cannot be acted on server-side — there is nothing to re-run.

### B. The approval path bypasses the model

The send DTO gains an optional approval field naming the pending card and the option chosen. On an affirmative answer the service re-invokes **that tool handler** with the original arguments plus `confirmed: true`, rather than asking the model to do it.

The model cannot then: ask again, answer in prose, or re-run with different arguments. All three observed failures become unreachable.

**Security:** persisted arguments are re-validated against the tool's own schema before execution, and the tenant context is rebuilt from the **request**, never from the stored payload. A stored argument blob is untrusted input, not a capability token.

**Cancellation:** a negative answer runs nothing and ends the turn with a short acknowledgement.

### C. `ask_user` is the only way to ask

- **Prompt:** state plainly that a question with choices must go through `ask_user`, never prose.
- **Code:** an outward tool that needs input returns a card; the path that lets a bare question reach the user as text is closed.

### D. One card, question and answer together

The card renders the chosen answer inside itself once answered, and the separate user bubble for that answer is suppressed. The exchange reads as one unit.

Free-typed messages are unaffected — only an answer that belongs to a card is absorbed into it.

---

## Out of scope

- **Metering.** The user explicitly set this aside: billing is per token, and this change is about the interaction. No change to how turns are counted or charged.
- **`ask_user` batching/tabs.** The multi-question wizard already works; only its enforcement changes.
- **Bridge surfaces (Telegram/WhatsApp).** They have no card UI; they keep today's text path. The backend change must not assume a card is present.

---

## Definition of done

- Clicking an affirmative option sends exactly once, with no second card and no prose confirmation.
- A question with options never arrives as plain text.
- An answered card shows the answer inside itself, with no duplicate user bubble.
- No stored argument reaches a tool without passing that tool's schema validation.
- `npm run test` and `npm run build` green on the backend; `npm run build` green on the frontend.
- New tests cover the approval path, including the negative answer and a tampered stored payload.
