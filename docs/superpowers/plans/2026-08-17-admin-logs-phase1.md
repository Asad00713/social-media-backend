# Admin Logs Phase 1 Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. This is integration-heavy infrastructure (custom logger, global filter, DB writes at bootstrap) in a codebase whose admin modules are verified by `npm run build` + a live boot on port 8010, not unit tests — so each task ends with a build and/or a live check rather than a Jest spec.

**Goal:** Capture application `error`/`warn` logs into Postgres and surface them in the super-admin dashboard's Logs → Errors tab, with filter/search and infinite scroll.

**Architecture:** A custom Nest `LoggerService` and a global exception filter both funnel into one fire-and-forget `LogWriterService` that inserts into a new `error_logs` table. A daily cron purges rows older than 30 days. Two admin endpoints (`GET /admin/logs`, `GET /admin/logs/stats`) read them back with the keyset-cursor pattern already used by `AdminActivityService`. The frontend Errors tab reads those endpoints; the other three Logs tabs become honest notes.

**Tech Stack:** NestJS, Drizzle ORM, Postgres, `@nestjs/schedule` (cron), React 19 + TanStack Query v5 (frontend).

**Spec:** `docs/superpowers/specs/2026-08-17-admin-logs-phase1-design.md`

## Global Constraints

- **Migration-drift rule:** NEVER run a generated drizzle migration. Apply the one new table with `CREATE TABLE IF NOT EXISTS` on local (and prod via Railway console on deploy). Do not run `npm run db:generate` / `db:migrate`.
- **Capture only `error` and `warn`.** Never write `log`/`info`/`debug`/`verbose` rows.
- **The logging path must never throw or recurse.** `LogWriterService.write` is fire-and-forget (`void … .catch(() => {})`), swallows its own failures to a plain `console.warn`, and never routes a failure back through the capturing logger.
- **The exception filter must not change the client response** — same status codes and body Nest already returns; it only adds a DB write.
- Money/counts are integers; timestamps are `timestamptz` on `error_logs` (so the keyset `isTz = true`).
- Backend runs locally on port **8010** for verification (`PORT=8010 node dist/src/main.js`); super-admin OTP login: `POST /auth/admin/challenge {email}` → OTP in console → `POST /auth/admin/verify {email, otp}` → `challengeToken` → `POST /auth/login {email, password: "Test1234!", challengeToken}` → `accessToken`. Admin email `asadmanzoor135@gmail.com`.
- `gh` CLI is off-PATH: `/c/Program Files/GitHub CLI/gh.exe`. Backend repo account `Asad00713`, frontend `asad00712`; `gh auth switch --user <x>` per repo.

---

## File Structure

**Backend (`socialmedia-workspace-otp`):**
- `src/drizzle/schema/error-logs.schema.ts` — the `error_logs` table (new)
- `src/drizzle/schema/index.ts` — export the new schema (modify)
- `src/logs/log-writer.service.ts` — fire-and-forget guarded inserter (new)
- `src/logs/app-logger.service.ts` — custom LoggerService, console + DB (new)
- `src/logs/all-exceptions.filter.ts` — global `@Catch()` filter (new)
- `src/logs/log-retention.service.ts` — daily 30-day purge cron (new)
- `src/logs/logs.module.ts` — wires the above (new)
- `src/app.module.ts` — import `LogsModule` (modify)
- `src/main.ts` — `app.useLogger(...)` + `app.useGlobalFilters(...)` (modify)
- `src/admin/admin-logs.service.ts` — keyset-paginated read + stats (new)
- `src/admin/admin.controller.ts` — `GET /admin/logs`, `GET /admin/logs/stats` (modify)
- `src/admin/admin.module.ts` — provide `AdminLogsService` (modify)

**Frontend (`schedura-admin`):**
- `src/features/logs/types/logs-live.ts` — endpoint types (new)
- `src/features/logs/api/logs.api.ts` — API wrappers (new)
- `src/features/logs/hooks/use-logs.ts` — queries (new)
- `src/features/logs/components/errors-tab.tsx` — live rewrite (modify)
- `src/features/logs/components/{audit,requests,integrations}-tab.tsx` — honest notes (modify)
- `src/features/logs/pages/logs-page.tsx` — adjust bodyScroll if needed (modify)

---

## Task 1: `error_logs` schema + table

**Files:**
- Create: `src/drizzle/schema/error-logs.schema.ts`
- Modify: `src/drizzle/schema/index.ts`

**Interfaces:**
- Produces: `errorLogs` (Drizzle pgTable), `ErrorLog` (inferred select type), `LOG_LEVELS = ['error','warn']`, `type LogLevel`.

