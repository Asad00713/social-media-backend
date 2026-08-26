# Maestro — Development TODO

Running backlog for the Maestro agent. Items here are agreed but not yet
scheduled; each one gets a spec before it gets code.

> Not to be confused with `ai-assistant-todo.md`, which tracks the older
> `src/chatbot/` module.

---

## Backlog

### Inline source attribution in replies

**Status:** captured 2026-08-26 — needs discussion before any work starts.

Today sources are a list *underneath* the reply (`web-sources.tsx`): a
"Sources from the web" heading with one bordered row per link. It works, but it
sits apart from the text, so the reader cannot tell **which claim** came from
**which source**.

What is wanted instead:

- **Inline citation chips** placed at the point of the claim — a small
  favicon + domain pill sitting in the sentence itself, not in a list below it.
- **A collapsed source summary** on the actions row — overlapping favicons plus
  a count ("10 sources"), sitting alongside copy / regenerate / thumbs, rather
  than a separate titled block.
- So a reply reads as prose with attribution woven through it, and the full
  list is available on demand instead of always expanded.

**Open questions — to settle in discussion:**

- Where do citation positions come from? The model must mark them in its output
  (some inline token the frontend parses), because the current `web_search`
  tool returns a flat result list with no mapping back to spans of text. This
  is the part that decides whether the rest is cheap or expensive.
- Do non-web tools get attribution too — a Slack read, a workspace lookup — or
  is this web-search only?
- What does the expanded view look like when the count is clicked?
- Favicon fetching: from the source domain at render time, or resolved and
  cached server-side? (Render-time is simpler but leaks the reader's IP to
  every cited domain.)

**Where it lands:** `src/maestro/tools/web.tools.ts` (source shape),
`system-prompt.ts` (citation instructions), and frontend `web-sources.tsx` +
`rich-text.tsx` (inline parsing and chips).

---

## Next up

### Tests for the Maestro core

24 source files, 3 spec files — and 2 of those 3 were written during the auth
work. Meanwhile the repo overall has 141 spec files, so Maestro is the outlier,
not the norm.

Priority order, highest payoff first:

1. **`maestro.service.ts` SSE event sequence** (779 lines, untested). The whole
   frontend activity row is built on the order of `thinking` →
   `tool_executing` → `message_stream` → `message_complete` → `done`. Change
   that order and the UI breaks, with no signal until someone opens a chat.
2. **`build-mcp-server.ts` tenant isolation** (64 lines). Each request builds an
   MCP server closing over a `ToolContext`. If that context ever leaks or is
   shared, one workspace sees another's data. Small file, security-critical.
3. **`confirm.ts` approval gate** (50 lines). If the gate is bypassed, the agent
   sends real messages without asking.

Tool wrappers are deliberately excluded — they mostly wrap external APIs, so
their tests would lean on mocks and prove little.

---

## Deferred (from the original review)

- **Platform tools** — Maestro can do messaging and posts, but not analytics,
  campaigns, or inbox.
- **Cost tracking** — `costUsd` is discarded, so per-model billing is not
  currently possible.
