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
dangerous option should not be the easy one to reach by accident.

## Production history

Production was baselined through `0035_error_logs.sql` on 2026-09-16. Everything
up to and including that file was applied by hand via the Railway console during
the 2026-09-10 incident; `0036` onward is the runner's.

⚠️ `0030_billing_account_scope.sql` as committed **deletes seven billing tables**
and must never run on production — by the time it was needed, prod held 22
subscriptions including two paying customers. `0030_billing_account_scope.PROD-SAFE.sql`
is the variant that was actually applied; it backfills instead of deleting.
