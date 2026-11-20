# Backend docs

Start here. Each entry says what it is for, so a session that has never seen
this repo can find the right page without opening all of them.

## Running it in production

| Doc | Read it when |
| --- | --- |
| [`process-role-split.md`](process-role-split.md) | Splitting web from worker. **Has the Railway runbook and the exact log lines to verify.** |
| [`railway-iac-migration.md`](railway-iac-migration.md) | Railway deploy settings. ⚠️ **Draining must be 30s** — it has reverted to 0 twice. The IaC migration itself is NOT owed (verified 2026-11-19). |
| [`graceful-shutdown-and-health.md`](graceful-shutdown-and-health.md) | Shutdown ordering, health endpoints. |
| [`cron-single-run.md`](cron-single-run.md) | Why every cron claims its tick in Redis. Required before any second process exists. |
| [`migrations.md`](migrations.md) | ⚠️ **Read before writing any migration.** Hand-written, `IF NOT EXISTS`, never `db:push`. |

## Incidents and the fixes that came out of them

| Doc | The bug |
| --- | --- |
| [`non-commentable-media.md`](non-commentable-media.md) | One IG Story polled 20,169 times in 7 days. The handling was right; the *memory* was missing. |
| [`linkedin-api-version.md`](linkedin-api-version.md) | Analytics pinned to a version sunset 2.5 years earlier. Also: proximity in a log is not attribution. |
| [`request-rate-metrics.md`](request-rate-metrics.md) | Measuring request rates before choosing a global limit. |
| [`auth-route-throttling.md`](auth-route-throttling.md) | Which auth routes needed throttling, and which already had stronger protection. |

## Conventions worth knowing before changing code

- **Jest does not typecheck.** A suite can be green while `tsc` fails. Run
  `npm run build` and `npx tsc --noEmit`, not just the tests.
- **New constructor parameters go last**, so positional construction in
  existing specs still lines up.
- **Gate at the registry, not the call site.** With 24 processors and 28 crons,
  the next one added is the one that gets forgotten, and nothing fails visibly
  when it does. See `cron-single-run.md` and `process-role-split.md`.
- **A mutation that breaks no test means the test is vacuous.** If it crashes
  the runner instead of failing, that is the same finding.
