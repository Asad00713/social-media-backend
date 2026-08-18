# Admin Audit Log — Design Spec

**Date:** 2026-08-17
**Status:** Approved for planning
**Module:** Security (schedura-admin) → Audit tab live
**Repos:** `socialmedia-workspace-otp` (backend), `schedura-admin` (frontend)

## Goal

An append-only record of **who did what admin action, when, and to whom**. It must survive later state changes — today, reactivating a suspended user or workspace NULLs out `suspendedById` / `suspendedReason` / `suspensionNote`, erasing all trace of who suspended it and why. The audit log fixes that gap and makes admin accountability reconstructable after the fact.

## Scope

**In scope — captured actions (super-admin only):**

- `user.suspend`, `user.reactivate`
- `workspace.suspend`, `workspace.reactivate`
- Bulk suspend / reactivate (user + workspace) → **one row per target**
- `channel.disconnect` (admin channel delete)
- `member.remove`
- `invitation.cancel`

**Out of scope (this phase):**

- Read actions (viewing users/workspaces) — not audit-worthy, high noise.
- Sessions tab — no session/token tracking table exists → honest no-data note.
- Compliance tab — no compliance data source → honest no-data note.
- Member role changes (`member.role_change`) — deferred; can be added later with the same `record()` call.

## Non-goals / decisions locked

- **Retention: 1 year.** Audit trails matter for accountability far longer than error logs (30 days). Daily cron purges rows older than 365 days. (Reviewable — could be "keep forever" given low volume; 1 year is the chosen default.)
- **Bulk actions: one row per target**, not a single summary row. Better auditability — each affected user/workspace is individually traceable. `metadata.bulk = true` marks them as part of a bulk operation.
- **Explicit capture in service/controller layer**, not an interceptor — gives rich before/after context (target label, reason, note) that raw controller params can't provide.
- **No FKs** on `actor_id` / `target_id` — matches the `error_logs` convention; the log is a standalone record that must survive deletion of the referenced rows. Actor email + target label are **denormalized snapshots** taken at action time so the row stays readable even if the actor or target is later deleted.

## Architecture

### 1. Data — `admin_audit_logs` table

New Drizzle schema `src/drizzle/schema/admin-audit-logs.schema.ts`. Append-only: rows are only ever inserted, and deleted only by the retention cron.

| column | type | notes |
|---|---|---|
| `id` | uuid pk defaultRandom | |
| `action` | varchar(40) `$type<AuditAction>` | one of the AUDIT_ACTIONS enum |
| `actor_id` | uuid (no FK) | acting super-admin's user id |
| `actor_email` | varchar(255) | denormalized snapshot of the actor's email |
| `target_type` | varchar(20) `$type<AuditTargetType>` | `user` / `workspace` / `channel` / `member` / `invitation` |
| `target_id` | varchar(64) | uuid or numeric id, stored as text |
| `target_label` | varchar(255) null | email / workspace name — snapshot at action time |
| `reason` | varchar(40) null | suspension reason enum value (suspend actions only) |
| `note` | text null | admin's free-text note |
| `metadata` | jsonb default `{}` | e.g. `{ bulk: true }`, `{ platform: 'youtube' }` |
| `created_at` | timestamptz defaultNow | |

**Indexes:**

- `admin_audit_created_idx` on `(created_at desc)`
- `admin_audit_action_created_idx` on `(action, created_at desc)`
- `admin_audit_actor_created_idx` on `(actor_id, created_at desc)`
- `admin_audit_target_idx` on `(target_type, target_id)`

**Exports:**

```ts
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

export type AdminAuditLog = typeof adminAuditLogs.$inferSelect;
```

Add `export * from './admin-audit-logs.schema';` to `src/drizzle/schema/index.ts`.

### 2. Capture — `AdminAuditService.record(entry)`

New service `src/admin/admin-audit.service.ts` (lives in the admin module, injected into `AdminService` and `AdminController`).

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

