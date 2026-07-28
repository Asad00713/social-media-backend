# Team Invitations — Phase 2: Roles, Capability Gating & My-Invitations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Reconcile the role enum, add a single-source-of-truth capability map + backend role guard enforcing it, mirror it on the frontend to hide/disable actions by role, and surface a "my invitations" inbox.

**Architecture:** Membership = `workspace_invitations` rows with status ACCEPTED; role on the row; OWNER = `workspace.ownerId`. A `WorkspaceRoleService.getRole()` resolves the caller's role; a `WorkspaceRoleGuard` + `@RequireCapability()` enforces a capability→min-role map on mutating endpoints. The frontend mirrors the same map via `useWorkspaceRole()` + `can()`.

**Tech Stack:** NestJS + Drizzle (Jest); Vite + React 19 + shadcn/ui + TanStack Query (vitest).

**Runs on:** the existing `feat/team-invitations` branch in both worktrees (`_wt-team-inv`, `_wt-team-inv-fe`). Phase 1 is already committed there.

## Global Constraints

- **No DB schema migration.** The DB `member_role` enum is already `['ADMIN','MEMBER','GUEST']` — canonical role VALUE is `GUEST` (not `VIEWER`). Reconcile code to it; do NOT run `db:generate`/`db:push`.
- **Canonical wire/DB value = `GUEST`.** UI display label stays "Viewer" (existing copy) — value and label are separate.
- Capability map is ONE source of truth, mirrored backend↔frontend; invite-dialog/role-menu permission copy derives from it.
- Backend guard = real security; UI gating (hide/disable) mirrors it but is never the only boundary.
- Auth is opt-in per controller (no global guard). Stage ONLY named files; never `git add -A`/`.`; never stage `.env`.
- ROLE_RANK: OWNER=4, ADMIN=3, MEMBER=2, GUEST=1. Capabilities:
  `billing:manage`→OWNER, `workspace:delete`→OWNER, `team:manage`→ADMIN, `channels:manage`→MEMBER, `posts:publish`→MEMBER, `inbox:reply`→MEMBER, `posts:draft`→GUEST, `inbox:view`→GUEST, `analytics:view`→GUEST.

---

### Task 1: Reconcile role enum VIEWER → GUEST (fixes live 500 on third-role invites)

**Bug:** backend `MemberRole` DTO enum uses `VIEWER`, but the DB `member_role` pgEnum is `GUEST`. Inviting the third role inserts `'VIEWER'` into a `{ADMIN,MEMBER,GUEST}` column → runtime DB error. Frontend also sends `VIEWER`.

**Files:**
- Modify: `_wt-team-inv/src/workspace-members/dto/add-member.dto.ts` (enum VIEWER→GUEST)
- Modify: `_wt-team-inv-fe/src/features/team/schemas/invite-member.schema.ts` (VIEWER→GUEST)
- Modify: `_wt-team-inv-fe/src/features/team/types/team.ts` (role unions VIEWER→GUEST; keep a `DisplayRole` if present)
- Modify: `_wt-team-inv-fe/src/features/team/utils/role.ts` (map value GUEST, label "Viewer")
- Test: `_wt-team-inv/src/workspace-members/dto/add-member.dto.spec.ts` (create)

