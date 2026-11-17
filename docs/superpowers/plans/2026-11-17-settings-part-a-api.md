# Settings redesign, Part A (backend API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship every backend contract the Part A settings screens need (capabilities, account, preferences, notifications pause, Google disconnect, workspaces list and leave, General, Members and invite link, Labels, Plan & billing on Lemon Squeezy, and the safe account delete) so the Part A frontend PR can build against stable, tested endpoints.

**Architecture:** NestJS feature modules on Drizzle/Postgres. Four hand-written migrations (0088 users, 0089 workspace, 0090 labels, 0091 FK fix) land first, then endpoints in the order the FE plan consumes them. Every workspace write is gated by `@RequireCapability` through the existing `WorkspaceRoleGuard`; caller-scoped routes live under `users/me`. Labels move to a catalogue plus a `post_labels` join table, and the composer keeps its name-based contract.

**Tech Stack:** NestJS 11, Drizzle ORM (node-postgres), Postgres, BullMQ, class-validator, Jest 30 (`*.spec.ts`, `*.db.spec.ts` on the rollback harness), Lemon Squeezy REST (JSON:API), Stripe SDK (existing).

**Spec:** `docs/superpowers/specs/2026-11-17-settings-redesign-design.md` (Part A = §4, §5, §6, §9 rows 0088–0091, §10, §11, §12–§14). Supporting research: session scratchpad `settings-research/be-gaps.md`.

**Repo for every path below:** `D:\My Documents\MyProjects\FullStackProjects\socialmedia-workspace-settings` (branch `feat/settings-account-api`, base `origin/main` f71a010). Paths are relative to that root.

## Global Constraints

- Migrations are numbered from **0088** upward, in `drizzle/migrations/`, hand-written SQL with the matching Drizzle schema change in the same commit. The boot migrator (`src/drizzle/migrate/runner.ts`) applies files by filename and tracks name + checksum: **never edit a committed migration**; a later change is a new file. If another branch lands a migration first, renumber at rebase.
- Every migration that ALTERs `users`, `workspace` or `posts`, or adds a FK to them, starts with `SET LOCAL lock_timeout = '10s';` as its first statement and is added to `FILES` in `src/drizzle/migrate/inbox-lock-timeout.spec.ts` (that spec asserts the exact string `'10s'`). No `BEGIN`/`COMMIT`, no `CONCURRENTLY` (the runner wraps each file in one transaction). Idempotent where practical (`IF NOT EXISTS`, `duplicate_object` guards). Header comment in the style of `0080_member_soft_removal.sql` (WHY / SAFETY / ROLLBACK / "never edit").
- DB specs (`*.db.spec.ts`) use `describeDb` + `withRollbackDb([...migrations], fn)` from `src/planner/testing/rollback-db.ts` and run **only against the localhost Postgres** in the backend `.env` (the harness refuses any other host). Run them with `PLANNER_DB_TESTS=1 npx jest <file> --runInBand`. Local runs that boot Nest need Redis on 6379.
- BullMQ job ids never contain `:`.
- Prettier: single quotes, trailing commas. Preserve CRLF in files that use CRLF (most of `src/` and every migration); new files match their neighbours (CRLF).
- **No new dependencies in Part A.** Never install anything.
- Never call prod or live services (no Railway, no live Lemon Squeezy, no live Stripe). Provider HTTP is mocked in tests (`global.fetch` stub, as `lemonsqueezy.client.spec.ts` does).
- Never create or edit `.env`.
- Never `git stash`, `git push` or merge. Commit per task.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Capabilities are enforced server-side through `CAPABILITY_MIN_ROLE` (`src/workspace-members/role-capabilities.ts`) + `@RequireCapability` + `WorkspaceRoleGuard`. The guard resolves the workspace from the `workspaceId`, `wsId` or `wid` route param only.
- Error bodies with a machine code use the existing shape `{ statusCode, error, code, message }` (see `memberConflict` in `workspace-members.service.ts`).
- Each task ends green on: `npm run build` and every jest spec the task touched (plus `src/workspace-members/every-workspace-route-guarded.spec.ts`, `open-routes.spec.ts` and `remaining-workspace-guards.spec.ts` whenever a controller changed). Typecheck covers spec files (`npm run build` alone does not; run `npx tsc --noEmit -p tsconfig.json` when a task edits specs).
- Spec values that are copied verbatim: capability levels (§4.2), preference enums and defaults (§5.4), pause limit 30 days, invite code format (§5.7), label palette and lengths (§5.9), throttles (`google/disconnect` 5/h per user, `DELETE /users/me` 3/h per user, resend 10/h per workspace).

## Review Focus

1. **`Intl.supportedValuesOf('timeZone')` does not list `UTC` on every Node build**, yet every existing workspace stores `'UTC'`. A reasonable person expects saving General or Preferences with zone `UTC` to work. Pinned in Task 7 (`isIanaTimeZone('UTC') === true`).
2. **Resending an EXPIRED invitation turns it back into a seat reservation.** A person expects "Resend" not to push the workspace over its seat limit. Pinned in Task 17 (resend of an expired invite with zero free seats → `403 SEAT_LIMIT_EXCEEDED`, row unchanged).
3. **Route shadowing by `:id` params**: `DELETE /users/me` against `DELETE /users/:id`, and `DELETE /workspace-members/:ws/members/me` against `…/members/:memberId`. A person expects "Leave" and "Delete account" to hit the new handlers, not a 403/404 from the old ones. Pinned in Task 10 and Task 21 (controller order specs).
4. **A label renamed or merged while a composer save is in flight**, and a composer save naming a label deleted 2 seconds ago. A person expects the post to keep its labels and the name to resolve to the live label (or recreate it). Pinned in Task 12 (`setForPost` with a soft-deleted name recreates it; never touches `metadata`).
5. **Pausing then a security event / failed post arriving**: the person expects "Mutes everything except failed posts and security alerts" to hold on both email and in-app. Pinned in Task 8 (paused user still gets `post_failed` and `security_alert` on `app`).

---

## File map

| Area | Create | Modify |
|---|---|---|
| Capabilities | `src/workspace-members/settings-routes-capabilities.spec.ts` | `src/workspace-members/role-capabilities.ts`, `role-capabilities.spec.ts` |
| Migrations | `drizzle/migrations/0088_user_account_settings.sql`, `0089_workspace_settings.sql`, `0090_workspace_labels.sql`, `0091_users_fk_set_null.sql`, `src/drizzle/migrate/settings-migrations.db.spec.ts`, `src/drizzle/schema/labels.schema.ts` | `src/drizzle/schema/users.schema.ts`, `workspace.schema.ts`, `workspace-invitation.schema.ts`, `billing.schema.ts`, `drips.schema.ts`, `canva.schema.ts`, `index.ts`, `src/drizzle/migrate/inbox-lock-timeout.spec.ts` |
| Account | `src/users/account-settings.controller.ts`, `src/users/preferences/user-preferences.ts`, `user-preferences.service.ts`, `dto/update-preferences.dto.ts`, `src/users/my-workspaces.service.ts`, `src/users/account-deletion.service.ts`, `src/users/dto/delete-account.dto.ts`, `src/users/dto/disconnect-google.dto.ts`, `src/common/validators/is-iana-time-zone.ts`, `src/email/templates/security/sign-in-method-changed.tsx` | `src/users/users.service.ts`, `users.controller.ts`, `users.module.ts`, `account-security.service.ts`, `account-security.controller.ts`, `dto/update-user.dto.ts`, `dto/change-password.dto.ts`, `src/notifications/recipients.service.ts`, `src/auth/strategies/jwt.strategy.ts`, `jwt-refresh.strategy.ts`, `src/drizzle/schema/admin-audit-logs.schema.ts` |
| Notifications | `src/notification-preferences/notification-pause.controller.ts`, `notification-pause.service.ts`, `dto/set-pause.dto.ts` | `notification-preferences.service.ts`, `notification-preferences.repository.ts`, `notification-preferences.module.ts` |
| General | `src/workspace/dto/presign-logo.dto.ts`, `src/workspace/dto/delete-workspace.dto.ts`, `src/workspace/workspace-timezone-move.service.ts`, `src/posts/services/post-reschedule.service.ts`, `src/common/utils/wall-clock.ts`, `src/posts/composer/services/approval-policy.service.ts` | `src/workspace/workspace.controller.ts`, `workspace.service.ts`, `workspace.module.ts`, `dto/update-workspace.dto.ts`, `src/media/cloudflare-r2.service.ts`, `src/campaigns/campaign-schedule.util.ts`, `src/posts/lib/draft-approval.ts`, `src/posts/composer/services/draft-store.service.ts`, `draft-approval.service.ts`, `composer-scheduling.service.ts`, `publish-orchestrator.service.ts`, `src/billing/services/subscription.service.ts` |
| Members | `src/workspace-members/invite-link.service.ts`, `join-link.controller.ts`, `dto/invite-link.dto.ts` | `workspace-members.controller.ts`, `workspace-members.service.ts`, `workspace-members.module.ts`, `open-workspace-routes.ts`, `dto/batch-invite.dto.ts`, `src/email/templates/team/workspace-invitation.tsx` |
| Labels | `src/labels/labels.module.ts`, `labels.controller.ts`, `labels.service.ts`, `post-labels.service.ts`, `dto/label.dto.ts`, `labels.service.db.spec.ts`, `post-labels.service.db.spec.ts` | `src/app.module.ts`, `src/posts/composer/lib/draft-organise.ts`, `composer.controller.ts`, `draft-store.service.ts`, `composer-scheduling.service.ts`, `publish-orchestrator.service.ts`, `src/planner/dto/planner-list.dto.ts`, `src/planner/services/planner-list.service.ts`, `src/posts/services/planner-posts.service.ts`, `src/posts/dto/planner-post.dto.ts` |
| Billing | `src/billing/services/billing-overview.service.ts`, `src/billing/dto/portal-link.dto.ts` | `src/billing/providers/payment-provider.interface.ts`, `lemonsqueezy.adapter.ts`, `stripe.adapter.ts`, `src/billing/billing.controller.ts`, `billing.module.ts`, `dto/billing.dto.ts`, `src/workspace-members/remaining-workspace-guards.spec.ts` |

