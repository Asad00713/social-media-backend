# YouTube API Compliance & Quota Safety — Design Spec

**Date:** 2026-07-17
**Branches:** `feat/youtube-quota-safety` then `feat/youtube-tos-compliance` (both off `main`)
**Status:** Approved design, pending implementation plan

---

## Goal

Make the YouTube integration submittable for **OAuth sensitive-scope verification** and the
**YouTube API Services Compliance Audit**, and stop it from exhausting its own API
quota in production.

Two separate efforts, shipped in order:

- **Effort A — Quota safety.** An active production defect: inbox polling can burn
  the entire daily YouTube quota within hours. Ships first, on its own branch.
- **Effort B — ToS compliance.** The Developer Policy obligations that must exist in
  code before an audit can pass: data retention, revocation, user deletion, disclosure.

## Why now

YouTube is one of the most complete integrations in the product — resumable upload,
Shorts detection, first-comment, inbox, PubSubHubbub push, analytics with
velocity/decay. The engineering is not the problem. What blocks submission is
quota discipline and a handful of Developer Policy obligations that were never built.

## Verified facts this design rests on

Researched and confirmed against official Google documentation on 2026-07-17.
These corrected three assumptions that were wrong at the outset — each is noted
because the wrong version would have produced a wrong design.

| Fact | Source |
|---|---|
| None of YouTube's four scopes are *restricted* — all are *sensitive*. **No CASA required.** | [Restricted scopes](https://support.google.com/cloud/answer/13464325) |
| `videos.insert` costs **~100 units** (not 1600 — changed 2025-12-04) and has its **own ~100 calls/day bucket**, outside the shared pool | [Revision history](https://developers.google.com/youtube/v3/revision_history), [Getting started](https://developers.google.com/youtube/v3/getting-started) |
| `search.list` likewise has its own ~100/day bucket | [Getting started](https://developers.google.com/youtube/v3/getting-started) |
| Everything else shares **10,000 units/day**; `commentThreads.list` = 1 unit/page, writes = 50 | [Quota calculator](https://developers.google.com/youtube/v3/determine_quota_cost) |
| **`commentThreads.list` has NO time filter** — no `publishedAfter`. Only `videoId`/`id`/`allThreadsRelatedToChannelId`. `order=time` is the default. | [commentThreads.list](https://developers.google.com/youtube/v3/docs/commentThreads/list) |
| **PubSubHubbub does NOT push comments** — only video upload, title change, description change | [Push notifications](https://developers.google.com/youtube/v3/guides/push_notifications) |
| Compliance audit is required only to obtain **more than default quota**; OAuth verification is required to serve **more than 100 users** | [Quota and compliance audits](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits) |

**Two corrections worth carrying forward:** the obvious fix for the polling defect —
"pass `since` to the API" — is impossible, because the endpoint has no time filter.
And PubSubHubbub cannot replace comment polling, because it does not carry comments.
Polling is unavoidable; only its *pacing* is under our control.

### The retention rule is narrower than it first appears

Developer Policy III.E.4 splits stored data in two, and the split decides this design:

**III.E.4.b — may be stored "for as long as is necessary":**
> *"(1) data retrieved through the YouTube Analytics API service, (2) data provided
> through the YouTube Reporting API service, or (3) statistics provided through other
> YouTube API services, such as the number of views for a video, the number of channels
> for a subscriber, or the number of videos in a playlist."*
>
> *"…even though an API Client may store this data for more than 30 days, the Client must
> still ensure every 30 days that it is still authorized by the user to access that data."*

**III.E.4.c — 30 calendar days, then delete or refresh:**
> *"all other types of Authorized Data not identified in section (III.E.4.b)"*

So **analytics and statistics are not on a 30-day clock** — view counts, subscriber
counts, like counts, daily rollups and the historical charts built on them may be kept
indefinitely, subject only to re-verifying authorization every 30 days. What *is* on the
clock is inbox comment **content**: comment text, author display names and avatars, and
cached video titles/thumbnails.

This matters because the naive reading ("delete everything after 30 days") would have
destroyed the analytics product for no reason.

## Scope

**Effort A — in scope:** adaptive + tiered inbox polling; early-exit pagination; quota
gating on every YouTube call site with per-subsystem allowances; a `YOUTUBE_APP_AUDITED`
gate mirroring TikTok's.

**Effort B — in scope:** a 30-day retention job for III.E.4.c data; Google token
revocation on disconnect; detection of out-of-band revocation; a user-facing "delete my
data" path; the "uses YouTube API Services" disclosure and policy links.

**Out of scope:** the 36-month derived-metrics application (optional — III.E.4.b already
permits indefinite stat storage); any change to other platforms' inbox polling beyond
what the shared scheduler requires; the submission paperwork itself (tracked as a
checklist, not code); YouTube-native `publishAt` scheduling; exposing playlist/thumbnail
in the composer UI (both exist server-side but are unreachable — separate effort).

---

## Effort A — Quota safety

### A1. The defect

`InboxPollScheduler` runs on `*/30 * * * * *` — **every 30 seconds**, i.e. 2,880 cycles/day
(`src/inbox/schedulers/inbox-poll.scheduler.ts:47`). Each cycle enqueues one job per
connected channel; each job pulls up to `MAX_POSTS_PER_RUN = 30` posts
(`src/inbox/processors/inbox-poll.processor.ts:24`) and calls `fetchComments` for every one.

`YoutubeInboxAdapter.fetchComments` accepts a `since` parameter and **never uses it**
(`src/inbox/adapters/youtube-inbox.adapter.ts:30-38`) — it is declared, then not passed to
`fetchVideoComments`. Filtering happens client-side afterwards, so every cycle re-fetches
every comment list from page 1, up to `maxPages = 5`
(`src/channels/services/youtube.service.ts:632`).

At 1 unit per page against a 10,000/day shared pool:

| Videos being polled | Units/day (1 page) | Verdict |
|---|---|---|
| 1 | 2,880 | 29% of budget |
| **4** | **11,520** | **budget exhausted** |
| 10 | 28,800 | 3× over |
| 30 (the cap) | 86,400 – 432,000 | 9–43× over |

**Four published videos exhaust the entire daily quota**, after which uploads, analytics
and comment replies all fail with `quotaExceeded` for the rest of the day. This is live
today.

### A2. Adaptive + tiered polling

A fixed cron is wrong at any scale: cost scales with videos polled, so any fixed interval
that is safe for one channel is unsafe for ten. Two mechanisms, together:

**Tiering by video age** — comments arrive overwhelmingly on recent uploads:

| Tier | Video age | Poll interval |
|---|---|---|
| Hot | < 48 hours | 15 minutes |
| Warm | 2 – 7 days | 1 hour |
| Cool | 7 – 30 days | 6 hours |
| Cold | > 30 days | Never |

The cold cutoff aligns with the existing 30-day inbox window, so no currently-polled video
is dropped. This mirrors `TieredPollingScheduler`, the pattern already used for analytics
(`src/channels/analytics/schedulers/tiered-polling.scheduler.ts`) — the codebase's own
idiom, not a new invention.

**Adaptive budget** — intervals alone are not enough, because cost scales with the number
of videos, not the interval. The scheduler is given an explicit daily allowance,
`YOUTUBE_INBOX_DAILY_UNITS`, **defaulting to 3,000** of the 10,000 shared units (leaving
roughly 5,000 for analytics and 2,000 for writes). Each cycle it computes the units its
due-now set would cost and serves only what fits, hot tier first.

Worked example at the default allowance, assuming one page per video:

| Load | Cost of one full sweep of all tiers | Fits in 3,000/day? |
|---|---|---|
| 1 channel, 5 hot + 10 warm + 15 cool videos | 5×96 + 10×24 + 15×4 = 780 | Yes |
| 10 channels, same shape each | 7,800 | No — hot served, cool deferred |

At the second load the scheduler serves hot (4,800) and warm within budget and defers
cool, rather than attempting all of it and failing mid-sweep. Deferral is logged with
counts (see Risks).

### A3. Early-exit pagination

`order=time` is the default, so the newest comments come first. Pagination stops at the
first comment older than `since` instead of always walking `maxPages = 5`. This does not
change the per-call cost, but it typically reduces 5 pages to 1 — a real 5× reduction
layered on top of the frequency fix.

### A4. Quota gating everywhere

`QuotaTrackerService` exists, is Redis-backed and correctly budgeted
(`platform-capabilities.registry.ts:477`), but is wired into only four analytics handlers.
Every other YouTube call is ungated: upload, `thumbnails.set`, `playlistItems.insert`,
`commentThreads.insert` (first comment), `comments.insert` (inbox reply), `comments.delete`,
`commentThreads.list`, `channels.list`, `videos.list`.

Gating is added at all of them, with **per-subsystem allowances** so that no subsystem can
starve another — specifically so inbox polling can never consume the budget that publishing
needs. Publishing is the user's paid-for action and takes precedence: when the budget is
tight, polling yields first.

`videos.insert` is tracked against its **own ~100/day bucket**, not the shared pool.

### A5. `YOUTUBE_APP_AUDITED`

TikTok already carries exactly this pattern: `TIKTOK_APP_AUDITED=false` gates a
pre-audit cap enforced at publish time (`src/posts/publishers/tiktok.publisher.ts`,
`tiktok-quota.service.ts`). YouTube gets the same shape — conservative caps while the
project is on default quota, relaxed once audited. The flag defaults to `false`, so a
missing env var fails safe.

---

## Effort B — ToS compliance

### B1. 30-day retention for III.E.4.c data

Nothing in the codebase deletes or ages out YouTube data today — a repo-wide search for
deletes against `inboxItems`, `channelSnapshots`, `postMetricSnapshots` and
`channelAnalyticsDaily` returns zero results. The only scheduled deletion anywhere is the
media-library recycle bin.

A scheduled job handles the III.E.4.c set only:

| Data | Table | Action after 30 days |
|---|---|---|
| Comment text, author display name, author avatar URL | `inbox_items` (`text`, `author_display_name`, `author_avatar_url`) | Delete or refresh |
| Cached video title/thumbnail on inbox rows | `inbox_items` | Delete or refresh |
| Cached channel description/thumbnail | `social_media_channels.metadata` | Already refreshed while active; delete when inactive |

Analytics and statistics (`channel_snapshots`, `channel_analytics_daily`,
`post_metric_snapshots`) are **III.E.4.b** and are explicitly **not** deleted — they are
covered instead by the 30-day authorization re-verification in B2.

A related bug is fixed here: `TieredPollingScheduler.enqueuePostMetricsByTier`
(`tiered-polling.scheduler.ts:50-64`) carries a comment promising "plus a sample of older
ones (cold tier)" while the SQL hard-filters `published_at >= cutoff30d`. The comment
describes behavior that does not exist. Either the code or the comment must go; the
comment does.

### B2. Revocation

The policy sets two different deadlines (III.D.2.3.a/b), so both paths must exist:

**In-app disconnect — revoke immediately, delete within 7 days.** Today `deleteChannel`
hard-deletes the channel row and Postgres cascades to every YouTube-derived table, which
satisfies deletion. What is missing is the revocation itself: nothing calls Google's
`https://oauth2.googleapis.com/revoke`. The only revoke call anywhere in the codebase is
Mastodon's (`src/channels/services/mastodon.service.ts:624`). The grant therefore survives
in the user's Google Account after they disconnect. A revoke call is added to the
disconnect path, and a failure to revoke must not block the disconnect — the user's intent
to disconnect wins; the failure is logged.

**Out-of-band revocation — delete within 30 days.** When a user revokes from Google's own
security settings, the app currently notices only reactively, via failed API calls, and
`connectionStatus` flips to `expired` after three consecutive auth failures
(`channel-profile-snapshot.handler.ts:203-217`). That flip stops future syncs but purges
nothing. A periodic authorization check is added, which does double duty: it satisfies
III.E.4.b's "ensure every 30 days that it is still authorized" for the analytics that are
kept indefinitely, and it triggers deletion for channels whose authorization is gone.

One job serves both obligations — they are the same question asked for two reasons.

### B3. User-initiated deletion

III.E.4 requires a way for a user to request deletion of their stored data, honored within
7 days. Disconnecting a channel already deletes its data via cascade, but that is a
side-effect of disconnecting, not a stated capability. This is made explicit and
discoverable in the UI, so it can be demonstrated to a reviewer, and the guarantee is
stated in plain language where the user acts.

### B4. Disclosure and branding

Platform brand icons are already rendered consistently next to YouTube data across the
composer, channel overview, inbox and insights. What is missing is the disclosure the
Developer Policy requires: a statement that the product uses YouTube API Services, and
links to the [YouTube Terms of Service](https://www.youtube.com/t/terms) and the
[Google Privacy Policy](https://policies.google.com/privacy). These are added where a
reviewer will look — the settings/legal surface and the YouTube connect flow.

---

## Rollout

**No DB migration.** Every change is code: schedulers, quota checks, a retention job, a
revoke call, and UI copy. Existing rows are handled by the retention job's first run.

The retention job's first run will delete comment content older than 30 days. This is the
intended, policy-required behavior and is not reversible — it is called out here so it is
not mistaken for data loss at deploy time. Analytics are untouched.

## Risks

**The retention job deletes real user-visible content.** Inbox items older than 30 days
lose their text. The window must be verified as 30 days from the comment's own timestamp,
not from row insertion, or comments will be deleted early. Tests must cover the boundary.

**Publishing must never be starved by polling.** The per-subsystem allowance is the
mechanism, and it is the thing most likely to be got wrong in a way that only shows up
under load. A test must assert that an exhausted polling allowance still leaves publishing
able to proceed.

**Silent under-polling.** An adaptive scheduler that quietly stops polling looks identical
to one that is working. Deferred tiers must be logged with counts, so "we polled nothing
today" is visible rather than inferred.

## Testing

- **Quota math** — unit tests for the adaptive budget across 1, 10 and 100 channels,
  asserting projected daily consumption stays inside the allowance.
- **Tier assignment** — boundary tests at 48h, 7d and 30d.
- **Early-exit pagination** — a comment list where page 2 crosses `since` must stop at
  page 2, not fetch all five.
- **Allowance isolation** — an exhausted polling allowance must not block a publish.
- **Retention boundary** — a comment at 29 days survives; at 31 days its content is gone;
  analytics rows in the same window are untouched.
- **Revocation** — disconnect calls Google's revoke endpoint; a revoke failure still
  disconnects; an out-of-band revocation is detected and triggers deletion.
- Backend `npm run build` and `npm run test` must pass; frontend `npm run build`,
  `npm run test` and `npm run lint` must pass.

## Submission checklist (not code — tracked here so it is not lost)

**OAuth sensitive-scope verification** — required to exceed 100 users; the app is in
Testing mode today, where the 100-user cap is a lifetime total and cannot be reset.
- Brand verification: homepage, verified domain, privacy policy
- A demo video showing the full consent flow with the actual scopes visible, then each
  granted scope being used in-product
- A justification per scope explaining why nothing narrower suffices

**YouTube API Services Compliance Audit** — required for quota above default (~100
uploads/day and 10,000 shared units/day). Submitted via the
[Audit and Quota Extension Form](https://support.google.com/youtube/contact/yt_api_form).
- Working demo account credentials — reviewers test the live product, and the most commonly
  reported rejection is the product not matching its written description
- Privacy policy screenshots highlighting the YouTube data section **and the deletion
  policy**
- Homepage screenshot showing the privacy policy link and YouTube branding
- Per-endpoint quota justification, with `videos.insert` and `search.list` as separate line
  items given their own buckets
- Screenshots of the OAuth grant/revoke flow, the upload UI, and the analytics dashboard

Google publishes no SLA for either process.

## Follow-ups (explicitly deferred)

- Expose playlist selection and custom thumbnail in the composer — both work server-side
  but have no UI field
- User-facing notification for expiring refresh tokens (`refresh-token-expiry.scheduler.ts:90`
  logs a warning and carries an explicit TODO); becomes far less urgent once the app leaves
  Testing mode and refresh tokens stop expiring weekly
- The optional 36-month derived-metrics application
- Admin dashboard quota panel (`docs/specs/admin-dashboard-spec.md`, still draft)
