# Admin Audit Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An append-only record of who did what admin action (suspend/reactivate/delete), when, and to whom — surviving later state changes that today erase the suspension trace — surfaced live in the schedura-admin Security → Audit tab.

**Architecture:** New `admin_audit_logs` Postgres table + `AdminAuditService.record()` called explicitly after each admin mutation (suspend/reactivate in `AdminService`, deletes in `AdminController`). Read via `GET /admin/audit` (keyset-paginated) + `/admin/audit/stats`. Frontend adds a live Audit tab mirroring the Logs Errors tab; Sessions/Compliance stay honest notes. Daily retention cron purges rows > 365 days.

**Tech Stack:** NestJS + Drizzle (Postgres, Neon/Railway), Vite + React 19 + TanStack Query + shadcn (Base UI).

**Spec:** `docs/superpowers/specs/2026-08-17-admin-audit-log-design.md`

## Global Constraints

- **Migration-drift rule:** NEVER run generated Drizzle migrations. Apply the table via `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` on local (and prod via Railway console).
- **No FKs** on `actor_id` / `target_id` — the log must survive deletion of referenced rows (mirror `error_logs`).
- **Audit write never breaks the action:** `record()` is called after the mutation succeeds, wrapped in try/catch; failure logs a `warn` (surfaces in the Logs module) but never rolls back or throws.
- **Denormalized snapshots:** `actor_email` and `target_label` captured at action time so rows stay readable after deletions.
- **Bulk = per-target row** with `metadata.bulk = true`.
- **Retention:** 365 days.
- **Keyset pagination:** `created_at desc, id desc`; `created_at` is `timestamptz` → cursor cast `::timestamptz` + `date_trunc('milliseconds', ...)` (reuse the proven `AdminLogsService.keysetBefore` pattern) to avoid boundary-row duplicates.
- **Backend dist path:** `dist/src/main.js`. Verify on `PORT=8010`. Local DB: `postgresql://postgres:postgres@localhost:5432/schedura`, psql at `/c/Program Files/PostgreSQL/17/bin/psql.exe`.
- **Frontend** feature structure mirrors `src/features/logs/` (`types/`, `api/`, `hooks/`, `components/`). `apiClient.get(path)` takes NO params object — build query strings inline with `URLSearchParams`.

---

### Task 1: `admin_audit_logs` schema + table

**Files:**
- Create: `src/drizzle/schema/admin-audit-logs.schema.ts`
- Modify: `src/drizzle/schema/index.ts` (add `export * from './admin-audit-logs.schema';`)

**Interfaces:**
- Produces: `adminAuditLogs` pgTable; `AUDIT_ACTIONS` (readonly tuple), `AuditAction` type; `AUDIT_TARGET_TYPES`, `AuditTargetType` type; `AdminAuditLog = typeof adminAuditLogs.$inferSelect`.

- [ ] **Step 1: Write the schema file**

```ts
// src/drizzle/schema/admin-audit-logs.schema.ts
import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

export const AUDIT_ACTIONS = [
  'user.suspend',
  'user.reactivate',
  'workspace.suspend',
  'workspace.reactivate',
  'channel.disconnect',
  'member.remove',
  'invitation.cancel',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_TARGET_TYPES = [
  'user',
  'workspace',
  'channel',
  'member',
  'invitation',
] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

/**
 * Append-only record of super-admin actions. Rows are only inserted (never
 * updated) and deleted only by the retention cron. actor_id / target_id are
 * intentionally NOT foreign keys: the log is a historical record that must
 * survive deletion of whatever it references. actor_email and target_label are
 * denormalized snapshots taken at action time so the row stays readable even
 * after the actor or target is deleted.
 */
export const adminAuditLogs = pgTable(
  'admin_audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    action: varchar('action', { length: 40 }).$type<AuditAction>().notNull(),
    actorId: uuid('actor_id').notNull(),
    actorEmail: varchar('actor_email', { length: 255 }),
    targetType: varchar('target_type', { length: 20 })
      .$type<AuditTargetType>()
      .notNull(),
    targetId: varchar('target_id', { length: 64 }).notNull(),
    targetLabel: varchar('target_label', { length: 255 }),
    reason: varchar('reason', { length: 40 }),
    note: text('note'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    createdIdx: index('admin_audit_created_idx').on(table.createdAt),
    actionCreatedIdx: index('admin_audit_action_created_idx').on(
      table.action,
      table.createdAt,
    ),
    actorCreatedIdx: index('admin_audit_actor_created_idx').on(
      table.actorId,
      table.createdAt,
    ),
    targetIdx: index('admin_audit_target_idx').on(
      table.targetType,
      table.targetId,
    ),
  }),
);

export type AdminAuditLog = typeof adminAuditLogs.$inferSelect;
```

- [ ] **Step 2: Export from the schema barrel**

Add to `src/drizzle/schema/index.ts`:

```ts
export * from './admin-audit-logs.schema';
```

- [ ] **Step 3: Create the table on the local DB (migration-drift rule — no generated migration)**

Run:

