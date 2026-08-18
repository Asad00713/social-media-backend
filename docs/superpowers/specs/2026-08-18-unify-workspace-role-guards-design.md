# Unify Workspace Role Guards — Design

**Date:** 2026-08-18
**Branch:** `feat/unify-workspace-role-guards` (both repos)
**Type:** Architectural (backend authorization restructure + frontend gating alignment)

## Problem

The workspace has a clean capability model (`role-capabilities.ts`): a single
role→capability matrix (`OWNER > ADMIN > MEMBER > GUEST`, rank-based) plus a
`WorkspaceRoleGuard` + `@RequireCapability(cap)` decorator that enforces it
declaratively. But **only `channels.controller.ts` actually uses that guard.**

The entire `workspace-members` module (invite / batch-invite / list members /
update role / remove member / list pending invitations / cancel invitation)
enforces permissions with **inline ad-hoc checks inside the service**
(`isOwner || isAdmin`, `isUserMember`, hand-rolled per method). This creates two
concrete defects:

- **Read-path over-exposure (functional bug).** `getMembers` gates only on
  `isUserMember` — it never checks role. Today that is *intentional* (any member
  should see the roster, ClickUp/Slack/Notion/Linear all do this), but it is
  enforced by omission, not by policy. There is no single place that says "team
  visibility = every member; team management = ADMIN+."

- **Two sources of truth (drift risk).** The capability map is the intended
  single source of truth, but team endpoints don't consult it. When a future
  role or capability is added, `channels` picks it up for free while
  `workspace-members` silently does not — exactly the class of silent-drift bug
  this codebase has hit before (composer schema drift, inbox scope drift).

## Decision (locked with user)

- **Approach B — unify.** Move `workspace-members` authorization onto the same
  `WorkspaceRoleGuard` + `@RequireCapability` mechanism `channels` already uses.
  The capability map becomes the real single source of truth.
- **Team visibility = ClickUp-style.** Any accepted member (GUEST+) can *view*
  the team roster; only ADMIN+ can *manage* it (invite, change role, remove,
  cancel invites, view pending invitations). A new capability `team:view`
  (min role GUEST) expresses "see the roster"; the existing `team:manage`
  (min role ADMIN) expresses "manage the team."

## Capability map change

Add one capability to **both** `role-capabilities.ts` (BE) and
`capabilities.ts` (FE mirror). Keep the two files byte-identical in their map.

```
'team:view': 'GUEST'   // NEW — see the member roster (view-only)
'team:manage': 'ADMIN' // unchanged — invite/roles/remove/cancel
```

`Capability` union and `CAPABILITY_MIN_ROLE` both gain the `'team:view'` entry.
No rank changes. `roleCan` is unchanged.

## Endpoint → capability mapping (backend)

`WorkspaceRoleGuard` resolves `workspaceId` from `req.params.workspaceId` and
`userId` from `req.user.userId` (populated by `JwtAuthGuard`). So the guard can
ONLY be applied to routes that carry `:workspaceId` AND run behind
`JwtAuthGuard`. Routes keyed by token or "me" (no workspaceId) must NOT get a
capability requirement — they self-authorize inside the service (email match on
the token), and adding the guard there would throw "Cannot resolve workspace
role."

`WorkspaceMembersController` (class-level `@UseGuards(JwtAuthGuard)`):

| Route | Method | Capability | Notes |
|---|---|---|---|
| `POST :workspaceId/invitations` | inviteMember | `team:manage` | ADMIN+ |
| `POST :workspaceId/invitations/batch` | batchInvite | `team:manage` | ADMIN+ |
| `GET :workspaceId/invitations` | getPendingInvitations | `team:manage` | pending list = management view, ADMIN+ |
| `DELETE :workspaceId/invitations/:invitationId` | cancelInvitation | `team:manage` | ADMIN+ |
| `GET :workspaceId/members` | getMembers | `team:view` | **any member (GUEST+)** |
| `PATCH :workspaceId/members/:memberId` | updateMemberRole | `team:manage` | ADMIN+ |
| `DELETE :workspaceId/members/:memberId` | removeMember | `team:manage` | ADMIN+ but self-removal must still work (see below) |
| `GET invitations/me` | getMyInvitations | — none — | no workspaceId; self-scoped |
| `POST invitations/accept` | acceptInvitation | — none — | token-scoped |
| `POST invitations/reject` | rejectInvitation | — none — | token-scoped |

