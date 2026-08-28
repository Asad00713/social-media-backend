# Unify Workspace Role Guards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `workspace-members` authorization onto the shared `WorkspaceRoleGuard` + `@RequireCapability` mechanism (as `channels` already uses), with a new `team:view` capability so any member can see the roster while only ADMIN+ can manage it, making the capability map the single source of truth.

**Architecture:** NestJS. A declarative `WorkspaceRoleGuard` reads `@RequireCapability(cap)` metadata, resolves the caller's workspace role via `WorkspaceRoleService.getRole`, and checks it against the rank-based `role-capabilities.ts` map. This plan (1) adds `team:view` to the map, (2) makes the guard super-admin-aware, (3) wires the guard onto the members controller's workspace-scoped routes per a fixed endpoint→capability table, keeping existing service-layer checks as defense-in-depth, and (4) mirrors the map addition on the frontend.

**Tech Stack:** NestJS, Drizzle ORM, class-validator, Jest (BE) · React 19 + Vite + Vitest (FE).

**Spec:** `socialmedia-workspace/docs/superpowers/specs/2026-08-18-unify-workspace-role-guards-design.md`

## Global Constraints

- Two repos: BE `socialmedia-workspace`, FE `socialmedia-frontend`. Both on branch `feat/unify-workspace-role-guards`.
- The BE `role-capabilities.ts` map and FE `capabilities.ts` map MUST stay byte-identical in their `Capability` union and `CAPABILITY_MIN_ROLE` object. Any change to one is mirrored to the other in the same effort.
- `WorkspaceRoleGuard` can ONLY guard routes that carry `:workspaceId` AND run behind `JwtAuthGuard` (it reads `req.user.userId` + `req.params.workspaceId`). Never apply `@RequireCapability` to token- or "me"-scoped routes.
- Guard order on a method is `@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)` — `JwtAuthGuard` first so `req.user` exists. Method-level `@UseGuards` replaces the class-level guard for that handler, so re-list `JwtAuthGuard` explicitly.
- The guard is ADDITIVE: existing inline service checks (`isOwner || isAdmin`, `isSelf`, `isInviter`, super-admin) stay in place. Do NOT delete them.
- `removeMember` must remain reachable by a non-manager removing THEIR OWN row (self-removal), so it does NOT get `@RequireCapability('team:manage')`.
- No DB migration. No new roles. `channels.controller.ts` is untouched.
- Never `git add .` / `-A` (FE `.env` is tracked with secrets; BE `.env` gitignored with secrets). Surgical `git add <path>` only. Commit only; do not push (controller handles finishing).
- Verify BE compiles (`npm run build` in `socialmedia-workspace`) and tests pass (`npm test`); FE tests pass (`npm test` / vitest in `socialmedia-frontend`).

---

### Task 1: Add `team:view` capability (BE + FE map, mirrored) + unit tests

**Files:**
- Modify: `socialmedia-workspace/src/workspace-members/role-capabilities.ts`
- Modify: `socialmedia-workspace/src/workspace-members/role-capabilities.spec.ts`
- Modify: `socialmedia-frontend/src/features/team/utils/capabilities.ts`
- Modify: `socialmedia-frontend/src/features/team/utils/capabilities.test.ts`

**Interfaces:**
- Produces: `Capability` union now includes `'team:view'`; `CAPABILITY_MIN_ROLE['team:view'] === 'GUEST'`. Used by Task 3 (`@RequireCapability('team:view')` on `getMembers`) and by the guard.

- [ ] **Step 1: Update the BE capability map**

In `socialmedia-workspace/src/workspace-members/role-capabilities.ts`, add `'team:view'` to the `Capability` union (place it just above `'team:manage'` for readability) and add its min-role entry to `CAPABILITY_MIN_ROLE`:

```ts
export type Capability =
  | 'billing:manage'
  | 'workspace:delete'
  | 'team:view'
  | 'team:manage'
  | 'channels:manage'
  | 'posts:publish'
  | 'inbox:reply'
  | 'posts:draft'
  | 'inbox:view'
  | 'analytics:view';
```

