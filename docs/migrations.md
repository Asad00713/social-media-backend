# Database migrations

Migrations are plain numbered `.sql` files in `drizzle/migrations/`, applied by
our own runner. **`drizzle-kit` is not used to apply anything** — `db:migrate`,
`db:push` and `db:generate` are wired to refuse.

## Why not drizzle-kit

Every migration from `0027` on is hand-written, so drizzle's `_journal.json`
knows only 26 of the 37 files on disk. Worse, its tracking table
(`drizzle.__drizzle_migrations`) on production is **empty**, so `drizzle-kit
migrate` believes nothing has ever been applied and would replay 26 migrations
against a live database.

Hand-writing is itself deliberate: `drizzle-kit generate` emits a journal-drift
diff here (it has re-emitted 15 existing tables).

## Day to day

Write a new migration as the next number:

```
drizzle/migrations/0036_what_it_does.sql
```

Then nothing else — it applies automatically on the next deploy, because the
container runs migrations before the app starts:

```dockerfile
CMD ["sh", "-c", "node dist/src/drizzle/migrate/migrate && node dist/src/main"]
```

To apply locally:

```bash
npm run build && npm run db:migrate:sql
```

## Rules

**Migrations are immutable once applied.** The runner checksums every file and
refuses to run *anything* if an already-applied file changed on disk — the
database no longer matches that file, and stacking later migrations on a schema
nobody can reproduce is how a drift becomes unrecoverable. Need a change? Add a
new migration.

**A failed migration stops the boot.** That is intentional. A container that
will not start is a loud, recoverable failure; a container serving traffic
against a schema it does not match is a silent outage — which is exactly what
happened on 2026-09-10.

**Each migration runs in one transaction.** A file's own `BEGIN`/`COMMIT` is
stripped so the runner owns the transaction, which lets the applied-record
commit atomically with the migration. Without that, a crash between the two
would leave a migration applied but unrecorded, and it would run twice. `0030`
drops a column; a second run is not survivable.

**`.PROD-SAFE.sql` files are never run by the runner.** They are hand-run
alternatives to a committed migration that is unsafe on production.

**A file may wrap itself in one `BEGIN;` ... `COMMIT;`, or use none at all.**
Anything else — a second pair, a stray `COMMIT;`, `BEGIN TRANSACTION;` — is
rejected before the runner connects. It is not pedantry: a stray `COMMIT` mid-
file ends the runner's transaction early, so everything before it commits
permanently, a later failure rolls back only the tail, and the applied-record is
lost — leaving a half-applied migration that runs again on the next boot. A
`DO $$ ... $$` block is fine; its `BEGIN` is PL/pgSQL, not a transaction.

**`CREATE INDEX CONCURRENTLY` cannot be used.** Postgres refuses it inside a
transaction, and every migration runs inside one. It fails loudly and leaves no
invalid index, but the container will not boot. Build the index by hand, or take
the lock with a plain `CREATE INDEX`.

**Commands refuse to target a database that is neither localhost nor the
deploy-internal network.** This repo's `.env` carries four `DATABASE_URL` lines,
one of them a commented-out production proxy; uncommenting it would otherwise
point `db:migrate:sql` at production from a laptop. Override deliberately with
`--i-know-this-is-production`. Inside the container the host is
`*.railway.internal`, which is allowed without any flag.

**Concurrent runs are safe.** A session-level advisory lock serialises them, so
when Railway overlaps an old and new container the second one waits and then
finds nothing pending, rather than failing on a duplicate key.

## Adopting a database that was migrated by hand

A database whose schema was brought up to date manually must be told so, or the
runner will see every file as pending and re-run it. Mark them applied without
running them:

```bash
npm run build
npm run db:baseline -- --upto 0035_error_logs.sql
npm run db:migrate:sql          # applies only what comes after
```

`--upto` is required; there is no "baseline everything" default, because the
dangerous option should not be the easy one to reach by accident. Both
`--upto <file>` and `--upto=<file>` work.

### If a deploy is blocked by a checksum mismatch

`migrate` refuses to run — and with `&&` in the CMD the container will not boot
— when an already-applied file differs from what was recorded. Almost always the
right fix is to restore the file: `git checkout -- drizzle/migrations/<file>`.
An accidental reformat-on-save of an old migration is the usual cause.

Only if the file's *content* is genuinely correct and the recorded checksum is
the wrong one (for example it was recorded from a mangled copy) should you
repair the record, deliberately, with SQL:

```sql
UPDATE applied_migrations SET checksum = '<sha256 of the file, LF-normalised>'
WHERE name = '<file>';
```

Never do this to "get the deploy through". The refusal means the database and
the file disagree, and skipping past it stacks later migrations on a schema
nobody can reproduce.

## Production history

Production was baselined through `0035_error_logs.sql` on 2026-09-16. Everything
up to and including that file was applied by hand via the Railway console during
the 2026-09-10 incident; `0036` onward is the runner's.

⚠️ `0030_billing_account_scope.sql` as committed **deletes seven billing tables**
and must never run on production — by the time it was needed, prod held 22
subscriptions including two paying customers. `0030_billing_account_scope.PROD-SAFE.sql`
is the variant that was actually applied; it backfills instead of deleting.
