# Invited-User Flow (skip verify + skip onboarding + workspaces hub) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** An email-invited user joins the inviter's workspace directly — no email-verification step, no create-workspace onboarding — and members can actually see/switch to workspaces they belong to; a `/workspaces` hub handles multi-workspace, zero-workspace, and post-removal (kickoff) cases.

**Runs on:** existing `feat/team-invitations` branch, both worktrees (`_wt-team-inv` backend, `_wt-team-inv-fe` frontend). No new branch.

**Tech:** NestJS + Drizzle (Jest); Vite/React 19/shadcn (vitest).

## Global Constraints
- **No DB migration.** Reuse existing tables/columns (`users.isEmailVerified`, `users.onboardingCompletedAt`, `workspaceInvitation`, `workspace`).
- **No auto-created personal workspace** for invited users (Approach 1). Invited users own nothing; they join via `workspaceInvitation` membership.
- Canonical role values `OWNER | ADMIN | MEMBER | GUEST` (GUEST label = "Viewer"). OWNER = `workspace.ownerId`; members = ACCEPTED `workspaceInvitation` rows.
- Auto-verify is safe ONLY because `acceptInvitation` already checks the invitee's account email equals the invitation email (case-insensitive) AND they hold the high-entropy token → inbox ownership proven.
- shadcn-only UI; Button is @base-ui (`render` not `asChild`). Stage only named files; never `.env`; never `git add -A`. Backend typecheck with `npx tsc --noEmit` (a dev server watches dist — do NOT `npm run build` in the backend worktree). Frontend `npm run build` is fine.

---

### Task B1: `whoAmI` returns owned + accepted-member workspaces, each with a `role`

**Files:**
- Modify: `_wt-team-inv/src/auth/auth.service.ts` (`MeResponse` type + `whoAmI`)
- Create: `_wt-team-inv/src/auth/workspace-membership.util.ts` (pure merge helper)
- Test: `_wt-team-inv/src/auth/workspace-membership.util.spec.ts`

**Interfaces:**
- Produces: `WorkspaceWithRole = Workspace & { role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST' }`; `MeResponse.workspaces: WorkspaceWithRole[]`.
- Pure helper `mergeWorkspacesWithRoles(owned: Workspace[], memberships: { workspace: Workspace; role: 'ADMIN'|'MEMBER'|'GUEST' }[]): WorkspaceWithRole[]` — owned rows get `role: 'OWNER'`; membership rows get their invitation role; if a workspace appears in both (owner also has a stray accepted invite), OWNER wins; de-duped by `workspace.id`; owned first, then members, each group newest-first is preserved from input order.

- [ ] **Step 1 — failing test** `workspace-membership.util.spec.ts`:
```ts
import { mergeWorkspacesWithRoles } from './workspace-membership.util';

const ws = (id: string, name = id) =>
  ({ id, name, slug: name, ownerId: 'o', createdAt: new Date(), updatedAt: new Date() }) as any;

describe('mergeWorkspacesWithRoles', () => {
  it('tags owned as OWNER and members by their invitation role, owner wins on overlap', () => {
    const owned = [ws('a')];
    const memberships = [
      { workspace: ws('b'), role: 'MEMBER' as const },
      { workspace: ws('a'), role: 'ADMIN' as const }, // overlap with owned
    ];
    const out = mergeWorkspacesWithRoles(owned, memberships);
    expect(out.map((w) => [w.id, w.role])).toEqual([
      ['a', 'OWNER'],
      ['b', 'MEMBER'],
    ]);
  });
});
```
Run `cd "d:/My Documents/MyProjects/FullStackProjects/_wt-team-inv" && npx jest src/auth/workspace-membership.util.spec.ts` → FAIL.

- [ ] **Step 2 — implement the helper** `workspace-membership.util.ts`:
```ts
import type { Workspace } from '../drizzle/schema';

export type WorkspaceRoleLabel = 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST';
export type WorkspaceWithRole = Workspace & { role: WorkspaceRoleLabel };

export function mergeWorkspacesWithRoles(
  owned: Workspace[],
  memberships: { workspace: Workspace; role: 'ADMIN' | 'MEMBER' | 'GUEST' }[],
): WorkspaceWithRole[] {
  const byId = new Map<string, WorkspaceWithRole>();
  for (const w of owned) byId.set(w.id, { ...w, role: 'OWNER' });
  for (const m of memberships) {
    if (byId.has(m.workspace.id)) continue; // owner wins
    byId.set(m.workspace.id, { ...m.workspace, role: m.role });
  }
  return [...byId.values()];
}
```
Run the test → PASS.

