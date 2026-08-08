# Workspace deactivation on inactivity

**Status:** design only — nothing here is built. The existing sweep is
disabled (see below) and must stay that way until this is implemented.

**Written:** 2026-08-08

---

## Why this exists

An account nobody has opened in months still costs us money: tokens refreshed
on a schedule, inbox polling, webhook deliveries, rows in every table. The
platform should be able to wind such an account down on its own and bring it
back the moment someone returns.

There was already a sweep doing something in this direction. It was wrong in
ways that made it dangerous, and it is currently switched off.

## What the old sweep did, and why it is off

`UserInactivityService` ran daily with four steps:

| Day | Action |
|-----|--------|
| 15 | Reminder email |
| 25 | Second reminder |
| 30 | `users.isActive = false` |
| 365 | `db.delete(users)` — cascades everywhere |

Three faults, in increasing order of severity.

**It measured the wrong thing.** `COALESCE(lastLoginAt, createdAt)` treats a
never-logged-in user as inactive from the day their row was created. But
`lastLoginAt` is only written on an interactive sign-in, and a user with a live
session and a refresh token can work for weeks without one. People who were
using the product every day were counted as thirty days gone.

**It acted on users, not workspaces.** It suspended the person. A workspace
whose owner went quiet kept publishing; a member who went quiet was switched
off even though their team was busy. Neither is what anyone wanted.

**The 365-day step deletes.** It selects on `isActive = false` — the exact
state the 30-day step creates. A wrong suspension today becomes a permanent
cascading delete in a year, with no human in the loop and no undo. This alone
justified disabling the whole cron rather than repairing one step of it.

The `@Cron` decorator was removed rather than commented out, and
`runManualCheck()` now refuses and logs. The method bodies are intact so this
design has something to build from.

---

## What "inactive" should mean

Not "nobody signed in." A workspace is alive if anything happened in it:

- a post published or scheduled
- an inbox message read or replied to
- a channel connected, reconnected or synced
- an AI call
- media uploaded
- any authenticated request against the workspace

The cheapest honest signal is a `workspace.lastActivityAt` column, written by
the same middleware that already resolves the workspace on a request. One
write per workspace per day is enough — a `lastActivityAt < today` guard keeps
this off the hot path.

**Open question:** does a scheduled post publishing on its own count as
activity? It is the platform working, not a person. Leaning no — otherwise a
workspace with one recurring drip campaign never goes quiet, which is exactly
the kind of account this is meant to catch. Worth deciding before writing the
query.

## Proposed schedule

Days are from `workspace.lastActivityAt`.

| Day | Action | Reversible by |
|-----|--------|---------------|
| 30 | First email to the owner | — |
| 45 | Second email, naming the date | — |
| 60 | Deactivate: `isActive = false`, `suspendedReason = 'inactivity'` | Owner signing in |
| — | **No automatic deletion, ever** | — |

Deletion stays a human decision. If dormant data becomes a real cost, that is
a separate proposal with its own review — not a step at the end of a cron.

### What deactivation does

- Members cannot sign in to the workspace; they see a page saying it went
  quiet and offering a one-click reactivate.
- Scheduled posts stop publishing. **Open question:** are queued posts held or
  cancelled? Held is kinder and risks a burst of stale posts firing on
  reactivation. Suggest holding them but requiring an explicit "publish these
  N held posts" confirmation rather than releasing them automatically.
- Inbox polling and token refresh stop for its channels. Tokens will expire;
  reactivation should surface which channels need reconnecting rather than
  pretending the workspace came back whole.
- Billing is untouched. A paying customer is never deactivated for inactivity
  — see below.

### Who is exempt

- Any workspace with an active paid subscription. They are paying for the
  privilege of not using it.
- Workspaces in trial, until the trial ends.
- Any workspace an admin has pinned. Needs a flag; does not exist yet.

## Reactivation

Signing in reactivates automatically — clearing `isActive` and
`suspendedReason`, and only when the reason is `inactivity`. A workspace a
person suspended must never be reopened by the customer walking back in, which
is the whole reason the two states are stored distinctly.

Admins can reactivate either kind from the dashboard, which already works.

## Emails

Three, all to the owner:

1. **Day 30** — "We haven't seen you in a month." What they set up, what is
   still scheduled, one link back in.
2. **Day 45** — Same, plus the date it switches off.
3. **Day 60** — "Your workspace has been paused." What paused means, what was
   kept, and the reactivate link.

All three need the customer-facing copy written; the admin-facing sentences in
this document are not it.

**Open question, still unanswered:** should an *admin* suspension email the
customer too? Currently it does not — a workspace can be suspended for
non-payment and the customer finds out by being locked out. Non-payment and
abuse probably want different answers, which is an argument for making the
email a per-reason decision in the suspend dialog rather than a blanket rule.

## Admin visibility

Most of this already exists:

- The workspaces list has a `deactivated` state filter, shown in amber and
  distinct from a human suspension.
- The detail page's banner already says the sweep did it and that no person
  is attached.

What is missing:

- A "quiet for N days" column or filter, so accounts can be seen drifting
  toward deactivation rather than only after it lands.
- Somewhere to see how many the sweep took each night, and undo a batch.

## Before any of this ships

1. `workspace.lastActivityAt`, backfilled from the best signal available, and
   **running in production long enough to be trusted** — at minimum one full
   deactivation window, so the column has real history before anything acts
   on it.
2. A dry-run mode that logs what it would deactivate and touches nothing.
   Read the output for a week.
3. Only then enable the sweep, starting with the emails and leaving the
   deactivation step off until the dry run has been boring for a while.

The old sweep's real failure was not any single query. It was going straight
to production with no dry run, no way to see what it had decided, and a delete
at the end of it.

## Open questions, collected

1. Does an automated publish count as workspace activity?
2. Are queued posts held or cancelled on deactivation?
3. Should admin suspensions email the customer, and does that depend on the
   reason?
4. Does an admin-pinned exemption flag get built now or when first needed?
