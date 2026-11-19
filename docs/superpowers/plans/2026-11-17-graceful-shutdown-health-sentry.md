# Graceful Shutdown, Health Checks & Sentry — Implementation Plan

> **For agentic workers:** steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a deploy stop stranding in-flight posts, let the platform restart a hung instance, and surface 5xx errors in Sentry.

**Architecture:** Three parts in dependency order. Shutdown ordering is fixed *first* because it is the reason hooks are currently disabled; health and Sentry build on a process that can now exit cleanly.

**Tech Stack:** NestJS 11, `@nestjs/terminus`, `@sentry/nestjs`, BullMQ (`@nestjs/bullmq` 11.0.4), ioredis, node-postgres.

**Spec:** `docs/superpowers/specs/2026-08-23-observability-health-shutdown-design.md` (on `feat/observability-health-shutdown`)

## Global Constraints

- **Only 5xx reaches Sentry.** 4xx is client noise and must not be captured.
- **`SENTRY_DSN` unset ⇒ Sentry fully disabled**, zero overhead, app behaves identically. This is the default dev experience and must stay true.
- **`/health/live` must NOT check dependencies.** A DB outage causing liveness failure would make the platform restart-loop a healthy app. Only `/health/ready` checks DB+Redis.
- **`sendDefaultPii: false`** — no IPs. User context is ids only.
- **The `error_logs` pipeline stays the system of record.** Sentry is additive; no response shape changes.
- **Shutdown must be idempotent** — a double signal must not throw.
- `src/instrument.ts` must be imported as the literal first line of `main.ts`.

## How the spec changed after re-verification (2026-11-17)

The spec is from 2026-08-23. Three of its assumptions no longer hold:

1. **Spec step A1 ("just call `enableShutdownHooks()`") is unsafe as written.** It was attempted and reverted on 2026-11-15 (`9fffcee`). Verified: `@nestjs/bullmq` 11.0.4 closes workers in `onApplicationShutdown`, which Nest runs *after* `onModuleDestroy` — where `RateLimiterService` and `ChatbotRateLimitGuard` quit their Redis clients. Enabling hooks alone makes workers run jobs against closed Redis. **Task 1 fixes the ordering first**; only then is the hook safe.
2. **`railway.json` is deprecated** — Railway stops reading it on 2026-12-01. Spec steps B6 (deploy block) and the Railway side of B7 are therefore **out of scope for this plan** and move to a follow-up that migrates to `.railway/railway.ts`.
3. **Railway IaC is not applied at deploy time** — it needs `railway config plan` / `railway config apply` from the CLI, i.e. an owner action, not a PR.

