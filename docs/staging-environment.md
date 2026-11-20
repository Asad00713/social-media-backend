# Staging environment (`Development` branch)

A second, password-gated copy of the app on Railway + Vercel, so a change can
be seen running **live** before it reaches users — without a local setup.

> **The one thing to know:** staging shares the **production database**.
> It is therefore run with `ROLE=web`, which means it serves HTTP but runs
> **no crons and no queue workers**. That is what keeps it safe. Removing
> `ROLE=web` from staging is not a tuning change — it hands a second copy of
> every cron and every publisher the production database.

---

## Branches

| Branch | Deploys to | Who sees it |
|---|---|---|
| `main` | production (`schedura.ai`, `api.schedura.ai`) | everyone |
| `Development` | staging (Railway + Vercel URLs) | anyone with the gate password |

Flow: feature branch → PR into `Development` → check it live on staging →
PR `Development` → `main` → production.

`Development` was branched from `main` and must stay behind it only by merges,
never by divergent history. If `main` moves ahead (a hotfix), merge `main`
into `Development` rather than rebasing it — `Development` is a shared,
long-lived branch and other clones track it.

---

## Why `ROLE=web` is mandatory on staging

Staging talks to the production database. Three things would go wrong without
the role gate, and each has already bitten this codebase once:

1. **Crons would run twice, on real rows.** Every process that boots with
   `ROLE=all` registers all 28 crons. `workspacePurge` hard-deletes
   soft-deleted workspaces; `tokenRefresh` rewrites channel tokens. A staging
   copy running those is a second writer on live customer data.
2. **Test posts would publish to real accounts.** Staging has real OAuth
   channels connected (see below). A scheduled post picked up by a staging
   worker goes out to the customer's actual Instagram/LinkedIn page. That is
   not reversible.
3. **Migrations still run at boot.** The Dockerfile's `CMD` is
   `node dist/src/drizzle/migrate/migrate && node dist/src/main`, so a staging
   deploy applies migrations to the **production** database. See "Migrations"
   below — this is the one risk `ROLE=web` does *not* remove.

`ROLE=web` is implemented in `src/common/process-role/` and documented in
[`process-role-split.md`](process-role-split.md). On a web process the queue
gate pauses every `WorkerHost` and the cron gate stops every registered job.

### Verifying the gate actually held

After a staging deploy, the logs must show the cron lock covering **zero**
jobs, not 28:

```
Cron single-run lock active on 0 of 0 job(s)
```

If staging logs show `28 of 28`, the role did not apply — stop and fix it
before using staging, because staging is then a second production worker.

---

## Migrations: the remaining risk

`ROLE=web` stops crons and workers. It does **not** stop the migrator, which
runs before the app in the same `CMD`. A migration merged to `Development`
runs against production the moment staging deploys.

**Consequences:**

- A migration is **not** "tested on staging" in any meaningful sense. It is
  tested on production, slightly earlier than the production deploy.
- `drizzle/migrations/0030_billing_account_scope.sql` deletes seven billing
  tables' data and must never run on production — including via staging.

**Rule:** treat a migration in a `Development` PR exactly as carefully as one
going straight to `main`. The usual migration rules in
[`migrations.md`](migrations.md) apply unchanged: hand-written,
`IF NOT EXISTS`, never generated, never `db:push`.

If migrations ever need real testing, that requires a separate staging
database — a deliberate change, not a config tweak.

---

## Railway setup (backend)

Staging is a **separate service** in the same Railway project, deploying the
`Development` branch.

1. New service → deploy from the `social-media-backend` repo → branch
   `Development`.
2. Copy the production service's variables, then **change these**:

| Variable | Production | Staging |
|---|---|---|
| `ROLE` | `all` / `worker` | **`web`** — mandatory, see above |
| `APP_URL` | `https://api.schedura.ai` | staging **backend** URL (`https://<svc>.up.railway.app`) |
| `API_PUBLIC_URL` | `https://api.schedura.ai` | same staging backend URL |
| `FRONTEND_URL` | `https://schedura.ai` | staging **frontend** URL (Vercel) |
| `NODE_ENV` | `production` | `production` — keep it; `development` unlocks dev-only auth paths |

