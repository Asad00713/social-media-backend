# One cron run per tick

Groundwork for Phase 2 #8 (splitting web from worker), done in code **before**
the Railway change rather than after it.

## The problem

`ScheduleModule.forRoot()` is registered in `AppModule`, so **every process
that boots the app runs every cron**. There are **28 `@Cron` jobs across 23
files** (the earlier note of "29" was off by one — counted).

Today there is one process, so this is invisible. A web/worker split gives two,
and then all 28 fire twice on every tick — and a rolling deploy briefly gives
three.

## Twice is not uniformly harmful, which is why this is one lock

Checked job by job, the 28 fall into four shapes:

| Shape                       | A second run does                             | Examples                                                                                                |
| --------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| deterministic `jobId`       | **nothing** — BullMQ refuses the duplicate    | reports (`slotJobId(report.id, nextRunAt)`), inbox later-wake, calendar sync                            |
| conditional write           | **nothing** — the second write matches no row | `stranded-post-sweeper` (`WHERE status = 'publishing'`; its comment already names "a concurrent sweep") |
| purge / retention           | wasted work, double load in one window        | log retention, post purge, workspace purge, recycle bin                                                 |
| **enqueue with no `jobId`** | **real damage**                               | `token-refresh.scheduler`                                                                               |

**`token-refresh` is the one that must not happen.** It enqueues a refresh job
per channel with no `jobId`:

```ts
await this.queue.add(
  'token-refresh',
  { channelId: rows[i].id },
  { delay: i * 100 },
);
```

Several platforms invalidate the old refresh token when it is exchanged, so two
concurrent refreshes for one channel can race into a token the platform no
longer accepts. The customer sees a channel that disconnected itself overnight,
with nothing in their own behaviour to explain it.

That asymmetry — most jobs harmless, one job silently breaking a customer's
integration — is the argument for a single shared mechanism rather than 28
individual fixes.

## It wraps the registry, not the job sites

A `@CronLock()` decorator on each job would work and would be wrong: with 28
jobs in 23 files, the 29th is the one somebody forgets, and **nothing fails
when they do**. The symptom is a duplicate run in production, weeks after the
commit.

`SchedulerRegistry.getCronJobs()` returns every job Nest has registered, so
wrapping there covers all of them, including ones added later, with nothing to
remember. Same reasoning as the fail-closed specs in BE #251 and #252: a net
over the real list beats a hand-maintained copy of it.

The mechanics were probed, not assumed. A `cron` `CronJob` keeps its tick
handlers in `_callbacks: [fn]`; replacing an entry changes what the tick runs,
and calling through still runs the original. The bootstrap logs how many jobs
it wrapped, and logs an **error** naming any it could not — an unwrapped job is
one that will double-fire.

## The TTL comes from each job's own schedule

The lock key has to live long enough to cover the job's runtime and expire
before the next tick. Too short and a slow job's second process claims the same
tick; too long and the key is still held when the next tick arrives, so that
tick is skipped **on every process** — a safety measure that silently stops the
job running.

Half the interval sits between the two, and it is derived per job rather than
hand-picked 28 times, so a job added later is covered without anyone choosing a
number for it. Measured from the real schedules in this repo:

| Schedule         | Interval | TTL          |
| ---------------- | -------- | ------------ |
| `*/30 * * * * *` | 30 s     | 15 s (floor) |
| `0 * * * * *`    | 60 s     | 30 s         |
| `*/5 * * * *`    | 5 min    | 2.5 min      |
| `*/15 * * * *`   | 15 min   | 7.5 min      |
| `15 * * * *`     | 1 h      | 30 min       |
| `0 0 * * *`      | 24 h     | 1 h (cap)    |
| `0 4 * * 0`      | 7 d      | 1 h (cap)    |

**The interval is the gap between two consecutive ticks, not the time until the
next one.** Those differ, and only the first is the interval: a daily midnight
job read at 05:00 is 19 h from its next tick but 24 h between ticks, so a TTL
built from time-until-next would be wrong on every run. That mutation fails 4
tests.

