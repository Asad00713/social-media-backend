# Admin Logs — Phase 1 Design

**Date:** 2026-08-17
**Status:** Approved design, pending spec review
**Branch:** `feat/admin-logs-live` (backend `socialmedia-workspace-otp`, frontend `schedura-admin`)

## Goal

Give the super-admin dashboard a live **Logs → Errors** view: capture application
errors and warnings (what broke, in which module) into Postgres, and let an admin
filter/search them from the dashboard. Today these logs only reach the console and
are lost. This is Phase 1 — a solid, self-contained foundation. Fingerprint
grouping, timeline histograms, live stream, and the Audit/Requests/Integrations
tabs are explicitly **out of scope** (Phase 2).

## Non-goals (Phase 1)

- No fingerprint/grouping (Sentry-style dedup) — the Errors tab shows a raw,
  filterable list, not error *groups*.
- No timeline histogram, no live stream.
- Audit, Requests, Integrations tabs stay honest "not tracked" notes.
- `info`/`debug` levels are **not** captured — only `error` and `warn`. Capturing
  every info log would be a per-request DB write and a table blow-up for no signal.

## What gets captured

Only `error` and `warn` levels, from two sources:

1. **Unhandled exceptions** — a new global `AllExceptionsFilter` writes a row for
   anything that reaches it (with the request path/method/status/user).
2. **Explicit logs** — a custom Nest logger writes a row when a service calls
   `this.logger.error(...)` or `.warn(...)`. This is where the real debugging
   value lives (e.g. "Slack scope missing", "rate-limit unavailable").

## Retention

30 days. A daily `@Cron` deletes rows older than 30 days. (`@nestjs/schedule` is
already used in the codebase.)

## Backend (`socialmedia-workspace-otp`)

### 1. Schema — `error_logs`

New file `src/drizzle/schema/error-logs.schema.ts`, exported from the schema barrel.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `defaultRandom()` |
| `level` | varchar(10) | `'error'` \| `'warn'` |
| `message` | text | the log message / exception message |
| `context` | varchar(255) nullable | module/service name (Nest logger context, e.g. `SlackService`) |
| `stack` | text nullable | stack trace when present |
| `path` | varchar(500) nullable | request route (exceptions only) |
| `method` | varchar(10) nullable | HTTP method (exceptions only) |
| `statusCode` | integer nullable | HTTP status (exceptions only) |
| `userId` | uuid nullable | acting user if resolvable (no FK — a log must survive user deletion) |
| `workspaceId` | uuid nullable | if resolvable (no FK, same reason) |
| `metadata` | jsonb | default `{}` — spare structured context |
| `createdAt` | timestamptz | `defaultNow()` |

Indexes: `(level, created_at desc)`, `(context, created_at desc)`, `(created_at)`.

`userId`/`workspaceId` are deliberately **not** foreign keys — a log is a
historical record and must not be cascade-deleted or block a user deletion.

**Migration:** per the repo's migration-drift rule, do NOT run a generated drizzle
migration. Apply the one table with `CREATE TABLE IF NOT EXISTS` on local, and the
same on prod via the Railway console when deploying.

### 2. `LogWriterService`

`src/logs/log-writer.service.ts`. A thin, injectable writer both the logger and the
filter use. One method: `write(entry)`. **Fire-and-forget and self-guarded** — the
insert is `void this.db.insert(...).catch(() => {})`. It must never throw: a failed
log-write that bubbled up would become a new error, which would try to log, which
would fail again — an infinite loop. On DB failure it falls back to a plain
`console.warn` and swallows.

To avoid the recursion entirely, the writer swallows its own failures and never
routes them back through the capturing logger.

### 3. `AppLoggerService`

`src/logs/app-logger.service.ts`, implementing Nest's `LoggerService`. Wraps the
default `ConsoleLogger` (console behaviour unchanged) and, for `error()`/`warn()`
only, also calls `LogWriterService.write()`. `log()`/`debug()`/`verbose()` are
console-only. Wired in `main.ts` via `app.useLogger(...)`.

Because the logger is constructed during bootstrap (before the DI container is
fully available for a plain `useLogger`), the writer is resolved from the Nest app
context (`app.get(LogWriterService)`) and injected into the logger after creation.

### 4. `AllExceptionsFilter`

`src/logs/all-exceptions.filter.ts`, `@Catch()` global filter registered with
`app.useGlobalFilters(...)`. It preserves the current default response behaviour
(same status codes and body shape Nest already returns — this filter must not
change what clients receive), and additionally writes an `error_logs` row with the
message, stack, request path/method, resolved status, and `req.user` id/workspace
when present. 4xx client errors below 500 are written as `warn`; 500s as `error`
(a validation 400 is not an application fault worth alerting on, but is worth
seeing).