Builder calls recorded by this plan (spec §13):
- #4 `composerDefaultWhen` default = `'draft'` (FE `when-menu.tsx`: "`null` means keep as a draft").
- #3 Google-disconnect email = new security template `sign-in-method-changed` (no existing A-group template fits; `password-changed` copy names a password).
- #8 Time-zone move goes to a BullMQ job above **500** scheduled posts (job id `tz-move-{workspaceId}`).
- #9 Workspace delete removes delayed publish jobs (`composer-publish-{postId}` and each `posts.job_id`) before the row delete. The processor already no-ops on a missing post (`post-publish.processor.ts:47-51`), so this is belt and braces.
- #10 Logo orphans: same as avatars (`users.service.ts` `setAvatar`): the old R2 object is not deleted.
- #14 `graceUntil` = first unresolved `failed` row in `billing_payment_alerts` for the owner (after the latest `recovered`) + **7 days**, the existing `GRACE_PERIOD_DAYS` in `src/billing/services/webhook.service.ts:40` (exported as `PAYMENT_GRACE_DAYS`).
- #16 Label purge runs lazily at the start of every label write (`purgeExpired(workspaceId)`), no cron, no queue.
- #17 Personal-table classification: Task 21's table.

---

### Task 1: Settings capabilities

**Files:**
- Modify: `src/workspace-members/role-capabilities.ts`
- Modify: `src/workspace-members/role-capabilities.spec.ts`

**Interfaces:**
- Produces: `Capability` gains `'settings:view' | 'workspace:manage' | 'labels:manage'`; `CAPABILITY_MIN_ROLE['settings:view'] = 'MEMBER'`, `['workspace:manage'] = 'ADMIN'`, `['labels:manage'] = 'MEMBER'`. The FE mirror (`features/team/utils/capabilities.ts`) copies these three rows.

- [ ] **Step 1: Write the failing test** in `role-capabilities.spec.ts`