**`APP_URL` and `FRONTEND_URL` are different things.** `APP_URL` is the
backend's own origin: OAuth redirect URIs are built from it as
`${APP_URL}/channels/oauth/<platform>/callback`
(`src/channels/services/oauth.service.ts:863`). `FRONTEND_URL` is what CORS
allows as a browser origin (`src/main.ts:72`). Setting one to the other's
value breaks either OAuth or CORS.

`DATABASE_URL` stays pointed at the production Postgres — that is the
deliberate trade-off this environment is built on.

3. Set Draining to **30s** under the Teardown toggle (hidden until that toggle
   is on), matching production.

---

## Vercel setup (frontend)

Vercel builds every branch automatically, so `Development` already gets a URL.
What needs configuring is the per-branch environment and the gate.

1. In the project's Environment Variables, scope these to the `Development`
   branch (Preview environment, branch-specific):

| Variable | Value |
|---|---|
| `VITE_API_URL` | the staging backend URL from Railway |
| `VITE_ACCESS_HASH` | SHA-256 of the staging gate password (see below) |

2. Everything else (Google/Stripe keys, etc.) can inherit from production
   unless a staging-specific key is wanted.

For a stable URL instead of a per-commit one, assign a domain such as
`staging.schedura.ai` to the `Development` branch in Vercel's Domains tab.
A stable URL is strongly preferred — OAuth callbacks must be registered
against a fixed host, and a per-commit preview URL changes every push.

### Keeping it hidden from users

The gate already exists: `ComingSoonGate` in `src/App.tsx`, with the password
hashed into `VITE_ACCESS_HASH` and compared in the browser
(`src/features/coming-soon/lib/access.ts`). Set it on staging; leave it unset
on production.

Generate the hash with the frontend repo's script, which prompts rather than
taking the password as an argument (an argument lands in shell history):

```bash
node scripts/access-hash.mjs
```

The gate is enforced only on a production build (`import.meta.env.PROD`),
which a Vercel preview build is — so it does apply on staging, while local
`npm run dev` stays open.

This is a soft gate — it hides the UI from casual visitors. It is not
authentication: the hash ships inside the JS bundle, so the password is
guessable offline if it is short or obvious. The staging **API** is open to
anyone who knows its URL, exactly as production's is. Do not treat staging as
private infrastructure.

---

## OAuth callbacks for staging

Redirect URIs are built as:

```
${APP_URL}/channels/oauth/<platform>/callback
```

So each platform's developer console needs the staging URL **added alongside**
the production one — adding does not disturb production. 22 platforms are
configured (`OAUTH_CONFIGS`, `oauth.service.ts:63`):

```
facebook   instagram  youtube    tiktok     pinterest  twitter
linkedin   threads    reddit     bluesky    mastodon   slack
telegram   discord    whatsapp   google_business
google_drive  google_photos  google_calendar
outlook_calendar  onedrive   dropbox
```

With staging backend at `https://<svc>.up.railway.app`, the entry to add for
e.g. LinkedIn is:

```
https://<svc>.up.railway.app/channels/oauth/linkedin/callback
```

Four platforms also appear with their own callback paths rather than the
pattern above — check these individually if they are needed on staging:
`slack`, `mastodon`, `facebook`, `discord` (`/oauth/<platform>/callback`, no
`/channels` prefix).

Google and Canva have their own builders
(`src/auth/google/google-oauth.client.ts`, `src/canva/canva.service.ts`) —
register those from the URL each logs at connect time rather than assuming the
pattern.

**Only platforms whose callbacks are registered will connect on staging.**
The rest fail at the provider with a redirect-URI mismatch, which is a
configuration result, not a bug.

---

## What staging is and is not good for

**Good for:** UI and UX review on real data, API behaviour, auth and billing
screens, admin pages, anything read-heavy, seeing a change live before users
do.

**Not good for:** anything that depends on a cron or a queue — scheduled
publishing, token refresh, sweepers, drip campaigns. Those are off by design.
Verify them on production after merge, or locally.

**Actively unsafe:** migrations (they hit production), and any manual write
that assumes staging is a sandbox. It is not — the database is live.