Each guarded route gets `@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)` +
`@RequireCapability(...)`. Guard order matters: `JwtAuthGuard` first so
`req.user` exists before `WorkspaceRoleGuard` reads it. (Method-level
`@UseGuards` replaces the class-level one for that handler, so re-list
`JwtAuthGuard` explicitly on each guarded method.)

## Service checks: keep, don't rip out

**The guard is an ADD, not a REPLACE.** The service methods keep the checks that
express business rules the guard structurally cannot:

- `removeMember` — **self-removal.** A MEMBER/GUEST leaving the workspace calls
  `DELETE :workspaceId/members/:memberId` on their own row. `team:manage` would
  block them. So `removeMember` must be reachable by non-managers when
  `isSelf`. **Resolution:** do NOT put `@RequireCapability('team:manage')` on
  `removeMember`. Keep its existing inline `isSelf || isOwner || isAdmin ||
  isSuperAdmin` check — it already encodes exactly the right policy, which the
  single-capability guard cannot (capability guards can't express "manage OR
  self"). Ledger this as a deliberate exception.
- `cancelInvitation` — inline check also allows the original **inviter**
  (`isInviter`) to cancel their own invite, plus super-admin. `team:manage`
  covers OWNER/ADMIN. An inviter is always ADMIN+ (only ADMIN+ can invite), so
  `team:manage` already subsumes `isInviter` for normal cases; super-admin is
  cross-workspace (not a member) so the guard would block them. **Resolution:**
  keep `@RequireCapability('team:manage')` for the normal path AND keep the
  inline super-admin allowance so platform support still works. The guard and
  the inline check are OR-combined at the service layer via the existing code —
  but note the guard runs FIRST and would 403 a super-admin before the service
  sees them. **So super-admin-reachable routes must NOT rely solely on the
  guard.** See "Super-admin" below.
- Every other guarded method's inline `isOwner || isAdmin` becomes redundant
  with the guard for member callers. Leave the inline checks in place
  (defense-in-depth; they also serve the admin-module callers that invoke the
  service directly, bypassing HTTP + guard). Do not delete them.

## Super-admin (platform SUPER_ADMIN) — important

`WorkspaceRoleService.getRole` returns `null` for a platform super-admin who is
not a member of the workspace. So `WorkspaceRoleGuard` would **403 a super-admin**
on any guarded route. Two service methods explicitly support super-admin today
(`updateMemberRole`, `removeMember`, `cancelInvitation` via `isPlatformSuperAdmin`).

But: the **admin dashboard does not call these HTTP routes** — it imports
`WorkspaceMembersService` directly (see `workspace-members.module.ts` exports
comment) and calls the methods in-process, bypassing the controller and its
guards entirely. So the guard 403-ing super-admins on the HTTP route is
harmless for the real admin flow.

**Resolution (chosen, single approach):** make `WorkspaceRoleGuard`
super-admin-aware so the two mechanisms never disagree and a future direct HTTP
call from an admin tool doesn't silently break. This mirrors
`isEmailAllowlisted`'s super-admin bypass.

Concretely:
1. Add `isPlatformSuperAdmin(userId): Promise<boolean>` to
   `WorkspaceRoleService` (single query on `users.role === 'SUPER_ADMIN'`). This
   is the ONE implementation; `WorkspaceMembersService.isPlatformSuperAdmin`
   (currently private) is refactored to delegate to it, so there's no duplicate.
2. In `WorkspaceRoleGuard.canActivate`, keep the flow exactly as today
   (`getRole` → `roleCan`), but before throwing the 403, check
   `roleService.isPlatformSuperAdmin(userId)` and pass if true. Ordering keeps
   the extra query OFF the hot path — it only runs for a caller who already
   failed the normal capability check, which is rare.

`WorkspaceRoleService.getRole` stays role-in-workspace only (unchanged). No
sentinel role, no `getEffectiveRole`, no `roleCan` change.

## Channels controller

`channels.controller.ts` already uses the guard correctly and is unaffected by
the map addition (`team:view` doesn't touch channels). No changes there.

## Frontend alignment

The FE already gates the team UI with `canManage = isOwner || myRole === 'ADMIN'`
and `useWorkspaceRole().can('team:manage')`. That is correct and stays.

Two FE changes, both small:

1. **Mirror the map.** Add `'team:view': 'GUEST'` to `capabilities.ts` `Capability`
   union + `CAPABILITY_MIN_ROLE`, keeping it identical to the BE file. Update the
   FE capabilities test to cover `team:view` (GUEST passes, and it's the floor).

2. **No UI regression.** The members roster is already only rendered on the team
   settings page, which is reachable by members. `getMembers` will now require
   `team:view` (GUEST+) server-side — every accepted member already clears that,
   so no member who can see the page today loses access. `canManage`-gated
   controls (invite button, role menu, remove, cancel) are unchanged. Verify the
   invite dialog still shows all three assignable roles (ADMIN/MEMBER/GUEST) —
   no change expected, it reads `ASSIGNABLE_ROLES`.

No new FE endpoints, hooks, or components. This is a policy-alignment change, not
a feature.

## Error contract

`WorkspaceRoleGuard` throws `ForbiddenException('You do not have permission to
perform this action in this workspace')` (403). The FE `apiClient` surfaces 403s
as errors; team mutations already toast on error. A GUEST/MEMBER who somehow
POSTs an invite (they can't from the UI — button is hidden) gets a clean 403
instead of the service's prose message. Acceptable and more consistent.

## Testing

**Backend (Jest, co-located `*.spec.ts`):**
- `role-capabilities.spec.ts` — add cases: `roleCan('GUEST','team:view')===true`,
  `roleCan('GUEST','team:manage')===false`, `team:view` min role is GUEST.
- `workspace-role.guard.spec.ts` — already tests cap present/absent, role
  sufficient/insufficient, null role. Add: super-admin passes even with null
  workspace role; `team:view` passes for a GUEST member; `team:manage` fails for
  a GUEST member.
- Controller wiring is verified structurally (decorators present) + the guard
  unit tests; no e2e added (module has none today, matching repo norm).

**Frontend (Vitest):**
- `capabilities.test.ts` — add `team:view` cases mirroring the BE.

## Files

**Backend:**
- Modify: `src/workspace-members/role-capabilities.ts` (+`team:view`)
- Modify: `src/workspace-members/workspace-role.guard.ts` (super-admin bypass)
- Modify: `src/workspace-members/workspace-role.service.ts` (shared
  `isPlatformSuperAdmin`)
- Modify: `src/workspace-members/workspace-members.controller.ts` (guards +
  `@RequireCapability` per table)
- Modify: `src/workspace-members/workspace-members.service.ts` (use shared
  super-admin helper; no policy change)
- Modify: `src/workspace-members/role-capabilities.spec.ts`
- Modify: `src/workspace-members/workspace-role.guard.spec.ts`

**Frontend:**
- Modify: `src/features/team/utils/capabilities.ts` (+`team:view`)
- Modify: `src/features/team/utils/capabilities.test.ts`

## Accepted behavior change (whole-branch review, LOW-1)

The service's `cancelInvitation` allows the original **inviter** (`isInviter`) to
cancel their own invite. The spec assumed "an inviter is always ADMIN+," but that
is not invariant: an OWNER can demote an ADMIN (who sent invites) down to
MEMBER/GUEST via `updateMemberRole`. After this change the `team:manage` guard
runs before the service, so a **demoted ex-admin can no longer cancel invitations
they sent** (clean 403). This is MORE restrictive, not a security hole, and is
judged correct team-management policy — a non-manager should not manage
invitations. The service's `isInviter` branch is retained (still reachable by
in-process admin-module callers that bypass HTTP); it is simply superseded by the
guard on the HTTP path. **Accepted, no code change.**

## Out of scope

- No change to the invitation data model, seat gating, or email flow.
- No change to `channels.controller.ts`.
- No new roles; no per-capability custom roles; no role rename.
- No migration (capability map is code, not DB).
