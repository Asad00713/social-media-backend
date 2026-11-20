# Splitting web from worker

One process currently serves HTTP, runs 28 cron declarations and processes all 24
BullMQ queues. A heavy publish blocks the same event loop that answers the
dashboard, and the two cannot be scaled apart.

**Running a second copy of the service does not fix this.** Both copies would
still do both jobs, so an API request can still land on the process that is
busy uploading a video. Capacity doubles; isolation stays zero. The split has
to happen inside the process first — that is what `ROLE` does.

## The roles

| `ROLE`   | HTTP         | Queues | Crons |
| -------- | ------------ | ------ | ----- |
| `all`    | all routes   | yes    | yes   |
| `web`    | all routes   | no     | no    |
| `worker` | `/health` only | yes  | yes   |

**The default is `all`**, which is exactly today's behaviour. An unset or
misspelled variable must not change how the platform runs: the opposite default
fails as a worker that silently stops publishing because somebody forgot an
environment variable. An unrecognised value logs a warning and falls back to
`all` rather than refusing to boot — a typo in a dashboard field should not take
the platform down.

So **merging this changes nothing**. The split happens when `ROLE` is set on
Railway, and is undone by removing it.

## How it is enforced

Two gates, both reading a registry rather than editing call sites:

- `QueueRoleGate` — finds every `WorkerHost` through `DiscoveryService` and
  calls `worker.pause(true)` on a `web` process. Same mechanism as
  `WorkerDrainService`, which already does this at shutdown.
- `CronRoleGate` — stops every job in `SchedulerRegistry` on a `web` process.

With 24 processors and 28 crons, gating each site means the next one added is
the one that gets forgotten — and nothing fails visibly when it does. This is
the same argument as the cron lock wrapping `SchedulerRegistry` rather than 28
job sites (`docs/cron-single-run.md`).

`pause()`, never `close()`: close is terminal, and the shutdown drain needs the
instance to still exist.

### A worker still listens

Railway's healthcheck has to reach it, and a container that never binds a port
is treated as a failed deploy and restarted forever. So a `worker` process
listens and answers `/health`, while every other route returns 404. That is
middleware rather than dropped controllers, so health keeps working unchanged
and a misrouted request fails loudly instead of being served quietly.

## This does NOT replace the cron single-run lock

The lock is still required. A rolling deploy briefly runs two worker
containers, and both would fire every cron — the token-refresh race the lock
exists to prevent. This gate decides *which kind of process* runs crons; the
lock decides *which copy* runs a given tick.

## Setting it up on Railway

The code is deployed and inert until these steps are taken.

1. On the existing `social-media-backend` service, add `ROLE=web`.
2. Create a second service in the same project from the same repo
   (`Asad00713/social-media-backend`) and the same branch (`main`).
   Name it `social-media-worker`.
3. Copy every variable across. Prefer references (`${{Postgres.DATABASE_URL}}`,
   `${{Redis.REDIS_URL}}`) over literals, so a rotated password reaches both
   services without being pasted twice.
4. Set `ROLE=worker` on it.
5. **Give the worker no public domain.** It serves no API traffic.
6. Leave the healthcheck path at `/health`.

### What to check afterwards

In **both** services' logs:

```
Cron single-run lock active on 27 of 27 job(s)
```

Then, per role:

| Service | Expected |
| ------- | -------- |
| web     | `Role 'web': paused 25 of 25 BullMQ worker(s)` and `Role 'web': stopped N of N cron job(s)` |
| worker  | `Role 'worker': BullMQ workers active` and `Role 'worker': cron jobs active` |

The counts are what the registries actually hold, which is not the same as
the number of decorators in the source: production logs **27 of 27** crons
while `grep -c '@Cron('` over `src/` finds **28**, because one lives in a
module that is not always registered. What matters is that both numbers in a
line match each other and neither is **0** -- a zero means the gate ran before
the registry was populated.
A count of **0** anywhere means the gate ran before the registry was populated,
so the role is not being enforced — the service is behaving as `all`.

Also confirm `api.schedura.ai` still answers, and that a scheduled post
publishes (that exercises the worker end to end).

### Rolling back

Remove `ROLE` from both services, or delete the worker service. Behaviour
returns to exactly what it is today; nothing persists.

## Deploy settings that must survive

`Draining` on each service must be **30s**, not 0. At 0 the old container is
killed immediately, `beforeApplicationShutdown` never runs, and an in-flight
publish is cut off mid-request. This was 0 on production twice — once before
BE #233 and again on 2026-11-19 — so check it after any settings change.