- [ ] **Step 1: Write the schema file**

```ts
// src/drizzle/schema/error-logs.schema.ts
import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

export const LOG_LEVELS = ['error', 'warn'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Application error/warning logs. Written fire-and-forget by the custom logger
 * and the global exception filter. userId/workspaceId are intentionally NOT
 * foreign keys — a log is a historical record and must survive the deletion of
 * whatever it references.
 */
export const errorLogs = pgTable(
  'error_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    level: varchar('level', { length: 10 }).$type<LogLevel>().notNull(),
    message: text('message').notNull(),
    context: varchar('context', { length: 255 }),
    stack: text('stack'),
    path: varchar('path', { length: 500 }),
    method: varchar('method', { length: 10 }),
    statusCode: integer('status_code'),
    userId: uuid('user_id'),
    workspaceId: uuid('workspace_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('error_logs_level_created_idx').on(table.level, table.createdAt),
    index('error_logs_context_created_idx').on(table.context, table.createdAt),
    index('error_logs_created_idx').on(table.createdAt),
  ],
);

export type ErrorLog = typeof errorLogs.$inferSelect;
```

- [ ] **Step 2: Export from the schema barrel**

Add to `src/drizzle/schema/index.ts` (alongside the other `export * from './*.schema'` lines):

```ts
export * from './error-logs.schema';
```

- [ ] **Step 3: Apply the table to the local DB** (migration-drift rule — no generated migration)

Run (Git Bash):

```bash
PSQL="/c/Program Files/PostgreSQL/17/bin/psql.exe"
DB="postgresql://postgres:postgres@localhost:5432/schedura"
"$PSQL" "$DB" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS error_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  level varchar(10) NOT NULL,
  message text NOT NULL,
  context varchar(255),
  stack text,
  path varchar(500),
  method varchar(10),
  status_code integer,
  user_id uuid,
  workspace_id uuid,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS error_logs_level_created_idx ON error_logs (level, created_at);
CREATE INDEX IF NOT EXISTS error_logs_context_created_idx ON error_logs (context, created_at);
CREATE INDEX IF NOT EXISTS error_logs_created_idx ON error_logs (created_at);
SQL
"$PSQL" "$DB" -tAc "SELECT tablename FROM pg_tables WHERE tablename='error_logs';"
```

Expected: prints `error_logs`.

- [ ] **Step 4: Build to typecheck the schema**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/drizzle/schema/error-logs.schema.ts src/drizzle/schema/index.ts
git commit -m "feat(logs): error_logs schema + table"
```

---

## Task 2: `LogWriterService` (fire-and-forget guarded inserter)

**Files:**
- Create: `src/logs/log-writer.service.ts`

**Interfaces:**
- Consumes: `errorLogs`, `LogLevel` from Task 1; `DRIZZLE` token + `DbType` (see any existing service, e.g. `src/admin/admin-activity.service.ts`, for the exact import paths — `import { DRIZZLE } from '../drizzle/drizzle.module'` and `import type { DbType } from '../drizzle/db'`).
- Produces: `LogWriterService` with `write(entry: LogWriteEntry): void` and the exported `interface LogWriteEntry`.

- [ ] **Step 1: Write the service**

```ts
// src/logs/log-writer.service.ts
import { Inject, Injectable } from '@nestjs/common';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { errorLogs, type LogLevel } from '../drizzle/schema';

export interface LogWriteEntry {
  level: LogLevel;
  message: string;
  context?: string | null;
  stack?: string | null;
  path?: string | null;
  method?: string | null;
  statusCode?: number | null;
  userId?: string | null;
  workspaceId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * The single write path for the logs table. Deliberately fire-and-forget: it is
 * never awaited on a request, and it swallows ALL of its own failures to a plain
 * console.warn. It must never throw and must never route a failure back through
 * the app logger — a logging failure that logged itself would loop forever.
 */
@Injectable()
export class LogWriterService {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  write(entry: LogWriteEntry): void {
    // Truncate defensively — a runaway message/stack shouldn't blow the row.
    const message = (entry.message ?? '').slice(0, 10_000);
    const stack = entry.stack ? entry.stack.slice(0, 20_000) : null;

