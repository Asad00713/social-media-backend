# Railway: migrating off `railway.json` before 2026-12-01

## ✅ The urgent part is done (2026-11-17)

The three deploy settings are **set, applied and verified** — in the
dashboard, which turned out not to need the migration at all.

| Setting | Was | Now |
|---|---|---|
| Draining | **0 seconds** | **60 seconds** |
| Healthcheck Path | *(empty)* | `/health/live` |
| Restart Policy | On Failure | On Failure, 10 retries |

**Draining was 0**, which means SIGTERM was followed immediately by SIGKILL
and every hook in BE #233 was dead on production: workers were never drained,
the pool was never closed, and a publish in flight could be cut mid-loop —
the exact stranded-post case the sweeper in BE #234 exists to clean up after.

Two things that cost time finding:

- **Draining and Overlap are hidden until the "Teardown" toggle is enabled.**
  With it off there is nothing on the page to suggest they exist.
- **The deploy that applies a draining change does not benefit from it.** The
  instance being killed started under the old value, so the gain appears from
  the next deploy onward.

Verified after the deploy: `/health/live` → 200, `/health/ready` → 200
`{"database":"up","redis":"up"}`.

There is also a `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` service variable that
sets the same thing, should the UI route ever be unavailable.

## What is left, and why it is not urgent

Only the file migration. Three distinct things are easy to conflate:

| | | After 2026-12-01 |
|---|---|---|
| Dashboard UI | clicking in Settings | ✅ unaffected, always works |
| `railway.json` (Config as Code) | the old file | ❌ no longer read |
| `.railway/railway.ts` (IaC) | the new file | ✅ the replacement |

The deadline is **not** "configuration must move to the dashboard" — the
dashboard is unaffected. It is that the old *file* stops being read. Ours
only sets `builder` and `dockerfilePath`, and the dashboard already shows
Dockerfile selected, so the likely effect of doing nothing is nothing. The
file is dead weight either way.

## The steps

Railway's own guidance is to generate the file from the live project rather
than write it by hand: a hand-written file omits whatever it does not mention
(volumes, variables, regions), and `apply` can then **delete** those.

```bash
railway link                  # if this machine is not linked yet

# 1. Generate .railway/railway.ts FROM the live project.
railway config pull --force
```

Open `.railway/railway.ts`. `railway.json`'s `builder`/`dockerfilePath` carry
over; `buildCommand` becomes `build`, `startCommand` becomes `start`,
`healthcheckPath` becomes `healthcheck`.

```bash
# 2. Stop the service reading the old file (does NOT redeploy).
railway config migrate cutover

# 3. Only now delete railway.json and commit that deletion.
#    Deleting it while the config path is still set fails the next build
#    with "config file not found".
git rm railway.json && git commit -m "chore(railway): migrate to Infrastructure as Code"

# 4. Review, then apply.
railway config plan
railway config apply
```

`railway config plan` refuses to run while a service still has a config-file
path set, which is why step 2 comes first. `railway config migrate undo`
reverts the cutover if something looks wrong.

## What to set in the generated file

On the backend service:

| Setting | Value | Why |
|---|---|---|
| `healthcheck` | `"/health/live"` | Liveness only. **Never `/health/ready`** — readiness fails when Postgres or Redis is down, and pointing the healthcheck at it would restart-loop a healthy app during a dependency outage. |
| `healthcheckTimeout` | `30` | Documented; the page does not state the unit. |
| graceful shutdown window | **≈ 60** | Long enough for a publish in flight to finish. |
| restart policy | `ON_FAILURE`, bounded retries | Brings back a crashed instance without looping forever on a broken deploy. |

⚠ **The last two field names are not in Railway's IaC docs.** Do not guess
them — a key Railway does not recognise is silently ignored, and the setting
looks applied when it is not. They are now set on the service, so
`railway config pull --force` renders them with their real names: generate the
file, do not write it.

## Verifying

After `apply`, deploy once and check the logs for the shutdown sequence on the
**old** instance:

```
… draining N BullMQ worker(s) before closing connections
… All BullMQ workers drained
… Postgres pool closed
```

Seeing all three means the drain window is long enough. If the logs stop
partway, raise the draining seconds.

See `docs/graceful-shutdown-and-health.md` for what those hooks do.

---

## Update 2026-11-19: the migration is NOT owed, and Draining was 0 again

Both findings come from reading the dashboard directly, not from inference.

### The migration does not apply to this service

Service → Settings → Config-as-code says:

> Config as Code is deprecated. Prefer Infrastructure as Code. Existing config
> files keep working until 2026-12-01. Starting 2026-08-28, services that have
> never used Config as Code cannot opt in.

**The file-path list is empty.** `social-media-backend` never used Config as
Code, so there is no config file to migrate, the 2026-12-01 date does not apply
to it, and opt-in is closed in any case.

The repo's `railway.json` is confirmed dead — Railway does not read it. Only
the `Dockerfile` matters, whose `CMD` runs the migrator and then the app.

This had been recorded as an owed job with a deadline. It is closed.

### Draining had reverted to 0

| Setting | Found 2026-11-19 | Set to |
| ------- | ---------------- | ------ |
| Draining | **0 sec** | **30 sec** |
| Overlap | 0 sec | left at 0 |
| Enable Teardown | on | on |

This doc records Draining being set to 60 on 2026-11-17. Two days later it was
0. **Why it reverted is not known** — it was not determined from the dashboard,
and guessing would be worse than saying so.

The practical consequence: **check Draining after any settings change, and
after a run of deploys.** At 0, `beforeApplicationShutdown` never runs, so
`WorkerDrainService` never drains and an in-flight publish is cut off.

Overlap was deliberately left at 0: raising it runs two containers at once,
which is safe since the cron lock (BE #255) but is a separate decision that
belongs with the web/worker split (`docs/process-role-split.md`).
