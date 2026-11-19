# Request-rate metrics

Phase 3 audit item #4, **part two**: the measurement a global rate limit has to
be chosen from. It counts and refuses nothing.

## Why measure first

`app.module.ts` registers `ThrottlerModule` with no app guard, and the comment
there is the whole argument:

> turning this on for every endpoint would silently start rejecting normal
> traffic on a platform that has never had rate limiting and **has not been
> measured for it**

A global limit picked without that measurement fails in one of two ways, and
there is no way to tell which from the inside:

- **too high** — it protects nothing, and we have shipped a config that reads
  like protection;
- **too low** — a real customer is thrown out of a dashboard that happens to
  issue thirty API calls on load.

The second is worse than having no limit, and it is the likelier one: nobody
guessing at this number guesses "a page load is 30 requests" first.

So this phase answers one question — _what does a real workspace's busiest
minute look like?_ — and the limit comes afterwards, from the answer.

## What it records

Two counters per request, both per minute:

| Key                                   | Meaning                                  |
| ------------------------------------- | ---------------------------------------- |
| `rate:ws:<workspaceId>:<minute>`      | that workspace's requests in that minute |
| `rate:route:<route pattern>:<minute>` | that endpoint's requests in that minute  |

**The route PATTERN, never the URL.** `req.route.path` yields
`/w/:workspaceId/posts/:id`, not `/w/ws-7/posts/post-123` — measured, not
assumed. That matters twice:

- **bounded key space** — 774 routes produce at most 774 keys a minute, where
  URLs would produce one per post id;
- **nothing identifying in Redis** — a URL can carry a token in a query string,
  an email, a workspace slug. A pattern carries none of it by construction.

The workspace id comes from `req.params`, the only place it ever arrives. All
three spellings in use are read (`:workspaceId`, `:wsId`, `:wid`), matching the
`WS_PARAM` regex in `every-workspace-route-guarded.spec.ts`.

## No database table, deliberately

A row per request would be roughly 130k rows a day. That number is not a
guess — it is what `error_logs` actually did, reaching **738MB and 2.17M rows
in 17 days** (BE #128), from a single `logger.warn` on a hot path.

So: Redis only, and **every key sets its own TTL** (36 hours). There is no
sweeper to forget to run and no retention cron to tune. The one incident this
design is reacting to was caused by writing a row per event on a hot path, and
the fix was to stop writing it — not to add a cleanup job.

The same incident's second lesson is here too: a Redis outage logs **once per
process**, not once per failed request. `AppLoggerService.warn` persists a row,
so an un-throttled warning is the original bug in miniature.

## An interceptor, not a guard

A guard can refuse a request. An interceptor cannot — it observes. That is the
point, and it is structural rather than a matter of care: the measurement has
to be impossible to confuse with enforcement, including by whoever reads this
code in six months.

`record()` returns `void` and is fired without awaiting; it swallows its own
errors. A metrics write must never be able to fail or slow a customer's
request, so the worst case is "no metrics", never "no service".

## 🔑 `enableOfflineQueue: false`, and why it is not optional

The sibling Redis providers (`channels/analytics/redis-client.provider.ts`)
leave ioredis's offline queue on, which is correct for them: they issue a
command now and then, and buffering across a brief reconnect is a feature.

This client runs on **every request**, which inverts the trade — and the
default would have quietly broken the "fails open" design above. Measured
against a closed port:

| Setting                            | 5,000 commands issued while disconnected          |
| ---------------------------------- | ------------------------------------------------- |
| offline queue **on** (the default) | 5,000 buffered, **0 settled**, queue length 5,000 |
| offline queue **off**              | 0 buffered, **5,000 rejected**, queue length 0    |

With the queue on and `maxRetriesPerRequest: null`, a command issued during an
outage neither resolves nor rejects — ioredis holds it for a connection that is
not coming. Two consequences:

- the queue grows with traffic for the length of the outage, holding every
  buffered command's closure in memory;
- **`record()`'s `.catch()` never runs**, so "fails open and logs once" does
  neither, and a Redis outage is invisible.

With it off, the command rejects immediately — which is exactly what `record()`
is built to swallow.

This was not caught by the unit tests, and could not have been: a fake Redis
rejects instantly, while a real one that is down stays silent. It took a probe
against a closed port.

## Reading the report

`GET /admin/metrics/request-rate` — super-admin only, read-only.

```json
{
  "enforcing": false,
  "note": "Counting only. No request is refused by these counters.",
  "unit": "requests per minute",
  "workspaces": {
    "samples": 4120,
    "histogram": { "5": 2900, "10": 900, "20": 280, "40": 38, "80": 2 },
    "p50": 3,
    "p90": 12,
    "p99": 38,
    "max": 96
  },
  "routes": { "...": "the same shape, per endpoint" },
  "busiestRoutes": [
    { "route": "/w/:workspaceId/posts", "peakPerMinute": 61, "total": 18402 }
  ]
}
```

**`workspaces.p99` is the number the limit is chosen against.** In the example
above, a limit of 120/min refuses attackers and approximately nobody else;
a limit of 30 would throw out one customer-minute in a hundred. `max` is the
wrong number to use — one busy minute from one workspace would set the limit
for everyone.

`busiestRoutes` answers the other half: if a single endpoint is responsible for
the peaks, it wants its own `@Throttle` rather than a global ceiling over all
774 routes.

`enforcing: false` is stated in the payload on purpose, so the counters cannot
be mistaken for a limit already in force.

## Tests

`request-rate.service.spec.ts` + `request-rate.interceptor.spec.ts` (56).

Mutation-tested:

| Mutation                                          | Tests that fail |
| ------------------------------------------------- | --------------- |
| put the colon back in the minute key              | 8               |
| drop the TTL (unbounded key space)                | 2               |
| record the URL instead of the route pattern       | 2               |
| `await` the record (Redis latency per response)   | 1               |
| warn on every failure instead of once             | 1               |
| stop calling `next.handle()` (refuse the request) | 3               |
| remove `enableOfflineQueue: false`                | 2               |

### Two bugs the tests found in my own work

**The minute key contained a colon.** `2026-11-19T13:07` — and the key
separator is also a colon, while a route pattern is full of them. Splitting a
key on its last colon then cut the minute in half and reported the route as
`/w/:workspaceId/posts/:id:2026-11-19T13`. The minute key now omits the one
colon it does not need, which makes the last colon unambiguous.

**And one of my own tests was vacuous.** The assertion for
`enableOfflineQueue: false` matched the raw file — but the explanatory comment
above the setting also contains that string, so deleting the _setting_ left
55/55 green. It now strips comments before matching, and asserts the setting
appears inside the `useFactory` rather than merely somewhere in the file. A
source-level test has to read the code, not the prose about the code.

## What happens next

1. This ships and runs for about a week.
2. Read `workspaces.p99` and `busiestRoutes` off the report.
3. Choose the global limit from those numbers — or decide, with evidence, that
   a per-route ceiling on the few busiest endpoints is the better instrument.
4. Only then turn on a global guard.