    void this.db
      .insert(errorLogs)
      .values({
        level: entry.level,
        message,
        context: entry.context ?? null,
        stack,
        path: entry.path ?? null,
        method: entry.method ?? null,
        statusCode: entry.statusCode ?? null,
        userId: entry.userId ?? null,
        workspaceId: entry.workspaceId ?? null,
        metadata: entry.metadata ?? {},
      })
      .catch((err: unknown) => {
        // Plain console only — never back into the app logger.
        // eslint-disable-next-line no-console
        console.warn(
          '[LogWriterService] failed to persist a log:',
          err instanceof Error ? err.message : err,
        );
      });
  }
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: exits 0 (service not yet provided by a module — that's Task 6; this only typechecks).

- [ ] **Step 3: Commit**

```bash
git add src/logs/log-writer.service.ts
git commit -m "feat(logs): fire-and-forget LogWriterService"
```

---

## Task 3: `AppLoggerService` (console + DB for error/warn)

**Files:**
- Create: `src/logs/app-logger.service.ts`

**Interfaces:**
- Consumes: `LogWriterService` from Task 2.
- Produces: `AppLoggerService extends ConsoleLogger` with a `setWriter(writer: LogWriterService)` method (the writer is injected after construction — see Task 7's `main.ts` wiring).

- [ ] **Step 1: Write the logger**

```ts
// src/logs/app-logger.service.ts
import { ConsoleLogger, Injectable } from '@nestjs/common';
import type { LogWriterService } from './log-writer.service';

/**
 * The app's logger. Console behaviour is unchanged (it extends ConsoleLogger);
 * additionally, error() and warn() persist a row via LogWriterService. log(),
 * debug() and verbose() are console-only — capturing info/debug would be a
 * per-call DB write for no signal.
 *
 * The writer is set after construction because the logger is installed during
 * bootstrap (app.useLogger) before we resolve providers from the container.
 */
@Injectable()
export class AppLoggerService extends ConsoleLogger {
  private writer?: LogWriterService;

  setWriter(writer: LogWriterService): void {
    this.writer = writer;
  }

  error(message: unknown, stackOrContext?: string, context?: string): void {
    super.error(message as string, stackOrContext as string, context as string);
    // Nest calls error(message, stack, context). When there's no stack the
    // second arg is the context instead — normalise both shapes.
    const ctx = context ?? (stackOrContext && !this.looksLikeStack(stackOrContext) ? stackOrContext : undefined);
    const stack = stackOrContext && this.looksLikeStack(stackOrContext) ? stackOrContext : undefined;
    this.writer?.write({
      level: 'error',
      message: this.asMessage(message),
      context: ctx ?? this.context ?? null,
      stack: stack ?? null,
    });
  }

  warn(message: unknown, context?: string): void {
    super.warn(message as string, context as string);
    this.writer?.write({
      level: 'warn',
      message: this.asMessage(message),
      context: context ?? this.context ?? null,
    });
  }

  private asMessage(message: unknown): string {
    if (typeof message === 'string') return message;
    if (message instanceof Error) return message.message;
    try {
      return JSON.stringify(message);
    } catch {
      return String(message);
    }
  }

  private looksLikeStack(value: string): boolean {
    return value.includes('\n') && value.includes('    at ');
  }
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/logs/app-logger.service.ts
git commit -m "feat(logs): AppLoggerService persists error/warn"
```

---

## Task 4: `AllExceptionsFilter`

**Files:**
- Create: `src/logs/all-exceptions.filter.ts`

**Interfaces:**
- Consumes: `LogWriterService` from Task 2.
- Produces: `AllExceptionsFilter implements ExceptionFilter` (registered globally in Task 7).

- [ ] **Step 1: Write the filter**

```ts
// src/logs/all-exceptions.filter.ts
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { LogWriterService } from './log-writer.service';

/**
 * Global exception filter. It preserves Nest's default response exactly — same
 * status and body a client would otherwise get — and additionally persists a
 * row. 5xx are 'error'; 4xx are 'warn' (a validation 400 is worth seeing, not
 * worth alerting on). The DB write is fire-and-forget and can never change or
 * block the response.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly writer: LogWriterService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof Error ? exception.message : 'Unknown error';
    const stack = exception instanceof Error ? exception.stack : undefined;

    // Persist (guarded, fire-and-forget). Never let this affect the response.
    try {
      const user = (request as unknown as { user?: { userId?: string; workspaceId?: string } }).user;
      this.writer.write({
        level: status >= 500 ? 'error' : 'warn',
        message,
        context: 'HTTP',
        stack: stack ?? null,
        path: request?.url ?? null,
        method: request?.method ?? null,
        statusCode: status,
        userId: user?.userId ?? null,
        workspaceId: user?.workspaceId ?? null,
      });
    } catch {
      // ignore — logging must not break the response
    }

    // Reproduce Nest's default response shape.
    const body =
      exception instanceof HttpException
        ? exception.getResponse()
        : { statusCode: status, message: 'Internal server error' };

    response.status(status).json(body);
  }
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/logs/all-exceptions.filter.ts
git commit -m "feat(logs): global exception filter persists errors"
```

---

## Task 5: retention cron

**Files:**
- Create: `src/logs/log-retention.service.ts`

**Interfaces:**
- Consumes: `errorLogs` (Task 1), `DRIZZLE`/`DbType`.
- Produces: `LogRetentionService` with `purgeOld(): Promise<number>` (returns rows deleted) driven by an `@Cron`.

- [ ] **Step 1: Confirm `ScheduleModule` is already registered**

Run: `grep -rn "ScheduleModule" src/app.module.ts`
Expected: a `ScheduleModule.forRoot()` line exists (the codebase already uses `@Cron`). If it is missing, add `ScheduleModule.forRoot()` to `AppModule`'s imports in this task.

- [ ] **Step 2: Write the service**

```ts
// src/logs/log-retention.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { lt, sql } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { errorLogs } from '../drizzle/schema';

const RETENTION_DAYS = 30;

@Injectable()
export class LogRetentionService {
  // Plain Logger here is fine: this class's own logs are low-volume and, if
  // persisted, wouldn't loop (it deletes, it doesn't fail-and-log-and-fail).
  private readonly logger = new Logger(LogRetentionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeOld(): Promise<number> {
    const cutoff = sql`now() - interval '${sql.raw(String(RETENTION_DAYS))} days'`;
    const deleted = await this.db
      .delete(errorLogs)
      .where(lt(errorLogs.createdAt, cutoff))
      .returning({ id: errorLogs.id });
    if (deleted.length > 0) {
      this.logger.log(`Purged ${deleted.length} log rows older than ${RETENTION_DAYS}d`);
    }
    return deleted.length;
  }
}
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/logs/log-retention.service.ts
git commit -m "feat(logs): 30-day retention cron"
```

---

## Task 6: `LogsModule` + app wiring

**Files:**
- Create: `src/logs/logs.module.ts`
- Modify: `src/app.module.ts`, `src/main.ts`

**Interfaces:**
- Consumes: all of Tasks 2–5.
- Produces: `LogsModule` exporting `LogWriterService` and `AppLoggerService`.

- [ ] **Step 1: Write the module**

```ts
// src/logs/logs.module.ts
import { Module } from '@nestjs/common';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { LogWriterService } from './log-writer.service';
import { AppLoggerService } from './app-logger.service';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { LogRetentionService } from './log-retention.service';

@Module({
  imports: [DrizzleModule],
  providers: [
    LogWriterService,
    AppLoggerService,
    AllExceptionsFilter,
    LogRetentionService,
  ],
  exports: [LogWriterService, AppLoggerService, AllExceptionsFilter],
})
export class LogsModule {}
```

- [ ] **Step 2: Import `LogsModule` in `AppModule`**

In `src/app.module.ts` add `LogsModule` to the `imports` array (and its import statement at top). If Step 1 of Task 5 found no `ScheduleModule.forRoot()`, add it here too.

- [ ] **Step 3: Wire logger + filter in `main.ts`**

In `src/main.ts`, after `const app = await NestFactory.create(...)` and before `app.listen`, add:

```ts
import { AppLoggerService } from './logs/app-logger.service';
import { LogWriterService } from './logs/log-writer.service';
import { AllExceptionsFilter } from './logs/all-exceptions.filter';

// … inside bootstrap(), after app is created:
const appLogger = app.get(AppLoggerService);
appLogger.setWriter(app.get(LogWriterService));
app.useLogger(appLogger);
app.useGlobalFilters(app.get(AllExceptionsFilter));
```

Place these lines alongside the existing `app.useGlobalPipes(...)` block. Keep the existing pipe/middleware setup intact.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 5: Live-verify capture**

Boot and confirm a deliberate error + a warn both land in `error_logs`.

```bash
# terminal A — boot (leave running)
PORT=8010 node dist/src/main.js
```

Wait until port 8010 listens, then in terminal B trigger a 404 and check the table:

```bash
curl -s -o /dev/null "http://localhost:8010/definitely-not-a-route"
PSQL="/c/Program Files/PostgreSQL/17/bin/psql.exe"; DB="postgresql://postgres:postgres@localhost:5432/schedura"
"$PSQL" "$DB" -tAc "SELECT level, status_code, path, left(message,60) FROM error_logs ORDER BY created_at DESC LIMIT 5;"
```

Expected: at least one row for the 404 (`warn`, `404`, `/definitely-not-a-route`). Note: a bare 404 with no matching route is handled by Nest's router as a `NotFoundException` and passes through the filter — confirm a row appears; if not, exercise a route that throws (any endpoint hit without auth returns 401 and should also produce a `warn` row).

- [ ] **Step 6: Commit**

```bash
git add src/logs/logs.module.ts src/app.module.ts src/main.ts
git commit -m "feat(logs): wire LogsModule, custom logger + global filter"
```

---

## Task 7: `AdminLogsService` (keyset read + stats)

**Files:**
- Create: `src/admin/admin-logs.service.ts`

**Interfaces:**
- Consumes: `errorLogs`, `LogLevel` (Task 1); the keyset technique from `src/admin/admin-activity.service.ts` (read it — copy `date_trunc('milliseconds', …)` + per-type cast; `error_logs.created_at` is `timestamptz`, so `isTz = true`).
- Produces: `AdminLogsService` with:
  - `getLogs(opts: { level?: LogLevel; context?: string; search?: string; since?: string; cursor?: string }): Promise<{ items: ErrorLog[]; nextCursor: string | null }>`
  - `getStats(): Promise<{ total24h: number; byLevel: { level: string; count: number }[]; topContexts: { context: string | null; count: number }[] }>`

- [ ] **Step 1: Write the service**

```ts
// src/admin/admin-logs.service.ts
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { errorLogs, type ErrorLog, type LogLevel } from '../drizzle/schema';

const PAGE_SIZE = 50;

function encodeCursor(row: { createdAt: Date | string; id: string }): string {
  const created =
    row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt);
  return `${created}_${row.id}`;
}

function decodeCursor(cursor?: string): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  const at = cursor.lastIndexOf('_');
  if (at <= 0) return null;
  return { createdAt: cursor.slice(0, at), id: cursor.slice(at + 1) };
}

@Injectable()
export class AdminLogsService {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  // error_logs.created_at is timestamptz — cast the cursor as timestamptz and
  // compare at millisecond precision (same fix as AdminActivityService).
  private keysetBefore(cursor?: string): SQL | undefined {
    const decoded = decodeCursor(cursor);
    if (!decoded) return undefined;
    const cursorTs = sql`${decoded.createdAt}::timestamptz`;
    const colMs = sql`date_trunc('milliseconds', ${errorLogs.createdAt})`;
    return or(
      lt(colMs, cursorTs),
      and(eq(colMs, cursorTs), lt(errorLogs.id, decoded.id)),
    );
  }

  async getLogs(opts: {
    level?: LogLevel;
    context?: string;
    search?: string;
    since?: string;
    cursor?: string;
  }): Promise<{ items: ErrorLog[]; nextCursor: string | null }> {
    const conditions: SQL[] = [];
    const keyset = this.keysetBefore(opts.cursor);
    if (keyset) conditions.push(keyset);
    if (opts.level) conditions.push(eq(errorLogs.level, opts.level));
    if (opts.context) conditions.push(eq(errorLogs.context, opts.context));
    if (opts.search?.trim())
      conditions.push(ilike(errorLogs.message, `%${opts.search.trim()}%`));
    if (opts.since) conditions.push(gte(errorLogs.createdAt, new Date(opts.since)));

    const rows = await this.db
      .select()
      .from(errorLogs)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(errorLogs.createdAt), desc(errorLogs.id))
      .limit(PAGE_SIZE + 1);

    if (rows.length <= PAGE_SIZE) return { items: rows, nextCursor: null };
    const items = rows.slice(0, PAGE_SIZE);
    return { items, nextCursor: encodeCursor(items[items.length - 1]) };
  }

  async getStats(): Promise<{
    total24h: number;
    byLevel: { level: string; count: number }[];
    topContexts: { context: string | null; count: number }[];
  }> {
    const since = sql`now() - interval '24 hours'`;
    const [byLevel, topContexts] = await Promise.all([
      this.db
        .select({ level: errorLogs.level, count: sql<number>`count(*)::int` })
        .from(errorLogs)
        .where(gte(errorLogs.createdAt, since))
        .groupBy(errorLogs.level),
      this.db
        .select({ context: errorLogs.context, count: sql<number>`count(*)::int` })
        .from(errorLogs)
        .where(gte(errorLogs.createdAt, since))
        .groupBy(errorLogs.context)
        .orderBy(desc(sql`count(*)`))
        .limit(8),
    ]);
    const total24h = byLevel.reduce((s, r) => s + r.count, 0);
    return { total24h, byLevel, topContexts };
  }
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/admin/admin-logs.service.ts
git commit -m "feat(logs): AdminLogsService keyset read + 24h stats"
```

---

## Task 8: admin endpoints

**Files:**
- Modify: `src/admin/admin.controller.ts`, `src/admin/admin.module.ts`

**Interfaces:**
- Consumes: `AdminLogsService` (Task 7).
- Produces: `GET /admin/logs`, `GET /admin/logs/stats`.

- [ ] **Step 1: Provide the service in `AdminModule`**

In `src/admin/admin.module.ts`: import `AdminLogsService` and add it to `providers` (mirroring how `AdminActivityService` is registered).

- [ ] **Step 2: Inject + add routes in `admin.controller.ts`**

Add `private readonly adminLogsService: AdminLogsService` to the constructor (import it at top), then add near the activity routes:

```ts
// ==========================================================================
// Logs — application error/warning capture (Phase 1). See AdminLogsService.
// ==========================================================================

@Get('logs')
@HttpCode(HttpStatus.OK)
async getLogs(
  @Query('level') level?: 'error' | 'warn',
  @Query('context') context?: string,
  @Query('search') search?: string,
  @Query('since') since?: string,
  @Query('cursor') cursor?: string,
) {
  return this.adminLogsService.getLogs({ level, context, search, since, cursor });
}

@Get('logs/stats')
@HttpCode(HttpStatus.OK)
async getLogStats() {
  return this.adminLogsService.getLogStats
    ? this.adminLogsService.getLogStats()
    : this.adminLogsService.getStats();
}
```

Note: the method on the service is `getStats()` — call `this.adminLogsService.getStats()` directly (drop the defensive `?.` shown above; it's there only to flag the name — verify it matches Task 7 and use the real name):

```ts
@Get('logs/stats')
@HttpCode(HttpStatus.OK)
async getLogStats() {
  return this.adminLogsService.getStats();
}
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 4: Live-verify endpoints** (boot :8010 if not running; log in via the OTP flow in Global Constraints; save `accessToken`)

```bash
AT="<accessToken>"
# list
curl -s "http://localhost:8010/admin/logs" -H "Authorization: Bearer $AT" | head -c 400
# filter by level
curl -s "http://localhost:8010/admin/logs?level=warn" -H "Authorization: Bearer $AT" | head -c 300
# search
curl -s "http://localhost:8010/admin/logs?search=Unauthorized" -H "Authorization: Bearer $AT" | head -c 300
# stats
curl -s "http://localhost:8010/admin/logs/stats" -H "Authorization: Bearer $AT"
```

Expected: `logs` returns `{ items: [...], nextCursor: ... }` with real rows captured so far; `level=warn` filters; `search` narrows by message; `stats` returns `{ total24h, byLevel, topContexts }`.

- [ ] **Step 5: Verify retention query is correct** (does not need the cron to fire)

```bash
PSQL="/c/Program Files/PostgreSQL/17/bin/psql.exe"; DB="postgresql://postgres:postgres@localhost:5432/schedura"
# back-date one row, run the same delete the cron runs, confirm it's removed, then confirm recent rows survive
"$PSQL" "$DB" -c "UPDATE error_logs SET created_at = now() - interval '40 days' WHERE id = (SELECT id FROM error_logs LIMIT 1);"
"$PSQL" "$DB" -c "DELETE FROM error_logs WHERE created_at < now() - interval '30 days';"
"$PSQL" "$DB" -tAc "SELECT count(*) FROM error_logs WHERE created_at < now() - interval '30 days';"
```

Expected: final count is `0` (no old rows remain); recent rows untouched.

- [ ] **Step 6: Commit**

```bash
git add src/admin/admin.controller.ts src/admin/admin.module.ts
git commit -m "feat(logs): GET /admin/logs + /admin/logs/stats"
```

---

## Task 9: frontend — types, api, hooks

**Files:**
- Create: `src/features/logs/types/logs-live.ts`, `src/features/logs/api/logs.api.ts`, `src/features/logs/hooks/use-logs.ts`

**Interfaces:**
- Consumes: the two backend endpoints (Task 8).
- Produces: `useLogs(filters)` (infinite query), `useLogStats()` (query); types `LiveLog`, `LogLevel`, `LogsResponse`, `LogStats`.

- [ ] **Step 1: Types** (mirror the backend response exactly)

```ts
// src/features/logs/types/logs-live.ts
export type LogLevel = 'error' | 'warn'

export interface LiveLog {
  id: string
  level: LogLevel
  message: string
  context: string | null
  stack: string | null
  path: string | null
  method: string | null
  statusCode: number | null
  userId: string | null
  workspaceId: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

export interface LogsResponse {
  items: LiveLog[]
  nextCursor: string | null
}

export interface LogStats {
  total24h: number
  byLevel: { level: string; count: number }[]
  topContexts: { context: string | null; count: number }[]
}

export interface LogFilters {
  level?: LogLevel
  context?: string
  search?: string
}
```

- [ ] **Step 2: API** (cursor appended inline — `apiClient.get` takes no params object)

```ts
// src/features/logs/api/logs.api.ts
import { apiClient } from '@/lib/api'
import type { LogFilters, LogStats, LogsResponse } from '../types/logs-live'

export function getLogs(filters: LogFilters, cursor?: string) {
  const q = new URLSearchParams()
  if (filters.level) q.set('level', filters.level)
  if (filters.context) q.set('context', filters.context)
  if (filters.search) q.set('search', filters.search)
  if (cursor) q.set('cursor', cursor)
  const qs = q.toString()
  return apiClient.get<LogsResponse>(`/admin/logs${qs ? `?${qs}` : ''}`)
}

export function getLogStats() {
  return apiClient.get<LogStats>('/admin/logs/stats')
}
```

- [ ] **Step 3: Hooks** (infinite query like the activity slice)

```ts
// src/features/logs/hooks/use-logs.ts
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { getLogs, getLogStats } from '../api/logs.api'
import type { LogFilters } from '../types/logs-live'

export const logsKeys = {
  all: ['admin', 'logs'] as const,
  list: (f: LogFilters) => [...logsKeys.all, 'list', f] as const,
  stats: () => [...logsKeys.all, 'stats'] as const,
}

export function useLogs(filters: LogFilters) {
  return useInfiniteQuery({
    queryKey: logsKeys.list(filters),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      getLogs(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 30_000,
  })
}

export function useLogStats() {
  return useQuery({
    queryKey: logsKeys.stats(),
    queryFn: getLogStats,
    refetchInterval: 30_000,
  })
}
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/features/logs/types/logs-live.ts src/features/logs/api/logs.api.ts src/features/logs/hooks/use-logs.ts
git commit -m "feat(logs): frontend types, api, hooks"
```

---

## Task 10: frontend — Errors tab live

**Files:**
- Modify: `src/features/logs/components/errors-tab.tsx`
- Read for reuse: `src/features/logs/components/log-detail-sheet.tsx`, `log-summary.tsx`; `src/features/activity/components/activity-feed.tsx` (infinite-scroll sentinel pattern); `src/components/data-table/*`.

**Interfaces:**
- Consumes: `useLogs`, `useLogStats` (Task 9).
- Produces: a live `ErrorsTab` reading real logs.

- [ ] **Step 1: Read the pieces to reuse**

Read `log-detail-sheet.tsx` and `log-summary.tsx` to see their exact props (they already exist from the mock). Read `activity-feed.tsx` for the IntersectionObserver sentinel used for infinite scroll. Match those signatures — do not invent new prop shapes.

- [ ] **Step 2: Rewrite `errors-tab.tsx` as a live list**

Replace the mock-group implementation with a live one:
- Header: `LogSummary` (or a `StatGrid`) fed by `useLogStats()` — 24h total, error count, warn count, and the busiest context.
- Toolbar: a search input (debounced into `filters.search`), a level filter (all / error / warn), and — when `topContexts` is available — a context filter.
- Body: rows from `useLogs(filters)` flattened across pages, each showing a level dot/badge, the message (truncated), the `context` and `path`, and a relative time. Row click opens `LogDetailSheet` with the full message, `stack`, `path`/`method`/`statusCode`, and metadata.
- Infinite scroll: an IntersectionObserver sentinel that calls `fetchNextPage()` when `hasNextPage && !isFetchingNextPage` (copy the guard from `activity-feed.tsx`).
- States: loading skeleton, error retry, and an empty state ("No errors or warnings captured yet — the app is quiet, or logging just started").

Keep the file focused: if the row/detail mapping grows past a screen, extract a small `LogRow`/`logDetailItems` helper in the same file (mirroring how `activity-feed.tsx` keeps `FeedRow` local).

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/features/logs/components/errors-tab.tsx
git commit -m "feat(logs): live Errors tab"
```

---

## Task 11: frontend — honest notes for the other three tabs + mock cleanup

**Files:**
- Modify: `src/features/logs/components/audit-tab.tsx`, `requests-tab.tsx`, `integrations-tab.tsx`, `src/features/logs/pages/logs-page.tsx`
- Possibly remove: unused parts of `src/lib/mock/logs.ts`

**Interfaces:**
- Consumes: `SectionNote` (`@/components/shared/section-note`).

- [ ] **Step 1: Replace each of the three tabs with an honest note**

Each becomes a `SectionNote` explaining what Phase 2 needs. Suggested copy:
- **Audit:** `status="no-data"` — "Who-did-what admin actions (suspend, reactivate, delete) aren't recorded to an append-only log yet — the acting admin is only stamped on the target row. A dedicated audit trail is Phase 2."
- **Requests:** `status="no-data"` — "Per-request logging (method, path, latency, status) isn't captured. The Errors tab is live and shows failed requests; a full request log is Phase 2."
- **Integrations:** `status="no-data"` — "Integration-specific logs aren't separated out. Errors from any integration currently surface in the Errors tab by their context; a dedicated view is Phase 2."

Keep each file a thin component that renders one `SectionNote` (mirror `src/features/platforms/components/quotas-tab.tsx`).

- [ ] **Step 2: Fix page scroll if needed**

Check `logs-page.tsx`: the live Errors tab is document-flow with infinite scroll, so its tab must have `bodyScroll` enabled (same lesson as the activity page — a `fill`/no-scroll tab silently caps the list). Ensure the errors tab scrolls; adjust the page's per-tab scroll flag accordingly.

- [ ] **Step 3: Remove now-unused mock**

```bash
grep -rln "mock/logs" src --include=*.ts --include=*.tsx
```

If nothing outside the logs feature imports `lib/mock/logs` and the live tabs no longer use it, `git rm src/lib/mock/logs.ts`. If some shared type is still imported by a kept file, leave the file but delete the unused fixtures. Do not remove anything still imported.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(logs): honest notes for audit/requests/integrations + mock cleanup"
```

---

## Task 12: end-to-end verification + PRs

- [ ] **Step 1: Full backend live-verify** (boot :8010 fresh from the latest build)

Trigger a few errors/warns (unauthenticated calls, a bad route), then via the admin token confirm `GET /admin/logs` returns them, filters work (`level`, `context`, `search`), pagination walks with no duplicate boundary row (paginate to `nextCursor: null`; confirm distinct ids), and `GET /admin/logs/stats` is sane.

- [ ] **Step 2: Frontend browser verify**

Boot FE dev against :8010 (`VITE_API_URL=http://localhost:8010 npm run dev`), open the Logs → Errors tab: list renders real rows, search + level/context filters work, a row opens the detail sheet with the stack, and scrolling loads more. The other three tabs show honest notes.

- [ ] **Step 3: Both builds green**

Backend `npm run build` and frontend `npm run build` both exit 0.

- [ ] **Step 4: Push + PRs** (ask the user before pushing/merging, per the standing rule)

Backend (`Asad00713`) and frontend (`asad00712`) each: `git push -u origin feat/admin-logs-live`, open a PR against `main` describing the capture pipeline, the endpoints, the `CREATE TABLE IF NOT EXISTS` deploy step (prod via Railway console), and that client response behaviour is unchanged. Backend PR is the dependency; merge it first.

- [ ] **Step 5: Deploy note for the user**

Remind the user: on deploy, run the `CREATE TABLE IF NOT EXISTS error_logs` DDL (+ indexes) on the prod DB via the Railway console before/with the backend deploy, since there is no generated migration.

---

## Self-Review

**Spec coverage:**
- error_logs schema + no-FK userId/workspaceId → Task 1 ✓
- LogWriterService fire-and-forget guarded → Task 2 ✓
- AppLoggerService console+DB for error/warn only → Task 3 ✓
- AllExceptionsFilter, response unchanged, 4xx=warn/5xx=error → Task 4 ✓
- 30-day retention cron → Task 5 ✓
- LogsModule + main.ts wiring (useLogger + global filter) → Task 6 ✓
- GET /admin/logs (keyset, filters) + /admin/logs/stats → Tasks 7–8 ✓
- Migration-drift CREATE TABLE IF NOT EXISTS (local + prod) → Task 1 Step 3, Task 12 Step 5 ✓
- FE Errors tab live + infinite scroll → Tasks 9–10 ✓
- Audit/Requests/Integrations honest notes + mock cleanup → Task 11 ✓
- Keyset tz/precision-safe reuse → Task 7 (isTz timestamptz) ✓

**Placeholder scan:** Task 8 Step 2 originally showed a defensive `getLogStats?.` — flagged and corrected inline to `this.adminLogsService.getStats()`. No other TBD/TODO.

**Type consistency:** `LogWriteEntry` (Task 2) ↔ `AppLoggerService`/filter callers (Tasks 3–4) ✓; `getLogs`/`getStats` signatures (Task 7) ↔ controller (Task 8) ↔ FE api (Task 9) ✓; `LiveLog` fields ↔ `error_logs` columns (Task 1) ✓; keyset `getStats` name consistent (not `getLogStats`).
```