- [ ] **Step 1 (backend test):**
```ts
// add-member.dto.spec.ts
import { MemberRole } from './add-member.dto';
describe('MemberRole enum', () => {
  it('matches the DB member_role enum values', () => {
    expect(Object.values(MemberRole).sort()).toEqual(['ADMIN', 'GUEST', 'MEMBER']);
    expect((MemberRole as Record<string, string>).VIEWER).toBeUndefined();
  });
});
```
- [ ] **Step 2:** Run `cd "d:/My Documents/MyProjects/FullStackProjects/_wt-team-inv" && npx jest src/workspace-members/dto/add-member.dto.spec.ts` → FAIL (VIEWER present).
- [ ] **Step 3 (backend):** In `add-member.dto.ts` change the enum member `VIEWER = 'VIEWER'` → `GUEST = 'GUEST'`.
- [ ] **Step 4:** Re-run the spec → PASS. Then `npm run build` → PASS.
- [ ] **Step 5 (frontend):** In `invite-member.schema.ts`: `z.enum(['ADMIN', 'MEMBER', 'GUEST'])`. In `types/team.ts`: replace `VIEWER` with `GUEST` in `MemberRole` (and in `DisplayRole` if it lists it). In `role.ts`: change `ASSIGNABLE_ROLES` to `['ADMIN','MEMBER','GUEST']`, and in `roleIcon`/`roleLabel`/`roleDescription` rename the `VIEWER` case to `GUEST` but keep the LABEL string `'Viewer'` (i.e. `case 'GUEST': return 'Viewer'`). Default the invite form + any `defaultValues: { role: 'MEMBER' }` unchanged.
- [ ] **Step 6:** `cd "d:/My Documents/MyProjects/FullStackProjects/_wt-team-inv-fe" && npm run build` → PASS. Grep to confirm no stray `VIEWER` value remains in team feature: `grep -rn "VIEWER" src/features/team` should only show it inside a label string if at all.
- [ ] **Step 7 (commit each repo separately):**
```
cd "d:/My Documents/MyProjects/FullStackProjects/_wt-team-inv" && git add src/workspace-members/dto/add-member.dto.ts src/workspace-members/dto/add-member.dto.spec.ts && git commit -m "fix(members): canonical role value GUEST (was VIEWER, broke DB insert)"
cd "d:/My Documents/MyProjects/FullStackProjects/_wt-team-inv-fe" && git add src/features/team/schemas/invite-member.schema.ts src/features/team/types/team.ts src/features/team/utils/role.ts && git commit -m "fix(team): role value GUEST to match backend enum (label stays Viewer)"
```

---

### Task 2: Backend capability map + ROLE_RANK

**Files:**
- Create: `_wt-team-inv/src/workspace-members/role-capabilities.ts`
- Test: `_wt-team-inv/src/workspace-members/role-capabilities.spec.ts`

**Produces:** `type WorkspaceRole = 'OWNER'|'ADMIN'|'MEMBER'|'GUEST'`; `type Capability` (the 9 strings); `ROLE_RANK`; `CAPABILITY_MIN_ROLE`; `roleCan(role, capability): boolean`.

- [ ] **Step 1 (test):**
```ts
import { roleCan, CAPABILITY_MIN_ROLE } from './role-capabilities';
describe('roleCan', () => {
  it('OWNER can everything', () => {
    for (const cap of Object.keys(CAPABILITY_MIN_ROLE)) {
      expect(roleCan('OWNER', cap as any)).toBe(true);
    }
  });
  it('MEMBER can publish + channels but not team/billing', () => {
    expect(roleCan('MEMBER', 'posts:publish')).toBe(true);
    expect(roleCan('MEMBER', 'channels:manage')).toBe(true);
    expect(roleCan('MEMBER', 'team:manage')).toBe(false);
    expect(roleCan('MEMBER', 'billing:manage')).toBe(false);
  });
  it('GUEST is view/draft only', () => {
    expect(roleCan('GUEST', 'analytics:view')).toBe(true);
    expect(roleCan('GUEST', 'posts:draft')).toBe(true);
    expect(roleCan('GUEST', 'posts:publish')).toBe(false);
    expect(roleCan('GUEST', 'inbox:reply')).toBe(false);
  });
  it('ADMIN cannot manage billing', () => {
    expect(roleCan('ADMIN', 'team:manage')).toBe(true);
    expect(roleCan('ADMIN', 'billing:manage')).toBe(false);
  });
});
```
- [ ] **Step 2:** Run → FAIL (module missing).
- [ ] **Step 3 (impl):**
```ts
export type WorkspaceRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST';
export type Capability =
  | 'billing:manage' | 'workspace:delete' | 'team:manage'
  | 'channels:manage' | 'posts:publish' | 'inbox:reply'
  | 'posts:draft' | 'inbox:view' | 'analytics:view';

export const ROLE_RANK: Record<WorkspaceRole, number> = {
  OWNER: 4, ADMIN: 3, MEMBER: 2, GUEST: 1,
};

export const CAPABILITY_MIN_ROLE: Record<Capability, WorkspaceRole> = {
  'billing:manage': 'OWNER',
  'workspace:delete': 'OWNER',
  'team:manage': 'ADMIN',
  'channels:manage': 'MEMBER',
  'posts:publish': 'MEMBER',
  'inbox:reply': 'MEMBER',
  'posts:draft': 'GUEST',
  'inbox:view': 'GUEST',
  'analytics:view': 'GUEST',
};

export function roleCan(role: WorkspaceRole, capability: Capability): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[CAPABILITY_MIN_ROLE[capability]];
}
```
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5 (commit):**
```
cd "d:/My Documents/MyProjects/FullStackProjects/_wt-team-inv" && git add src/workspace-members/role-capabilities.ts src/workspace-members/role-capabilities.spec.ts && git commit -m "feat(members): capability map + roleCan"
```