```bash
"/c/Program Files/PostgreSQL/17/bin/psql.exe" "postgresql://postgres:postgres@localhost:5432/schedura" -c "
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action varchar(40) NOT NULL,
  actor_id uuid NOT NULL,
  actor_email varchar(255),
  target_type varchar(20) NOT NULL,
  target_id varchar(64) NOT NULL,
  target_label varchar(255),
  reason varchar(40),
  note text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_audit_created_idx ON admin_audit_logs (created_at);
CREATE INDEX IF NOT EXISTS admin_audit_action_created_idx ON admin_audit_logs (action, created_at);
CREATE INDEX IF NOT EXISTS admin_audit_actor_created_idx ON admin_audit_logs (actor_id, created_at);
CREATE INDEX IF NOT EXISTS admin_audit_target_idx ON admin_audit_logs (target_type, target_id);
"
```

Expected: `CREATE TABLE` then four `CREATE INDEX` (or no-op if already present).

- [ ] **Step 4: Verify the table exists**

Run:

```bash
"/c/Program Files/PostgreSQL/17/bin/psql.exe" "postgresql://postgres:postgres@localhost:5432/schedura" -c "\d admin_audit_logs"
```

Expected: table with all 11 columns and 4 indexes listed.

- [ ] **Step 5: Commit**

```bash
git add src/drizzle/schema/admin-audit-logs.schema.ts src/drizzle/schema/index.ts
git commit -m "feat(audit): admin_audit_logs schema + table"
```

---

### Task 2: `AdminAuditService` — `record()` capture method

**Files:**
- Create: `src/admin/admin-audit.service.ts`
- Modify: `src/admin/admin.module.ts` (register + export `AdminAuditService`)

**Interfaces:**
- Consumes: `DRIZZLE` token, `DbType`, `adminAuditLogs`, `users` schema.
- Produces:
  ```ts
  interface AuditRecordEntry {
    action: AuditAction;
    actorId: string;
    targetType: AuditTargetType;
    targetId: string;
    targetLabel?: string | null;
    reason?: string | null;
    note?: string | null;
    metadata?: Record<string, unknown>;
  }
  class AdminAuditService {
    record(entry: AuditRecordEntry): Promise<void>;
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// src/admin/admin-audit.service.spec.ts
import { AdminAuditService } from './admin-audit.service';

function makeDb(overrides: Partial<any> = {}) {
  const inserted: any[] = [];
  const db: any = {
    inserted,
    query: {
      users: {
        findFirst: jest.fn().mockResolvedValue({ email: 'admin@x.com' }),
      },
    },
    insert: () => ({
      values: (v: any) => {
        inserted.push(v);
        return Promise.resolve();
      },
    }),
    ...overrides,
  };
  return db;
}

describe('AdminAuditService.record', () => {
  it('inserts a row with resolved actor email', async () => {
    const db = makeDb();
    const svc = new AdminAuditService(db);
    await svc.record({
      action: 'user.suspend',
      actorId: 'admin-1',
      targetType: 'user',
      targetId: 'user-9',
      targetLabel: 'joe@x.com',
      reason: 'spam',
    });
    expect(db.inserted).toHaveLength(1);
    expect(db.inserted[0]).toMatchObject({
      action: 'user.suspend',
      actorId: 'admin-1',
      actorEmail: 'admin@x.com',
      targetType: 'user',
      targetId: 'user-9',
      targetLabel: 'joe@x.com',
      reason: 'spam',
    });
  });

  it('never throws when the insert fails', async () => {
    const db = makeDb({
      insert: () => ({ values: () => Promise.reject(new Error('db down')) }),
    });
    const svc = new AdminAuditService(db);
    await expect(
      svc.record({
        action: 'user.suspend',
        actorId: 'a',
        targetType: 'user',
        targetId: 'u',
      }),
    ).resolves.toBeUndefined();
  });

  it('stores null actor email when the actor is missing', async () => {
    const db = makeDb({
      query: { users: { findFirst: jest.fn().mockResolvedValue(undefined) } },
    });
    const svc = new AdminAuditService(db);
    await svc.record({
      action: 'user.reactivate',
      actorId: 'ghost',
      targetType: 'user',
      targetId: 'u',
    });
    expect(db.inserted[0].actorEmail).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- admin-audit.service`
Expected: FAIL — `Cannot find module './admin-audit.service'`.

- [ ] **Step 3: Write the service**