- [ ] **Step 3 — wire into `whoAmI`.** In `auth.service.ts`: change `MeResponse.workspaces` to `WorkspaceWithRole[]` (import from the util). Keep the owned query. Add a memberships query and merge:
```ts
// after the owned `workspaces` query
const memberRows = await this.db.query.workspaceInvitation.findMany({
  where: and(
    eq(workspaceInvitation.userId, userId),
    eq(workspaceInvitation.status, 'ACCEPTED'),
  ),
  with: { workspace: true },
});
const memberships = memberRows
  .filter((r) => r.workspace)
  .map((r) => ({ workspace: r.workspace!, role: r.role as 'ADMIN' | 'MEMBER' | 'GUEST' }));
const merged = mergeWorkspacesWithRoles(workspaces, memberships);
```
Return `workspaces: merged`. Add imports: `and` from `drizzle-orm`, `workspaceInvitation` from `../drizzle/schema`, and the util. **Verify** the `workspaceInvitation` relation named `workspace` exists in the drizzle relations (check `src/drizzle/schema/workspace-invitation.schema.ts` relations — if the relation key differs, use the actual name; if no relation is defined, fetch workspaces by id in a second query and map instead of `with`).
- [ ] **Step 4 — run helper test + typecheck.** `npx jest src/auth/workspace-membership.util.spec.ts` PASS; `npx tsc --noEmit` (pre-existing unrelated errors in calendar-sync/channels/stock-media specs are OK; introduce none new in auth/). Commit:
```
git add src/auth/auth.service.ts src/auth/workspace-membership.util.ts src/auth/workspace-membership.util.spec.ts
git commit -m "feat(auth): whoAmI returns owned + member workspaces with role"
```

---

### Task B2: `acceptInvitation` auto-verifies email + stamps onboarding complete

**Files:**
- Modify: `_wt-team-inv/src/workspace-members/workspace-members.service.ts` (`acceptInvitation`)
- Test: append to `_wt-team-inv/src/workspace-members/workspace-members.service.spec.ts`

**Interfaces:** Consumes `usersService.verifyEmail(userId)` and `usersService.markOnboardingCompleted(userId)` (both exist, idempotent). The service constructor currently takes `(db, usageService, emailService)` — **verify whether `UsersService` is already injected**; if not, add it to the constructor and to `WorkspaceMembersModule` providers wiring (import `UsersModule`, which is already transitively available via AuthModule — confirm `UsersService` is exported).

- [ ] **Step 1 — read `acceptInvitation`** (`workspace-members.service.ts`, ~lines 241-336) and the service constructor + spec's construction pattern. Note where the ACCEPTED flip + `incrementMemberCount` happen — the verify/onboarding calls go right after a successful accept, before returning.
- [ ] **Step 2 — failing test** (append to spec). Assert that on a successful accept, the user is verified + onboarding-stamped. Mirror the existing spec's `new WorkspaceMembersService(...)` construction and mock shape (read a passing test in the file first for the exact db mock). Add mocks for `usersService.verifyEmail`/`markOnboardingCompleted` and assert both were called with the accepting user's id.
```ts
// sketch — adapt to the spec's real construction + mocks:
it('verifies email and stamps onboarding on successful accept', async () => {
  // ...arrange a valid PENDING invitation whose email matches the current user...
  await svc.acceptInvitation('tok', 'user-1');
  expect(usersService.verifyEmail).toHaveBeenCalledWith('user-1');
  expect(usersService.markOnboardingCompleted).toHaveBeenCalledWith('user-1');
});
```
Run the targeted test → FAIL.
- [ ] **Step 3 — implement.** In `acceptInvitation`, after the invitation is flipped to ACCEPTED and membership counted, call:
```ts
await this.usersService.verifyEmail(currentUserId);
await this.usersService.markOnboardingCompleted(currentUserId);
```
Both are idempotent, so calling them for an already-verified/onboarded user is a no-op. If `UsersService` wasn't injected, add it (constructor + module). Keep the accept return shape unchanged.
- [ ] **Step 4 — run tests + typecheck.** `npx jest src/workspace-members/workspace-members.service.spec.ts` all PASS; `npx tsc --noEmit` no new errors. Commit:
```
git add src/workspace-members/workspace-members.service.ts src/workspace-members/workspace-members.service.spec.ts
git commit -m "feat(members): auto-verify email + complete onboarding on invite accept"
```
> If the constructor/module changed, include `src/workspace-members/workspace-members.module.ts` in the commit.

---

### Task F1: Frontend `Workspace` type gains `role`; switcher shows a role badge