---

### Task 3: WorkspaceRoleService.getRole

**Files:**
- Create: `_wt-team-inv/src/workspace-members/workspace-role.service.ts`
- Modify: `_wt-team-inv/src/workspace-members/workspace-members.module.ts` (provide + export it)
- Test: `_wt-team-inv/src/workspace-members/workspace-role.service.spec.ts`

**Produces:** `WorkspaceRoleService.getRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null>` — OWNER if `workspace.ownerId===userId`; else the ACCEPTED invitation's role; else null.

- [ ] **Step 1 (test):**
```ts
import { WorkspaceRoleService } from './workspace-role.service';
describe('WorkspaceRoleService.getRole', () => {
  const svc = (db: any) => new WorkspaceRoleService(db);
  it('returns OWNER for the workspace owner', async () => {
    const db: any = { query: { workspace: { findFirst: jest.fn().mockResolvedValue({ id: 'w', ownerId: 'u1' }) },
      workspaceInvitation: { findFirst: jest.fn() } } };
    expect(await svc(db).getRole('w', 'u1')).toBe('OWNER');
  });
  it('returns the accepted invitation role', async () => {
    const db: any = { query: { workspace: { findFirst: jest.fn().mockResolvedValue({ id: 'w', ownerId: 'owner' }) },
      workspaceInvitation: { findFirst: jest.fn().mockResolvedValue({ role: 'ADMIN', status: 'ACCEPTED' }) } } };
    expect(await svc(db).getRole('w', 'u2')).toBe('ADMIN');
  });
  it('returns null for a non-member', async () => {
    const db: any = { query: { workspace: { findFirst: jest.fn().mockResolvedValue({ id: 'w', ownerId: 'owner' }) },
      workspaceInvitation: { findFirst: jest.fn().mockResolvedValue(undefined) } } };
    expect(await svc(db).getRole('w', 'nobody')).toBeNull();
  });
});
```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3 (impl):**
```ts
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { DbType } from 'src/drizzle/db';
import { DRIZZLE } from 'src/drizzle/drizzle.module';
import { workspace, workspaceInvitation } from 'src/drizzle/schema';
import type { WorkspaceRole } from './role-capabilities';

@Injectable()
export class WorkspaceRoleService {
  constructor(@Inject(DRIZZLE) private db: DbType) {}

  async getRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
    const ws = await this.db.query.workspace.findFirst({ where: eq(workspace.id, workspaceId) });
    if (!ws) return null;
    if (ws.ownerId === userId) return 'OWNER';
    const inv = await this.db.query.workspaceInvitation.findFirst({
      where: and(
        eq(workspaceInvitation.workspaceId, workspaceId),
        eq(workspaceInvitation.userId, userId),
        eq(workspaceInvitation.status, 'ACCEPTED'),
      ),
    });
    return (inv?.role as WorkspaceRole) ?? null;
  }
}
```
Register in `workspace-members.module.ts`: add `WorkspaceRoleService` to `providers` AND `exports`.
- [ ] **Step 4:** Run spec → PASS; `npm run build` → PASS.
- [ ] **Step 5 (commit):**
```
cd "d:/My Documents/MyProjects/FullStackProjects/_wt-team-inv" && git add src/workspace-members/workspace-role.service.ts src/workspace-members/workspace-role.service.spec.ts src/workspace-members/workspace-members.module.ts && git commit -m "feat(members): WorkspaceRoleService.getRole"
```