```ts
// src/admin/admin-audit.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import {
  adminAuditLogs,
  users,
  type AuditAction,
  type AuditTargetType,
} from '../drizzle/schema';

export interface AuditRecordEntry {
  action: AuditAction;
  actorId: string;
  targetType: AuditTargetType;
  targetId: string;
  targetLabel?: string | null;
  reason?: string | null;
  note?: string | null;
  metadata?: Record<string, unknown>;
}

const MAX_NOTE = 5000;
const MAX_LABEL = 255;

@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /**
   * Write one audit row. Call AFTER the underlying mutation has succeeded — a
   * failed action must not leave an audit row. Never throws and never rolls
   * back the caller's action: a write failure is logged as a warning (which
   * itself lands in error_logs) and swallowed.
   */
  async record(entry: AuditRecordEntry): Promise<void> {
    try {
      const actor = await this.db.query.users.findFirst({
        where: eq(users.id, entry.actorId),
        columns: { email: true },
      });

      await this.db.insert(adminAuditLogs).values({
        action: entry.action,
        actorId: entry.actorId,
        actorEmail: actor?.email ?? null,
        targetType: entry.targetType,
        targetId: entry.targetId,
        targetLabel: entry.targetLabel?.slice(0, MAX_LABEL) ?? null,
        reason: entry.reason ?? null,
        note: entry.note?.slice(0, MAX_NOTE) ?? null,
        metadata: entry.metadata ?? {},
      });
    } catch (err) {
      this.logger.warn(
        `Failed to write audit log for ${entry.action} on ${entry.targetType}:${entry.targetId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
```

- [ ] **Step 4: Register in the module**

In `src/admin/admin.module.ts`, add `AdminAuditService` to `providers` and `exports`:

```ts
import { AdminAuditService } from './admin-audit.service';
// ...
providers: [
  AdminService,
  AdminAuditService,
  AdminActivityService,
  AdminLogsService,
  UserInactivityService,
  QueueMonitorService,
],
exports: [AdminService, UserInactivityService, QueueMonitorService, AdminAuditService],
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- admin-audit.service`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/admin/admin-audit.service.ts src/admin/admin-audit.service.spec.ts src/admin/admin.module.ts
git commit -m "feat(audit): AdminAuditService.record capture method"
```

---

### Task 3: Wire capture into suspend/reactivate (AdminService)

**Files:**
- Modify: `src/admin/admin.service.ts` (`suspendUser`, `reactivateUser`, `suspendWorkspace`, `reactivateWorkspace`, `bulkReactivateWorkspaces`)
- Modify: `src/admin/admin.controller.ts` (`reactivateUser`, `reactivateWorkspace`, `bulkReactivateWorkspaces` — thread `adminId`)

**Interfaces:**
- Consumes: `AdminAuditService.record` (Task 2).
- Produces: `reactivateUser(userId, adminId)`, `reactivateWorkspace(workspaceId, adminId, metadata?)`, `bulkReactivateWorkspaces(workspaceIds, adminId)`, `suspendWorkspace(workspaceId, adminId, reason, note, metadata?)` — new/changed signatures downstream tasks and the controller rely on.

- [ ] **Step 1: Inject AdminAuditService into AdminService**

In `src/admin/admin.service.ts` constructor, add:

```ts
constructor(
  @Inject(DRIZZLE) private readonly db: DbType,
  // ...existing injected deps...
  private readonly auditService: AdminAuditService,
) {}
```

Add the import: `import { AdminAuditService } from './admin-audit.service';`

- [ ] **Step 2: Record on `suspendUser`**

After the `users` UPDATE succeeds (right before the method's `return`), add:

```ts
await this.auditService.record({
  action: 'user.suspend',
  actorId: adminId,
  targetType: 'user',
  targetId: userId,
  targetLabel: user.email,
  reason,
  note,
});
```

- [ ] **Step 3: Thread `adminId` into `reactivateUser` and record**

Change the signature to `async reactivateUser(userId: string, adminId: string)`. After the reactivate UPDATE succeeds, add (note: `user.email` is available from the pre-update lookup already in the method):

```ts
await this.auditService.record({
  action: 'user.reactivate',
  actorId: adminId,
  targetType: 'user',
  targetId: userId,
  targetLabel: user.email,
});
```

- [ ] **Step 4: Record on `suspendWorkspace` + accept optional metadata**

Change signature to `async suspendWorkspace(workspaceId, adminId, reason, note?, metadata?: Record<string, unknown>)`. After the workspace UPDATE succeeds, add:

```ts
await this.auditService.record({
  action: 'workspace.suspend',
  actorId: adminId,
  targetType: 'workspace',
  targetId: workspaceId,
  targetLabel: ws.name,
  reason,
  note,
  metadata,
});
```

- [ ] **Step 5: Thread `adminId` + metadata into `reactivateWorkspace` and record**

Change signature to `async reactivateWorkspace(workspaceId, adminId, metadata?: Record<string, unknown>)`. After the reactivate UPDATE succeeds, add:

```ts
await this.auditService.record({
  action: 'workspace.reactivate',
  actorId: adminId,
  targetType: 'workspace',
  targetId: workspaceId,
  targetLabel: ws.name,
  metadata,
});
```

- [ ] **Step 6: Pass `{ bulk: true }` through the bulk workspace methods**

- `bulkSuspendWorkspaces(workspaceIds, adminId, reason, note?)`: inside the loop change the call to `await this.suspendWorkspace(workspaceId, adminId, reason, note, { bulk: true });`
- `bulkReactivateWorkspaces`: change signature to `async bulkReactivateWorkspaces(workspaceIds: string[], adminId: string)` and inside the loop `await this.reactivateWorkspace(workspaceId, adminId, { bulk: true });`

(No separate bulk user suspend/reactivate methods exist in the controller set covered by this plan — only workspace bulk. If a user bulk method is present, apply the same `{ bulk: true }` pattern; otherwise skip.)

- [ ] **Step 7: Update the controller call sites for the new signatures**

In `src/admin/admin.controller.ts`:

```ts
// reactivateUser
@Post('users/:userId/reactivate')
@HttpCode(HttpStatus.OK)
async reactivateUser(
  @Param('userId') userId: string,
  @CurrentUser() admin: { userId: string },
) {
  return this.adminService.reactivateUser(userId, admin.userId);
}

// reactivateWorkspace
@Post('workspaces/:workspaceId/reactivate')
@HttpCode(HttpStatus.OK)
async reactivateWorkspace(
  @Param('workspaceId') workspaceId: string,
  @CurrentUser() admin: { userId: string },
) {
  return this.adminService.reactivateWorkspace(workspaceId, admin.userId);
}

// bulkReactivateWorkspaces
@Post('workspaces/bulk/reactivate')
@HttpCode(HttpStatus.OK)
async bulkReactivateWorkspaces(
  @Body() dto: BulkIdsDto,
  @CurrentUser() admin: { userId: string },
) {
  return this.adminService.bulkReactivateWorkspaces(
    dto.workspaceIds,
    admin.userId,
  );
}
```

- [ ] **Step 8: Build to verify the wiring compiles**

Run: `npm run build`
Expected: build succeeds (no TS errors from the changed signatures).

- [ ] **Step 9: Commit**

```bash
git add src/admin/admin.service.ts src/admin/admin.controller.ts
git commit -m "feat(audit): record suspend/reactivate actions + thread adminId through reactivate"
```

---

### Task 4: Wire capture into delete actions (AdminController)

**Files:**
- Modify: `src/admin/admin.controller.ts` (`disconnectWorkspaceChannel`, `removeWorkspaceMember`, `cancelWorkspaceInvitation`)

**Interfaces:**
- Consumes: `AdminAuditService.record` (Task 2), `@CurrentUser()`.

- [ ] **Step 1: Inject AdminAuditService into the controller**

Add to the `AdminController` constructor: `private readonly auditService: AdminAuditService,` and import it.

- [ ] **Step 2: Record on channel disconnect**

Capture `@CurrentUser() admin` in the handler, then after the delegated call succeeds:

```ts
@Delete('workspaces/:workspaceId/channels/:channelId')
@HttpCode(HttpStatus.OK)
async disconnectWorkspaceChannel(
  @Param('workspaceId') workspaceId: string,
  @Param('channelId', ParseIntPipe) channelId: number,
  @CurrentUser() admin: { userId: string },
) {
  await this.channelService.deleteChannel(channelId, workspaceId);
  await this.auditService.record({
    action: 'channel.disconnect',
    actorId: admin.userId,
    targetType: 'channel',
    targetId: String(channelId),
    metadata: { workspaceId },
  });
  return { success: true, message: 'Channel disconnected' };
}
```

- [ ] **Step 3: Record on member removal**

After `membersService.removeMember(...)` succeeds:

```ts
await this.auditService.record({
  action: 'member.remove',
  actorId: admin.userId,
  targetType: 'member',
  targetId: memberId,
  metadata: { workspaceId },
});
```

- [ ] **Step 4: Record on invitation cancel**

After `membersService.cancelInvitation(...)` succeeds:

```ts
await this.auditService.record({
  action: 'invitation.cancel',
  actorId: admin.userId,
  targetType: 'invitation',
  targetId: invitationId,
  metadata: { workspaceId },
});
```

- [ ] **Step 5: Build to verify**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/admin/admin.controller.ts
git commit -m "feat(audit): record channel/member/invitation delete actions"
```

---

### Task 5: `AdminAuditService` read API (getAudit + getStats)

**Files:**
- Modify: `src/admin/admin-audit.service.ts` (add `getAudit`, `getStats`, keyset helper)
- Test: `src/admin/admin-audit.service.spec.ts` (add keyset-pagination distinctness test)

**Interfaces:**
- Produces:
  ```ts
  getAudit(opts: { action?; targetType?; actorId?; search?; since?; cursor? }):
    Promise<{ items: AdminAuditLog[]; nextCursor: string | null }>;
  getStats(): Promise<{
    total24h: number;
    total7d: number;
    byAction: { action: string; count: number }[];
    topActors: { actorId: string; actorEmail: string | null; count: number }[];
  }>;
  ```

- [ ] **Step 1: Write the failing pagination test**

`getAudit` slices `PAGE_SIZE + 1` rows: with ≤ 50 rows `nextCursor` is `null`; with 51 rows it returns the first 50 and a cursor encoding the 50th row. Test that slice-and-cursor boundary with a fake `db.select()` chain that returns a fixed ordered array (the keyset *SQL* itself is already proven in `admin-logs.service.ts`; here we only pin the service's slice/cursor logic). Add to `src/admin/admin-audit.service.spec.ts`:

```ts
function makeSelectDb(rows: any[]) {
  // Model select().from().where().orderBy().limit(n) → first n rows of `rows`.
  const chain: any = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: (n: number) => Promise.resolve(rows.slice(0, n)),
  };
  return { select: () => chain } as any;
}

describe('AdminAuditService.getAudit pagination', () => {
  const row = (i: number) => ({
    id: `id-${i}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  });

  it('returns nextCursor=null when a page is not full', async () => {
    const svc = new AdminAuditService(makeSelectDb([row(1), row(2)]));
    const res = await svc.getAudit({});
    expect(res.items).toHaveLength(2);
    expect(res.nextCursor).toBeNull();
  });

  it('returns 50 items + a cursor on the 50th row when a 51st exists', async () => {
    const rows = Array.from({ length: 51 }, (_, i) => row(i));
    const svc = new AdminAuditService(makeSelectDb(rows));
    const res = await svc.getAudit({});
    expect(res.items).toHaveLength(50);
    expect(res.nextCursor).toContain('id-49'); // 50th row (0-indexed)
    // The cursor row id must NOT be in the returned page's tail boundary re-fetch:
    expect(res.items.map((r: any) => r.id)).not.toContain('id-50');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- admin-audit.service`
Expected: FAIL — `getAudit is not a function`.

- [ ] **Step 3: Implement getAudit + getStats + keyset helper**

Add to `admin-audit.service.ts` (mirror `AdminLogsService`):

```ts
import { and, desc, eq, gte, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import { adminAuditLogs, type AdminAuditLog, type AuditAction, type AuditTargetType } from '../drizzle/schema';

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

// inside the class:
private keysetBefore(cursor?: string): SQL | undefined {
  const decoded = decodeCursor(cursor);
  if (!decoded) return undefined;
  const cursorTs = sql`${decoded.createdAt}::timestamptz`;
  const colMs = sql`date_trunc('milliseconds', ${adminAuditLogs.createdAt})`;
  return or(
    lt(colMs, cursorTs),
    and(eq(colMs, cursorTs), lt(adminAuditLogs.id, decoded.id)),
  );
}

async getAudit(opts: {
  action?: AuditAction;
  targetType?: AuditTargetType;
  actorId?: string;
  search?: string;
  since?: string;
  cursor?: string;
}): Promise<{ items: AdminAuditLog[]; nextCursor: string | null }> {
  const conditions: SQL[] = [];
  const keyset = this.keysetBefore(opts.cursor);
  if (keyset) conditions.push(keyset);
  if (opts.action) conditions.push(eq(adminAuditLogs.action, opts.action));
  if (opts.targetType) conditions.push(eq(adminAuditLogs.targetType, opts.targetType));
  if (opts.actorId) conditions.push(eq(adminAuditLogs.actorId, opts.actorId));
  if (opts.search?.trim()) {
    const term = `%${opts.search.trim()}%`;
    conditions.push(
      or(ilike(adminAuditLogs.targetLabel, term), ilike(adminAuditLogs.note, term))!,
    );
  }
  if (opts.since) conditions.push(gte(adminAuditLogs.createdAt, new Date(opts.since)));

  const rows = await this.db
    .select()
    .from(adminAuditLogs)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(adminAuditLogs.createdAt), desc(adminAuditLogs.id))
    .limit(PAGE_SIZE + 1);

  if (rows.length <= PAGE_SIZE) return { items: rows, nextCursor: null };
  const items = rows.slice(0, PAGE_SIZE);
  return { items, nextCursor: encodeCursor(items[items.length - 1]) };
}

async getStats(): Promise<{
  total24h: number;
  total7d: number;
  byAction: { action: string; count: number }[];
  topActors: { actorId: string; actorEmail: string | null; count: number }[];
}> {
  const since24h = sql`now() - interval '24 hours'`;
  const since7d = sql`now() - interval '7 days'`;
  const [total24hRows, byAction, topActors] = await Promise.all([
    this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(adminAuditLogs)
      .where(gte(adminAuditLogs.createdAt, since24h)),
    this.db
      .select({ action: adminAuditLogs.action, count: sql<number>`count(*)::int` })
      .from(adminAuditLogs)
      .where(gte(adminAuditLogs.createdAt, since7d))
      .groupBy(adminAuditLogs.action)
      .orderBy(desc(sql`count(*)`)),
    this.db
      .select({
        actorId: adminAuditLogs.actorId,
        actorEmail: adminAuditLogs.actorEmail,
        count: sql<number>`count(*)::int`,
      })
      .from(adminAuditLogs)
      .where(gte(adminAuditLogs.createdAt, since7d))
      .groupBy(adminAuditLogs.actorId, adminAuditLogs.actorEmail)
      .orderBy(desc(sql`count(*)`))
      .limit(8),
  ]);
  const total7d = byAction.reduce((s, r) => s + r.count, 0);
  return {
    total24h: total24hRows[0]?.count ?? 0,
    total7d,
    byAction,
    topActors,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- admin-audit.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/admin/admin-audit.service.ts src/admin/admin-audit.service.spec.ts
git commit -m "feat(audit): getAudit (keyset) + getStats read API"
```

---

### Task 6: Audit read endpoints (AdminController)

**Files:**
- Modify: `src/admin/admin.controller.ts` (add `GET /admin/audit`, `GET /admin/audit/stats`)

**Interfaces:**
- Consumes: `AdminAuditService.getAudit`, `AdminAuditService.getStats`.

- [ ] **Step 1: Add the endpoints**

```ts
@Get('audit')
@HttpCode(HttpStatus.OK)
async getAudit(
  @Query('action') action?: AuditAction,
  @Query('targetType') targetType?: AuditTargetType,
  @Query('actorId') actorId?: string,
  @Query('search') search?: string,
  @Query('since') since?: string,
  @Query('cursor') cursor?: string,
) {
  return this.auditService.getAudit({
    action,
    targetType,
    actorId,
    search,
    since,
    cursor,
  });
}

@Get('audit/stats')
@HttpCode(HttpStatus.OK)
async getAuditStats() {
  return this.auditService.getStats();
}
```

Import the `AuditAction` / `AuditTargetType` types from `../drizzle/schema`.

- [ ] **Step 2: Build to verify**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/admin/admin.controller.ts
git commit -m "feat(audit): GET /admin/audit + /admin/audit/stats endpoints"
```

---

### Task 7: Retention cron

**Files:**
- Create: `src/admin/admin-audit-retention.service.ts`
- Modify: `src/admin/admin.module.ts` (register provider)

**Interfaces:**
- Consumes: `DRIZZLE`, `adminAuditLogs`.

- [ ] **Step 1: Write the retention service**

```ts
// src/admin/admin-audit-retention.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { lt, sql } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { adminAuditLogs } from '../drizzle/schema';

const RETENTION_DAYS = 365;

@Injectable()
export class AdminAuditRetentionService {
  private readonly logger = new Logger(AdminAuditRetentionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  // 3:30 AM, offset from the error-logs 3 AM purge so the two don't collide.
  @Cron('30 3 * * *')
  async purgeOld(): Promise<void> {
    try {
      const cutoff = sql`now() - interval '${sql.raw(String(RETENTION_DAYS))} days'`;
      await this.db.delete(adminAuditLogs).where(lt(adminAuditLogs.createdAt, cutoff));
    } catch (err) {
      this.logger.warn(
        `Audit retention purge failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
```

- [ ] **Step 2: Register in the module**

Add `AdminAuditRetentionService` to `providers` in `src/admin/admin.module.ts` (import it). No export needed.

- [ ] **Step 3: Build to verify**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/admin/admin-audit-retention.service.ts src/admin/admin.module.ts
git commit -m "feat(audit): daily retention purge (365-day window)"
```

---

### Task 8: Backend live verification (:8010)

**Files:** none (verification only).

- [ ] **Step 1: Boot the backend on 8010**

Run (background): `PORT=8010 node dist/src/main.js` after `npm run build`. Wait for boot (~30-70s; Redis retry storm is expected when Redis is down).

- [ ] **Step 2: Get an admin access token**

Use the super-admin OTP flow: `POST /auth/admin/challenge {email:'asadmanzoor135@gmail.com'}` → read OTP from the dev console (`Admin login code for ...: NNNNNN`) → `POST /auth/admin/verify {email, otp}` → `{challengeToken}` → `POST /auth/login {email:'asadmanzoor135@gmail.com', password:'Test1234!', challengeToken}` → `{accessToken}`. (Challenge is rate-limited 1/min.)

- [ ] **Step 3: Exercise the capture path + assert rows**

- Suspend a non-admin test user via `POST /admin/users/:id/suspend {reason, note}` → then `GET /admin/audit?action=user.suspend` shows a row with the reason/note + `actor_email` set.
- Reactivate the same user → `GET /admin/audit?action=user.reactivate` shows a second row; separately confirm the user's `suspended_reason`/`suspended_by_id` are now NULL in the DB (audit history survives the NULLing — the core point of the feature).
- Suspend + reactivate a test workspace → two workspace rows.
- Run a bulk workspace reactivate over 2 ids → 2 rows each with `metadata.bulk = true`.
- Verify `GET /admin/audit` filters (`action`, `targetType`, `actorId`, `search`, `since`) and `GET /admin/audit/stats` (total24h/total7d/byAction/topActors) return correct shapes.

- [ ] **Step 4: Verify keyset pagination has no boundary duplicate**

Insert >50 rows (repeat a suspend/reactivate cycle, or seed via SQL with distinct `created_at`), then walk `GET /admin/audit` page-by-page following `nextCursor` and assert the union of all page item ids is fully distinct (0 dups). This is the tz/precision trap check — `created_at` is timestamptz so the `::timestamptz` cast is correct.

- [ ] **Step 5: Record findings**

Note pass/fail for each check in the branch's verification notes. If any check fails, use systematic-debugging before proceeding — do not patch blindly.

---

### Task 9: Frontend — types, api, hooks

**Files:**
- Create: `src/features/security/types/audit.ts`
- Create: `src/features/security/api/audit.api.ts`
- Create: `src/features/security/hooks/use-audit.ts`

**Interfaces:**
- Produces: `AuditAction`, `AuditTargetType`, `AuditLog`, `AuditResponse`, `AuditStats`, `AuditFilters` types; `getAudit(filters, cursor)`, `getAuditStats()`; `useAudit(filters)`, `useAuditStats()`, `auditKeys`.

- [ ] **Step 1: Write the types**

```ts
// src/features/security/types/audit.ts
export type AuditAction =
  | 'user.suspend'
  | 'user.reactivate'
  | 'workspace.suspend'
  | 'workspace.reactivate'
  | 'channel.disconnect'
  | 'member.remove'
  | 'invitation.cancel'

export type AuditTargetType =
  | 'user'
  | 'workspace'
  | 'channel'
  | 'member'
  | 'invitation'

export interface AuditLog {
  id: string
  action: AuditAction
  actorId: string
  actorEmail: string | null
  targetType: AuditTargetType
  targetId: string
  targetLabel: string | null
  reason: string | null
  note: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

export interface AuditResponse {
  items: AuditLog[]
  nextCursor: string | null
}

export interface AuditStats {
  total24h: number
  total7d: number
  byAction: { action: string; count: number }[]
  topActors: { actorId: string; actorEmail: string | null; count: number }[]
}

export interface AuditFilters {
  action?: AuditAction
  targetType?: AuditTargetType
  actorId?: string
  search?: string
}
```

- [ ] **Step 2: Write the api wrappers**

```ts
// src/features/security/api/audit.api.ts
import { apiClient } from '@/lib/api'
import type { AuditFilters, AuditResponse, AuditStats } from '../types/audit'

export function getAudit(filters: AuditFilters, cursor?: string) {
  const q = new URLSearchParams()
  if (filters.action) q.set('action', filters.action)
  if (filters.targetType) q.set('targetType', filters.targetType)
  if (filters.actorId) q.set('actorId', filters.actorId)
  if (filters.search) q.set('search', filters.search)
  if (cursor) q.set('cursor', cursor)
  const qs = q.toString()
  return apiClient.get<AuditResponse>(`/admin/audit${qs ? `?${qs}` : ''}`)
}

export function getAuditStats() {
  return apiClient.get<AuditStats>('/admin/audit/stats')
}
```

- [ ] **Step 3: Write the hooks**

```ts
// src/features/security/hooks/use-audit.ts
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { getAudit, getAuditStats } from '../api/audit.api'
import type { AuditFilters } from '../types/audit'

export const auditKeys = {
  all: ['admin', 'audit'] as const,
  list: (f: AuditFilters) => [...auditKeys.all, 'list', f] as const,
  stats: () => [...auditKeys.all, 'stats'] as const,
}

export function useAudit(filters: AuditFilters) {
  return useInfiniteQuery({
    queryKey: auditKeys.list(filters),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      getAudit(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 30_000,
  })
}

export function useAuditStats() {
  return useQuery({
    queryKey: auditKeys.stats(),
    queryFn: getAuditStats,
    refetchInterval: 30_000,
  })
}
```

- [ ] **Step 4: Build to verify**

Run: `npm run build`
Expected: build succeeds (types/api/hooks compile; no consumers yet).

- [ ] **Step 5: Commit**

```bash
git add src/features/security/types/audit.ts src/features/security/api/audit.api.ts src/features/security/hooks/use-audit.ts
git commit -m "feat(security): audit types, api, hooks"
```

---

### Task 10: Frontend — live Audit tab

**Files:**
- Modify: `src/features/security/components/audit-tab.tsx` (rewrite live)
- Modify: `src/features/security/pages/security-page.tsx` (`bodyScroll={false}` → `bodyScroll`)

**Interfaces:**
- Consumes: `useAudit`, `useAuditStats`, `AuditLog`, `AuditAction`, `AuditTargetType`.

- [ ] **Step 1: Rewrite `audit-tab.tsx` as the live tab**

Mirror `src/features/logs/components/errors-tab.tsx` structure exactly: a `StatGrid` (24h total, 7d total, busiest action, top actor), a filter row (debounced search `Input` + action filter buttons/select + target-type filter), a document-flow row list inside `divide-y rounded-lg border`, an IntersectionObserver sentinel, and a self-contained `AuditDetailSheet` (Sheet + DetailList + note/metadata block). Reuse the local `useDebounced` and `useInfiniteScroll` helpers from the errors-tab (copy them in). Row shows: actor email → human-readable action label → target label (or target id), with a `StatusDot` toned by action family (suspend/disconnect/remove/cancel = warning or danger; reactivate = success) and a relative timestamp. Action-label map:

```ts
const ACTION_LABEL: Record<AuditAction, string> = {
  'user.suspend': 'Suspended user',
  'user.reactivate': 'Reactivated user',
  'workspace.suspend': 'Suspended workspace',
  'workspace.reactivate': 'Reactivated workspace',
  'channel.disconnect': 'Disconnected channel',
  'member.remove': 'Removed member',
  'invitation.cancel': 'Cancelled invitation',
}
const ACTION_TONE: Record<AuditAction, 'danger' | 'warning' | 'success'> = {
  'user.suspend': 'danger',
  'user.reactivate': 'success',
  'workspace.suspend': 'danger',
  'workspace.reactivate': 'success',
  'channel.disconnect': 'warning',
  'member.remove': 'warning',
  'invitation.cancel': 'warning',
}
```

Loading (skeletons), empty ("No admin actions recorded yet"), and error (retry) states match the errors-tab. The detail sheet lists: actor email, action (label), target type + label + id, reason, note, metadata (pretty JSON if non-empty), full timestamp.

- [ ] **Step 2: Switch the page to document-flow scroll**

In `src/features/security/pages/security-page.tsx` change `bodyScroll={false}` to `bodyScroll` (the audit tab now scrolls the document like the Logs page; Sessions/Compliance notes render fine).

- [ ] **Step 3: Build to verify**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/features/security/components/audit-tab.tsx src/features/security/pages/security-page.tsx
git commit -m "feat(security): live Audit tab (stats, filters, detail sheet, infinite scroll)"
```

---

### Task 11: Frontend — honest notes for Sessions + Compliance

**Files:**
- Modify: `src/features/security/components/sessions-tab.tsx` (rewrite to a single honest note)
- Modify: `src/features/security/components/compliance-tab.tsx` (rewrite to a single honest note)
- Delete: any mock file these tabs imported (e.g. `src/lib/mock/security.ts` if present and now unused)

**Interfaces:** none consumed.

- [ ] **Step 1: Rewrite `sessions-tab.tsx`**

```tsx
import { SectionNote } from '@/components/shared/section-note'

export function SessionsTab() {
  return (
    <div className="flex flex-col gap-4">
      <SectionNote status="no-data">
        Active sessions aren't tracked — there's no session or token store to
        list who is currently signed in, from where, or on what device.
        Building this needs a session table the auth layer writes to on login
        and clears on logout/expiry. It's Phase 2.
      </SectionNote>
    </div>
  )
}
```

- [ ] **Step 2: Rewrite `compliance-tab.tsx`**

```tsx
import { SectionNote } from '@/components/shared/section-note'

export function ComplianceTab() {
  return (
    <div className="flex flex-col gap-4">
      <SectionNote status="no-data">
        There's no compliance data to show yet — data-subject requests,
        retention audits and export/erasure records aren't tracked in one
        place. A real compliance view needs those events recorded as they
        happen; that's Phase 2. The Audit tab is the live half of this module.
      </SectionNote>
    </div>
  )
}
```

- [ ] **Step 3: Remove any now-orphaned mock import**

If `sessions-tab`/`compliance-tab` previously imported a mock module (grep for the old import), delete the mock file if nothing else references it. Run: `npx tsc --noEmit` (or `npm run build`) to confirm no dangling imports.

- [ ] **Step 4: Build to verify**

Run: `npm run build`
Expected: build succeeds, no unused-import or missing-module errors.

- [ ] **Step 5: Commit**

```bash
git add src/features/security/components/sessions-tab.tsx src/features/security/components/compliance-tab.tsx
git commit -m "feat(security): honest Phase-2 notes for Sessions + Compliance"
```

---

### Task 12: End-to-end verification + handoff

**Files:** none (verification only).

- [ ] **Step 1: Backend green**

Run: `npm run build` (backend) and `npm test -- admin-audit.service`. Expected: build succeeds, unit tests pass.

- [ ] **Step 2: Frontend green**

Run: `npm run build` (frontend). Expected: succeeds.

- [ ] **Step 3: Browser check**

Boot FE dev on 3003 against `VITE_API_URL=http://localhost:8010`, log in as `asadmanzoor135@gmail.com` / `Test1234!` (OTP from dev console), open **Security → Audit**: real rows render newest-first; action + target-type filters and search work; a row opens the detail sheet with reason/note/metadata; scrolling past 50 rows loads more. Sessions + Compliance show honest notes.

- [ ] **Step 4: Clean up local test rows**

Delete any suspend/reactivate/bulk test rows created during verification:

```bash
"/c/Program Files/PostgreSQL/17/bin/psql.exe" "postgresql://postgres:postgres@localhost:5432/schedura" -c "DELETE FROM admin_audit_logs;"
```

(Also reactivate any test user/workspace left suspended.)

- [ ] **Step 5: Ask before pushing/merging (standing rule)**

Do NOT push or merge. Present the module for the user's browser review and wait for explicit go-ahead. Merge order when approved: **backend first** (FE depends on `/admin/audit`), then frontend; `gh` multi-account (`Asad00713` backend / `asad00712` frontend, switch before each gh op). Remind the user of the deploy note below.

- [ ] **Step 6: Deploy note (for when the user deploys)**

On prod, create `admin_audit_logs` + its 4 indexes via the Task 1 Step 3 DDL in the Railway console — no generated migration (migration-drift rule).
