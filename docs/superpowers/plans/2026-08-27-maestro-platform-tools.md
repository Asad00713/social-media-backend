# Maestro platform tools — Layer 1 implementation plan

**Spec:** `docs/superpowers/specs/2026-08-27-maestro-platform-tools-design.md`
**Branch:** `feat/maestro-platform-tools` (same name BOTH repos, off `main`)

Backend first, then frontend — workspace CLAUDE.md rule. Frontend starts only
after the backend half is reviewed with the user.

---

## Task 0 — branches

```
cd socialmedia-workspace && git checkout main && git pull
git checkout -b feat/maestro-platform-tools
# frontend at Task 5
```

---

## Backend

### Task 1 — the reference contract

`src/maestro/tools/references.ts` (new)

A tool result carries the entities it names, so the frontend can turn them into
links. Decide once, here, and reuse for every later tool:

- what a reference is (kind, id, label, optional status)
- how the model points at one from its prose
- what happens to a marker that resolves to nothing → **plain text, never a
  broken link**

Ship a helper that wraps a tool result with its references, plus a type the
frontend imports, so the shape cannot drift between repos.

**Do not** put URLs in the reference. The backend does not own frontend routing;
the model owning it would be worse still.

**Green check:** unit tests for the helper — well-formed refs, empty refs, and a
marker with no matching entity.

### Task 2 — channel read tools

`src/maestro/tools/channel.tools.ts` (new)

- `list_channels` — connected channels, health/expiry state, per platform
- `get_channel_stats` — followers, reach, performance for one channel

Both return references so each channel name becomes a link.

Reuse the existing channels service — do not query Drizzle directly from a tool.
Scope every read to `ctx.workspaceId`; a tool must never accept a workspace id
as an argument.

Register in `build-mcp-server.ts` alongside the existing tool groups.

### Task 3 — analytics read tools

`src/maestro/tools/analytics.tools.ts` (new)

Everything the Insights UI shows: KPIs and trend, the metric series over a
period, per-platform breakdown, per-channel performance.

Read through the services `kpi-strip`, `metrics-chart`, `platform-breakdown`,
and `channel-table` already call. Do not recompute — if the agent and the
Insights page can disagree, this task is wrong.

Prefer one tool with a period/metric argument over four near-identical tools
(tool-count discipline, see Notes).

### Task 4 — `connect_channel` card

Returns an interactive card naming the platform to connect. The frontend renders
it as a button that runs **the real OAuth flow** — same behaviour as the
Channels page.

Not an outward action in the confirm-gate sense — the tool performs nothing, so
**no confirm gate**. The user clicking is the action.

If the platform is already connected, say so instead of offering the button.

### Task 5 — backend verification

```
npx jest src/maestro test/maestro-core   # 93 existing + new
npm run test          # 4 pre-existing failures (billing, evergreen, db-pool) — expect exactly those
npm run build
npx eslint <changed files>
```

New tests:
- Each tool returns references whose ids match the entities named.
- Reads are workspace-scoped — another workspace's channels never appear.
- `connect_channel` on an already-connected platform offers no button.
- A tool result with no entities still renders (empty references, not absent).
- Analytics tools return the same figures as the Insights services they wrap.

**Then STOP.** Present the backend and propose the frontend plan before writing
frontend code.

---

## Frontend (after user approval)

### Task 6 — render references as links

`rich-text.tsx` today handles paragraphs, bullets, and `**bold**` — there is no
link support. Add reference resolution:

- marker → `<a>` routed via the workspace route table the app already owns
- status rendered inline beside the label as a shadcn `Badge`
- **unresolved marker → plain text**, never a dead link

Follow the shadcn-only rule: check the MCP before reaching for any component.
The shadcn MCP failed to connect this session — if it is still down, STOP and
tell the user rather than hand-rolling a badge.

Keep `RevealedText` streaming intact: a link must fade in with the words around
it, not pop in fully-formed.