The cap matters for the weekly job: a half-interval TTL would hold its key for
3.5 days, turning one failed run into a skipped week.

## It fails CLOSED, deliberately

If Redis cannot be reached, the tick is **skipped, not run**. That is the
opposite of `SendLockService`, which fails a send loudly, and the opposite of
most fail-open defaults in this codebase — so the reasoning is explicit:

- every one of these jobs is on a schedule, so a skipped tick is retried by the
  next one, minutes or hours later, at no cost to anyone;
- running it anyway means running it **in every process at once**, which is the
  exact outcome this exists to prevent.

A missed nightly purge is invisible. A double token refresh disconnects a
customer's channel. The asymmetry decides it.

A hung Redis is bounded separately (`ACQUIRE_TIMEOUT_MS`, 2 s): ioredis holds a
command for a connection that is not coming, so without the bound a hung Redis
would hold the tick open indefinitely. The client also sets
`enableOfflineQueue: false`, for the reason measured in
`docs/request-rate-metrics.md`.

## The lock is not released when the job finishes

This is "once per tick", not "one at a time". Releasing on completion would let
the other process pick up the **same** tick and run it again — the duplicate
the whole mechanism exists to prevent. The key expires on its own instead.

## Why not an env flag

`RUN_CRONS=false` on the web service would also work, and it **fails silently
when someone forgets it** — including the person creating the second service
for the first time, who has no reason to know the variable exists. A missing
flag looks exactly like a working deployment until a channel drops.

The lock needs no configuration, so there is nothing to forget, and it keeps
working for cases a flag never covers: a rolling deploy where old and new
processes overlap, or two worker replicas.

## Tests

`cron-lock.spec.ts` (36), including a net asserting that `app.module.ts`
registers `SchedulingModule` **after** `ScheduleModule.forRoot()` — before it,
there are no jobs to wrap and every cron is left unprotected.

Mutation-tested:

| Mutation                                            | Tests that fail |
| --------------------------------------------------- | --------------- |
| fail **open** instead of closed                     | 5               |
| release the lock when the job finishes              | 5               |
| TTL = the full interval                             | 4               |
| time-until-next instead of the gap between ticks    | 4               |
| wrap only the first job in the registry             | 2               |
| register `SchedulingModule` before `ScheduleModule` | 1               |
| remove `SchedulingModule` from `AppModule`          | 2               |

### Two things the tests taught me

**`fireOnTick` does not await its callbacks.** The lock's Redis round trip is a
microtask, so the job body runs _after_ it: measured, `ran` is still 0
immediately after `fireOnTick()` and 1 once microtasks drain. Harmless in
production — the job runs, a tick of the event loop later — but a test
asserting straight after the call reads the wrong moment. The helper now drains
before asserting.

**`_callbacks` is `private`, and Jest never said so.** The first version typed
the job as `CronJob & { _callbacks?: ... }`. An intersection that redeclares a
private property collapses to `never`, so every use of it failed to compile —
but all 36 tests passed, because **Jest does not typecheck**. It surfaced only
in `npm run typecheck`. The shape is now standalone and the cast goes through
`unknown`, which is what reaching past `private` actually requires.

**A fake has to be able to perform the mistake it is meant to catch.** The
first fake Redis had no `del`, so the mutation that _released_ the lock on
completion was a silent no-op against it and all 36 tests stayed green. Adding
`del` to the fake made that mutation fail 5 tests. The interface the lock
depends on deliberately does **not** declare `del` — the fake has it anyway,
precisely so a release can be detected.

## What this does not do

- **It does not split web from worker.** That is a Railway change (two
  services), and it is an owner action. This only makes it safe to do.
- **It does not stop BullMQ workers running in both processes.** Queue
  consumers are already safe to run anywhere — that is what a queue is for. The
  problem was only ever the schedulers that _fill_ the queues.
