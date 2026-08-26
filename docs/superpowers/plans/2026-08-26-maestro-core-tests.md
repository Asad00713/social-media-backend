# Maestro core tests — implementation plan

**Spec:** `docs/superpowers/specs/2026-08-26-maestro-core-tests-design.md`
**Branch:** `test/maestro-core` (off `main`, backend only)
**Scheduled:** 2026-08-27

Ordered cheapest-first, so each task lands green before the next begins. Tasks 1
and 2 are quick and build the habit; task 3 is the bulk of the work.

---

## Task 0 — branch

```
cd socialmedia-workspace
git checkout main && git pull
git checkout -b test/maestro-core
```

Frontend is untouched — no test framework there, and nothing in this effort
changes its contract.

---

## Task 1 — `src/maestro/tools/confirm.spec.ts`

Smallest surface, clearest guarantee. Pure functions, no fakes needed.

1. `isConfirmed` truth table: setting off → true; setting on with no flag →
   false; setting on with `confirmed: true` → true.
2. **Strict-equality cases**: `'true'`, `1`, `'yes'`, `{}`, `[]` each → false.
   Name the test so the intent survives — the guarantee is that only a real
   boolean `true` opens the gate.
3. `confirmCard` shape: `kind: 'question'`, `shown: true`, one question, exactly
   `[yesLabel, 'No, cancel']`, `multiSelect: false`.
4. `confirmCard` instruction mentions the yes label (the model is told to
   re-call with `confirmed:true`).

**Green check:** `npx jest src/maestro/tools/confirm.spec.ts`

---

## Task 2 — `src/maestro/tools/build-mcp-server.spec.ts`

Needs a small SDK stub. No real SDK import — it is ESM-only and slow to load.

1. Build the stub: `tool(name, desc, schema, handler)` records the handler and
   returns a marker; `createSdkMcpServer` returns its argument.
2. **Isolation test** (the reason this file exists): build two servers with
   different `ctx` objects, invoke both handlers, assert each received its own
   context. Assert on the identity of the object passed through, not a field
   copy.
3. Success wrapping: handler return → `{ content: [{ type:'text', text: JSON }] }`.
4. Error wrapping: handler throws `Error('boom')` → `isError: true` and `boom`
   in the payload; the call itself does not reject.
5. Non-`Error` throw (e.g. a string) → `'Tool failed'` fallback.
6. Name helpers round-trip; `stripQualifiedToolName('plain')` → `'plain'`.

**Green check:** `npx jest src/maestro/tools/build-mcp-server.spec.ts`

---

## Task 3 — `src/maestro/services/maestro.service.spec.ts`

The bulk. Build the harness first, then add cases against it.

### 3a — harness

- `fakeRuntime(events: AgentEvent[])` → `{ run: async function* () { yield* events } }`.
- `collect(gen)` → drains an async generator into an array.
- Stubs: `conversations.addMessage` → `{ id: 'msg-1' }`; `tokens.checkBudget` →
  not exceeded; `tokens.recordUsage` → jest.fn recording its args;
  `keys.getDecryptedKey` → null by default (platform key path).
- Set `process.env.ANTHROPIC_API_KEY` in `beforeEach` so auth resolves; restore
  `process.env` in `afterAll`, matching `maestro-key.service.spec.ts`.

Construct the service directly with `new MaestroService(...)` and fakes — no
`@nestjs/testing`, per the existing spec style.

### 3b — ordering

- Plain turn: `thinking` → `message_stream` → `message_complete` → `done`.
- Tool turn: `tool_executing` and `tool_result` appear before the text events.
- `done` is the final event; `message_complete` precedes it.
- Runtime `error` event → an `error` is yielded and **nothing follows it**.

### 3c — followups marker (highest value in this task)

- Whole marker in one delta → text before it streams; nothing after it does.
- **Marker split across two deltas** (`__FOLL` + `OWUPS__`) → no partial marker
  ever appears in any `message_stream` token. Assert by concatenating all
  emitted tokens and checking neither the marker nor a prefix of it is present.
- No marker → concatenated tokens equal the full raw text exactly (no
  truncation from the held-back tail, no duplication from the final flush).
- Followups parsing: split on `|`, bullets/numbering stripped, capped at 4.

### 3d — persistence, metering, abort

- `message_complete.messageId` is the id from `addMessage`.
- Metadata-only turn (media/question/web, empty text) still persists and
  completes.
- Billing: 100:1, `Math.ceil`, minimum 1. Include a small-usage case that must
  bill 1, not 0.
- **BYOK**: `keys.getDecryptedKey` returns a key → `recordUsage` called with
  `{ billable: false }`. Platform key → `{ billable: true }`.
- Abort mid-stream → loop breaks, no `error` yielded.

**Green check:** `npx jest src/maestro`

---

## Task 4 — full verification

```
npm run test     # all 141+ specs
npm run build
npm run lint
```

All three green before any commit is pushed.

---

## Task 5 — commit and PR

- One commit per task (`test(maestro): …`), so each target is reviewable alone.
- **If a test uncovers a real defect**, fix it in a SEPARATE commit from the
  tests, so the behaviour change is visible on its own rather than buried in a
  test diff.
- PR against `main` on the backend repo (`gh auth switch --user Asad00713`
  first — the backend uses that account).

---

## Notes and risks

- **`streamMessage` is long (779 lines).** If a case turns out to be unreachable
  without heavy mocking, stop and report it rather than reshaping production
  code to be testable. Any such refactor is its own decision, made with the
  user.
- **Do not weaken assertions to force green.** A failing test here likely means
  a real bug — that is the entire point of the effort.
- The frontend need not run for any of this.