---

### Task 4: WorkspaceRoleGuard + @RequireCapability decorator

**Files:**
- Create: `_wt-team-inv/src/workspace-members/require-capability.decorator.ts`
- Create: `_wt-team-inv/src/workspace-members/workspace-role.guard.ts`
- Modify: `_wt-team-inv/src/workspace-members/workspace-members.module.ts` (provide + export the guard)
- Test: `_wt-team-inv/src/workspace-members/workspace-role.guard.spec.ts`

**Produces:** `@RequireCapability(cap: Capability)`; `WorkspaceRoleGuard` — reads `workspaceId` from `req.params.workspaceId` (fallback `req.params.wsId`/`req.params.wid`), resolves role via `WorkspaceRoleService`, allows iff `roleCan(role, cap)`; 403 otherwise. Requires a prior `JwtAuthGuard` (uses `req.user.userId`).

- [ ] **Step 1 (test):**
```ts
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WorkspaceRoleGuard } from './workspace-role.guard';

function ctx(params: any, user: any): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ params, user }) }), getHandler: () => ({}), getClass: () => ({}) } as any;
}
describe('WorkspaceRoleGuard', () => {
  const reflector = { getAllAndOverride: jest.fn() } as unknown as Reflector;
  it('allows when role satisfies the capability', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue('posts:publish');
    const roleSvc = { getRole: jest.fn().mockResolvedValue('MEMBER') } as any;
    const guard = new WorkspaceRoleGuard(reflector, roleSvc);
    await expect(guard.canActivate(ctx({ workspaceId: 'w' }, { userId: 'u' }))).resolves.toBe(true);
  });
  it('denies when role is too low', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue('team:manage');
    const roleSvc = { getRole: jest.fn().mockResolvedValue('MEMBER') } as any;
    const guard = new WorkspaceRoleGuard(reflector, roleSvc);
    await expect(guard.canActivate(ctx({ workspaceId: 'w' }, { userId: 'u' }))).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('passes through when no capability metadata is set', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(undefined);
    const guard = new WorkspaceRoleGuard(reflector, { getRole: jest.fn() } as any);
    await expect(guard.canActivate(ctx({}, { userId: 'u' }))).resolves.toBe(true);
  });
});
```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3 (impl):**
`require-capability.decorator.ts`:
```ts
import { SetMetadata } from '@nestjs/common';
import type { Capability } from './role-capabilities';
export const REQUIRE_CAPABILITY = 'require_capability';
export const RequireCapability = (cap: Capability) => SetMetadata(REQUIRE_CAPABILITY, cap);
```
`workspace-role.guard.ts`:
```ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRE_CAPABILITY } from './require-capability.decorator';
import { roleCan, type Capability } from './role-capabilities';
import { WorkspaceRoleService } from './workspace-role.service';

@Injectable()
export class WorkspaceRoleGuard implements CanActivate {
  constructor(private reflector: Reflector, private roleService: WorkspaceRoleService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const cap = this.reflector.getAllAndOverride<Capability | undefined>(REQUIRE_CAPABILITY, [
      context.getHandler(), context.getClass(),
    ]);
    if (!cap) return true; // no capability required on this route
    const req = context.switchToHttp().getRequest();
    const userId = req.user?.userId;
    const workspaceId = req.params?.workspaceId ?? req.params?.wsId ?? req.params?.wid;
    if (!userId || !workspaceId) throw new ForbiddenException('Cannot resolve workspace role');
    const role = await this.roleService.getRole(workspaceId, userId);
    if (!role || !roleCan(role, cap)) {
      throw new ForbiddenException('You do not have permission to perform this action in this workspace');
    }
    return true;
  }
}
```
Register both `WorkspaceRoleGuard` and `WorkspaceRoleService` in the module `providers` (and export the guard) — `Reflector` is available from `@nestjs/core` automatically.
- [ ] **Step 4:** Run spec → PASS; `npm run build` → PASS.
- [ ] **Step 5 (commit):**
```
cd "d:/My Documents/MyProjects/FullStackProjects/_wt-team-inv" && git add src/workspace-members/require-capability.decorator.ts src/workspace-members/workspace-role.guard.ts src/workspace-members/workspace-members.module.ts src/workspace-members/workspace-role.guard.spec.ts && git commit -m "feat(members): WorkspaceRoleGuard + RequireCapability"
```

