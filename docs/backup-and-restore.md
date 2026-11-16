# Database backup and restore

The production database is backed up by **GitHub Actions**, not by Railway.

Railway's managed backups are a paid feature this project is not on. What its
Backups tab lists are volume-resize snapshots taken when the infrastructure
changed — one a month apart, taken for Railway's reasons, not ours. They are
not a recovery plan.

---

## What runs, and where

| | |
|---|---|
| **Schedule** | Daily at 02:30 UTC — `.github/workflows/database-backup.yml` |
| **Script** | `scripts/backup-database.mjs` |
| **Format** | `pg_dump --format=custom` (compressed; supports selective restore) |
| **Destination** | Cloudflare R2, `backups/` prefix of the app's existing bucket |
| **Retention** | 30 days, **except** the newest backup, which is never deleted |
| **Manual run** | Actions → "Database backup" → Run workflow |

Every run dumps, then **verifies** the archive by reading its table of contents
before uploading. A truncated or malformed dump fails the job instead of
quietly replacing a good backup with a bad one.

### Required GitHub secrets

Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `BACKUP_DATABASE_URL` | The **public** Postgres connection string from Railway (Variables → `DATABASE_PUBLIC_URL`). The private `.railway.internal` host is not reachable from GitHub. |
| `CLOUDFLARE_R2_ACCOUNT_ID` | Same values the backend already uses |
| `CLOUDFLARE_R2_ACCESS_KEY_ID` | |
| `CLOUDFLARE_R2_SECRET_ACCESS_KEY` | |
| `CLOUDFLARE_R2_BUCKET` | |

---

## Restoring

> **Read this part before you need it.** A restore overwrites tables and cannot
> be undone. The script refuses a non-local target unless you pass
> `--i-know-this-is-production`, and that flag is the only thing between a
> recovery and a second outage.

Install a Postgres 18 client first (`pg_restore` must be at least the server's
version), then set the four `CLOUDFLARE_R2_*` variables in your shell.

**1. See what exists**

```bash
node scripts/restore-database.mjs --list
```

**2. Restore into a scratch database** (always do this first)

```bash
node scripts/restore-database.mjs \
  --latest \
  --target "postgres://postgres:postgres@localhost:5432/schedura_restore_test"
```

**3. Check it is actually the data you expect**

```sql
SELECT count(*) FROM users;
SELECT count(*) FROM posts;
SELECT max(created_at) FROM posts;   -- how recent is this backup, really?
```

**4. Only then, if you are recovering production**

```bash
node scripts/restore-database.mjs \
  --key backups/schedura-2026-11-16T02-30-00-000Z.dump \
  --target "$DATABASE_PUBLIC_URL" \
  --clean \
  --i-know-this-is-production
```

`--clean` drops each object before recreating it. Without it, a restore over a
populated database collides on every existing row.

---

## Test the restore on a schedule

A backup nobody has restored is a guess.

**Test it quarterly**, and after any change to the schema tooling or this
script. Steps 1–3 above are the whole test: restore the latest backup into a
scratch database and check the row counts look like production.

| Date tested | By | Backup used | Result |
|---|---|---|---|
| 2026-11-16 | Setup | Local dump via this script | **Pass** — restored into a scratch database: 80/80 tables, and `users` 342, `workspace` 211, `posts` 29, `social_media_channels` 8 all matched the source exactly. Production-target guard also verified: it refused a non-local `--target` without the explicit flag. |

---

## What this does **not** cover

- **Media files.** Images and video live in R2 and Cloudinary, which have their
  own durability. They are not in this dump, and a restored database will point
  at media that still exists in those buckets — unless the bucket itself was
  what you lost.
- **Redis.** Scheduled publish jobs live in Redis, not Postgres. Restoring the
  database brings back the `posts` rows but **not** their queued jobs, so posts
  restored in `scheduled` state will not fire. (This is tracked separately: the
  production-readiness audit calls for a DB-driven reconciler that re-queues
  scheduled posts from the database, which would also close this gap.)
- **Point-in-time recovery.** These are daily snapshots. Worst case you lose up
  to 24 hours. PITR is a Railway Pro feature.

---

## Known landmine

`drizzle/migrations/0030_billing_account_scope.sql` as committed **deletes seven
billing tables** and must never run against production — see `docs/migrations.md`.
The production database is baselined past it. A from-scratch rebuild by replaying
`drizzle/migrations/` is **not** currently possible (`0002` fails on an empty
database), which is precisely why these dumps are the recovery path.