**Files:**
- Modify: `_wt-team-inv-fe/src/types/auth.ts` (`Workspace` interface)
- Modify: `_wt-team-inv-fe/src/features/dashboard/components/workspace-menu-content.tsx` (render role badge per row)

**Interfaces:** `Workspace` gains `role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST'`. Consumed by F3's hub page and the switcher.

- [ ] **Step 1** — add `role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST'` to `Workspace` in `src/types/auth.ts`.
- [ ] **Step 2** — in `workspace-menu-content.tsx`, for each workspace row render a small role indicator using the existing team role helpers. Reuse `roleLabel` + `roleBadgeClass` from `@/features/team/utils/role` (they accept `DisplayRole` which includes OWNER). Show a subtle `Badge` (shadcn) with `roleBadgeClass(ws.role)` + `roleLabel(ws.role)`, only when helpful (e.g. next to the name). Keep the row layout intact; don't break active-check/switch behavior.
- [ ] **Step 3** — `cd "d:/My Documents/MyProjects/FullStackProjects/_wt-team-inv-fe" && npx eslint src/types/auth.ts src/features/dashboard/components/workspace-menu-content.tsx && npm run build` → 0 errors + build passes. Commit:
```
git add src/types/auth.ts src/features/dashboard/components/workspace-menu-content.tsx
git commit -m "feat(workspaces): add role to Workspace type + show role badge in switcher"
```

---

### Task F2: Let invited users through — drop `needs-verify`, reorder redirect, route signup to accept

**Files:**
- Modify: `_wt-team-inv-fe/src/features/team/utils/accept-state.ts` (drop the `needs-verify` branch)
- Modify: `_wt-team-inv-fe/src/features/team/utils/accept-state.test.ts` (update expectations)
- Modify: `_wt-team-inv-fe/src/features/team/components/accept-invitation-view.tsx` (remove `needs-verify` UI)
- Modify: `_wt-team-inv-fe/src/pages/index-redirect.tsx` (pending-invite short-circuit BEFORE `!isVerified`)
- Modify: `_wt-team-inv-fe/src/features/auth/hooks/use-signup-mutation.ts` (route to accept when a pending invite exists)

**Behavior:** an authenticated invitee whose account email matches the invitation is `ready` to accept even if their email isn't verified — the backend (B2) verifies them on accept. So the verify gate must not stand between them and `acceptInvitation`.

- [ ] **Step 1 — accept-state.** In `accept-state.ts`, delete the `if (!auth.isVerified) return { kind: 'needs-verify' }` branch (currently right after the `needs-auth` check). An authenticated + email-matching invitee now falls through to `ready`. Remove `needs-verify` from the state union type if it's declared there and no longer produced. Update `accept-state.test.ts`: any test asserting `needs-verify` for an unverified authed user now expects `ready`; add/adjust a case proving an unverified-but-email-matching user resolves to `ready`. Run `cd "d:/My Documents/MyProjects/FullStackProjects/_wt-team-inv-fe" && npx vitest run src/features/team/utils/accept-state.test.ts` → PASS.
- [ ] **Step 2 — accept view.** In `accept-invitation-view.tsx`, remove the `state.kind === 'needs-verify'` block (the "Verify your email to finish joining" card). Nothing else in the view changes.
- [ ] **Step 3 — index-redirect.** In `index-redirect.tsx`, move the pending-invite short-circuit ABOVE the `if (!isVerified) return <Navigate to="/verify-email-pending" />` line, so an authenticated-but-unverified user WITH a pending invite is sent to `/invite/accept` instead of the verify page. Order becomes: `!isAuthenticated` → pending-invite → `!isVerified` → `!hasWorkspace` → … Keep all other branches.
- [ ] **Step 4 — signup redirect.** In `use-signup-mutation.ts` `onSuccess`, after `fetchQuery` of `/auth/me`: if `getPendingInvite()` (from `@/lib/auth-storage`) returns a token, `navigate('/invite/accept?token=' + encodeURIComponent(token), { replace: true })` and SKIP the "check your inbox to verify" toast (show a neutral "Account created" or no toast). Otherwise keep the existing `/verify-email-pending` behavior + toast.
- [ ] **Step 5 — build.** `npx vitest run src/features/team/utils/accept-state.test.ts && npm run build` → PASS. Commit:
```
git add src/features/team/utils/accept-state.ts src/features/team/utils/accept-state.test.ts src/features/team/components/accept-invitation-view.tsx src/pages/index-redirect.tsx src/features/auth/hooks/use-signup-mutation.ts
git commit -m "feat(team): invited users skip email verification and land via accept"
```

---

### Task F3: `/workspaces` hub page + kickoff/stale routing