---

### Task 5: Apply the guard to channels endpoints (highest-value, self-contained)

**Scope note:** This task gates the CHANNELS module (connect/create/delete = `channels:manage`, MEMBER+). Posts/inbox/billing gating are deferred to a Phase-2b follow-up to keep this task's blast radius reviewable; the guard + map are reusable for them. Record that deferral in the progress ledger.

**Files:**
- Modify: `_wt-team-inv/src/channels/channels.controller.ts` (add guard + `@RequireCapability('channels:manage')` on mutating routes that carry a workspaceId param)
- Modify: `_wt-team-inv/src/channels/channels.module.ts` (import `WorkspaceMembersModule` so the guard/service are available)
- Test: none new (guard already unit-tested); verification is build + manual.

- [ ] **Step 1:** Read `channels.controller.ts`. Identify mutating routes whose path includes a workspace id param (e.g. connect/create/disconnect/delete under `workspaces/:workspaceId`). For EACH such route add `@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)` (JwtAuthGuard first so `req.user` is set) — or, if the controller already has a class-level `@UseGuards(JwtAuthGuard)`, add a method-level `@UseGuards(WorkspaceRoleGuard)` and `@RequireCapability('channels:manage')`. Do NOT gate GET/read routes.
- [ ] **Step 2:** In `channels.module.ts` add `WorkspaceMembersModule` to `imports` (it exports `WorkspaceRoleService` + `WorkspaceRoleGuard`). Watch for circular-import: if `WorkspaceMembersModule` imports something that imports `ChannelsModule`, use `forwardRef(() => WorkspaceMembersModule)` on both sides. Confirm by building.
- [ ] **Step 3:** `cd "d:/My Documents/MyProjects/FullStackProjects/_wt-team-inv" && npm run build` → PASS (resolves guard DI).
- [ ] **Step 4 (manual sanity, code-inspection):** confirm only mutating workspace-scoped routes got `@RequireCapability('channels:manage')`; read routes untouched.
- [ ] **Step 5 (commit):**
```
cd "d:/My Documents/MyProjects/FullStackProjects/_wt-team-inv" && git add src/channels/channels.controller.ts src/channels/channels.module.ts && git commit -m "feat(channels): gate connect/disconnect behind channels:manage"
```

---

### Task 6: Frontend capability map mirror + useWorkspaceRole + can()

**Files:**
- Create: `_wt-team-inv-fe/src/features/team/utils/capabilities.ts`
- Create: `_wt-team-inv-fe/src/features/team/hooks/use-workspace-role.ts`
- Modify: `_wt-team-inv-fe/src/features/team/utils/role.ts` (rewrite `roleDescription` to derive from the capability map)
- Test: `_wt-team-inv-fe/src/features/team/utils/capabilities.test.ts`

**Produces:** mirror of `ROLE_RANK`/`CAPABILITY_MIN_ROLE`/`roleCan` (identical values to backend), `roleCapabilitySummary(role): string`, and `useWorkspaceRole(workspaceId)` returning `{ role, can }`.

