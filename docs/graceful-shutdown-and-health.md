# Graceful shutdown, health checks and Sentry

What happens when the process is told to stop, how the platform decides an
instance is healthy, and where errors surface.

---

## Graceful shutdown

### The problem it solves

Railway sends `SIGTERM` on every deploy. Without shutdown hooks the process
dies where it stands — and if it was publishing a post at that moment, that
post is stranded forever: its row sits in `publishing`, the processor skips
non-`scheduled` rows, and manual retry refuses that state. Nothing recovers
it. Every deploy was a chance to lose a post.

### The ordering, and why it is the whole design

Hooks were enabled once before and reverted the same day (`9fffcee`,
2026-11-15). The reason was real: `@nestjs/bullmq` closes its workers in
`onApplicationShutdown`, and our Redis clients were closing in
`onModuleDestroy` — which Nest runs *first*. Workers kept taking jobs against
a dead connection, so a publish could reach the platform, fail its own
bookkeeping, be marked failed, and **double-post on retry**.

Moving Redis to `onApplicationShutdown` is *not* a fix on its own. Nest runs
the hooks **within** a phase concurrently:

```js
await Promise.all(callOperator(nonTransientInstances, signal));
```

Two things in the same phase is a race, not an order. What *is* guaranteed is
that the phases themselves are sequential and awaited:

```
onModuleDestroy → beforeApplicationShutdown → dispose → onApplicationShutdown
                         ▲                                      ▲
                  workers drain here                 connections close here
```

So the ordering comes from the **phase split**:

| Phase | What runs | Where |
|---|---|---|
| `beforeApplicationShutdown` | every BullMQ worker closed | `src/queue/worker-drain.service.ts` |
| `onApplicationShutdown` | Redis `.quit()` ×5, Postgres `pool.end()` ×2 | the services below |

By the time any connection closes, no job is still running.

`WorkerDrainService` reaches the workers through `WorkerHost`, not through
`@nestjs/bullmq`'s private explorer. The library's own hook still fires
afterwards and finds them closed — `Worker.close()` is idempotent.

### What closes

| Resource | Closed by |
|---|---|
| BullMQ workers | `WorkerDrainService` (`beforeApplicationShutdown`) |
| `RateLimiterService` Redis | its own `onApplicationShutdown` |
| `ChatbotRateLimitGuard` Redis | its own `onApplicationShutdown` |
| `REDIS_CLIENT` (×4 modules) | `RedisClientCloser`, beside the provider |
| `MESSAGING_REDIS` | `MessagingRedisCloser` |
| `DRIZZLE_POOL` | `DatabaseLifecycleService` |
| `db.ts` pool (230 importers) | a second `DatabaseLifecycleService` |

Two Postgres pools exist and both are real: the `db.ts` singleton (imported by
230 files) and the one behind the `DRIZZLE` token (130 injection sites).

### Rules when touching this

- **Never clean up a connection in `onModuleDestroy`.** That phase runs before
  the workers stop. The tests assert the hook *name* for this reason — renaming
  it back is the regression, and it must fail.
- A `useFactory` provider's return value gets **no lifecycle hooks**. A client
  built that way needs a closer service, or it leaks.
- Every closer must be idempotent and must never reject: a double signal is
  ordinary, and one failure must not abandon the rest of the sequence.

### Verifying it

**Not on Windows.** `process.kill(pid, 'SIGTERM')` there terminates the process
immediately without running handlers — Windows has no POSIX signals. A shutdown
test on Windows proves nothing.

Use Linux, and make sure something keeps the event loop alive. Nest's signal
handler is `async`; if nothing else is pending, Node exits mid-await and the
hooks are cut off. The real app has its HTTP server; a probe needs a listening
socket of its own.

Verified 2026-11-17 in `node:22-alpine` with a real SIGTERM, against the real
`DatabaseLifecycleService`:

```
ORDER=1-workers-drained -> 2-pool-end
```

---

## Health checks

| Route | Checks | Answers |
|---|---|---|
| `GET /health/live` | **nothing** | always `200 {"status":"ok"}` |
| `GET /health/ready` | Postgres + Redis | `200`, or `503` with which one is down |

**Liveness must never check a dependency.** If it did, a database outage would
read as a dead app, the platform would kill and recreate the instance, and the
restarts would make a recoverable blip into an outage of our own making.
Dependency health belongs to readiness, where the consequence is shedding
traffic rather than killing the process.

Both readiness checks run even when the first fails, so one request reports the
whole picture, and each is bounded by a 3s timeout — a hung dependency would
otherwise make an unready instance look merely slow.

The 503 body names which dependency is down but never carries the underlying
error: connection failures quote hosts, ports and sometimes credentials, and
this route is unauthenticated.

Verified against a running server with Redis stopped: `/live` stayed `200`
while `/ready` returned `503 {"database":"up","redis":"down"}`.

---

## Sentry

Reports **5xx only**. A 4xx is the client being wrong, and alerting on those
buries the failures that are ours. 4xx still lands in `error_logs`, which
remains the system of record — Sentry is additive.

`SENTRY_DSN` unset ⇒ the SDK is disabled: no network calls, no overhead,
identical behaviour. Setting the variable is the only step to turn alerting on.

**URLs are scrubbed before they leave.** `sendDefaultPii: false` withholds IPs
and headers but not the request URL, and some of this app's URLs *are* the
credential (report links, render tokens, email unsubscribe and security links).
`beforeSend`, `beforeSendTransaction` and `beforeSendSpan` all apply the same
redaction the `error_logs` writer uses — transactions are sampled independently
of errors, so a token would otherwise reach Sentry through tracing even when
nothing threw. Bodies, query strings, cookies and headers are dropped outright.

`src/instrument.ts` is the literal first import in `main.ts`. Sentry patches
libraries as they load; anything imported ahead of it is captured by reference
and never traced.

---

## ⚠ Still owed on Railway — the platform side

The code is only half of a graceful deploy. Railway decides **how long** the
old process gets before `SIGKILL`, and right now nothing sets that.

`railway.json` **cannot** be used for this: Railway deprecated Config as Code
and stops reading those files on **2026-12-01**. The replacement is
`.railway/railway.ts`, and it is not applied on deploy — it needs
`railway config plan` then `railway config apply` from the CLI.

So two things are owed, and they are one job:

1. Migrate `railway.json` → `.railway/railway.ts` (mandatory before 2026-12-01
   regardless of this work).
2. Set in it:
   - `drainingSeconds` — the window the shutdown above actually runs in.
     Without it the drain starts and is killed partway.
   - `healthcheckPath: "/health/live"` — so an instance that stops answering
     is restarted. Never `/health/ready`: a Redis blip would then restart a
     healthy instance, turning a degraded dependency into an outage.
   - `restartPolicyType: "ON_FAILURE"` with a bounded retry count.

Until both happen, the shutdown sequence runs but may not finish, and nothing
restarts a hung instance.

### Sentry is live (2026-11-17)

Done, so no longer on the list above:

| | |
|---|---|
| Org / project | `schedura-qt` / `schedura-backend` (platform Nest.js) |
| Products | Error monitoring + Tracing. Logging, Profiling and Application Metrics are off deliberately — this backend emits none of them, and each costs quota. |
| Privacy | Data Scrubber, default scrubbers, and "Prevent Storing of IP Addresses" all on. That last one is off by default in a new project. It is a second layer behind this app's own scrubbing, not a replacement for it. |
| Alerting | One rule: high-priority issues → email. |
| `SENTRY_DSN` | Set in Railway Variables. |

The DSN is readable any time from the project's Client Keys page, so it does
not need to be recorded here.