### 5. Retention cron

`src/logs/log-retention.service.ts` — `@Cron` daily at a quiet hour:
`DELETE FROM error_logs WHERE created_at < now() - interval '30 days'`. Logs how
many rows it purged (via console only, not back into the table).

### 6. `LogsModule`

`src/logs/logs.module.ts` — provides `LogWriterService`, `AppLoggerService`,
`LogRetentionService`; imports `DrizzleModule`; exports the writer and logger.
Registered in `AppModule`.

### 7. Admin API

Two endpoints on the existing `AdminController` (class already has
`JwtAuthGuard + SuperAdminGuard + @SkipSuspendCheck()`), delegating to a new
`AdminLogsService` (`src/admin/admin-logs.service.ts`):

- `GET /admin/logs` — cursor-paginated list, newest first. Query params:
  `level` (`error`|`warn`), `context` (exact module), `search` (message ILIKE),
  `since` (ISO, optional lower bound), `cursor`. Reuses the **keyset cursor**
  pattern from `AdminActivityService` (created_at desc, id desc) — including the
  tz/precision-safe comparison (`error_logs.created_at` is `timestamptz`, so
  `isTz = true`). Page size 50.
- `GET /admin/logs/stats` — counts for the last 24h: total, by level
  (error/warn), and the top ~8 contexts by count. Feeds the header stat row.

## Frontend (`schedura-admin`)

New feature slice `src/features/logs/` already exists (mock). Phase 1:

- **New** `api/logs.api.ts`, `hooks/use-logs.ts`, `types/logs.ts` (mirror the two
  endpoints; cursor pagination like the activity slice).
- **Errors tab → live.** Rewrite `components/errors-tab.tsx` to read `GET
  /admin/logs`: a `DataTable` (or the existing log list components where they fit)
  with columns level badge, message, context/module, path, relative time. Toolbar:
  search box + level filter + context filter. Row click → `LogDetailSheet` showing
  the full stack and metadata. Header: `LogSummary` from `/admin/logs/stats`
  (24h totals by level, top contexts). Infinite scroll via the activity slice's
  cursor pattern (`useInfiniteQuery` + IntersectionObserver sentinel).
- **Audit / Requests / Integrations tabs → honest notes** (`SectionNote`), each
  saying what Phase 2 would need. Remove the parts of `lib/mock/logs` those tabs
  consumed if nothing else imports them; keep any shared types the live tab reuses.

The mock's fingerprint grouping, `state` (new/ongoing/resolved), `workspaces hit`,
and event counts are **dropped** from the live Errors tab — none are backed by
Phase 1 data. The live tab shows individual log rows, not groups.

## Data flow

```
error thrown / this.logger.error|warn(...)
        │
        ├── AllExceptionsFilter (unhandled)  ─┐
        └── AppLoggerService.error|warn(...) ─┤
                                              ▼
                                   LogWriterService.write()   (fire-and-forget, guarded)
                                              ▼
                                   INSERT error_logs
                                              ▼
        GET /admin/logs  ──►  AdminLogsService (keyset paginate)  ──►  FE Errors tab
```

## Error handling (the critical part)

The logging path must never be able to crash the app or feed itself:

- `LogWriterService.write` is fire-and-forget (`void … .catch()`), never awaited on
  the request path, and swallows all its own errors to a plain `console.warn`.
- The writer never re-enters the capturing logger, so a DB outage can't produce a
  storm of "failed to write log" logs.
- The exception filter's added write is wrapped so that a logging failure cannot
  change or block the response the client would otherwise get.

## Testing / verification

- Backend `npm run build` green.
- Local: boot on :8010, apply the table, trigger a deliberate error (a bad request
  and a `logger.warn`) and confirm rows land in `error_logs`; read them back via
  `GET /admin/logs` (super-admin OTP flow) and check filters (`level`, `context`,
  `search`) and pagination; run the retention delete against a back-dated row.
- Frontend `npm run build` green; view the Errors tab in the browser against the
  live backend (list, filter, search, detail sheet, infinite scroll).

## Deploy notes

- One new table `error_logs`, applied via `CREATE TABLE IF NOT EXISTS` (local now,
  prod via Railway console on deploy) — no generated migration.
- `app.useLogger` + a global filter are the only bootstrap changes; response
  behaviour for clients is unchanged.
- No new env vars.

## Phase 2 (not now)

Fingerprint grouping + dedup, timeline histogram, live stream (SSE/websocket),
Audit tab (needs the separate admin-action audit trail), Requests tab (needs
request logging), Integrations tab. Retention tiering if volume warrants.
```
