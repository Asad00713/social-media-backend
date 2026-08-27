# Maestro — platform tools, and answers you can click

**Date:** 2026-08-27
**Status:** Layer 1 approved, layers 2–4 agreed in principle
**Scope:** backend (`socialmedia-workspace`) + frontend (`socialmedia-frontend`)

---

## Where we are

Maestro has 28 tools. **26 of them are messaging** — Slack, Discord, Telegram,
WhatsApp. The product itself has three: `list_posts`, `get_post`, `publish_post`.

So Maestro today is a messaging agent that happens to live inside Schedura. It
cannot answer "how many channels do I have", "what's going out this week", or
"which post did best" — the three things a user is most likely to ask it.

---

## Not module by module

The obvious plan is to finish Channels, then Campaigns, then Inbox. We are
deliberately not doing that, for two reasons.

**Users think in tasks, not modules.** "What's going out this week?" touches
posts, campaigns, and the calendar at once. Finishing Campaigns' twelve tools
while Channels has none leaves the agent unable to answer ordinary questions —
it would look no better than it does now, for a lot of work.

**More tools means worse tool choice.** Going from 28 to ~80 tools degrades
selection accuracy, and we run Haiku 4.5 by default. Breadth-first keeps the
tool count honest: each layer adds a thin slice everywhere rather than a deep
well in one place.

So: **capability by capability**, each layer spanning the whole product.

| Layer | What | Risk | Gate |
|---|---|---|---|
| 1 | Read — show me | none | none |
| 2 | Interactive cards — do it in the UI | none (user acts) | none |
| 3 | Create / edit drafts | reversible | none |
| 4 | Publish, launch, delete | irreversible | confirm |

Layer 4 rides on the confirm gate fixed in
`2026-08-27-maestro-question-turn-design.md`.

---

## Layer 1 — read, with references

This document covers Layer 1. Later layers get their own specs.

### The actual requirement: answers you can click

Not just "return the data". Every entity Maestro names must be a **link back
into the app**, rendered inline the way ClickUp's assistant does it: the task
name is clickable, and its status rides beside it as a pill.

Today `rich-text.tsx` renders paragraphs, bullets, and `**bold**` — and nothing
else. There is no link support at all. A tool returning a channel list can only
produce dead text.

This is the substance of Layer 1, not a polish pass on top of it. A read tool
whose answer cannot be clicked has not really answered.

### How references travel

Tools return **structured references**, never a pre-baked URL string.

A tool result carries the entities it mentions — kind, id, label, and status —
and the model refers to them by a marker in its prose. The frontend resolves
each marker into a link, building the href from the workspace route table it
already owns.

This matters because the model must not be inventing URLs. It knows entity ids
because the tool gave them; it does not know our routing, and should not.
Anything it cannot resolve renders as plain text — a wrong link is worse than
no link.

### Tools

Channels first — it is where the user's own example starts ("I don't know how
to connect a channel"), and everything else depends on channels existing.

1. `list_channels` — what is connected, what is expiring, what needs reconnecting
2. `get_channel_stats` — followers, reach, per-channel performance
3. `connect_channel` — an interactive card (below)

Then the same shape across posts, campaigns, inbox, media, and calendar.

### `connect_channel` — the card pattern

The user's example: *"I don't know how to connect a channel"* → agent asks which
platform → user picks → agent returns **a button** → user clicks → connected.

This is a new pattern, not just a new tool: **the agent returns an interactive
card, and the actual work happens in the browser.** `MediaGrid` already proves
the panel can render a rich tool result; this extends it to one that acts.

The card routes to `/settings/channels` with the platform preselected. It does
**not** open the OAuth popup directly from the panel: the COOP popup-close bug
is still open on production (`project_oauth_popup_close_bug`), and routing the
user to the page they would have used anyway avoids inheriting it.

The pattern is reused later for "open this post", "show this campaign",
"reconnect this channel".

---

## Out of scope

- **Layers 2–4.** `connect_channel` is included because it is Layer 1's proof of
  the card pattern at small scope, not because Layer 2 starts here.
- **Analytics comparisons.** Reading numbers is Layer 1. Charts, period-over-
  period, and cross-channel comparison are a separate effort.
- **Write of any kind.** No tool in this layer changes state.

---

## Definition of done

- Asking about channels, posts, campaigns, inbox, media, or the calendar returns
  real data from the user's workspace.
- Every entity named in an answer is clickable and lands on the right screen,
  with status shown inline where the entity has one.
- An unresolvable reference degrades to plain text — never a broken link.
- Reference rendering is verified **visually in a real browser**, not only by
  unit test: screenshots of the rendered answer plus the network payload behind
  it.
- No tool in this layer can change workspace state.
- `npm run test` and `npm run build` green on the backend; `npm run build` green
  on the frontend.