- [ ] **Step 1 (test):**
```ts
import { describe, it, expect } from 'vitest'
import { roleCan, roleCapabilitySummary } from './capabilities'

describe('capabilities mirror', () => {
  it('matches the backend matrix', () => {
    expect(roleCan('MEMBER', 'channels:manage')).toBe(true)
    expect(roleCan('MEMBER', 'team:manage')).toBe(false)
    expect(roleCan('GUEST', 'posts:publish')).toBe(false)
    expect(roleCan('ADMIN', 'billing:manage')).toBe(false)
    expect(roleCan('OWNER', 'billing:manage')).toBe(true)
  })
  it('summary mentions the right high-level abilities', () => {
    expect(roleCapabilitySummary('GUEST').toLowerCase()).toContain('view')
    expect(roleCapabilitySummary('MEMBER').toLowerCase()).toContain('publish')
  })
})
```
- [ ] **Step 2:** Run `cd "d:/My Documents/MyProjects/FullStackProjects/_wt-team-inv-fe" && npx vitest run src/features/team/utils/capabilities.test.ts` → FAIL.
- [ ] **Step 3 (impl):** `capabilities.ts` — copy the SAME `WorkspaceRole`/`Capability`/`ROLE_RANK`/`CAPABILITY_MIN_ROLE`/`roleCan` as the backend `role-capabilities.ts` (values MUST be identical). Add:
```ts
export function roleCapabilitySummary(role: WorkspaceRole): string {
  switch (role) {
    case 'OWNER': return 'Full access, including billing and workspace settings.'
    case 'ADMIN': return 'Manage team, channels, and content. No billing or workspace deletion.'
    case 'MEMBER': return 'Connect channels, create and publish posts, reply in the inbox, and view analytics.'
    case 'GUEST': return 'View-only: see analytics and draft posts. Cannot publish, reply, connect channels, or manage the team.'
  }
}
```
`use-workspace-role.ts`:
```ts
import { useMemo } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { useWorkspaceDetail } from '@/features/workspaces/hooks/use-workspace-detail'
import { useWorkspaceMembers } from './use-workspace-members'
import { roleCan, type Capability, type WorkspaceRole } from '../utils/capabilities'

export function useWorkspaceRole(workspaceId: string | null | undefined) {
  const { user } = useAuth()
  const { workspace } = useWorkspaceDetail(workspaceId ?? undefined)
  const { data } = useWorkspaceMembers(workspaceId)
  const role = useMemo<WorkspaceRole | null>(() => {
    if (!user) return null
    if (workspace && workspace.ownerId === user.id) return 'OWNER'
    const m = data?.members.find((x) => x.user?.id === user.id)
    return (m?.role as WorkspaceRole) ?? null
  }, [user, workspace, data])
  return {
    role,
    can: (cap: Capability) => (role ? roleCan(role, cap) : false),
  }
}
```
Rewrite `roleDescription` in `role.ts` to `return roleCapabilitySummary(role as WorkspaceRole)` (import from capabilities), so the role-menu copy and the enforcement never drift. Keep `roleLabel`/`roleIcon` (GUEST→"Viewer").
- [ ] **Step 4:** Run test + `npm run build` → PASS.
- [ ] **Step 5 (commit):**
```
cd "d:/My Documents/MyProjects/FullStackProjects/_wt-team-inv-fe" && git add src/features/team/utils/capabilities.ts src/features/team/hooks/use-workspace-role.ts src/features/team/utils/role.ts src/features/team/utils/capabilities.test.ts && git commit -m "feat(team): capability mirror + useWorkspaceRole + role summary"
```

---

### Task 7: My-invitations inbox + gate channel-connect entry for GUEST

**Files:**
- Modify: `_wt-team-inv-fe/src/features/team/api/team.api.ts` (add `getMyInvitations`)
- Create: `_wt-team-inv-fe/src/features/team/hooks/use-my-invitations.ts`
- Create: `_wt-team-inv-fe/src/features/team/components/my-invitations-card.tsx`
- Modify: the Team settings view (`team-settings-view.tsx`) to render `<MyInvitationsCard />` at the top
- Modify: `_wt-team-inv-fe/src/features/channels/components/platform-connect-view.tsx` — hide the Connect button for users who lack `channels:manage`
- Test: `_wt-team-inv-fe/src/features/team/api/team.api.test.ts` (append a getMyInvitations assertion)