### Task 7 — the connect card

Render `connect_channel`'s result as a button, following `MediaGrid`'s
precedent for a rich tool result. The button runs the real OAuth flow.

**Reuse `useInitiateOAuth` + `openOAuthPopup`.** Do not write a second connect
path — a divergent one would drift from the Channels page and break in ways only
the agent shows.

The popup must be opened **synchronously in the click handler** (the hook's own
docblock says so: it does not redirect on its own, and popup blockers fire
otherwise). So the card owns the click; `openOAuthPopup` first, then point it at
the authorization URL from the mutation's `onSuccess`.

On success, refresh the channel list so the agent's next answer reflects the new
channel.

Loading, disabled, and error states per CLAUDE.md Rule 4.

### Task 7b — fix the COOP popup close

`project_oauth_popup_close_bug`: on production the OAuth popup does not
auto-close after connecting, because COOP severs the child's `window.close()`.
Fix parent-side in the opener.

This is queued work we are pulling in deliberately, not scope creep: Task 7
makes the bug the ending of the agent's headline flow. Shipping a connect button
that leaves a stranded window is worse than not shipping it.

If it turns out to need more than a parent-side close, stop and raise it —
do not let it silently expand this branch.

### Task 8 — frontend verification

```
npm run build
npm run lint
```

**Then verify it in a real browser — visually and technically, both.** The user
asked for this explicitly; a green build is not evidence that a link renders
correctly.

Using Chrome DevTools MCP, on a real workspace:

1. Ask "which channels do I have connected?" → screenshot the answer. Channel
   names must be visibly links, with status pills beside them.
2. Click one → confirm it lands on the right screen for that channel.
3. Inspect the SSE payload behind the answer — confirm references arrived
   structured, and that the rendered href matches the entity id.
4. Ask something with **no** results (a workspace with no campaigns) → confirm a
   real empty state, not a broken reference or a dead link.
5. Ask about analytics → confirm the figures **match the Insights page** for the
   same period. Open both and compare; a plausible-looking wrong number is the
   failure mode here, and only a side-by-side catches it.
6. Ask "I don't know how to connect a channel" → confirm the question card
   appears with platform options, then the button. Click it and confirm the
   OAuth popup actually opens against the right provider — not merely that the
   button rendered.
7. Complete a real connection through that popup → confirm the popup closes on
   its own (Task 7b), the channel appears, and asking again reflects it.
8. Reload mid-conversation → confirm links still work on the hydrated message
   (references must survive persistence, not only live streaming).

Screenshot each step. A link that looks right but points at the wrong id is
exactly the failure this step exists to catch — check the rendered href against
the entity id, not just the pixels.

Where the browser cannot complete a step (a real OAuth consent screen may need
the user's own credentials), say so plainly and hand that step to the user
rather than reporting it as passed.

---

## Notes and risks

- **The model must not invent URLs.** It knows ids because a tool gave them; it
  does not know our routing. If a link's href can be traced back to model output
  rather than the route table, that is a bug.
- **Hydration parity.** A reference that renders live but breaks after reload is
  the same class of bug as the `serverId` defect in the question-turn work —
  test the reloaded path explicitly (step 6), not just the streaming one.
- **Tool-count discipline.** Layer 1 across all modules should land near a dozen
  tools, not thirty. If a module seems to need five read tools, it probably
  needs one with a filter argument. This matters more as we approach full
  parity: the target is everything the user can do, but reached through well-
  chosen tools, not one tool per button in the UI.
- **One connect path, not two.** The agent reuses the UI's OAuth hook and popup.
  If the agent ever grows its own variant, they will drift and only the agent's
  will be broken.
- **Workspace scoping is a security boundary**, not a convenience. Every read
  derives its workspace from `ctx`, never from tool arguments.
- If a task needs production code reshaped beyond this scope, stop and raise it
  rather than widening silently.
