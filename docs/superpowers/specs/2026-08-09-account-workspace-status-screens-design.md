# Account & Workspace Status Screens — Design

**Date:** 2026-08-09
**Repos:** `socialmedia-workspace` (backend), `socialmedia-frontend` (frontend)
**Branch:** `feat/account-status-screens` (both repos, off `main`)

## Goal

When a **user** is deactivated/suspended, or a **workspace** is suspended (manually
by an admin, or automatically by billing), the person must land on a **standardized
status screen** that states *what happened*, *why* (a user-safe reason), and *how to
recover* (contact support / update payment) — instead of being silently logged out or
hitting a raw error. One consistent look across all three paths.

## Background — three suspension paths (as-built)

The codebase already has three independent suspension mechanisms. Enforcement is
uneven and the frontend only handles one of them cleanly.

| Path | Column / source | Set by | Enforced by (today) | Frontend today |
|---|---|---|---|---|
| **User** | `users.isActive` + `suspendedReason` | `AdminService.suspendUser`, inactivity job | `jwt.strategy.validate` → **401**, plain-string message | none — just a 401 → logout |
| **Workspace — manual** | `workspace.isActive` + `suspendedReason` | `AdminService.suspendWorkspace` | only `WorkspaceService.findOne` → 403 (not global) | none |
| **Workspace — billing** | `subscriptions.status` ∈ {`unpaid`,`incomplete_expired`} | Stripe webhook | `WorkspaceSuspendedGuard` (global APP_GUARD) → **403 `WORKSPACE_SUSPENDED`** | ✅ `SubscriptionGate` → `AccountSuspendedScreen` |

### Gaps this design closes

1. **Manual workspace suspend is orphaned** — `WorkspaceSuspendedGuard` reads only
   `subscriptions.status`, never `workspace.isActive`. An admin's manual suspend is
   therefore *not* enforced globally (only when a route happens to call
   `WorkspaceService.findOne`). Fix: guard checks **both**.
2. **User 401 is unstructured** — `jwt.strategy` throws a plain-string
   `UnauthorizedException`. The frontend can't distinguish "suspended" from any other
   401, so there's no dedicated screen. Fix: emit a structured body
   `{ code: 'ACCOUNT_SUSPENDED', reason }`.
3. **No user-safe reason mapping** — internal reasons (`policy_violation`, `abuse`, …)
   must never surface verbatim; map to friendly, vague-but-clear copy.

## Global Constraints

- **Shadcn-only** frontend (CLAUDE.md). Status screens reuse the existing
  `StatusPage` component; no hand-rolled panels.
- **No push / no PR / no merge** without explicit user request.
- **No DB migration commands** run by the assistant. This effort ships **no schema
  changes** — all columns (`users.isActive/suspendedReason`,
  `workspace.isActive/suspendedReason`) already exist. So no migration is needed at all.
- **Support email:** the constant **already exists** —
  `SUPPORT_EMAIL = 'support@schedura.ai'` in
  `src/features/status/components/status-footer.tsx`, already consumed by `StatusShell`
  (footer link + the "Contact support" button on `branded` screens). This effort only
  **removes the stale `TODO: confirm` comment** above it — the value is now confirmed.
  Do **not** create a second constant. (Email delivery is set up out-of-band via
  ImprovMX forwarding; code is independent of that.)
- **Reason lists stay in lockstep** between backend `SUSPENSION_REASONS`
  (`non_payment`, `policy_violation`, `abuse`, `user_request`, `inactivity`, `manual`)
  and the frontend friendly-text map.
- **Never leak internal `suspensionNote`** to the client. Only the coarse `reason`
  enum value crosses the wire.
- **Super admins are never suspendable** (already guarded in `AdminService`).

## Architecture

### Decision: catch user-suspension at login, not via a global interceptor

A suspended user cannot pass `jwt.strategy` at all — every authenticated request 401s.
So the natural, single choke point is the **login / session-bootstrap** path, not a
per-request interceptor tangled with the refresh-token queue in `lib/api.ts`.

- Backend: `jwt.strategy` (and the login path) emit a structured 401 with
  `code: 'ACCOUNT_SUSPENDED'` and the coarse `reason`.
- Frontend: the login mutation (and `/auth/me` bootstrap) detect that code and route to
  a dedicated `/account-suspended` screen carrying the reason. Logout is always allowed.

Rejected: a global 401 interceptor in `lib/api.ts` — more moving parts, interacts badly
with the refresh queue, and a suspended user never gets far enough in for it to matter.

### Decision: fold manual workspace suspension into the existing guard + gate

`WorkspaceSuspendedGuard` already returns a structured 403 `WORKSPACE_SUSPENDED` the
frontend understands. Extend it to also treat `workspace.isActive === false` as
suspended, with `reason` sourced from `workspace.suspendedReason`. Billing suspension
keeps `reason: 'billing'`. The frontend's `SubscriptionGate` + `AccountSuspendedScreen`
then handle both with a reason-driven branch — minimal new surface.

## Components & data flow

### Backend (`socialmedia-workspace`)