```ts
export const CAPABILITY_MIN_ROLE: Record<Capability, WorkspaceRole> = {
  'billing:manage': 'OWNER',
  'workspace:delete': 'OWNER',
  'team:view': 'GUEST',
  'team:manage': 'ADMIN',
  'channels:manage': 'MEMBER',
  'posts:publish': 'MEMBER',
  'inbox:reply': 'MEMBER',
  'posts:draft': 'GUEST',
  'inbox:view': 'GUEST',
  'analytics:view': 'GUEST',
};
```

- [ ] **Step 2: Mirror the change on the FE map**

In `socialmedia-frontend/src/features/team/utils/capabilities.ts`, make the identical edit to the `Capability` union and `CAPABILITY_MIN_ROLE`. The two objects must match byte-for-byte in their entries.

- [ ] **Step 3: Write BE tests (add to existing spec)**

Append to `socialmedia-workspace/src/workspace-members/role-capabilities.spec.ts`:

```ts
it('lets any member view the team (team:view floor is GUEST)', () => {
  expect(roleCan('GUEST', 'team:view')).toBe(true);
  expect(roleCan('MEMBER', 'team:view')).toBe(true);
  expect(roleCan('ADMIN', 'team:view')).toBe(true);
  expect(roleCan('OWNER', 'team:view')).toBe(true);
});

it('keeps team management ADMIN+ (a viewer cannot manage)', () => {
  expect(roleCan('GUEST', 'team:manage')).toBe(false);
  expect(roleCan('MEMBER', 'team:manage')).toBe(false);
  expect(roleCan('ADMIN', 'team:manage')).toBe(true);
});
```

(If `role-capabilities.spec.ts` does not exist yet, create it importing `roleCan` from `./role-capabilities` and add the two `it` blocks inside a `describe('role-capabilities', () => { ... })`.)

- [ ] **Step 4: Write FE tests (add to existing spec)**

Append to `socialmedia-frontend/src/features/team/utils/capabilities.test.ts` the mirrored cases (same `roleCan` import from `./capabilities`):

```ts
it('lets any member view the team (team:view floor is GUEST)', () => {
  expect(roleCan('GUEST', 'team:view')).toBe(true)
  expect(roleCan('ADMIN', 'team:view')).toBe(true)
})

it('keeps team management ADMIN+ (viewer cannot manage)', () => {
  expect(roleCan('GUEST', 'team:manage')).toBe(false)
  expect(roleCan('ADMIN', 'team:manage')).toBe(true)
})
```

- [ ] **Step 5: Run tests**