Spec detail corrections: `src/drizzle/db.ts` exports only `db`, not `pool` (Task 2 must export it); the global guard is `WorkspaceSuspendedGuard`, not an allowlist guard.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/channels/analytics/redis-client.provider.ts` | **Modify** — close its client after workers, not before |
| `src/channels/messaging-overview/messaging-overview.module.ts` | **Modify** — same |
| `src/chatbot/guards/chatbot-rate-limit.guard.ts` | **Modify** — `onModuleDestroy` → `onApplicationShutdown` |
| `src/queue/rate-limiter.service.ts` | **Modify** — same (this is the publish-path client) |
| `src/drizzle/db.ts` | **Modify** — export `pool` so it can be closed |
| `src/drizzle/database-lifecycle.service.ts` | **Create** — `pool.end()` on shutdown |
| `src/main.ts` | **Modify** — `import './instrument'` first line; `enableShutdownHooks()` |
| `src/instrument.ts` | **Create** — `Sentry.init` |
| `src/health/health.module.ts` / `health.controller.ts` | **Create** — `/health/live`, `/health/ready` |
| `src/logs/all-exceptions.filter.ts` | **Modify** — capture 5xx to Sentry with user context |
| `.env.example` | **Modify** — Sentry vars |

---

### Task 1: Move Redis cleanup after worker shutdown

The bug that forced hooks off. Nest order: `onModuleDestroy` → `beforeApplicationShutdown` → `onApplicationShutdown`. BullMQ workers close in `onApplicationShutdown`, so any Redis the publish path needs must survive until then.

**Files:**
- Modify: `src/queue/rate-limiter.service.ts:416`
- Modify: `src/chatbot/guards/chatbot-rate-limit.guard.ts:36`
- Modify: `src/channels/analytics/redis-client.provider.ts`
- Modify: `src/channels/messaging-overview/messaging-overview.module.ts`
- Test: `src/queue/rate-limiter.service.spec.ts`

- [ ] **Step 1: Write the failing test** — asserts the service implements `onApplicationShutdown` and NOT `onModuleDestroy`, and that a double call does not throw.

- [ ] **Step 2: Run it, confirm it fails**

- [ ] **Step 3: Rename the hook** in `rate-limiter.service.ts` and `chatbot-rate-limit.guard.ts`: `OnModuleDestroy` → `OnApplicationShutdown`, keeping the existing `status !== 'ready' ? disconnect() : quit().catch(disconnect)` body (already idempotent). Add a comment naming *why* the late hook matters.

- [ ] **Step 4: Give the two provider-created clients a closer.** `RedisClientProvider` and `MessagingRedisProvider` are factories; a factory's return value gets no lifecycle hooks. Add a small `OnApplicationShutdown` service in each module that injects the client and quits it.

- [ ] **Step 5: Run tests, confirm pass**

- [ ] **Step 6: Commit** — `fix(shutdown): close Redis after BullMQ workers, not before`

### Task 2: Close the database pool on shutdown

**Files:**
- Modify: `src/drizzle/db.ts` (export `pool`)
- Create: `src/drizzle/database-lifecycle.service.ts`
- Test: `src/drizzle/database-lifecycle.service.spec.ts`

- [ ] **Step 1: Failing test** — `onApplicationShutdown` calls `pool.end()`; a second call does not throw and does not call `end()` twice.
- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3:** `export const pool = ...` in `db.ts`; write the lifecycle service with a `closed` flag; register it in the Drizzle module.
- [ ] **Step 4: Run, confirm pass**
- [ ] **Step 5: Commit** — `fix(shutdown): close the Postgres pool on shutdown`

### Task 3: Enable shutdown hooks

Only safe once Tasks 1–2 land.

**Files:** Modify `src/main.ts:28-32`

- [ ] **Step 1:** Replace the "stay off on purpose" comment with `app.enableShutdownHooks()` plus a comment recording the ordering requirement that makes it safe, and the Railway draining caveat.
- [ ] **Step 2:** `npm run build` green.
- [ ] **Step 3: Commit** — `feat(shutdown): enable shutdown hooks now that ordering is correct`

### Task 4: Health endpoints

**Files:**
- Create: `src/health/health.module.ts`, `src/health/health.controller.ts`
- Test: `src/health/health.controller.spec.ts`
- Modify: `src/app.module.ts`

- [ ] **Step 1: Failing tests** — `/health/live` returns ok with no dependency call at all (assert the DB/Redis mocks were never invoked — this is the invariant, not just the status code); `/health/ready` 200 when both ping, 503 when either rejects.
- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3:** Implement with terminus. `live` = static ok. `ready` = `SELECT 1` + Redis `PING`.
- [ ] **Step 4:** Confirm `WorkspaceSuspendedGuard` lets these through (unauthenticated infra probes); mark `@Public()`/`@SkipSuspendCheck()` as the codebase requires.
- [ ] **Step 5: Run, confirm pass**
- [ ] **Step 6: Commit** — `feat(health): liveness and readiness endpoints`

### Task 5: Sentry

**Files:**
- Create: `src/instrument.ts`
- Modify: `src/main.ts` (first line), `src/app.module.ts`, `src/logs/all-exceptions.filter.ts`, `.env.example`
- Test: `src/logs/all-exceptions.filter.spec.ts`

- [ ] **Step 1: Failing test** — filter captures a 500 to Sentry; does NOT capture a 404; attaches user id + workspace tag when `request.user` exists; still writes `error_logs` and returns the same response in both cases.
- [ ] **Step 2: Run, confirm fail**
- [ ] **Step 3:** `instrument.ts` with `enabled: !!process.env.SENTRY_DSN`; import first in `main.ts`; `SentryModule.forRoot()` in AppModule; manual `Sentry.captureException` gated to `status >= 500` in the filter (manual, not the decorator — the decorator captures all statuses and the 5xx-only rule is a hard constraint).
- [ ] **Step 4: Run, confirm pass**
- [ ] **Step 5:** `.env.example` — `SENTRY_DSN=`, `SENTRY_TRACES_SAMPLE_RATE=0.1`.
- [ ] **Step 6:** `npm run build` green both with and without `SENTRY_DSN`.
- [ ] **Step 7: Commit** — `feat(observability): report 5xx to Sentry`

### Task 6: Verify locally, then document

- [ ] **Step 1:** Boot against local Postgres + Redis. `GET /health/live` → 200; `GET /health/ready` → 200.
- [ ] **Step 2:** Stop Redis → `/health/ready` 503, `/health/live` **still 200** (the whole point).
- [ ] **Step 3:** SIGTERM the process → logs show workers closing, then Redis quits, then `pool.end()`, clean exit, no "connection terminated unexpectedly".
- [ ] **Step 4:** Write `docs/graceful-shutdown-and-health.md` — ordering rule, why hooks were once off, what the owner must still do on Railway.
- [ ] **Step 5: Commit**

---

## Out of scope — follow-up PR

Railway-side config (`healthcheckPath`, `restartPolicyType`, `drainingSeconds`) must move to `.railway/railway.ts` and be applied via `railway config apply` by the owner. Without a draining window the shutdown code still runs, but has less time to finish. Tracked separately because it is an owner CLI action, and because it doubles as the mandatory `railway.json` migration before 2026-12-01.