1. **`jwt.strategy.ts`** — replace the plain-string throw with:
   ```ts
   throw new UnauthorizedException({
     statusCode: 401,
     error: 'Unauthorized',
     code: 'ACCOUNT_SUSPENDED',
     reason: user.suspendedReason ?? 'manual',
     message: 'Your account has been suspended.',
   })
   ```
   `findOneWithSuspension` already returns `suspendedReason`, so no query change.

2. **`workspace-suspended.guard.ts`** — after the existing subscription check, also
   load `workspace.isActive` + `suspendedReason` for the resolved `workspaceId`.
   - If `isActive === false` → throw structured 403 `WORKSPACE_SUSPENDED` with
     `reason: suspendedReason ?? 'manual'`.
   - Billing suspension path unchanged, but now carries `reason: 'billing'` for the
     frontend to distinguish the two.
   - Keep the early-out shape: no `workspaceId` param → pass; `@SkipSuspendCheck()` →
     pass; no workspace row → pass.
   - One combined query (or two cheap selects) — keep the guard fast; it runs on every
     workspace-scoped request.

3. **Tests** — extend `workspace-suspended.guard.spec.ts` (manual-suspend case + reason
   propagation) and add a `jwt.strategy` suspended-user case.

### Frontend (`socialmedia-frontend`)

1. **`src/lib/constants.ts`** — `export const SUPPORT_EMAIL = 'support@schedura.ai'`.

2. **`src/features/billing/lib/suspension-reason.ts`** (new) — pure map:
   ```
   non_payment      → "A billing issue on your account."
   policy_violation → "A violation of our usage policies."
   abuse            → "Activity that violated our terms of service."
   inactivity       → "Your account was closed after a long period of inactivity."
   user_request     → "This account was closed at your request."
   billing          → (workspace billing copy — existing)
   manual / unknown → "Your account is currently under review."
   ```
   Export `friendlySuspensionReason(reason?: string): string`.

3. **`AccountSuspendedScreen`** — generalize to accept a `variant`:
   - `user` — "Your account is suspended" + reason + `Contact support` (mailto) +
     `Back to login`.
   - `workspace-manual` — "This workspace is suspended" + reason + `Contact support` +
     `Log out`.
   - `workspace-billing` — existing payment copy + `Update payment` + `Log out`
     (unchanged behaviour).
   All built on `StatusPage`; `Contact support` opens
   `mailto:${SUPPORT_EMAIL}?subject=...` prefilled with the account email.

4. **`/account-suspended` route** — a thin page that reads the reason (from navigation
   state or a lightweight store set by the login mutation) and renders the `user`
   variant. Reachable when unauthenticated.

5. **Login mutation / auth bootstrap** — on a 401 whose body has
   `code === 'ACCOUNT_SUSPENDED'`, stop the normal error toast and navigate to
   `/account-suspended` with the reason. `useAuth` `/auth/me` failure with the same code
   does the same.

6. **`SubscriptionGate` learns about manual suspension via the workspace fetch, not the
   subscription hook.** Today the gate only reads `useWorkspaceSubscription`, whose
   `status` never reflects a manual `workspace.isActive=false`. Decision: the gate also
   reads the workspace's own active/suspended state.
   - Preferred: extend the workspace-fetch response (`WorkspaceService.findOne` already
     returns the row, but throws 403 when suspended) OR the workspace hook the gate has
     access to, to expose `{ isActive, suspendedReason }`. The gate then renders the
     `workspace-manual` variant when `isActive === false`, and keeps the billing branch
     (`classifySubscription(...) === 'suspended'`) unchanged.
   - Because `WorkspaceService.findOne` currently **throws** on a suspended workspace,
     the frontend may instead catch the structured 403 `WORKSPACE_SUSPENDED` (with its
     `reason`) from the workspace-detail query the shell already runs, and branch:
     `reason === 'billing'` → billing screen; else → `workspace-manual`. The plan picks
     ONE of these two concrete wirings after inspecting how the workspace shell loads its
     workspace; both end at the same reason-driven branch.
   - Whichever path: billing suspension keeps its existing screen/behaviour verbatim.

## Error / loading / empty / edge states

- **Loading:** never lock before status is known (existing `SubscriptionGate`
  `isLoading` guard preserved) — avoids flash-lock and lets a network hiccup through
  rather than trapping the user.
- **Missing reason:** always fall back to the `manual` friendly text; never render an
  empty reason.
- **Reason enum drift:** unknown reason → `manual` copy (safe default).
- **Super admin:** cannot be suspended (guarded); no special-casing needed.
- **Recovery dead-end avoidance:** billing routes stay in the allowlist so a
  billing-suspended user can still pay; `Contact support` mailto works even fully
  logged-out.
- **Reduced motion / focus / keyboard:** inherited from `StatusPage` (shadcn) — no new
  primitives.

## Testing strategy

- Backend: guard spec (manual + billing + skip + no-param), jwt-strategy suspended case.
  Run `npx tsc --noEmit` + affected Jest specs.
- Frontend: `friendlySuspensionReason` unit test (each enum + unknown fallback); a
  render test for each `AccountSuspendedScreen` variant (title + reason + actions).
  Run `npm run build`.

## Out of scope

- No new suspension *reasons* or admin UI (admin app is separate — `schedura-admin`).
- No self-service un-suspend.
- No schema changes / migrations.
- Email infrastructure (ImprovMX/DNS) — handled by the user out-of-band.