Run (BE): `cd socialmedia-workspace && npx jest role-capabilities`
Expected: PASS.
Run (FE): `cd socialmedia-frontend && npx vitest run capabilities`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
# in socialmedia-workspace
git add src/workspace-members/role-capabilities.ts src/workspace-members/role-capabilities.spec.ts
git commit -m "feat(rbac): add team:view capability (GUEST can see roster)"
# in socialmedia-frontend
git add src/features/team/utils/capabilities.ts src/features/team/utils/capabilities.test.ts
git commit -m "feat(rbac): mirror team:view capability on frontend map"
```

---

### Task 2: Make `WorkspaceRoleGuard` super-admin-aware (single shared `isPlatformSuperAdmin`)

**Files:**
- Modify: `socialmedia-workspace/src/workspace-members/workspace-role.service.ts`
- Modify: `socialmedia-workspace/src/workspace-members/workspace-role.guard.ts`
- Modify: `socialmedia-workspace/src/workspace-members/workspace-role.guard.spec.ts`
- Modify: `socialmedia-workspace/src/workspace-members/workspace-members.service.ts` (delegate its private helper to the shared one)

**Interfaces:**
- Consumes: `WorkspaceRoleService.getRole(workspaceId, userId)` (existing).
- Produces: `WorkspaceRoleService.isPlatformSuperAdmin(userId): Promise<boolean>` (new, public). `WorkspaceRoleGuard` passes when it returns true even if `getRole` was null/insufficient.

- [ ] **Step 1: Add the failing guard test**

In `socialmedia-workspace/src/workspace-members/workspace-role.guard.spec.ts`, add a test that a platform super-admin (null workspace role) passes a capability-required route. The guard constructor is `new WorkspaceRoleGuard(reflector, roleService)`. Build a `roleService` stub whose `getRole` resolves `null` and whose `isPlatformSuperAdmin` resolves `true`:

```ts
it('passes a platform super-admin even with no workspace role', async () => {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue('team:manage') } as any;
  const roleSvc = {
    getRole: jest.fn().mockResolvedValue(null),
    isPlatformSuperAdmin: jest.fn().mockResolvedValue(true),
  } as any;
  const guard = new WorkspaceRoleGuard(reflector, roleSvc);
  const ctx = {
    switchToHttp: () => ({ getRequest: () => ({ user: { userId: 'sa' }, params: { workspaceId: 'w1' } }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as any;
  await expect(guard.canActivate(ctx)).resolves.toBe(true);
});
```

Also update any EXISTING guard tests whose `roleService` stub lacks `isPlatformSuperAdmin`: give those stubs `isPlatformSuperAdmin: jest.fn().mockResolvedValue(false)` so the insufficient-role tests still reach the throw. (The guard calls `isPlatformSuperAdmin` only on the failure path, so stubs for the "role sufficient → pass" tests do not strictly need it, but add it to any stub used by a test that expects a throw.)

- [ ] **Step 2: Run it, verify it fails**

Run: `cd socialmedia-workspace && npx jest workspace-role.guard`
Expected: FAIL — `isPlatformSuperAdmin is not a function` on the service, or the new test throws instead of passing.

- [ ] **Step 3: Add `isPlatformSuperAdmin` to `WorkspaceRoleService`**

In `workspace-role.service.ts`, import `users` from the schema (alongside `workspace, workspaceInvitation`) and add:

```ts
async isPlatformSuperAdmin(userId: string): Promise<boolean> {
  const user = await this.db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { role: true },
  });
  return user?.role === 'SUPER_ADMIN';
}
```

(Add `users` to the existing `import { workspace, workspaceInvitation } from 'src/drizzle/schema';` line → `import { users, workspace, workspaceInvitation } from 'src/drizzle/schema';`.)

- [ ] **Step 4: Make the guard consult it before throwing**

In `workspace-role.guard.ts`, change the final block so a super-admin passes. Replace:

```ts
    const role = await this.roleService.getRole(workspaceId, userId);
    if (!role || !roleCan(role, cap)) {
      throw new ForbiddenException(
        'You do not have permission to perform this action in this workspace',
      );
    }
    return true;
```

with:

```ts
    const role = await this.roleService.getRole(workspaceId, userId);
    if (role && roleCan(role, cap)) {
      return true;
    }
    // Platform super admins are not workspace members, so getRole returns null
    // for them. Let them through anyway (support/admin tooling), mirroring the
    // service-layer isPlatformSuperAdmin allowance. This lookup runs only on the
    // failure path, keeping it off the hot path for normal members.
    if (await this.roleService.isPlatformSuperAdmin(userId)) {
      return true;
    }
    throw new ForbiddenException(
      'You do not have permission to perform this action in this workspace',
    );
```

- [ ] **Step 5: Delegate the members service's private helper to the shared one**

In `workspace-members.service.ts`, the class has a private `isPlatformSuperAdmin(userId)` doing the same `users.role === 'SUPER_ADMIN'` query. Inject `WorkspaceRoleService` (it's already exported by `WorkspaceRoleModule`, which `WorkspaceMembersModule` imports) and make the private method delegate, so there is one implementation:

  - Add to the constructor params: `private roleService: WorkspaceRoleService,` and import `WorkspaceRoleService` from `./workspace-role.service`.
  - Replace the body of the existing private `isPlatformSuperAdmin` with: `return this.roleService.isPlatformSuperAdmin(userId);` (keep the method + its doc comment so call sites are unchanged).

- [ ] **Step 6: Run tests + build**

Run: `cd socialmedia-workspace && npx jest workspace-role.guard workspace-members && npm run build`
Expected: PASS + build OK.

- [ ] **Step 7: Commit**

```bash
git add src/workspace-members/workspace-role.service.ts src/workspace-members/workspace-role.guard.ts src/workspace-members/workspace-role.guard.spec.ts src/workspace-members/workspace-members.service.ts
git commit -m "feat(rbac): make WorkspaceRoleGuard super-admin aware via shared helper"
```

---

### Task 3: Wire the guard onto `WorkspaceMembersController` per the endpoint table

**Files:**
- Modify: `socialmedia-workspace/src/workspace-members/workspace-members.controller.ts`

**Interfaces:**
- Consumes: `WorkspaceRoleGuard` (from `./workspace-role.guard`), `RequireCapability` (from `./require-capability.decorator`), `JwtAuthGuard` (already imported), capabilities `'team:view'` / `'team:manage'` from Task 1.

- [ ] **Step 1: Add imports**

At the top of `workspace-members.controller.ts`, add:

```ts
import { UseGuards } from '@nestjs/common'; // already imported — confirm, do not duplicate
import { WorkspaceRoleGuard } from './workspace-role.guard';
import { RequireCapability } from './require-capability.decorator';
```

(`UseGuards` and `JwtAuthGuard` are already imported. Add only the two new imports.)

- [ ] **Step 2: Decorate the workspace-scoped routes**

Apply per this exact table. For each listed method add the two decorators directly above the existing `@Post/@Get/@Patch/@Delete(...)` (method-level `@UseGuards` re-lists `JwtAuthGuard`):

| Method | Decorators to add |
|---|---|
| `inviteMember` (`@Post(':workspaceId/invitations')`) | `@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)` + `@RequireCapability('team:manage')` |
| `batchInvite` (`@Post(':workspaceId/invitations/batch')`) | `@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)` + `@RequireCapability('team:manage')` |
| `getPendingInvitations` (`@Get(':workspaceId/invitations')`) | `@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)` + `@RequireCapability('team:manage')` |
| `cancelInvitation` (`@Delete(':workspaceId/invitations/:invitationId')`) | `@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)` + `@RequireCapability('team:manage')` |
| `getMembers` (`@Get(':workspaceId/members')`) | `@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)` + `@RequireCapability('team:view')` |
| `updateMemberRole` (`@Patch(':workspaceId/members/:memberId')`) | `@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)` + `@RequireCapability('team:manage')` |

Example (inviteMember):

```ts
  @Post(':workspaceId/invitations')
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequireCapability('team:manage')
  inviteMember(
```

- [ ] **Step 3: Do NOT decorate these**

Leave WITHOUT `@RequireCapability` / `WorkspaceRoleGuard` (they keep only the class-level `JwtAuthGuard`):
- `removeMember` (`@Delete(':workspaceId/members/:memberId')`) — self-removal must work; its inline `isSelf || isOwner || isAdmin || isSuperAdmin` check is the correct policy.
- `getMyInvitations` (`@Get('invitations/me')`) — no `:workspaceId`.
- `acceptInvitation` (`@Post('invitations/accept')`) — token-scoped, no `:workspaceId`.
- `rejectInvitation` (`@Post('invitations/reject')`) — token-scoped, no `:workspaceId`.

Add a short comment above `removeMember` noting why it is intentionally guard-free:

```ts
  // No @RequireCapability here: a member/guest must be able to remove THEIR OWN
  // row (leave the workspace), which a team:manage gate would block. The
  // service's isSelf || owner || admin || super-admin check is the real policy.
```

- [ ] **Step 4: Build + run the module's tests**

Run: `cd socialmedia-workspace && npm run build && npx jest workspace-members workspace-role`
Expected: build OK, tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workspace-members/workspace-members.controller.ts
git commit -m "feat(rbac): enforce team:view/team:manage on workspace-members routes"
```

---

### Task 4: Full verification pass (both repos)

**Files:** none (verification only).

- [ ] **Step 1: BE full build + test**

Run: `cd socialmedia-workspace && npm run build && npm test`
Expected: build OK; full Jest suite green (or pre-existing unrelated failures only — note them, do not fix out of scope).

- [ ] **Step 2: FE full test**

Run: `cd socialmedia-frontend && npm test`
Expected: vitest suite green.

- [ ] **Step 3: FE build**

Run: `cd socialmedia-frontend && npm run build`
Expected: `tsc -b && vite build` OK — confirms the `team:view` addition typechecks against every `Capability` consumer.

- [ ] **Step 4: Record result in the ledger** (no commit — verification only). If anything failed, surface it before the whole-branch review.
