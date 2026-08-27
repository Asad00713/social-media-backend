# Maestro core tests — design

**Date:** 2026-08-26
**Status:** approved, not started (coding scheduled for 2026-08-27)
**Scope:** backend only (`socialmedia-workspace`)

---

## Why

Maestro has **24 source files and 3 spec files**, and two of those three were
written during the BYOK work. The repo overall has **141 spec files**, so
Maestro is the outlier, not the norm.

The practical cost is already visible: during the activity-row work a shimmer
regression came back twice, and a tool row that should have disappeared was
"fixed" in the wrong branch twice — because the only way to check behaviour was
to open a chat and watch it. Every Maestro change currently ends in manual
verification.

These tests are not about a coverage number. They target the three places where
a break is **invisible until production**.

---

## What is NOT in scope

- **Tool wrappers** (`slack.tools.ts`, `discord.tools.ts`, …). They mostly
  forward to external APIs; tests would assert against mocks and prove little.
- **The runtime adapter** (`claude-agent-sdk.runtime.ts`). It maps SDK messages
  to our `AgentEvent` union. Worth testing eventually, but it is exercised
  indirectly by the service tests, so it stays second-tier.
- **E2E / HTTP-level tests.** These are unit tests against the service and its
  helpers, using the fake-runtime seam described below.
- **Frontend tests.** No test framework is configured there.

---

## Target 1 — `maestro.service.ts` SSE event sequence

779 lines, zero tests. This is the highest-value target because the **entire
frontend activity row is built on the order and shape of these events**.

### The seam

`streamMessage` is an async generator that consumes `this.runtime.run(input)`,
itself an async iterable of `AgentEvent`. That makes the runtime a clean
injection point: a fake runtime yielding a scripted `AgentEvent[]` lets us drive
any scenario without the SDK, the network, or an API key.

Collaborators to stub: `conversations` (addMessage/updateTitle), `tokens`
(checkBudget/recordUsage), `keys` (getDecryptedKey), and the db handle.

### Cases

**Event ordering**
- A plain turn yields `thinking` → `message_stream`* → `message_complete` →
  `done`, in that order.
- A tool turn interleaves `tool_executing` → `tool_result` before the text.
- `message_complete` always precedes `done`, and `done` is last.
- An `error` event from the runtime **terminates the stream** — nothing is
  yielded after it.

**The followups marker** — the subtlest logic in the file, and the most likely
to break silently.

`FOLLOWUPS_MARKER = '__FOLLOWUPS__'` splits display text from suggestions. The
streaming loop holds back the last `markerLength - 1` characters so a marker
split across two deltas is never emitted as visible text. Cases:

- Marker arriving whole in one delta: text before it streams, nothing after it does.
- Marker **split across deltas** (e.g. `__FOLL` + `OWUPS__`) — the partial must
  never reach the client. This is the case the held-back buffer exists for.
- No marker at all: the held-back tail is flushed exactly once at the end, and
  the full text is emitted with no truncation and no duplication.
- Text after the marker is parsed into at most 4 followups, split on `|`, with
  list bullets/numbering stripped.

**Persistence and metering**
- `message_complete` carries the id returned by `conversations.addMessage`.
- A turn with no display text but with media/question/web metadata **still**
  persists and completes.
- Billing converts real tokens at 100:1, rounded up, minimum 1.
- **BYOK turns are logged with `billable: false`** — the workspace already paid
  Anthropic directly. A regression here silently double-charges customers.

**Abort**
- When the signal aborts mid-stream, the loop breaks and no `error` is yielded.

---

## Target 2 — `build-mcp-server.ts` tenant isolation

64 lines, security-critical.

Every request builds a fresh MCP server whose tool handlers **close over that
request's `ToolContext`**. If a context were ever hoisted, shared, or captured
by reference across requests, one workspace would act with another's
credentials. Nothing currently proves it doesn't.

### Cases

- Each `buildMcpServer` call passes **its own** `ctx` to handlers; two servers
  built with different contexts never cross over.
- Handler results are wrapped as `{ content: [{ type:'text', text: <json> }] }`.
- A **thrown** handler error becomes `isError: true` with the message in the
  payload — it must not escape and kill the turn.
- A non-`Error` throw still yields the `'Tool failed'` fallback.
- `toQualifiedToolName` / `stripQualifiedToolName` round-trip, and stripping a
  name without the prefix returns it unchanged.

The SDK is stubbed: `sdk.tool` records its handler, `createSdkMcpServer` returns
a marker. No SDK import is needed, so these tests stay fast.

---

## Target 3 — `confirm.ts` approval gate

50 lines. If this gate opens when it shouldn't, **Maestro sends real messages
to real channels without asking**.

The file's own docblock explains why the gate is code and not a prompt rule:
weaker models narrate "Confirm?" in prose without ever calling `ask_user`, so a
prompt-only policy gates nothing. That reasoning is exactly what the tests
should pin down.

### Cases

- `isConfirmed(false, {})` → true (setting off, proceed).
- `isConfirmed(true, {})` → false (setting on, first call, refuse).
- `isConfirmed(true, { confirmed: true })` → true.
- **Strict `true` only**: `'true'`, `1`, `'yes'`, `{}` must all be rejected.
  This is the actual guarantee — a truthy check here would be the bug.
- `confirmCard` returns `kind:'question'` with exactly the two options, the
  affirmative label first, and `multiSelect: false`.

---

## Approach

- Plain Jest, matching `maestro-key.service.spec.ts`: hand-written fakes, no
  `@nestjs/testing` module compilation, no DB.
- Specs co-located as `*.spec.ts`, per repo convention.
- A shared `collect(gen)` helper drains the generator into an array so ordering
  can be asserted directly.
- Fakes stay minimal and local to each spec — no shared fixture package for
  three files.

## Definition of done

- `npm run test` green, including the 141 existing specs.
- `npm run build` green.
- Each of the three targets has its listed cases covered.
- No production code changed **unless a test finds a real defect** — in which
  case the fix is a separate commit from the tests, so the fix is reviewable on
  its own.