- [ ] **Step 1 (test append):**
```ts
it('getMyInvitations hits the me route', () => {
  teamApi.getMyInvitations()
  expect(apiClient.get).toHaveBeenCalledWith('/workspace-members/invitations/me')
})
```
- [ ] **Step 2:** Run the team.api test → FAIL.
- [ ] **Step 3 (impl):**
`team.api.ts` add:
```ts
  getMyInvitations: () =>
    apiClient.get<Array<{ id: string; role: MemberRole; workspace: { id: string; name: string }; inviter: { name: string | null } | null; token: string }>>(
      `${BASE}/invitations/me`,
    ),
```
> The backend `getMyInvitations` returns pending invitations addressed to the current user, each with `workspace` + `inviter`. It does NOT expose accept tokens for others — but it DOES include the row's own token for the current user, which is acceptable (they own the invite). If the backend omits `token`, accept via the token isn't possible from here — in that case the card's Accept button should navigate to `/invite/accept?token=` only if a token is present; otherwise omit Accept and rely on the emailed link. Read the real `getMyInvitations` return in `workspace-members.service.ts` and adapt the type + card accordingly.

`use-my-invitations.ts`:
```ts
import { useQuery } from '@tanstack/react-query'
import { teamApi } from '../api/team.api'
export function useMyInvitations() {
  return useQuery({ queryKey: ['my-invitations'], queryFn: () => teamApi.getMyInvitations() })
}
```
`my-invitations-card.tsx` — a shadcn `Card` listing pending invites with workspace name + inviter + role; each row has Accept (→ `useAcceptInvitation` then refetch `me` + navigate) and Decline (→ `useRejectInvitation`). Render nothing when the list is empty (no empty-state clutter). Use existing hooks from Phase 1. Loading = a `Skeleton`; error = an inline `Alert`.
Render `<MyInvitationsCard />` at the top of `TeamSettingsView` (above the members list).
In `platform-connect-view.tsx`, compute `const { can } = useWorkspaceRole(workspaceId)` and render the Connect button only when `can('channels:manage')`; otherwise show a disabled state with a "You need channel-manage permission" tooltip/text.
- [ ] **Step 4:** `cd "d:/My Documents/MyProjects/FullStackProjects/_wt-team-inv-fe" && npx vitest run src/features/team/api/team.api.test.ts && npm run build` → both PASS.
- [ ] **Step 5 (manual sanity):** code-inspection — Accept refetches `me`; empty invite list renders nothing; Connect hidden for GUEST.
- [ ] **Step 6 (commit):**
```
cd "d:/My Documents/MyProjects/FullStackProjects/_wt-team-inv-fe" && git add src/features/team/api/team.api.ts src/features/team/hooks/use-my-invitations.ts src/features/team/components/my-invitations-card.tsx src/features/team/components/team-settings-view.tsx src/features/channels/components/platform-connect-view.tsx src/features/team/api/team.api.test.ts && git commit -m "feat(team): my-invitations inbox + gate channel connect by role"
```

---

## Self-Review Notes
- **Spec coverage (Phase 2 slice):** role reconciliation (T1, also a bugfix), capability map single-source (T2), role service (T3), guard + decorator (T4), backend enforcement on channels (T5, with posts/inbox/billing gating explicitly deferred to Phase 2b), frontend mirror + useWorkspaceRole + role-summary-from-map (T6), my-invitations inbox + one concrete UI gate (T7).
- **Deferred (Phase 2b, record in ledger):** applying `@RequireCapability` to posts (`posts:publish`), inbox (`inbox:reply`), billing/subscription/addon (`billing:manage`), drips; and the composer/inbox UI hide-disable. The guard + maps are reusable — 2b is decoration + UI conditionals, no new infra.
- **Type consistency:** `WorkspaceRole`/`Capability`/`roleCan` identical BE (`role-capabilities.ts`) and FE (`capabilities.ts`); role value `GUEST` everywhere on the wire; label "Viewer" only in `roleLabel`.
- **Verify during execution:** backend `getMyInvitations` return shape (token presence); `useWorkspaceDetail` hook name/signature; `platform-connect-view` current Connect button structure.
