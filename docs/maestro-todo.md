# Maestro — Development TODO

Running backlog for the Maestro agent. Items here are agreed but not yet
scheduled; each one gets a spec before it gets code.

> Not to be confused with `ai-assistant-todo.md`, which tracks the older
> `src/chatbot/` module.

---

## Backlog

### Write tools — Maestro cannot create anything yet

**Status:** captured 2026-09-30 — blocks the three items below it.

Maestro reads. Across all 18 tool files there is no `create_post`,
`draft_post` or `schedule_post`: the post tools are `list_posts`, `get_post`
and `publish_post`, and the last one publishes a post that already exists.
Posts are created in the composer, never by the agent.

So "write me a caption and schedule it for Tuesday" does not work today, and
neither does anything built on top of it. This is the item everything else
waits for.

**What it needs:**

- `create_post` and `schedule_post`, with the same validation the composer
  applies — per-platform character limits, media requirements, channel
  eligibility. The agent must not be able to create a post the composer
  would have refused.
- A decision about `confirmBeforeSend`. It exists and works for one action.
  Thirty posts is a different question: confirming each is unusable,
  confirming none is unsafe. Probably: confirm the *plan*, then execute.
- The blast radius is real. A wrong caption, a wrong time, or a wrong
  channel is a public mistake on someone's brand account.

**Where it lands:** `src/maestro/tools/post.tools.ts`, and whatever the
composer uses for validation so the rules are shared rather than restated.

---

### Bulk generation as a background job

**Status:** captured 2026-09-30 — needs write tools first.

"Make me 30 days of posts" cannot run inside a turn. Thirty captions at a
few seconds each is minutes of work: the SSE connection would have to stay
open, closing the tab would lose everything, and `maxTurns` (8) is hit long
before the end. It is a job, not a request.

**Shape:**

1. Maestro enqueues the job and answers immediately — "on it, I'll tell you
   when they're ready".
2. A worker generates them in the background. BullMQ is already here
   (`POST_PUBLISHING`, `TOKEN_REFRESH`, `DRIP_CAMPAIGNS`).
3. The user is notified when it finishes; `src/notifications/` already does
   this.

**This is where the Batch API fits.** Thirty captions are independent of
each other, so they can all go at once for half price — unlike a chain such
as "read this image, then caption it, then schedule it", where each step
needs the one before it and batching saves nothing. Note that batch and
prompt caching pull against each other (batch runs on its own schedule, so
the cache window lapses); keep caching on the chat path and batch on this
one.

---

### Per-user context — who the user is, and what they post about

**Status:** captured 2026-09-30.

Maestro knows the workspace but not the person. A doctor and a car dealer
get the same generic captions, and every turn starts from nothing.

The user should be able to say, once: what they do, who they are writing
for, which topics they post about, what they never post about, and how they
want to sound. Maestro then writes accordingly without being told again.

**The groundwork already exists.** `users.maestro_tone` is a per-user
column, and `tonePolicy()` in `system-prompt.ts` injects it into the prompt
per turn. This is the same mechanism with a richer payload — the shape is
proven, so the work is the content and the UI, not the plumbing.

**Open questions:**

- Per user or per workspace? Tone is per user. But an agency running one
  brand account probably wants the brand's context shared across the team,
  which argues for per workspace with a per-user override.
- Free text or structured fields? Free text is easier to write and harder
  to use well; structured fields are the reverse. Likely a few fields
  (profession, audience, topics, never-mention) plus a free-text note.
- It lands in the cached prefix, so it is nearly free per turn — but it
  must sit **before** the cache breakpoint and stay stable, or it
  invalidates the cache on every edit. Where exactly it goes in
  `promptParts` matters for cost, not just for behaviour.

**Where it lands:** a new column or table beside `users.maestro_tone`,
`system-prompt.ts` (a `contextPolicy()` beside `tonePolicy()`), plus
settings UI on the frontend.

---

### Proactive Maestro — noticing, and reaching out first

**Status:** captured 2026-09-30 — the largest item here; needs the three
above, and a spec of its own.

Today Maestro only answers. The goal is an assistant that notices: if
someone posts about the same few topics every morning at nine and then one
morning does not, Maestro should say so — "you haven't posted today, want me
to draft one? Last week you covered X and Y; either of those, or something
else?"

**The pieces are all here already**, which is what makes this worth doing:

- **Schedulers** — six run today (`channel-snapshots`, `tiered-polling`,
  `refresh-token-expiry`, `evergreen-reconcile`, ...), so a daily pass over
  user activity is an established pattern, not new infrastructure.
- **Outbound reach** — `src/maestro/bridge/` already pushes Maestro to
  Telegram and WhatsApp, and `src/notifications/` handles in-app. Maestro
  can already reach a user; it just never does so on its own initiative.
- **The data** — posting times, topics and channels are all in the
  database. No new collection is needed to detect a habit.

**What is genuinely new:**

- **Detecting a habit, and being right about it.** Three posts is not a
  pattern; three weeks is. Getting this wrong in the confident direction is
  how an assistant becomes a nuisance.
- **Knowing when to stay quiet.** Weekends, holidays, someone who has
  deliberately paused, someone who already posted from another tool. A
  reminder that fires when the user knows better than the system is worse
  than no reminder.
- **Frequency discipline.** At most one nudge a day, easy to turn off, and
  silence after it is ignored twice. This should be a hard rule in code,
  not a line in the prompt.
- **Consent.** Unprompted messages need explicit opt-in, per channel. A
  WhatsApp message nobody asked for is a different thing from an in-app
  card.

**Open questions:**

- Does the nudge carry a ready draft, or only an offer? A draft is more
  useful and more presumptuous.
- Who does the noticing — a scheduler running deterministic checks, or the
  model reading a summary of recent activity? The first is cheap and
  predictable; the second catches patterns nobody thought to look for. Most
  likely: deterministic detection, model-written message.
- Does it learn from being ignored, and how quickly?

**Where it lands:** a new scheduler under `src/maestro/`, the existing
bridge and notification services for delivery, and a per-user preference
row for consent and frequency.

---

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

**Spec:** `docs/superpowers/specs/2026-08-26-maestro-core-tests-design.md`
**Plan:** `docs/superpowers/plans/2026-08-26-maestro-core-tests.md`
**Status:** planned 2026-08-26, coding scheduled for 2026-08-27.

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