```ts
describe('settings capabilities (spec §4.2)', () => {
  it.each([
    ['settings:view', 'GUEST', false], ['settings:view', 'MEMBER', true],
    ['workspace:manage', 'MEMBER', false], ['workspace:manage', 'ADMIN', true],
    ['labels:manage', 'GUEST', false], ['labels:manage', 'MEMBER', true],
    ['billing:manage', 'ADMIN', false], ['workspace:delete', 'ADMIN', false],
  ] as const)('%s for %s is %s', (cap, role, ok) => {
    expect(roleCan(role, cap)).toBe(ok);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**
Run: `npx jest src/workspace-members/role-capabilities.spec.ts`
Expected: FAIL (type error / `undefined` rank for the new capabilities).

- [ ] **Step 3: Add the three capabilities** to the `Capability` union (each with a one-line doc comment naming its use from §4.2) and to `CAPABILITY_MIN_ROLE`.

- [ ] **Step 4: Run tests and build**
Run: `npx jest src/workspace-members src/maestro/tools && npm run build`
Expected: PASS (the `Record<Capability, …>` map in `maestro/tools/capability-gate.ts` is keyed by string, so nothing else needs a row).

- [ ] **Step 5: Commit** — `feat(settings): settings:view, workspace:manage, labels:manage capabilities`

---

### Task 2: Migration 0088 — user account settings columns

**Files:**
- Create: `drizzle/migrations/0088_user_account_settings.sql`
- Create: `src/drizzle/migrate/settings-migrations.db.spec.ts`
- Modify: `src/drizzle/schema/users.schema.ts`, `src/drizzle/migrate/inbox-lock-timeout.spec.ts`

**Interfaces:**
- Produces (Drizzle `users`): `preferences: jsonb('preferences').$type<Record<string, unknown>>().notNull().default({})`, `passwordChangedAt: timestamp('password_changed_at', { withTimezone: true })`, `notificationsPausedUntil: timestamp('notifications_paused_until', { withTimezone: true })`, `deletedAt: timestamp('deleted_at', { withTimezone: true })`.

- [ ] **Step 1: Write the failing DB spec** `settings-migrations.db.spec.ts` (one `describeDb` block per migration; this task adds the 0088 block)

```ts
it('0088 adds the four users columns with their defaults', …
  // SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name='users' AND column_name IN (...)
  // expect preferences jsonb NOT NULL default '{}'::jsonb; the three timestamptz nullable
it('0088 copies planner weekStartsOn into preferences.weekStart from the most recently updated row', …
  // seed user + 2 workspaces; planner_preferences rows {weekStartsOn:0} updated_at older, {weekStartsOn:1} newer
  // re-run 0088 (harness applies twice) → users.preferences = {"weekStart":"monday"}
it('0088 leaves preferences {} when the user has no planner_preferences row', …
```

- [ ] **Step 2: Run to verify it fails**
Run: `PLANNER_DB_TESTS=1 npx jest src/drizzle/migrate/settings-migrations.db.spec.ts --runInBand`
Expected: FAIL (`ENOENT 0088_user_account_settings.sql`).

- [ ] **Step 3: Write `0088_user_account_settings.sql`**: `SET LOCAL lock_timeout = '10s';` then four `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS …` (`preferences jsonb NOT NULL DEFAULT '{}'::jsonb` is catalog-only on PG ≥ 11), then the week-start copy:

```sql
UPDATE users u SET preferences = u.preferences || jsonb_build_object('weekStart',
  CASE p.week WHEN '0' THEN 'sunday' ELSE 'monday' END)
FROM (SELECT DISTINCT ON (user_id) user_id, prefs->>'weekStartsOn' AS week
        FROM planner_preferences
       WHERE prefs ? 'weekStartsOn'
       ORDER BY user_id, updated_at DESC) p
WHERE p.user_id = u.id AND NOT (u.preferences ? 'weekStart');
```
(The planner key is `weekStartsOn` with values `0 | 1`, `src/planner/dto/planner-prefs.dto.ts:70-72`, not `weekStart` as the spec wrote.) Add the four Drizzle columns with a comment each, and `'0088_user_account_settings.sql'` to `FILES` plus one line in that spec's doc comment.

- [ ] **Step 4: Run tests**
Run: `PLANNER_DB_TESTS=1 npx jest src/drizzle/migrate --runInBand && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit** — `feat(db): 0088 users preferences, password_changed_at, notifications pause, deleted_at`

---

### Task 3: Migration 0089 — workspace settings columns

**Files:**
- Create: `drizzle/migrations/0089_workspace_settings.sql`
- Modify: `src/drizzle/schema/workspace.schema.ts`, `src/drizzle/schema/workspace-invitation.schema.ts`, `src/drizzle/migrate/inbox-lock-timeout.spec.ts`, `src/drizzle/migrate/settings-migrations.db.spec.ts`

**Interfaces:**
- Produces in `workspace.schema.ts`: `export const APPROVAL_POLICIES = ['none', 'members', 'everyone'] as const; export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];` columns `approvalPolicy: text('approval_policy').$type<ApprovalPolicy>().notNull().default('none')`, `shortenLinksDefault: boolean('shorten_links_default').notNull().default(false)`, `utmDefault: boolean('utm_default').notNull().default(false)`, `inviteLinkCode: varchar('invite_link_code', { length: 32 }).unique()`, `inviteLinkEnabled: boolean('invite_link_enabled').notNull().default(false)`.
- Produces in `workspace-invitation.schema.ts`: `message: text('message')`.

- [ ] **Step 1: Add the 0089 block to the DB spec**: columns exist with the defaults above; `UPDATE workspace SET approval_policy='sometimes'` raises `23514` (CHECK); two workspaces with the same `invite_link_code` raise `23505`; an existing workspace reads `('none', false, false, NULL, false)`.
- [ ] **Step 2: Run to verify it fails** (same command as Task 2). Expected: FAIL (missing file).
- [ ] **Step 3: Write the migration**: lock timeout first; `ADD COLUMN IF NOT EXISTS` for the five workspace columns; `approval_policy` CHECK added inside a `duplicate_object` guard as `workspace_approval_policy_check`; unique index `workspace_invite_link_code_uq` (`CREATE UNIQUE INDEX IF NOT EXISTS`); `ALTER TABLE workspace_invitations ADD COLUMN IF NOT EXISTS message text`. Drizzle columns as above; FILES entry.
- [ ] **Step 4: Run** `PLANNER_DB_TESTS=1 npx jest src/drizzle/migrate --runInBand && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(db): 0089 workspace publishing defaults, invite link, invitation message`

---

### Task 4: Migration 0090 — label catalogue, join table, backfill

**Files:**
- Create: `drizzle/migrations/0090_workspace_labels.sql`, `src/drizzle/schema/labels.schema.ts`
- Modify: `src/drizzle/schema/index.ts`, `src/drizzle/migrate/inbox-lock-timeout.spec.ts`, `src/drizzle/migrate/settings-migrations.db.spec.ts`

**Interfaces:**
- Produces `labels.schema.ts`: `export const LABEL_COLORS = ['blue', 'orange', 'green', 'purple', 'pink', 'teal', 'red', 'grey'] as const; export type LabelColor`; tables `workspaceLabels` (`workspace_labels`) and `postLabels` (`post_labels`) exactly as spec §5.9 SQL; types `WorkspaceLabel`, `PostLabel`. Exported from `schema/index.ts`.

- [ ] **Step 1: Add the 0090 block to the DB spec**:
  - backfill: posts in workspace W with `metadata.labels` `["Promo","launch"]`, `["promo"]`, `"not-an-array"`, `["Launch"," BTS "]` → catalogue rows `Promo`, `launch`, `BTS` (first-seen spelling by `posts.created_at`, trimmed and whitespace-collapsed as `normaliseLabels` does), colours in palette order by first-seen (`blue`, `orange`, `green`); `post_labels` has one row per (post, label), 5 rows total; labels in another workspace are not mixed in.
  - running the file twice creates no duplicates.
  - `INSERT` of `promo` while `Promo` is live → `23505`; the same insert after `UPDATE … SET deleted_at = now()` on `Promo` succeeds (partial unique index).
  - `color = 'cyan'` → `23514`.
- [ ] **Step 2: Run to verify it fails.** Expected: FAIL (missing file).
- [ ] **Step 3: Write the migration**: lock timeout first; the two `CREATE TABLE IF NOT EXISTS` and indexes from §5.9; backfill as set-based SQL:
  1. a CTE over `posts p, jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.metadata->'labels')='array' THEN p.metadata->'labels' ELSE '[]' END) WITH ORDINALITY` producing `(workspace_id, name := regexp_replace(btrim(label), '\s+', ' ', 'g'), key := lower(name), first_at := min(p.created_at, ordinality))`, dropping empty and >40-char names;
  2. `INSERT INTO workspace_labels (workspace_id, name, color, created_at) SELECT … , (ARRAY['blue','orange','green','purple','pink','teal','red','grey'])[((row_number() OVER (PARTITION BY workspace_id ORDER BY first_at, key) - 1) % 8) + 1] … ON CONFLICT DO NOTHING` (conflict target is the partial unique index: `ON CONFLICT (workspace_id, lower(name)) WHERE deleted_at IS NULL DO NOTHING`);
  3. `INSERT INTO post_labels (post_id, label_id, created_at) SELECT DISTINCT p.id, l.id, p.created_at … JOIN workspace_labels l ON l.workspace_id = p.workspace_id AND lower(l.name) = key AND l.deleted_at IS NULL ON CONFLICT DO NOTHING`.
  The header states: `metadata.labels` is left in place and no longer read or written (removal is a follow-up); labels written by the old instance between this migration and the switch-over are not copied (seconds-long window, accepted). Add FILES entry.
- [ ] **Step 4: Run** the DB spec and `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(db): 0090 workspace_labels + post_labels with backfill`

---

### Task 5: Migration 0091 — user FKs stop blocking or cascading

**Files:**
- Create: `drizzle/migrations/0091_users_fk_set_null.sql`
- Modify: `src/drizzle/schema/billing.schema.ts:362,459`, `drips.schema.ts:201,237`, `canva.schema.ts:19-21`, `workspace-invitation.schema.ts:30-32`, `workspace.schema.ts:19-21`, `src/drizzle/migrate/inbox-lock-timeout.spec.ts`, `settings-migrations.db.spec.ts`

**Interfaces:**
- Produces (schema): `usageEvents.triggeredByUserId`, `subscriptionChanges.changedByUserId`, `dripPosts.reviewedById`, `dripCampaignHistory.performedById` → `{ onDelete: 'set null' }`; `workspaceInvitation.invitedBy` → nullable + `set null` (type becomes `string | null`; fix compile errors at its readers with `?? null` / name fallback, no behaviour change); `canvaConnections.userId` → `{ onDelete: 'cascade' }` (it is the person's own Canva grant; the column is NOT NULL so SET NULL is impossible); `workspace.ownerId` → `{ onDelete: 'restrict' }`.

- [ ] **Step 1: Add the 0091 block to the DB spec**
```ts
it('no foreign key to users is NO ACTION any more', …
  // SELECT conrelid::regclass, a.attname FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
  //  WHERE c.contype='f' AND c.confrelid='users'::regclass AND c.confdeltype='a'  → expect []
it('workspace.owner_id is ON DELETE RESTRICT', … // confdeltype = 'r'
it('hard-deleting a non-owner user who invited, changed a plan, reviewed a drip and connected Canva succeeds', …
  // seed: owner O + workspace W; user U invited someone (workspace_invitations.invited_by=U), a subscription_changes row changed_by=U,
  // a usage_events row triggered_by=U, drip_posts.reviewed_by_id=U, drip_campaign_history.performed_by_id=U, canva_connections.user_id=U
  // DELETE FROM users WHERE id=U → ok; invited_by/changed_by/triggered_by/reviewed_by/performed_by are NULL; canva row gone
it('deleting a user who owns a workspace fails with 23001 and the workspace survives', …
```
- [ ] **Step 2: Run to verify it fails.** Expected: FAIL (missing file / NO ACTION rows listed).
- [ ] **Step 3: Write the migration.** First statement the lock timeout. Constraint names differ between environments (Drizzle-generated vs hand-written), so do not hard-code them: one `DO $$ … $$` block with a local array of `(table, column, action)` triples (the six above plus `workspace.owner_id → RESTRICT`); for each, loop over `pg_constraint` rows where `contype='f' AND conrelid = table::regclass AND confrelid = 'users'::regclass AND conkey = ARRAY[attnum of column]`, `EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', …)`, then `EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES users(id) ON DELETE %s NOT VALID', table, table||'_'||column||'_fkey', column, action)` and `VALIDATE CONSTRAINT`. Before the loop: `ALTER TABLE workspace_invitations ALTER COLUMN invited_by DROP NOT NULL`. Finally, a guard that raises if any FK to `users` is still `confdeltype = 'a'` (so a table the audit missed fails the boot loudly on a dev DB, not silently on prod). Header lists every changed column and the ROLLBACK statements. FILES entry.
- [ ] **Step 4: Run** the DB spec, `npx tsc --noEmit -p tsconfig.json`, `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `fix(db): 0091 user FKs set null, owner_id restrict`

---

### Task 6: PublicUser extras, password stamp, name limit, keep-sessions option

**Files:**
- Modify: `src/users/users.service.ts:25-98, 297-312`, `src/users/account-security.service.ts:78-118`, `src/users/account-security.controller.ts:74-100`, `src/users/dto/update-user.dto.ts`, `src/users/dto/change-password.dto.ts`
- Test: `src/users/users.service.spec.ts`, `src/users/account-security.service.spec.ts`, `src/users/dto/update-user.dto.spec.ts`

**Interfaces:**
- Produces: `PublicUser` gains `hasGoogle: boolean` and `passwordChangedAt: Date | null` (serialised ISO). `PUBLIC_USER_EXTRAS` gains `hasGoogle: sql<boolean>\`${fields.googleSub} is not null\``; `PUBLIC_USER_COLUMNS.passwordChangedAt = true`; `toPublicUser` maps both. `ChangePasswordDto.revokeOtherSessions?: boolean` (`@IsBoolean() @IsOptional()`, default `true`).

- [ ] **Step 1: Write failing tests**
  - `toPublicUser({ …row, googleSub: 'g1', passwordChangedAt: d })` → `hasGoogle: true, passwordChangedAt: d`; `googleSub: null` → `hasGoogle: false`; the object has no `googleSub` key.
  - `changePassword(…, { …, revokeOtherSessions: false })` writes `password` and `passwordChangedAt` but no `sessionsRevokedAt`; omitted → writes both (assert on the `set()` argument of the mocked update).
  - `resetPassword` SQL text contains `password_changed_at`.
  - `UpdateUserDto` with a 61-char name fails validation with `MaxLength`; 60 passes.
- [ ] **Step 2: Run** `npx jest src/users`. Expected: FAIL.
- [ ] **Step 3: Implement**: add the two fields; stamp `passwordChangedAt: now` in `changePassword` and `password_changed_at = ${now}` in `resetPassword`; `sessionsRevokedAt` only when `body.revokeOtherSessions !== false`; `@MaxLength(60)` on `UpdateUserDto.name`. The controller passes the DTO through unchanged and still mints this device's pair.
- [ ] **Step 4: Run** `npx jest src/users src/auth && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(account): hasGoogle, passwordChangedAt, keep-other-sessions option, name max 60`

---

### Task 7: User preferences (`GET|PATCH /users/me/preferences`)

**Files:**
- Create: `src/common/validators/is-iana-time-zone.ts`, `src/users/preferences/user-preferences.ts`, `src/users/preferences/user-preferences.service.ts`, `src/users/preferences/dto/update-preferences.dto.ts`, `src/users/account-settings.controller.ts`
- Modify: `src/users/users.module.ts`, `src/notifications/recipients.service.ts:81-92`
- Test: `src/common/validators/is-iana-time-zone.spec.ts`, `src/users/preferences/user-preferences.spec.ts`, `src/users/preferences/user-preferences.service.db.spec.ts`, `src/users/preferences/dto/update-preferences.dto.spec.ts`, `src/notifications/recipients.service.spec.ts`

**Interfaces:**
- Produces: `isIanaTimeZone(value: string): boolean` and decorator `IsIanaTimeZone(options?: ValidationOptions)`.
- Produces: `UserPreferences` (exact interface from spec §5.4) and `DEFAULT_PREFERENCES: UserPreferences = { theme: 'system', language: 'en', timezone: null, timeFormat: '12h', weekStart: 'monday', dateFormat: 'D_MMM_YYYY', startPage: 'home', hiddenModules: [], composerDefaultWhen: 'draft' }`; `mergePreferences(stored: unknown): UserPreferences` (unknown keys and invalid values dropped, so a bad stored value never reaches the client).
- Produces: `UserPreferencesService.get(userId: string): Promise<UserPreferences>`, `update(userId: string, patch: UpdatePreferencesDto): Promise<UserPreferences>`.
- Produces: `AccountSettingsController` `@Controller('users/me') @UseGuards(JwtAuthGuard)`; later tasks add handlers to it.

- [ ] **Step 1: Write failing tests**
  - `isIanaTimeZone`: `'UTC'`, `'Asia/Karachi'`, `'America/Argentina/Buenos_Aires'` → true; `'Mars/Olympus'`, `''`, `'utc+5'` → false.
  - `mergePreferences({ theme: 'dark', bogus: 1, weekStart: 'friday' })` → defaults with `theme: 'dark'`, `weekStart: 'monday'`, no `bogus`.
  - DTO: `hiddenModules: ['inbox','inbox','library']` → transformed to `['inbox','library']`; 5 items or `'home'` → fails; `timezone: null` passes; `timezone: 'Nowhere/X'` fails; `language: 'ur'` fails. Unknown keys are stripped by the global `ValidationPipe` whitelist; the service also copies only `UserPreferences` keys, so `update(u, { bogus: 1 } as never)` stores nothing.
  - DB: `update(u, { theme: 'dark' })` then `update(u, { timeFormat: '24h' })` → stored jsonb is `{"theme":"dark","timeFormat":"24h"}` (sparse, merged in SQL with `preferences || $patch::jsonb`, so two concurrent patches of different keys both survive); `get` returns the full object; `update(u, { timezone: null })` stores `"timezone": null` and reads back `null`.
  - `RecipientsService.userTimezone`: a user whose `preferences.timezone = 'Europe/Paris'` gets `'Europe/Paris'` even with a last-accessed workspace in `'Asia/Karachi'`; without it, the workspace zone (existing behaviour).
- [ ] **Step 2: Run** `npx jest src/common/validators src/users/preferences src/notifications/recipients.service.spec.ts` and the DB spec. Expected: FAIL.
- [ ] **Step 3: Implement.** `isIanaTimeZone`: membership in a lazily built `Set` of `Intl.supportedValuesOf('timeZone')` plus `'UTC'`, and as a fallback `new Intl.DateTimeFormat('en', { timeZone })` not throwing (covers aliases like `Asia/Calcutta`). DTO fields all `@IsOptional()` with `@IsIn` per enum, `timezone` `@ValidateIf(v => v.timezone !== null) @IsIanaTimeZone()`, `hiddenModules` `@IsArray() @ArrayMaxSize(4) @IsIn([...], { each: true })` + `@Transform` dedupe. Controller: `@Get('preferences')`, `@Patch('preferences')`. `userTimezone` selects `users.preferences->>'timezone'` and returns it when non-null and `isIanaTimeZone`. Register `AccountSettingsController` **first** in `UsersModule.controllers` (Task 21 relies on the order).
- [ ] **Step 4: Run** the tests above, `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(account): server-persisted user preferences`

---

### Task 8: Notification pause

**Files:**
- Create: `src/notification-preferences/notification-pause.controller.ts`, `notification-pause.service.ts`, `dto/set-pause.dto.ts`
- Modify: `src/notification-preferences/notification-preferences.service.ts:60-78`, `notification-preferences.repository.ts`, `notification-preferences.module.ts`
- Test: `notification-pause.service.spec.ts`, `notification-preferences.service.spec.ts`, `notification-preferences.repository.db.spec.ts`

**Interfaces:**
- Produces: `GET /users/me/notifications/pause` → `{ pausedUntil: string | null }`; `PUT /users/me/notifications/pause` body `{ until: string | null }` (ISO 8601) → same. Controller `@Controller('users/me/notifications') @UseGuards(JwtAuthGuard)`.
- Produces: `NotificationPreferencesRepository.pausedUntil(userId: string): Promise<Date | null>` and `setPausedUntil(userId: string, until: Date | null): Promise<void>`; `PAUSE_EXEMPT_EVENTS: ReadonlySet<PreferenceEventKey> = new Set(['post_failed', 'security_alert'])`.

- [ ] **Step 1: Write failing tests**
  - service: `set(u, now+31d)` → `400 PAUSE_TOO_LONG`; `set(u, now-1m)` → `400 PAUSE_IN_PAST`; `set(u, null)` clears; `get` returns `null` when the stored value is in the past.
  - `shouldSend` with `pausedUntil = now+1h`: `member_activity/app` → false; `inbox_mention/email` → false; `post_failed/app` → true; `security_alert/app` → true; `billing_alert/email` (locked) → true. With `pausedUntil = now-1s`: overrides/defaults apply as before.
- [ ] **Step 2: Run** `npx jest src/notification-preferences`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `shouldSend`, after `if (rule.locked) return true;` and before the membership check: `if (!PAUSE_EXEMPT_EVENTS.has(event)) { const until = await this.repo.pausedUntil(userId); if (until && until > new Date()) return false; }`. Slack routes are a different sender (`notification-routes`) and are not touched (§5.5). Max 30 days.
- [ ] **Step 4: Run** the unit specs, the repository DB spec with `PLANNER_DB_TESTS=1 … --runInBand`, and `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(notifications): per-user pause with failed-post and security exemptions`

---

### Task 9: Disconnect Google

**Files:**
- Create: `src/users/dto/disconnect-google.dto.ts`, `src/email/templates/security/sign-in-method-changed.tsx`
- Modify: `src/users/account-security.service.ts`, `src/users/account-security.controller.ts`, `src/email/templates/security/index.ts`
- Test: `src/users/account-security.service.spec.ts`, `src/users/account-security.controller.spec.ts`, the security templates spec next to `password-changed.tsx`

**Interfaces:**
- Produces: `POST /users/me/google/disconnect` body `{ currentPassword: string }` → `PublicUser`; Throttle 5/h per user (tracker `'google:' + userId`). `AccountSecurityService.disconnectGoogle(userId: string, currentPassword: string, ctx: RequestContext): Promise<PublicUser>`.
- Produces: template `signInMethodChangedTemplate` with props `{ when: string; device: string; location: string | null; method: 'google'; change: 'disconnected'; resetUrl: string }`.

- [ ] **Step 1: Write failing tests**: no password → `409 NO_PASSWORD`; `googleSub` already null → `409 GOOGLE_NOT_CONNECTED`; wrong password → `401 WRONG_PASSWORD` (map `CURRENT_PASSWORD_INCORRECT` from `verifyCurrentPassword` to this code for this route only); success sets `googleSub: null`, returns `hasGoogle: false`, and calls `notify.notify` with `event: 'security_alert'`, template `signInMethodChangedTemplate`; a notify failure does not fail the call. Controller spec: the route carries `ThrottlerGuard` and the per-user tracker.
- [ ] **Step 2: Run** `npx jest src/users src/email/templates/security`. Expected: FAIL.
- [ ] **Step 3: Implement** following `changePassword` / `sendPasswordChanged` (detached `void` send, never throws). Template copy: subject "Google sign-in was removed from your Schedura account", body names the device, place and time and the "This wasn't me" link (same `securityToken({ act: 'not_me' })`). Register in `security/index.ts`.
- [ ] **Step 4: Run** tests + `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(account): disconnect Google with password confirm and security email`

---

### Task 10: My workspaces list and Leave workspace

**Files:**
- Create: `src/users/my-workspaces.service.ts`
- Modify: `src/users/account-settings.controller.ts`, `src/users/users.module.ts`, `src/workspace-members/workspace-members.controller.ts`, `workspace-members.service.ts`, `open-workspace-routes.ts`
- Test: `src/users/my-workspaces.service.db.spec.ts`, `src/workspace-members/workspace-members.leave.db.spec.ts`, `src/workspace-members/workspace-members.controller.order.spec.ts`

**Interfaces:**
- Produces: `GET /users/me/workspaces` → `{ workspaces: MyWorkspace[] }` (interface verbatim from spec §5.2), owned first then by name (the FE puts current first). `MyWorkspacesService.list(userId: string): Promise<{ workspaces: MyWorkspace[] }>`; `planName` = `plans.name` of the workspace owner's `subscriptions` row when `status IN ('active','trialing','past_due')`, else the `FREE` plan's name; `invitedByName` = inviter's `name ?? email` for member rows, `null` for owned and when `invited_by` is null.
- Produces: `DELETE /workspace-members/:workspaceId/members/me` → 204. `WorkspaceMembersService.leaveWorkspace(workspaceId: string, userId: string): Promise<void>`: owner → `409 OWNER_CANNOT_LEAVE`; no ACCEPTED row → `404`; else `removeMember(workspaceId, row.id, userId)`.

- [ ] **Step 1: Write failing tests**
  - DB `list`: user owns W1 (owner on PRO) and is MEMBER of W2 invited by Hina (W2 owner on FREE) and was REMOVED from W3 → two rows: `{W1, role:'OWNER', planName:'Pro', invitedByName:null}`, `{W2, role:'MEMBER', planName:'Free', invitedByName:'Hina'}`; W3 absent.
  - DB `leaveWorkspace`: member leaves → row `REMOVED`, `removed_by = user`; owner → 409 `OWNER_CANNOT_LEAVE`; a GUEST can leave.
  - Order spec: in `WorkspaceMembersController.prototype`, the handler for `members/me` is declared before `removeMember` (`Object.getOwnPropertyNames(proto).indexOf('leaveWorkspace') < indexOf('removeMember')`), because Express matches routes in declaration order and `:memberId` would swallow `me`.
  - `every-workspace-route-guarded.spec.ts` stays green with the new key in `OPEN_ROUTES`.
- [ ] **Step 2: Run** the specs. Expected: FAIL.
- [ ] **Step 3: Implement.** Handler `leaveWorkspace` with `@Delete(':workspaceId/members/me') @HttpCode(204) @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)` placed above `removeMember`. `OPEN_ROUTES['DELETE /workspace-members/:workspaceId/members/me']` reason: "leave: the caller removes their OWN membership at any role; the service resolves the caller's ACCEPTED row and refuses the owner". `@Get('workspaces')` on `AccountSettingsController`.
- [ ] **Step 4: Run** specs + route guard specs + `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(account): my workspaces list and leave workspace`

---

### Task 11: Labels catalogue API

**Files:**
- Create: `src/labels/labels.module.ts`, `labels.controller.ts`, `labels.service.ts`, `dto/label.dto.ts`
- Modify: `src/app.module.ts`
- Test: `src/labels/labels.service.db.spec.ts`, `src/labels/labels.controller.spec.ts`

**Interfaces:**
- Produces: `interface Label { id: string; name: string; color: LabelColor; description: string | null; postCount: number; lastUsedAt: string | null }`.
- Produces `LabelsService`:
  - `list(workspaceId): Promise<{ labels: Label[]; total: number }>` (live labels, `ORDER BY lower(name)`; `postCount` = `count(post_labels)`; `lastUsedAt` = `max(post_labels.created_at)`)
  - `create(workspaceId, userId, dto: CreateLabelDto): Promise<Label>` (colour omitted → `nextColor(workspaceId)`: first palette colour least used among live labels, ties in palette order)
  - `update(workspaceId, labelId, dto: UpdateLabelDto): Promise<Label>`
  - `merge(workspaceId, labelId, intoId): Promise<{ target: Label; moved: number }>`
  - `remove(workspaceId, labelId): Promise<{ undoUntil: string }>` (now + 10 s)
  - `restore(workspaceId, labelId): Promise<Label>` (accepted while `deleted_at > now() - 60 s`)
  - `purgeExpired(workspaceId): Promise<void>` (hard-deletes labels with `deleted_at < now() - 10 min`; first statement of every write)
  - `catalogueNames(workspaceId): Promise<string[]>` (live names, name order; used by Task 12)
- Routes (`@Controller('labels/workspaces/:workspaceId')`, `JwtAuthGuard, WorkspaceRoleGuard`): `GET ''` `posts:draft`; `POST ''` `labels:manage` (201); `PATCH ':labelId'`, `POST ':labelId/merge'`, `DELETE ':labelId'`, `POST ':labelId/restore'` `labels:manage`. `labelId`/`intoId` through `ParseUUIDPipe`.
- DTOs: `CreateLabelDto { name: string (trim, collapse spaces, 1–40); color?: LabelColor; description?: string (≤120) }`; `UpdateLabelDto { name?; color?; description?: string | null }`; `MergeLabelDto { intoId: string (UUID) }`.

- [ ] **Step 1: Write failing DB tests** (`withRollbackDb(['0090_workspace_labels.sql'], …)`)
  - create `Promo` then `promo` → `409 LABEL_NAME_TAKEN`; rename `BTS` to `PROMO` → 409; rename to its own name in other case (`promo`→`Promo`) succeeds.
  - create without colour on a workspace whose live labels are blue, blue, orange → `green`.
  - merge A (posts p1, p2) into B (posts p2, p3) → `moved: 1`, B has p1, p2, p3, A no longer exists (hard delete), all in one transaction; merging into itself → `400 MERGE_SAME_LABEL`; into a label of another workspace → `404`.
  - remove → `undoUntil` ≈ now+10 s; list no longer shows it; its `post_labels` rows remain; restore within 60 s → label back with the same `postCount`; restore after the name was reused → `409 LABEL_NAME_TAKEN`; restore with `deleted_at` 61 s ago → `410 UNDO_EXPIRED`.
  - `purgeExpired` removes a label deleted 11 min ago (and its `post_labels` by cascade), keeps one deleted 9 min ago.
  - `list` counts and `lastUsedAt` are per label; a never-used label has `postCount: 0, lastUsedAt: null`.
  - a label id from workspace X used under workspace Y → 404 on every mutation.
- [ ] **Step 2: Write the failing controller spec**: each handler's `REQUIRE_CAPABILITY` metadata equals the table above and `GUARDS_METADATA` contains `WorkspaceRoleGuard`.
- [ ] **Step 3: Run** both specs. Expected: FAIL.
- [ ] **Step 4: Implement.** Merge SQL as spec §5.9 (`INSERT … SELECT … ON CONFLICT DO NOTHING`, `moved` = inserted row count, then `DELETE FROM workspace_labels WHERE id = source`). Every query is scoped by `workspace_id`. Register `LabelsModule` (imports `WorkspaceRoleModule`) in `app.module.ts`.
- [ ] **Step 5: Run** both specs, the route guard specs, `npm run build`. Expected: PASS.
- [ ] **Step 6: Commit** — `feat(labels): label catalogue CRUD, merge, soft delete with undo`

---

### Task 12: Labels in the composer and Planner

**Files:**
- Create: `src/labels/post-labels.service.ts`
- Modify: `src/labels/labels.module.ts` (export), `src/posts/composer/lib/draft-organise.ts:103-127`, `src/posts/composer/composer.controller.ts:211-214`, `src/posts/composer/services/draft-store.service.ts` (save, reads, `toDraft`, `listLabels`), `composer-scheduling.service.ts:212-216,365-368`, `publish-orchestrator.service.ts:177,456`, `src/posts/services/planner-posts.service.ts:21-48`, `src/posts/dto/planner-post.dto.ts`, `src/planner/dto/planner-list.dto.ts`, `src/planner/services/planner-list.service.ts:61-121`, the posts/planner module files to import `LabelsModule`
- Test: `src/labels/post-labels.service.db.spec.ts`, `src/posts/composer/lib/draft-organise.spec.ts`, `src/posts/composer/services/draft-organise.services.spec.ts`, `src/planner/services/planner-list.service.db.spec.ts`

**Interfaces:**
- Consumes: `LabelsService.catalogueNames`, `nextColor` (Task 11).
- Produces `PostLabelsService`:
  - `setForPost(workspaceId: string, postId: string, names: string[]): Promise<void>` — normalises with `normaliseLabels`, resolves names case-insensitively to live labels, creates missing ones (palette colour, `created_by` null), replaces the post's `post_labels` set in one transaction (`DELETE … WHERE post_id = $p AND label_id <> ALL($ids)`, `INSERT … ON CONFLICT DO NOTHING`). Never reads or writes `posts.metadata`.
  - `namesForPosts(postIds: string[]): Promise<Map<string, string[]>>` (live labels only, name order)
  - `idsForPosts(postIds: string[]): Promise<Map<string, string[]>>`
- Produces: `organiseMeta` no longer emits `labels` (it still keeps `campaignId`/`campaignSlot`); `readOrganise` returns `{ campaignId }` only and `OrganiseView.labels` is removed; `DraftStoreService.toDraft(row, labels: string[])`.
- Produces: `PlannerPostDto.labelIds: string[]` (from `present()`), so the Planner calendar filters client-side; `PlannerListQueryDto.labels?: string` (comma-separated UUIDs, ≤20, each validated) filtering `list` server-side with `EXISTS (SELECT 1 FROM post_labels pl JOIN workspace_labels l ON l.id = pl.label_id AND l.deleted_at IS NULL WHERE pl.post_id = posts.id AND pl.label_id = ANY($ids))` applied to both the page and the counts.
- `GET /composer/workspaces/:wsId/labels` keeps `{ labels: string[] }`, now `catalogueNames`.

- [ ] **Step 1: Write failing tests**
  - DB `setForPost`: `['Promo', 'promo', ' New one ']` on a post → two rows (`Promo` existing, `New one` created with the next palette colour); calling again with `['New one']` leaves one row; `[]` clears; a name matching a soft-deleted label creates a fresh live label (the deleted one stays deleted); `posts.metadata` byte-identical before and after.
  - `organiseMeta(existing, { labels: ['x'] })` has no `labels` key; `campaignId` behaviour unchanged (existing cases still pass).
  - service spec (`draft-organise.services.spec.ts`): saving a draft with `labels` calls `setForPost(ws, draftId, labels)`; saving with `labels` absent does not call it; schedule-split calls it once per sibling; publish-inline calls it.
  - DB planner list: `labels=<A>` returns only posts carrying A, `total` and `counts` match the filter; a malformed id → 400.
- [ ] **Step 2: Run** the specs. Expected: FAIL.
- [ ] **Step 3: Implement.** In each of the three write paths call `postLabels.setForPost` right after the row upsert, only when `dto.labels !== undefined` ("absent keeps, present sets"). Draft reads batch `namesForPosts` for the rows they return and pass the names to `toDraft`. Remove the metadata-based `listLabels` body (keep the method as a delegate to `catalogueNames` so the controller is unchanged).
- [ ] **Step 4: Run** `npx jest src/posts src/planner src/labels`, the DB specs, `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(labels): composer and Planner read and write labels through post_labels`

---

### Task 13: General — read, update, logo, publishing defaults

**Files:**
- Create: `src/workspace/dto/presign-logo.dto.ts`
- Modify: `src/workspace/workspace.controller.ts`, `workspace.service.ts:286-399`, `workspace.module.ts`, `dto/update-workspace.dto.ts`, `src/media/cloudflare-r2.service.ts:30-80`
- Test: `src/workspace/workspace.controller.spec.ts` (new), `src/workspace/dto/update-workspace.dto.spec.ts` (new), `src/workspace/workspace.general.db.spec.ts` (new)

**Interfaces:**
- Produces: route params on `GET /workspace/:workspaceId` and `PATCH /workspace/:workspaceId` renamed from `:id` (URL unchanged) so `WorkspaceRoleGuard` resolves them; `GET` → `settings:view`, `PATCH` → `workspace:manage`. `GET /workspace/slug/:slug` stays owner-only (no workspace id in its path).
- Produces: `WorkspaceService.findDetail(workspaceId: string): Promise<WorkspaceDetail>` where `WorkspaceDetail = Omit<Workspace, 'maestroAnthropicKey' | 'inviteLinkCode'> & { owner: { id; name; email }; ownerName: string; approvalPolicy; shortenLinksDefault; utmDefault; ownerId }` (`ownerName = owner.name ?? owner.email`). Response stays `{ success: true, data }`.
- Produces: `WorkspaceService.update(workspaceId, dto, userId)` without the owner check (the guard decides); returns `{ workspace, timezoneMove: TimezoneMoveResult | null }` and the controller answers `{ success, message, data: workspace, timezoneMove }` (Task 14 fills `timezoneMove`).
- Produces: `POST /workspace/:workspaceId/logo/presign` (`workspace:manage`) body `PresignLogoDto { contentType: 'image/png' | 'image/jpeg'; sizeBytes ≤ 2 MB }` → R2 `createPresignedUpload({ kind: 'workspace-logo', workspaceId, userId, … })`.
- Produces: `GET /workspace/:workspaceId/publishing-defaults` (`posts:draft`) → `{ approvalPolicy, shortenLinksDefault, utmDefault }`.
- Produces: `R2MediaKind` gains `'workspace-logo'` (prefix `workspace-logos`, max 2 MB, mime `^image/(png|jpeg)$`).
- `UpdateWorkspaceDto`: `timezone` `@IsIanaTimeZone()`; `applyTimezoneToChannels?: boolean` (`@ValidateIf(o => o.applyTimezoneToChannels !== undefined)` + service 400 `TIMEZONE_REQUIRED` when sent without `timezone`); `logo?: string | null` (`@ValidateIf(o => o.logo !== null)`, `@IsUrl`), server-side `isOwnPublicUrl(logo, 'workspace-logo')` else `400 LOGO_NOT_UPLOADED`; `approvalPolicy?: ApprovalPolicy` (`@IsIn(APPROVAL_POLICIES)`); `shortenLinksDefault?`, `utmDefault?` (`@IsBoolean`).

- [ ] **Step 1: Write failing tests**
  - controller metadata: `findOne` → `settings:view`, `update` → `workspace:manage`, `presignLogo` → `workspace:manage`, `publishingDefaults` → `posts:draft`, all with `WorkspaceRoleGuard`. (`removePermanently` is renamed to `:workspaceId` here too, so the every-route spec sees it; give it `@RequireCapability('workspace:delete')` + the guard in this task, keeping the service owner check until Task 16 removes it.)
  - DTO: `timezone: 'Mars/X'` fails, `'UTC'` passes; `logo: null` passes; `approvalPolicy: 'some'` fails.
  - DB: an ADMIN's `update(ws, { name: 'New' })` succeeds (no owner check); `logo` set to a foreign URL → 400 `LOGO_NOT_UPLOADED`; `logo: null` clears; `findDetail` returns `ownerName` and never `maestroAnthropicKey` or `inviteLinkCode`.
  - `every-workspace-route-guarded.spec.ts` now covers these routes (they carry `:workspaceId`).
- [ ] **Step 2: Run** the specs. Expected: FAIL.
- [ ] **Step 3: Implement.** Add `WorkspaceRoleModule` to `WorkspaceModule.imports`, `CloudflareR2Service` provider access (import its module as `UsersModule` does). Keep the suspended check in `findDetail`.
- [ ] **Step 4: Run** specs + route guard specs + `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(workspace): admin-editable General, logo upload, publishing defaults`

---

### Task 14: Time zone "Also move existing"

**Files:**
- Create: `src/common/utils/wall-clock.ts`, `src/posts/services/post-reschedule.service.ts`, `src/workspace/workspace-timezone-move.service.ts`, `src/workspace/workspace-timezone-move.processor.ts`
- Modify: `src/campaigns/campaign-schedule.util.ts:47` (import the moved helper), `src/queue/queue.module.ts` (add `QUEUES.WORKSPACE_TZ_MOVE = 'workspace-tz-move'`), `src/workspace/workspace.service.ts`, `workspace.module.ts`, `src/posts/posts.module.ts` (export the service)
- Test: `src/common/utils/wall-clock.spec.ts`, `src/workspace/workspace-timezone-move.db.spec.ts`

**Interfaces:**
- Produces: `wallClockToUtc(date: string, time: string, timeZone: string): Date | null` (moved verbatim from `campaign-schedule.util.ts`) and `utcToWallClock(at: Date, timeZone: string): { date: string; time: string }` (`HH:mm:ss`).
- Produces: `PostRescheduleService.moveTo(workspaceId: string, postId: string, at: Date): Promise<void>` — updates `posts.scheduled_at`, removes jobs `composer-publish-{postId}` and the row's `job_id`, re-adds `publishingQueue.add('publish', { postId }, { jobId: 'composer-publish-' + postId, delay: max(0, at - now), attempts: 3 })`, records the job id on the row (same as `composer-scheduling.service.ts:296-316`).
- Produces: `WorkspaceTimezoneMoveService.moveExisting(workspaceId: string, fromZone: string, toZone: string): Promise<TimezoneMoveResult>`, `TimezoneMoveResult = { movedChannels: number; rescheduledPosts: number; queued: boolean }`. Above 500 SCHEDULED posts it updates the channels inline, enqueues job `tz-move-{workspaceId}` (data `{ workspaceId, fromZone, toZone, channelZones }`, 3 attempts, exponential backoff) on `QUEUES.WORKSPACE_TZ_MOVE`, whose `WorkspaceTimezoneMoveProcessor` reschedules the posts, and returns `queued: true` with the counts it will process.

- [ ] **Step 1: Write failing tests**
  - wall-clock: `utcToWallClock(2026-03-29T01:30Z, 'Europe/London')` → `{date:'2026-03-29', time:'02:30:00'}`; round trip in `Asia/Karachi`.
  - DB (`BullMQ` faked with a `{ getJob, add }` stub): workspace in `Asia/Karachi`, two channels (`Asia/Karachi`, `Europe/Paris`), a SCHEDULED post at 09:00 Karachi wall time on the first channel, a DRAFT, and a PUBLISHED post; `moveExisting(ws, 'Asia/Karachi', 'America/New_York')` → both channels now `America/New_York`; the scheduled post now at 09:00 New York wall time; its old job removed and `composer-publish-<id>` re-added with the new delay; draft and published untouched; result `{ movedChannels: 2, rescheduledPosts: 1, queued: false }`. A post whose new instant is in the past is set to `now` delay 0 (it publishes now, as a past-due reschedule does today) and counted.
  - `update(ws, { timezone: 'X', applyTimezoneToChannels: true })` returns `timezoneMove`; without the flag channels are untouched and `timezoneMove` is `null`.
  - A job id never contains `:` (assert on every `add` call).
- [ ] **Step 2: Run** the specs. Expected: FAIL.
- [ ] **Step 3: Implement.** Wall-clock source zone for a post = the zone its first target channel had before the move, fallback `fromZone`. Channel update and `scheduled_at` writes in one DB transaction; job moves after commit (a failed job move is logged and retried by the processor's next attempt in the queued path; in the inline path it throws after the commit is done — log and continue, return the count of successful moves).
- [ ] **Step 4: Run** specs + `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(workspace): move channels and scheduled posts to a new time zone`

---

### Task 15: Approval policy enforcement

**Files:**
- Create: `src/posts/composer/services/approval-policy.service.ts`
- Modify: `src/posts/lib/draft-approval.ts:28-80`, `src/posts/composer/services/draft-store.service.ts` (insert branch), `draft-approval.service.ts:141-188, 350-393`, `composer-scheduling.service.ts:227`, `publish-orchestrator.service.ts:426`, composer module providers
- Test: `src/posts/composer/services/approval-policy.service.spec.ts`, `src/posts/composer/services/draft-approval.db.spec.ts`

**Interfaces:**
- Produces: `policyCovers(policy: ApprovalPolicy, role: WorkspaceRole | 'SUPER_ADMIN' | null): boolean` (`members` → MEMBER, GUEST; `everyone` → every workspace role; `none` and `SUPER_ADMIN` → false). `ApprovalPolicyService.coversAuthor(workspaceId: string, userId: string): Promise<boolean>` (reads `workspace.approval_policy` + `WorkspaceRoleService.getRole`).
- Produces: `DraftApproval.byPolicy?: true` and `notifiedAt?: string`; `newApprovalRequest(userId, now?, opts?: { byPolicy?: boolean })`; `readApproval` reads both.
- Produces: `assertPolicyAllowsDirectSend(covers: boolean, metadata: unknown): void` in `draft-approval.ts` — throws the existing `APPROVAL_REQUIRED` refusal when `covers && readApproval(metadata) === null`.

- [ ] **Step 1: Write failing tests**
  - `policyCovers` table: `members`×{OWNER,ADMIN,MEMBER,GUEST} → F,F,T,T; `everyone` → all T; `none` → all F.
  - DB: policy `members`; a MEMBER creates a draft → `metadata.approval` `{ required: true, byPolicy: true }`, no approver notification queued; `setRequired(false)` by an ADMIN on it → 403 (`canTurnOff` false while the policy still covers the author); after the policy is set to `none` the ADMIN can turn it off; an OWNER's new draft under `members` has no approval.
  - DB: a draft created before the policy changed to `everyone` keeps `approval` absent.
  - `setRequired(true)` on a `byPolicy` request without `notifiedAt` sends `notifyApprovers` once and stamps `notifiedAt`; a second call sends nothing.
  - schedule and publish-inline of a post with no stored approval by a covered MEMBER → `APPROVAL_REQUIRED`; by an ADMIN under `members` → allowed.
- [ ] **Step 2: Run** the specs. Expected: FAIL.
- [ ] **Step 3: Implement.** Draft insert branch adds the policy approval only when `existing.length === 0` and `coversAuthor` is true. `view()` sets `canTurnOff = may(role, APPROVE_CAPABILITY) && !(approval?.byPolicy && await coversAuthor(ws, approval.requestedById))`; `setRequired(false)` asserts the same. Call `assertPolicyAllowsDirectSend(await policy.coversAuthor(ws, userId), existing?.metadata)` immediately before each of the two `assertApprovedFor` calls. `ALLOW_SELF_APPROVAL` unchanged.
- [ ] **Step 4: Run** `npx jest src/posts`, the DB spec, `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(composer): workspace approval policy applied to new drafts and direct sends`

---

### Task 16: Delete workspace — preview, typed confirm, jobs, subscription

**Files:**
- Create: `src/workspace/dto/delete-workspace.dto.ts`
- Modify: `src/workspace/workspace.controller.ts:115-128`, `workspace.service.ts:419-502`, `src/billing/services/subscription.service.ts:716-786`, `src/billing/dto/billing.dto.ts:65-69`, `src/billing/billing.controller.ts:141-156`
- Test: `src/workspace/workspace.delete.db.spec.ts`, `src/billing/services/subscription.cancel.spec.ts`

**Interfaces:**
- Produces: `GET /workspace/:workspaceId/deletion-preview` (`workspace:delete`) → `{ channels: number; scheduledPosts: number; members: number; guests: number; isLastOwnedWorkspace: boolean; planName: string }` (channels = non-disconnected `social_media_channels` rows of the workspace; members = ACCEPTED non-GUEST; guests = ACCEPTED GUEST; `planName` as in Task 10).
- Produces: `DELETE /workspace/:workspaceId/permanent` (`workspace:delete`) body `DeleteWorkspaceDto { confirmName: string }` → `400 CONFIRM_NAME_MISMATCH` unless `confirmName.trim() === workspace.name` (exact, case-sensitive).
- Produces: `CancelReason = 'too_expensive' | 'missing_feature' | 'switching_tool' | 'taking_break'`; `CancelSubscriptionBodyDto.reason?: CancelReason`.
- Produces: `SubscriptionService.cancelForAccount(userId: string, atPeriodEnd: boolean, opts?: { reason?: CancelReason; changedByUserId?: string | null }): Promise<'cancelled' | 'none'>` — `'none'` for no subscription, FREE, or already `canceled`; otherwise `adapter.cancel`, the existing subscription row update, and an inserted `subscription_changes` row `{ changeType: 'SUBSCRIPTION_CANCELLED', reason, changedByUserId, newValue: { atPeriodEnd } }`. `cancelSubscription(workspaceId, userId, atPeriodEnd, reason?)` keeps its owner check and delegates.

- [ ] **Step 1: Write failing tests**
  - DB preview: workspace with 3 channels (1 disconnected), 4 scheduled + 2 draft posts, 2 MEMBERs, 1 ADMIN, 1 GUEST → `{ channels: 2, scheduledPosts: 4, members: 3, guests: 1 }`; `isLastOwnedWorkspace` true with one owned workspace, false with two.
  - DB delete: `confirmName: ' Acme '` for workspace `Acme` → ok; `'acme'` → 400 `CONFIRM_NAME_MISMATCH` and the workspace exists; on success every SCHEDULED post's `composer-publish-<id>` and `job_id` jobs are removed (queue stub records `remove`); when it was the last owned workspace on a paid plan, `cancelForAccount(owner, true)` is called; with another owned workspace it is not; on FREE it is not.
  - `cancelForAccount`: inserts `subscription_changes` with `reason: 'too_expensive'`; FREE → `'none'` and no adapter call. The cancel route passes `reason` through.
- [ ] **Step 2: Run** the specs. Expected: FAIL.
- [ ] **Step 3: Implement.** Order inside `remove`: verify name → collect scheduled post ids and `job_id`s → existing EXTRA_WORKSPACE release → `DELETE workspace` → remove jobs (best effort, logged) → `cancelForAccount` when last owned and paid (logged on failure, never fails the delete, since the workspace is already gone) → existing limit re-apply. Drop the service-level owner check in favour of the guard (`workspace:delete` is OWNER; keep a SUPER_ADMIN path through the guard).
- [ ] **Step 4: Run** specs, `remaining-workspace-guards.spec.ts`, `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(workspace): deletion preview, typed-name confirm, job cleanup, last-workspace cancel`

---

### Task 17: Members — last active, invitation list, personal message, resend

**Files:**
- Modify: `src/workspace-members/workspace-members.service.ts:129-336, 512-553, 637-698, 1089-1135`, `workspace-members.controller.ts`, `dto/batch-invite.dto.ts`, `src/email/templates/team/workspace-invitation.tsx:33-45`
- Test: `src/workspace-members/workspace-members.service.spec.ts`, `src/workspace-members/workspace-members.invitations.db.spec.ts`, `src/email/templates/team/team.spec.ts`

**Interfaces:**
- Produces: `getMembers` adds `lastActiveAt: string | null` on `owner` and on each member (`users.last_login_at`). Existing keys unchanged.
- Produces: `getPendingInvitations` returns PENDING rows plus EXPIRED rows (status `EXPIRED`, or PENDING with `expires_at < now()`) whose `expires_at > now() - 30 days`, each with `status: 'PENDING' | 'EXPIRED'` (computed), `invitedByName: string | null`, `createdAt`, `expiresAt`, `message`. Token still never included.
- Produces: `BatchInviteDto.message?: string` (`@IsString() @MaxLength(500) @Transform(trim)`, empty → undefined), stored on every created row; `InvitationProps.message: string | null` rendered as a quoted paragraph (React escapes it).
- Produces: `POST /workspace-members/:workspaceId/invitations/:invitationId/resend` (`team:manage`, Throttle 10/h, tracker `'resend:' + workspaceId`) → the invitation view above. `WorkspaceMembersService.resendInvitation(workspaceId, invitationId, userId)`: ACCEPTED/REMOVED/REJECTED → `409 INVITATION_NOT_RESENDABLE`; unknown → 404; EXPIRED (or PENDING past `expires_at`) → under `lockWorkspaceSeats`, `freeSeats(workspaceId) >= 1` else `403 SEAT_LIMIT_EXCEEDED`, then status `PENDING`; always `expires_at = now + 7 days`, token kept, `updated_at` bumped, email re-sent (new idempotency key from the new `expiresAt`).

- [ ] **Step 1: Write failing tests**
  - DB list: one pending, one expired 3 days ago, one expired 40 days ago, one ACCEPTED → two rows with statuses `PENDING`, `EXPIRED`, and `invitedByName`.
  - DB resend: pending → `expires_at` moved, token unchanged; expired with 0 free seats → 403 and row unchanged; expired with a free seat → PENDING; ACCEPTED → 409.
  - batch invite with `message` stores it on each row and passes it to the email props; 501 chars → validation error.
  - template: `message: '<b>hi</b>'` renders the text escaped, never as markup; `message: null` renders no quote block.
  - `getMembers` exposes `lastActiveAt`.
- [ ] **Step 2: Run** the specs. Expected: FAIL.
- [ ] **Step 3: Implement** as specified; the resend handler goes before any `:invitationId` catch-all in declaration order.
- [ ] **Step 4: Run** specs, route guard specs, `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(members): last active, expired invites, personal message, resend`

---

### Task 18: Invite link and join by code

**Files:**
- Create: `src/workspace-members/invite-link.service.ts`, `join-link.controller.ts`, `dto/invite-link.dto.ts`
- Modify: `workspace-members.controller.ts`, `workspace-members.module.ts`, `src/workspace-members/open-routes.spec.ts`
- Test: `src/workspace-members/invite-link.service.spec.ts`, `src/workspace-members/invite-link.db.spec.ts`

**Interfaces:**
- Produces: `generateInviteCode(workspaceName: string, random: (n: number) => Buffer = crypto.randomBytes): string` → `{initials}-{10 Crockford base32 chars}`; initials = first ASCII letter or digit of the first two words, lowercased, fallback `ws`; alphabet `0123456789abcdefghjkmnpqrstvwxyz`; matches `/^[a-z0-9]{1,2}-[0-9a-hjkmnp-tv-z]{10}$/`.
- Produces `InviteLinkService`: `get(workspaceId): Promise<InviteLinkState>`, `setEnabled(workspaceId, enabled: boolean): Promise<InviteLinkState>` (creates a code on first enable, keeps it on disable), `reset(workspaceId): Promise<InviteLinkState>` (new code, keeps `enabled`), `preview(code): Promise<{ workspaceName: string; workspaceLogo: string | null; ownerName: string }>`, `join(code, userId): Promise<{ workspaceId: string }>`. `InviteLinkState = { enabled: boolean; url: string | null }`, `url = links.frontend('/join/' + code)` when enabled.
- Routes on `WorkspaceMembersController` (`team:manage`): `GET :workspaceId/invite-link`, `PUT :workspaceId/invite-link` body `{ enabled: boolean }`, `POST :workspaceId/invite-link/reset`.
- `JoinLinkController` `@Controller('invitations')`: `GET join/:code` (no auth; `ThrottlerGuard` 30/15 min per IP) and `POST join/:code` (`JwtAuthGuard`, `@SkipLaunchGate()`), code validated by the regex above (400 otherwise).

- [ ] **Step 1: Write failing tests**
  - unit: `generateInviteCode('Rehman Works', fixedBytes)` starts with `rw-`; `'  '` starts with `ws-`; 1,000 generated codes all match the regex and none repeat.
  - DB: enable → `url` ends with `/join/<code>`; disable → `{ enabled: false, url: null }`; reset → new code, old code `preview` → 404; disabled link `preview`/`join` → 404.
  - DB join: a non-member joins → ACCEPTED MEMBER row with `invited_by = owner`, `email = user email`, member count incremented; already a member → `409 ALREADY_MEMBER`; the owner → `409 ALREADY_MEMBER`; zero free seats → `409 SEAT_LIMIT_EXCEEDED` (body code); a REMOVED row for the same user does not block (a new ACCEPTED row is inserted).
  - `open-routes.spec.ts`: `JoinLinkController.preview` has `ThrottlerGuard` and no `JwtAuthGuard`; `join` has `JwtAuthGuard`.
- [ ] **Step 2: Run** the specs. Expected: FAIL.
- [ ] **Step 3: Implement.** `join` runs in one transaction under `lockWorkspaceSeats`, reuses `freeSeats` and `usageService.incrementMemberCount`, inserts the row with a random 32-byte token, then `notifyInviterOfAcceptance` (owner gets B2). Code collisions on `UNIQUE` retry once with a new code.
- [ ] **Step 4: Run** specs, route guard specs, `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(members): workspace invite link with join by code`

---

### Task 19: Provider adapters — portal link, invoices, billing profile

**Files:**
- Modify: `src/billing/providers/payment-provider.interface.ts`, `lemonsqueezy.adapter.ts`, `stripe.adapter.ts`
- Test: `src/billing/providers/lemonsqueezy.adapter.spec.ts`, `stripe.adapter.spec.ts`, `payment-provider.interface.spec.ts`

**Interfaces:**
- Produces in the interface file:
  ```ts
  export type PortalIntent = 'portal' | 'update_payment_method';
  export interface ProviderInvoice { id: string; date: string; description: string; amountCents: number; currency: string; status: 'paid' | 'pending' | 'failed' | 'refunded' | 'void'; downloadUrl: string | null }
  export interface BillingProfile { card: { brand: string | null; last4: string | null } | null; billingDetails: { name: string | null; email: string | null; country: string | null } | null }
  ```
  and on `PaymentProviderAdapter`: `createPortalLink(subscriptionId: number, intent: PortalIntent): Promise<{ url: string }>`, `listInvoices(subscriptionId: number, limit: number): Promise<ProviderInvoice[]>`, `getBillingProfile(subscriptionId: number): Promise<BillingProfile>`.
- Lemon Squeezy: portal = `GET subscriptions/{BASE_PLAN providerSubscriptionId}` → `data.attributes.urls.customer_portal` or `.update_payment_method` (missing → `502 PORTAL_UNAVAILABLE`). Invoices = for every provider row of the subscription, `GET subscription-invoices?filter[subscription_id]={id}&page[size]={limit}`, merged, newest first, first `limit`; mapping `id`, `created_at`, `total` (cents), `currency`, `urls.invoice_url`, status `paid → paid`, `refunded|partial_refund → refunded`, `void → void`, `pending → failed` when the row's `billing_reason` is `renewal` and the invoice is older than 1 hour, else `pending`; description = `"{Plan name} plan"` for BASE_PLAN rows, the add-on display name for add-on rows (from `CatalogueService`). Profile = subscription `card_brand`, `card_last_four` + `GET customers/{customer_id}` `name`, `email`, `country`.
- Stripe: portal = `stripe.getClient().billingPortal.sessions.create({ customer, return_url: links.billing(ws) })` (flow `payment_method_update` for that intent); invoices from the `invoices` table (existing columns); profile from the default `payment_methods` row, `billingDetails: null`.

- [ ] **Step 1: Write failing tests** (LS with `global.fetch` mocked per URL, as `lemonsqueezy.client.spec.ts`; never a real request)
  - portal intent `update_payment_method` requests `subscriptions/<base id>` and returns its `update_payment_method` URL; intent `portal` returns `customer_portal`.
  - invoices: two provider rows (base + EXTRA_CHANNEL) with 2 and 1 invoices → 3 rows newest first, `amountCents` from `total`, `downloadUrl` from `urls.invoice_url`; a `pending` renewal 2 h old → `failed`; `limit` 2 → 2 rows; fetch URL contains `filter%5Bsubscription_id%5D=` or `filter[subscription_id]=` with the provider id.
  - profile maps `card_brand`/`card_last_four` and the customer.
  - Stripe portal calls `billingPortal.sessions.create` with the customer id (Stripe client mocked).
  - `payment-provider.interface.spec.ts`: both adapters implement all three methods.
- [ ] **Step 2: Run** `npx jest src/billing/providers`. Expected: FAIL.
- [ ] **Step 3: Implement** the three methods per adapter.
- [ ] **Step 4: Run** `npx jest src/billing && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(billing): provider portal link, invoice list and billing profile`

---

### Task 20: Billing overview, provider invoices, portal link endpoints

**Files:**
- Create: `src/billing/services/billing-overview.service.ts`, `src/billing/dto/portal-link.dto.ts`
- Modify: `src/billing/billing.controller.ts`, `billing.module.ts`, `src/billing/services/webhook.service.ts:40` (export `PAYMENT_GRACE_DAYS = 7` and use it), `src/workspace-members/remaining-workspace-guards.spec.ts`
- Test: `src/billing/services/billing-overview.service.spec.ts`, `src/billing/billing.controller.spec.ts`

**Interfaces:**
- Consumes: Task 19 adapter methods; `DashboardService.getWorkspaceDashboard` (usage), `SubscriptionLookupService`, `ProviderRegistryService.adapterForSubscription`, `getNextTokenResetDate`, `BestTimesCache` (`src/planner/lib/best-times-cache.ts`) as the 10-minute TTL cache (version = subscription `updated_at` ISO).
- Produces: `BillingOverviewService.overview(workspaceId): Promise<BillingOverview>` (interface verbatim from spec §5.8, exported from the service file), `invoices(workspaceId): Promise<{ invoices: ProviderInvoice[] }>` (24 rows, cached 10 min per subscription), `portalLink(workspaceId, intent): Promise<{ url: string }>` (never cached).
- Routes (all `billing:manage`, `JwtAuthGuard, WorkspaceRoleGuard`): `GET billing/workspaces/:workspaceId/overview`, `GET billing/workspaces/:workspaceId/invoices/provider`, `POST billing/workspaces/:workspaceId/portal-link` body `PortalLinkDto { intent: PortalIntent }`. Declare `invoices/provider` before any `invoices/:x` route in the class.
- Mapping rules: `status` = `free` (no subscription or FREE), `trialing`, `past_due`, `cancelled_at_period_end` (`cancelAtPeriodEnd`), else `active`; `renewsAt` = `currentPeriodEnd` unless cancelling, `endsAt` = `currentPeriodEnd` when cancelling; `card`/`billingDetails` from `getBillingProfile` (cached; a provider error yields `null`s, never a failed page); `paymentFailure` only for `past_due`: amount = newest `failed` provider invoice (fallback `nextInvoice.amountCents`), `graceUntil` = first unresolved `failed` alert (`billing_payment_alerts`, after the latest `recovered`) + `PAYMENT_GRACE_DAYS`; `nextInvoice` = base plan + active add-ons (`subscription_items`, as the dashboard computes `monthlyTotal`) at `renewsAt`, `null` when free or cancelling; `usage.aiCredits.byFeature` = `ai_usage_log` grouped by `operation` for the account's workspaces since the first of the month, `null` when empty; `resetsAt` = `getNextTokenResetDate()`.

- [ ] **Step 1: Write failing tests** (repositories and adapter mocked)
  - free account → `status: 'free'`, `card: null`, `nextInvoice: null`, `paymentFailure: null`.
  - active LS account → `card: { brand: 'visa', last4: '4242' }`, `nextInvoice.amountCents` = base + add-ons.
  - past_due with alerts failed(Nov 1) → recovered(Nov 3) → failed(Nov 10) → `graceUntil` = Nov 17.
  - `cancelAtPeriodEnd` → `status: 'cancelled_at_period_end'`, `endsAt` set, `renewsAt: null`.
  - provider profile throws → overview still resolves with `card: null`.
  - `invoices` second call within 10 min does not call the adapter again; a changed subscription `updated_at` refetches.
  - `portalLink` calls the adapter every time.
  - controller/remaining-guards: the three handlers map to `billing:manage`.
- [ ] **Step 2: Run** `npx jest src/billing src/workspace-members/remaining-workspace-guards.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the service and routes.
- [ ] **Step 4: Run** the specs, route guard specs, `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(billing): plan & billing overview, provider invoices, portal links`

---

### Task 21: Account delete (soft delete, anonymise, owned-workspace block)

**Files:**
- Create: `src/users/account-deletion.service.ts`, `src/users/dto/delete-account.dto.ts`
- Modify: `src/users/account-settings.controller.ts`, `src/users/users.controller.ts:90-95`, `src/users/users.module.ts`, `src/users/users.service.ts:159-182,417-425`, `src/auth/strategies/jwt.strategy.ts:59-80`, `jwt-refresh.strategy.ts:44-70`, `src/drizzle/schema/admin-audit-logs.schema.ts:11-19`
- Test: `src/users/account-deletion.db.spec.ts`, `src/users/users.module.order.spec.ts`, `src/auth/strategies/jwt.strategy.spec.ts`

**Interfaces:**
- Consumes: `SubscriptionService.cancelForAccount` (Task 16), `MyWorkspacesService` (Task 10), 0088 `deleted_at`, 0091 FKs.
- Produces: `DELETE /users/me` (Jwt, Throttle 3/h per user, tracker `'delete:' + userId`) body `DeleteAccountDto { confirmEmail: string }` → 204. `AccountDeletionService.deleteAccount(userId: string, input: { confirmEmail?: string; actor: 'self' | 'super_admin'; actorId: string }): Promise<void>`.
  - `400 EMAIL_MISMATCH` unless `normalizeEmail(confirmEmail) === normalizeEmail(user.email)` (skipped for `super_admin`).
  - `409 OWNS_WORKSPACES` with body `{ …, workspaces: [{ id, name }] }` while `workspace.owner_id = user` for any row.
  - `cancelForAccount(userId, false)` before the transaction; any throw → `502 BILLING_CANCEL_FAILED`, nothing written.
  - One transaction: memberships ACCEPTED/PENDING (by `user_id`, and PENDING by lower(email)) → `REMOVED` with `removed_by = user`, `removed_at = now` (member counts decremented through `usageService.decrementMemberCount` per workspace after commit); anonymise `users` (`email = 'deleted+' || id || '@deleted.invalid'`, `name`, `password`, `google_sub`, `avatar_url`, `pending_email`, `pending_email_code_hash`, `pending_email_expires_at`, `email_verification_token`, `password_reset_token` → NULL, `preferences = '{}'`, `is_active = false`, `deleted_at = now()`, `sessions_revoked_at = now()`, `last_login_ip`, `country`, `country_code` → NULL); delete personal rows per the table below; insert `admin_audit_logs` `{ action: 'user.self_delete' (or 'user.admin_delete'), actorId, targetType: 'user', targetId: userId, actorEmail: null, targetLabel: null }`.
- `DELETE /users/:id` becomes `@UseGuards(SuperAdminGuard)` and calls `deleteAccount(id, { actor: 'super_admin', actorId })`: no code path hard-deletes a user any more.
- `findOneWithSuspension` also returns `deletedAt`; both JWT strategies throw `401 { code: 'ACCOUNT_DELETED' }` when it is set (checked before the suspension check).

Personal-table classification (spec §13 #17; FK audit from `src/drizzle/schema/*.ts`):

| Delete (person's own data) | Keep (workspace data; FK SET NULL or row kept) | Anonymise |
|---|---|---|
| `known_devices`, `notification_preferences`, `planner_preferences`, `inbox_user_settings`, `insight_hidden_steps`, `feedback_dismissals`, `conversations` (Maestro chats, cascades `chat_messages`), `maestro_channel_links`, `maestro_bridge_threads`, `admin_login_challenges`, `canva_connections` where `user_id` = user (their Canva grant), `notifications` (bell rows), `channel_connect_links` created by the user that are still unused | posts, comments (`post_comments.user_id`), inbox notes/replies/assignments, media, campaigns, drips, short links, reports, calendar notes, saved replies, network requests, billing rows (`subscriptions` stays for history; cancelled above), `ai_usage_log`, `feedback` | `users` row (above) |

- [ ] **Step 1: Write failing tests**
  - DB (`withRollbackDb([0088…0091], …)`): user owning a workspace → 409 `OWNS_WORKSPACES` listing `{id,name}`, nothing changed.
  - DB: a member of two workspaces with a known device, notification prefs, a Maestro conversation, a post and a comment, who invited someone and changed a plan → after delete: both memberships `REMOVED`; `users.email = 'deleted+<id>@deleted.invalid'`, `name/password/google_sub/avatar_url` null, `is_active false`, `deleted_at` and `sessions_revoked_at` set; `known_devices`/`notification_preferences`/`conversations` rows gone; the post and comment still exist with the same author id; the invitation they sent still exists; one `admin_audit_logs` row; a new account can register with the old email (`INSERT INTO users (email) VALUES (<old>)` succeeds).
  - `confirmEmail` `' Old@Example.com '` matches `old@example.com`; `'other@x.com'` → 400 `EMAIL_MISMATCH`.
  - cancel throws → 502 `BILLING_CANCEL_FAILED` and the user row is untouched.
  - jwt strategy spec: a user with `deletedAt` → `ACCOUNT_DELETED`.
  - order spec: `Reflect.getMetadata('controllers', UsersModule)` lists `AccountSettingsController` before `UsersController` (so `DELETE /users/me` is not captured by `DELETE /users/:id`).
- [ ] **Step 2: Run** the specs. Expected: FAIL.
- [ ] **Step 3: Implement** as specified; add `'user.self_delete'` and `'user.admin_delete'` to `AUDIT_ACTIONS`.
- [ ] **Step 4: Run** `npx jest src/users src/auth`, the DB spec, `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `fix(account): soft-delete and anonymise accounts, block while owning workspaces`

---

### Task 22: Settings route capability matrix and branch verification

**Files:**
- Create: `src/workspace-members/settings-routes-capabilities.spec.ts`

**Interfaces:**
- Consumes: every route added in Tasks 10–20.

- [ ] **Step 1: Write the spec** (style of `remaining-workspace-guards.spec.ts`): a table `controller.handler → capability` for every §4.3 row: `WorkspaceController.findOne → settings:view`, `update → workspace:manage`, `presignLogo → workspace:manage`, `publishingDefaults → posts:draft`, `deletionPreview → workspace:delete`, `removePermanently → workspace:delete`; `WorkspaceMembersController.getMembers → team:view`, `getPendingInvitations`, `batchInvite`, `resendInvitation`, `getInviteLink`, `setInviteLink`, `resetInviteLink`, `updateMemberRole` → `team:manage`, `leaveWorkspace → none (OPEN_ROUTES)`; `LabelsController.list → posts:draft`, the five writes → `labels:manage`; `BillingController.getOverview`, `getProviderInvoices`, `createPortalLink`, `cancelSubscription → billing:manage`. Plus role assertions through `roleCan`: a GUEST is denied `settings:view`; a MEMBER is denied `workspace:manage`; an ADMIN is denied `workspace:delete` and `billing:manage`.
- [ ] **Step 2: Run** `npx jest src/workspace-members/settings-routes-capabilities.spec.ts`. Expected: PASS (it pins the rule; mutate one decorator locally to confirm it fails, then revert).
- [ ] **Step 3: Full verification**
Run: `npm run build && npm run lint && npx tsc --noEmit -p tsconfig.json && npx jest` then `PLANNER_DB_TESTS=1 npx jest --runInBand src/drizzle/migrate src/users src/labels src/workspace src/workspace-members src/notification-preferences src/planner src/posts/composer`
Expected: all green; the pre-existing FE-side Inbox time-bomb is not in this repo.
- [ ] **Step 4: Commit** — `test(settings): pin the Part A route capability matrix`

---

## Contract summary for the FE plan (stable after the named task)

| Task | Contract |
|---|---|
| 1 | three capabilities |
| 6 | `PublicUser.hasGoogle`, `passwordChangedAt`; `ChangePasswordDto.revokeOtherSessions` |
| 7 | `GET/PATCH /users/me/preferences` |
| 8 | `GET/PUT /users/me/notifications/pause` |
| 9 | `POST /users/me/google/disconnect` |
| 10 | `GET /users/me/workspaces`, `DELETE /workspace-members/:ws/members/me` |
| 11–12 | `/labels/workspaces/:ws…`, `PlannerPostDto.labelIds`, Planner `list?labels=` |
| 13–16 | `GET/PATCH /workspace/:ws`, logo presign, publishing-defaults, deletion-preview, `DELETE …/permanent {confirmName}`, cancel `reason` |
| 17–18 | members `lastActiveAt`, invitation list fields, `message`, resend, invite link, `/invitations/join/:code` |
| 20 | `GET …/overview`, `GET …/invoices/provider`, `POST …/portal-link` |
| 21 | `DELETE /users/me {confirmEmail}` |
