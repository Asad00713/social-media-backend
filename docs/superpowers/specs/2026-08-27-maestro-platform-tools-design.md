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

## The target

**Anything the user can do or see in the app, the agent can do or see too.**

That is the standard set for this work, and it is what makes the layering below
a sequence rather than a subset: every layer is on the way to full parity, none
of them is the stopping point.

Two things follow from it, and they hold for every later layer:

- **The agent uses the same paths the UI uses.** Not a parallel implementation
  that drifts. If connecting a channel runs OAuth in the UI, it runs OAuth from
  the agent — the same hook, the same popup, the same callback.
- **Parity of surface, not of permission.** The agent inherits the user's own
  capabilities and workspace scope. It can never see or do more than the person
  asking, and every read derives its workspace from the request context.

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

**Analytics: everything the Insights UI shows** — per the user's decision. That
surface is `kpi-strip`, `metrics-chart`, `platform-breakdown`, and
`channel-table`, so the agent reads the same numbers behind them: KPIs and their
trend, the metric series over a period, the per-platform split, and per-channel
performance.

Read the values through the services the UI already calls. Nothing new is
computed for the agent, and no number should be derivable only by asking it —
if the agent and the Insights page disagree, that is a bug in this work.

The agent answers in prose and links; it does not draw charts. Rendering a chart
in the panel is a later question, and not what "show me my analytics" needs.

### `connect_channel` — the card pattern

The user's example: *"I don't know how to connect a channel"* → agent asks which
platform → user picks → agent returns **a button** → user clicks → connected.

This is a new pattern, not just a new tool: **the agent returns an interactive
card, and the actual work happens in the browser.** `MediaGrid` already proves
the panel can render a rich tool result; this extends it to one that acts.

**The button runs the real OAuth flow** — the same behaviour as connecting from
the Channels page, per the user's decision. It reuses `useInitiateOAuth` and
`openOAuthPopup` rather than reimplementing anything: the agent must not become
a second, subtly different connect path.

One constraint shapes the card: `useInitiateOAuth` does not redirect on its own,
and the popup **must be opened synchronously inside the click handler** or popup
blockers kill it. So the card owns the click and the popup; the agent's job ends
at rendering it. An agent-initiated popup is not possible here, and that is
fine — the user clicking is the action.

**This inherits the open COOP popup bug.** `project_oauth_popup_close_bug`:
on production the popup does not auto-close after connecting, because COOP
severs `window.close()`. It is real today on the Channels page and it will be
equally real inside Maestro. Since this work makes it more visible, the fix
(parent-side close) belongs here rather than staying queued — otherwise the
agent's headline feature ends in a window the user has to close by hand.

The pattern is reused later for "open this post", "show this campaign",
"reconnect this channel".

---

## Out of scope

- **Layers 2–4.** `connect_channel` is included because it is Layer 1's proof of
  the card pattern at small scope, not because Layer 2 starts here.
- **Analytics beyond what the UI shows.** Nothing new is computed for the agent.
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