**Files:**
- Create: `_wt-team-inv-fe/src/pages/workspaces.tsx` (thin route shell)
- Create: `_wt-team-inv-fe/src/features/workspaces/components/workspaces-hub.tsx` (the list + empty-state)
- Modify: `_wt-team-inv-fe/src/router.tsx` (add `/workspaces` route)
- Modify: `_wt-team-inv-fe/src/components/routes/workspace-guard.tsx` (stale/kickoff → `/workspaces`)

**Behavior:** `/workspaces` lists every workspace the user belongs to (owned + member, from `useAuth().workspaces`, now role-tagged), each row entering that workspace via `useWorkspaceSwitch().switchWorkspace(id)` then navigating to `wsHome(id)`. Empty state (0 workspaces) shows a "Create your first workspace" CTA reusing `CreateWorkspaceDialog` (from the switcher) / `useCreateWorkspace`. When a `/w/:workspaceId/*` route's id isn't in the user's list (kickoff or stale), `WorkspaceGuard` redirects to `/workspaces` instead of silently jumping to another workspace or onboarding.

- [ ] **Step 1 — hub component** `workspaces-hub.tsx`. Read `src/features/dashboard/components/workspace-menu-content.tsx` for the row pattern (avatar/initials, name, `switchWorkspace`, `wsHome`) and `src/features/workspaces/hooks/use-create-workspace.ts` + `CreateWorkspaceDialog` for the create flow. Build with shadcn `Card`/`Button`/`Badge`/`Avatar`:
  - Header: brand + "Your workspaces".
  - If `workspaces.length > 0`: a list of rows — avatar/initials, name, `roleLabel(ws.role)` badge (`roleBadgeClass`), click → `switchWorkspace(ws.id)` then `navigate(wsHome(ws.id))`. Include a secondary "Create workspace" action (opens `CreateWorkspaceDialog`).
  - If `workspaces.length === 0`: empty state (icon + "You're not part of any workspace yet") + primary "Create workspace" CTA (opens `CreateWorkspaceDialog`; on create success it already remembers + you navigate to `wsHome(newId)`).
  - Loading state: skeleton rows while `useAuth().isLoading`.
- [ ] **Step 2 — page shell** `pages/workspaces.tsx`: thin — renders `<WorkspacesHub />`.
- [ ] **Step 3 — route.** In `router.tsx`, add `/workspaces` under a guard that requires authenticated + verified but NOT onboarded/hasWorkspace (a kicked or zero-workspace user must reach it). Simplest: place it under the same `VerifiedRoute` group the onboarding routes use (auth + verified, no workspace requirement). Confirm `VerifiedRoute` doesn't itself force onboarding (per recon it only checks auth + verified).
- [ ] **Step 4 — kickoff routing.** In `workspace-guard.tsx`, where it currently falls back via `resolveActiveWorkspaceId` when the URL `:workspaceId` isn't in `workspaces`, change the fallback to `<Navigate to="/workspaces" replace />` (drop the silent jump to first-workspace/onboarding). Keep the happy path (valid workspace) untouched; keep the `rememberCurrentWorkspace` write on valid loads.
- [ ] **Step 5 — build.** `npm run build` → PASS (also `npx eslint` the new/changed files → 0). Commit:
```
git add src/pages/workspaces.tsx src/features/workspaces/components/workspaces-hub.tsx src/router.tsx src/components/routes/workspace-guard.tsx
git commit -m "feat(workspaces): workspaces hub page + route kicked/stale members to it"
```

---

## Self-Review Notes
- **Coverage:** skip-verify (B2 backend + F2 frontend), skip-onboarding (B1 membership → hasWorkspace true, B2 onboarding stamp, F2 redirect), member workspace access (B1 whoAmI + F1 type/switcher), post-kickoff & zero-workspace hub (F3).
- **No auto personal workspace** — nothing creates a `workspace` row for an invitee; `hasWorkspace` becomes true purely via B1 membership inclusion.
- **Sequencing:** B1 before F1 (shape); B2 independent; F2 independent of F3; F3 depends on F1 (`Workspace.role`). Execute B1, B2, F1, F2, F3 in order.
- **Risk:** B1 changes `/auth/me` shape app-wide. `Workspace.role` is additive (existing consumers ignore it); owner-only checks still work via `ownerId` compare. Final whole-branch review must audit switcher/guards/billing for any "all my workspaces are owned" assumption.
- **Verify during execution:** the `workspaceInvitation.workspace` drizzle relation name (B1 Step 3); whether `UsersService` is already injected into `WorkspaceMembersService` (B2); that `VerifiedRoute` doesn't force onboarding (F3 Step 3).