async record(entry: AuditRecordEntry): Promise<void>
```

**Behavior:**

- Called **after** the underlying mutation has succeeded (never before — a failed action must not leave an audit row).
- Resolves `actor_email` from `users` by `actorId` (single lookup; if the actor row is somehow missing, store `null` — never throw).
- Wrapped internally in try/catch: an audit write failure logs a `warn` (which lands in `error_logs` — closing the loop with the Logs module) but never rolls back or fails the action the admin just performed.
- Truncates `note` to a safe length (5000 chars) and `target_label` to 255.

**Where each action calls `record()`:**

- **Suspend / reactivate (individual + bulk)** — inside `AdminService`. These methods own the mutation directly, so they write inline after the DB update.
  - `reactivateUser` / `reactivateWorkspace` currently take **no adminId** — thread `adminId` through from the controller (`@CurrentUser()`), including the bulk reactivate variants.
- **channel.disconnect / member.remove / invitation.cancel** — these delegate to customer-facing services (`channelService.deleteChannel`, `membersService.removeMember`, `membersService.cancelInvitation`) that also serve non-admin callers. To keep customer code clean and fire only on the admin path, capture in the **`AdminController`** after the delegated call returns. The controller reads `@CurrentUser()` for the actor and has the target ids from the route params; it fetches the target label (channel/member/invitation) as needed before/after the call.

### 3. Read API — `AdminAuditService` + `AdminController`

- `GET /admin/audit`
  - Query: `action?`, `targetType?`, `actorId?`, `search?` (matches `target_label` or `note`, case-insensitive), `since?` (ISO date), `cursor?`.
  - Keyset pagination, PAGE_SIZE = 50, ordered `created_at desc, id desc`. `created_at` is `timestamptz`, so the cursor casts `::timestamptz` with `date_trunc('milliseconds', ...)` — reuse the tz/precision-safe pattern proven in `admin-logs.service.ts` / `admin-activity.service.ts`.
  - Returns `{ items: AdminAuditLog[], nextCursor: string | null }`.
- `GET /admin/audit/stats`
  - Returns `{ total24h, total7d, byAction: { action, count }[], topActors: { actorId, actorEmail, count }[] (top 8, last 7d) }`.

Both endpoints under the existing admin controller guards (`JwtAuthGuard + SuperAdminGuard + @SkipSuspendCheck()`).

Register `AdminAuditService` in `admin.module.ts` providers.

### 4. Frontend — Security module (`schedura-admin`)

Feature folder `src/features/security/` gains `types/`, `api/`, `hooks/` (mirroring the Logs module structure).

- **Audit tab (live)** — `src/features/security/components/audit-tab.tsx`:
  - Stat grid: 24h total, 7d total, busiest action, top actor.
  - Filters: action filter (all + each AUDIT_ACTION), target-type filter, debounced search.
  - Row list: actor email → human-readable action → target label, with relative timestamp; newest first.
  - Detail sheet: actor, action, target (type + label + id), reason, note, metadata, full timestamp.
  - Infinite scroll (`useInfiniteQuery` + IntersectionObserver, `rootMargin: 400px`), 30s refetch.
  - Loading / empty / error states (matching the Logs Errors tab).
- **Sessions tab** — single `SectionNote status="no-data"`: no active-session / token tracking exists; a real view needs a session store. Phase 2.
- **Compliance tab** — single `SectionNote status="no-data"`: no compliance data source (data-subject requests, retention audits) is tracked yet. Phase 2.
- `security-page.tsx` — switch the page to `bodyScroll` (currently `bodyScroll={false}`) and let the Audit tab render a document-flow row list with an IntersectionObserver sentinel, exactly like the Logs page ended on (`logs-page.tsx` uses `bodyScroll` + document-flow list, not a fill table). The Sessions/Compliance notes render fine under `bodyScroll` too.

### 5. Retention — `AdminAuditRetentionService`

New service `src/admin/admin-audit-retention.service.ts` (or fold into the existing logs retention if co-located cleanly — but audit has a different window, so a separate `@Cron` method is clearer).

- `@Cron(CronExpression.EVERY_DAY_AT_3AM)` (or 3:30AM to not collide with the error-logs 3AM purge) `purgeOld()` deletes rows older than 365 days.

## Data flow

```
Super-admin clicks "Suspend user" in schedura-admin
  → POST /admin/users/:id/suspend  (AdminController, @CurrentUser → adminId)
  → AdminService.suspendUser(userId, adminId, reason, note)
      → UPDATE users SET is_active=false, suspended... (existing)
      → AdminAuditService.record({ action:'user.suspend', actorId:adminId,
          targetType:'user', targetId:userId, targetLabel:user.email,
          reason, note })  ← NEW, after the update
  → row appears in GET /admin/audit
  → Security → Audit tab (live) shows it, newest first
```

Reactivate follows the same path but the audit row is the **only** surviving record of the original suspension's who/why once the user row's suspend fields are NULLed.

## Error handling

- Audit write failure → `warn` logged (surfaces in Logs module), action still succeeds. Never rolls back.
- Missing actor email → store `null`, don't throw.
- `GET /admin/audit` on empty table → `{ items: [], nextCursor: null }`; FE shows an honest empty state ("No admin actions recorded yet").
- Keyset cursor uses the tz/precision-safe cast to avoid boundary-row duplicates (known trap — `admin_audit_logs.created_at` is timestamptz, cast `::timestamptz`).

## Testing

- **Unit (BE):** `AdminAuditService.record` inserts the expected row shape; resolves actor email; swallows a DB failure without throwing. Keyset pagination returns distinct rows across pages (no boundary dup) — walk a >PAGE_SIZE set and assert all-distinct ids.
- **Integration (BE, manual/live on :8010):** suspend a user → audit row present with reason/note; reactivate → second row present AND user's suspend fields NULLed but audit history intact; bulk suspend N → N rows with `metadata.bulk=true`; channel disconnect / member remove / invitation cancel each produce a row. `GET /admin/audit` filters (action/targetType/actorId/search/since) and stats correct.
- **FE:** `npm run build` green; Audit tab renders real rows, filters + search + detail sheet + infinite scroll work; Sessions/Compliance show honest notes.

## Deploy note

On prod, create `admin_audit_logs` + its 4 indexes via `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` in the Railway console — **no generated migration** (migration-drift rule). The exact DDL will be in the implementation plan.

## Migration-drift rule

Apply the table locally (and later on prod) via `CREATE TABLE IF NOT EXISTS` — never run a generated Drizzle migration.
