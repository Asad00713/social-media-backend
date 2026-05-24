# Admin Dashboard Spec (SaaS Owner View)

**Date:** 2026-05-17
**Status:** Draft — planning only, not yet implemented
**Audience:** SaaS owner (single super-admin role), NOT end users

---

## 1. Goal & non-goals

### Goal
Single internal dashboard for the SaaS owner to monitor system health, resource consumption, user activity, and operational risks. Surfaces the data needed to operate the product without diving into logs or DB queries.

### Non-goals
- End-user-facing analytics (those live on the per-workspace channel pages)
- Per-workspace billing UI (that's the existing billing module)
- Real production observability replacement (Prometheus/Grafana eventually; this is the at-a-glance ops view)

### Access control
- Single `SUPER_ADMIN` role (already exists in auth schema)
- All dashboard routes guarded by existing `SuperAdminGuard`
- Mounted at `/admin/dashboard` (separate from existing Bull Board at `/admin/queues`)

---

## 2. Sections (vertical scroll, top to bottom)

### 2.1 System health overview (top hero)
- Backend uptime, last deploy timestamp, current git commit SHA
- Number of: active users, active workspaces, connected channels (total + by platform)
- Total scheduled posts queued for next 24h
- Open errors in last 1h / 24h (count, with link to detail)

### 2.2 Platform API quota tracking
**The most important panel.** Each row = one platform.

| Platform | Today's usage | Daily limit | % used | Status |
|---|---|---|---|---|
| YouTube | 4,230 / 10,000 units | 10,000 | 42% | 🟢 |
| YouTube Analytics | 1,150 / unlimited | — | n/a | 🟢 |
| Facebook | 850 calls / unlimited (per-user limits) | — | n/a | 🟢 |
| Instagram | 1,420 calls / unlimited | — | n/a | 🟢 |
| Twitter | 89 / 100 (Free tier) | 100/15min | 89% | 🟡 |
| LinkedIn | 234 / 500 (per app) | 500/day | 47% | 🟢 |
| TikTok | 12 / 1,000 | 1,000/day | 1% | 🟢 |
| Pinterest | 67 / 1,000 | 1,000/day | 7% | 🟢 |

**Data sources:**
- YouTube: Redis quota tracker (`quota:youtube:YYYY-MM-DD` already exists)
- Other platforms: similar Redis trackers (build per-platform as adapters ship)
- Visual: stacked bar chart per platform over last 24h (per-hour buckets)
- Alert thresholds: 70% yellow, 90% red, 95% block-new-calls
- Drill-down: click a platform → see per-workspace breakdown (who's burning the quota)

### 2.3 Cron jobs status
Live table of all registered crons.

| Job name | Schedule (UTC) | Last run | Status | Next run | Duration | Items processed |
|---|---|---|---|---|---|---|
| `enqueueProfileSnapshots` | 02:00 daily | 2026-05-17 02:00 | ✅ | 2026-05-18 02:00 | 3.2s | 47 channels |
| `enqueueRecentPostsSync` | 02:30 daily | 2026-05-17 02:30 | ✅ | 2026-05-18 02:30 | 2.1s | 47 channels |
| `enqueueDailyRollups` | 03:00 daily | 2026-05-17 03:00 | ✅ | 2026-05-18 03:00 | 1.8s | 47 channels |
| `enqueueTokenRefreshes` | every 10 min | 2026-05-17 16:40 | ✅ | 2026-05-17 16:50 | 0.4s | 3 channels refreshed |
| `checkRefreshTokenExpiry` | 12:00 daily | 2026-05-17 12:00 | ✅ | 2026-05-18 12:00 | 0.2s | 0 channels expiring |
| (additional from chatbot / drip / etc.) | | | | | | |

**Data source:** NestJS `SchedulerRegistry` for registered crons + a new `cron_run_log` table that each cron writes to (start time, end time, status, items processed, error message).

**Drill-down:** click a cron → see last 30 runs (success/failure history) + log output.

### 2.4 BullMQ queue depth
Per-queue live counts (link to existing Bull Board at `/admin/queues` for full detail).

| Queue | Waiting | Active | Completed (24h) | Failed (24h) | Avg job duration |
|---|---|---|---|---|---|
| `post-publishing` | 12 | 2 | 891 | 4 | 1.4s |
| `token-refresh` | 0 | 0 | 144 | 0 | 0.3s |
| `drip-campaigns` | 3 | 0 | 67 | 1 | 2.1s |
| `channel-snapshots` | 0 | 1 | 423 | 0 | 0.8s |

**Alert:** if any queue's `failed` exceeds 5% of completed, flag in red.

### 2.5 AI token consumption per user per workspace
This is the most expensive recurring cost — needs careful monitoring.

**Top-level summary:**
- Today's total: 1.2M tokens · $14.50
- Past 7 days: 7.8M tokens · $92.30
- Past 30 days: 31M tokens · $367.00
- By provider: Anthropic 70%, Groq 25%, Tavily 5%

**Per-user / per-workspace breakdown table:**

| User | Workspace | Tokens (today) | Cost (today) | Tokens (30d) | Cost (30d) | Top feature |
|---|---|---|---|---|---|---|
| asad@... | Acme Co | 124,500 | $1.50 | 2.3M | $28.00 | chatbot |
| ... | | | | | | |

**Drill-down:** click a row → see per-tool breakdown (which AI feature consumed: chatbot, drip generator, agent runtime, post composer assist, etc.) + per-day chart.

**Data source:** existing `ai_usage_log` table in billing schema — already has the right shape. Just needs aggregation queries + UI.

**Alert:** flag any user > 95th percentile of consumption (likely abuse or runaway agent).

### 2.6 User activity stats
- New signups (today / 7d / 30d trends)
- Active users (DAU / WAU / MAU)
- Posts published (count by platform, today / 7d / 30d)
- Posts scheduled (currently queued)
- Drip campaigns running
- Channel connects (today / 7d) + reconnect rate (signal of token issues)
- Top platforms by usage

### 2.7 Errors + incidents
Last 50 errors across the system, filterable.

| Time | User | Workspace | Module | Error | Status |
|---|---|---|---|---|---|
| 16:42 | asad@... | Acme | analytics | YT 403 quotaExceeded | ack |
| ... | | | | | |

**Data source:** new `error_events` table (centralized error capture middleware, NestJS interceptor) OR query existing logs.

### 2.8 Billing / revenue snapshot
- MRR / ARR
- Active subscriptions by plan tier
- Trial conversions this month
- Recent payment failures
- Pending cancellations

**Data source:** existing billing module — just dashboard view.

### 2.9 Channel health
- Channels with `connection_status = 'expired' | 'error'` (need reconnect)
- Channels expiring in next 3 days (refresh-token TTL approaching)
- Channels with sync failures > 3 in last 24h

---

## 3. Sync-button validations (related concern)

Tied to quota tracking — the manual "Refresh" button in user-facing channel pages needs validations:

- **Per-channel rate limit:** 1 manual refresh per hour (already implemented via Redis)
- **Per-workspace daily cap:** add — max 50 manual refreshes per workspace per day (prevent user from burning shared YT quota)
- **Per-platform quota check:** before enqueuing the refresh job, check current quota usage; if > 85%, refuse with friendly message ("Sync currently throttled — too many requests today. Try in {N} hours.")
- **Quota tracker is the source of truth** — already exists; just needs validation hook before enqueue

Frontend UX:
- Disable button when blocked, show tooltip explaining why
- Show "Next allowed at HH:MM" countdown

---

## 4. Implementation phases

### Phase 1 (foundation)
- New `admin/dashboard.controller.ts` with section endpoints
- New `admin/dashboard.service.ts` with aggregation queries
- New `cron_run_log` table + middleware that every `@Cron()` method writes to
- New `error_events` table + global exception filter that captures
- Per-platform quota tracker extensions (already have YouTube — add the other 9)

### Phase 2 (frontend)
- New admin route in frontend at `/admin/dashboard` (separate from existing admin pages)
- Capability-driven sections (some panels only render if data sources exist)
- Real-time updates via WebSocket (same WebSocket gateway built for user-facing analytics)
- Charts: Recharts (already used)

### Phase 3 (alerts)
- Optional: email/Slack/Discord notifications when:
  - Quota > 90% for any platform
  - Any cron failed
  - AI cost spike (> 2× rolling 7-day average)
  - Channel sync failure rate > 10%

---

## 5. Open questions (not blocking design)

1. **WebSocket-pushed updates** for the dashboard (so admin sees live numbers without refresh) — implement now or after user-facing WebSocket layer ships?
2. **Historical retention** for cron_run_log / error_events — 30 days? 90? Forever?
3. **Export to CSV** — needed or skip?
4. **Multi-admin** — if SaaS grows, support multiple admin users with role permissions? (Defer until needed)

---

## 6. Related memory

- Production-grade architecture mandate: see `feedback_production_grade_no_shortcuts.md` — every panel should default to real-time / WebSocket-pushed, not "click refresh to see updates"
- YouTube API quota strategy: see `project_youtube_quota_strategy.md` (sibling memory) — admin dashboard's platform quota panel is the operational view of this

---

## 7. NOT IMPLEMENTED YET

This document is the **spec for future implementation**. No code exists yet. When build begins, follow Phase 1 → 2 → 3 ordering. Estimated effort: 2-3 weeks for full implementation.
