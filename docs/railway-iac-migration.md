# Railway: migrating off `railway.json` before 2026-12-01

**This is an owner task.** It needs the Railway CLI signed in to the project,
and Infrastructure as Code is applied from a terminal, not on deploy. Nothing
in this repository can do it.

## Why it cannot wait

Railway deprecated Config as Code. **It stops reading `railway.json` on
2026-12-01.** Our file only sets the builder today, so nothing breaks loudly —
but the migration is also the only way to set the three deploy settings the
graceful-shutdown work depends on. Until they are set:

- **`drainingSeconds` is unset** — the shutdown sequence starts on SIGTERM and
  is killed partway through, so a publish in flight can still be cut off. The
  code added in BE #233 runs, but may not finish.
- **No healthcheck** — a wedged instance keeps receiving traffic.
- **No restart policy** — nothing brings a crashed instance back.

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

⚠ **The last two field names are not in Railway's IaC docs.** The docs say to
read them off a service that already has them: set them once in the dashboard
(service → Settings → Deploy), then run `railway config pull --force` and copy
how they are rendered. Do not guess the names — a key Railway does not
recognise is silently ignored, and the setting looks applied when it is not.

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
