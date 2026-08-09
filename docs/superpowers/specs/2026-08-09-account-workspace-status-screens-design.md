# Account & Workspace Status Screens — Design

**Date:** 2026-08-09
**Repos:** `socialmedia-workspace` (backend), `socialmedia-frontend` (frontend)
**Branch:** `feat/account-status-screens` (both repos, off `main`)
**Status:** Spec — reconciled to as-built code (2026-08-09), ready for implementation plan

## Goal

When a **user** is deactivated/suspended, or a **workspace** is suspended (manually
by an admin, or automatically by billing), the person must land on a **standardized
status screen** that states *what happened*, *why* (a user-safe reason), and *how to
recover* (contact support / update payment) — instead of being silently logged out or
hitting a raw error. One consistent look across all three paths, built on the existing
`StatusPage` shell.

## Background — three suspension paths (verified as-built)

| Path | Column / source | Set by | Enforced by (today) | Frontend today |
|---|---|---|---|---|
| **User** | `users.isActive` + `suspendedReason` | `AdminService.suspendUser`, inactivity job | `jwt.strategy.validate` -> **401 plain-string** | none — 401 -> refresh fails -> `session-expired` |
| **Workspace — manual** | `workspace.isActive` + `suspendedReason` | `AdminService.suspendWorkspace` | ONLY `WorkspaceService.findOne` -> plain-string 403 (owner-only, not global) | none |
| **Workspace — billing** | `subscriptions.status` in {`unpaid`,`incomplete_expired`} | Stripe webhook | `WorkspaceSuspendedGuard` (global APP_GUARD) -> **403 `WORKSPACE_SUSPENDED`** | yes: `SubscriptionGate` (status-driven) -> `AccountSuspendedScreen` |

### Gaps this design closes (verified)

1. **Manual workspace suspend is orphaned globally.** `WorkspaceSuspendedGuard` reads
   ONLY `subscriptions.status`; it never checks `workspace.isActive`. An admin's manual
   suspend is enforced only inside `WorkspaceService.findOne` (a plain-string 403,
   owner-only). Fix: guard also treats `workspace.isActive === false` as suspended.
2. **User 401 is unstructured.** `jwt.strategy` throws a plain-string
   `UnauthorizedException` ("Your account has been suspended. Reason: ..."). The
   frontend can't distinguish "suspended" from any other 401. Fix: emit a structured
   body `{ code: 'ACCOUNT_SUSPENDED', reason }`.
3. **No user-safe reason mapping.** Internal reasons (`policy_violation`, `abuse`, ...)
   are interpolated raw into strings today. Map to friendly, vague-but-clear copy on
   the frontend; never surface `suspensionNote`.

## Global Constraints

- **Shadcn-only** frontend (CLAUDE.md). Status screens reuse the existing
  `StatusPage` (`src/features/status/components/status-page.tsx`) — it already exposes
  `variant` / `tone` / `code` / `actions` (`StatusAction`). No hand-rolled panels.
- **No push / no PR / no merge** without explicit user request.
- **No DB migration commands** run by the assistant. This effort ships **no schema
  changes** — all columns already exist (`users.isActive/suspendedReason`,
  `workspace.isActive/suspendedReason`). No migration needed.
- **Support email:** reuse the EXISTING `SUPPORT_EMAIL` (`= 'support@schedura.ai'`)
  already exported from `src/features/status/components/status-footer.tsx`. Do NOT
  create a new `src/lib/constants.ts`. Keep ONE source of truth (re-export if wider
  reuse is needed).
- **Reason lists stay in lockstep** between backend `SUSPENSION_REASONS`
  (`non_payment`, `policy_violation`, `abuse`, `user_request`, `inactivity`, `manual`)
  and the frontend friendly-text map. Add `billing` as a frontend-only synthetic key
  for the billing variant.
- **Never leak internal `suspensionNote`** to the client. Only the coarse `reason`
  enum value crosses the wire.
- **Super admins are never suspendable** (already guarded in `AdminService.suspendUser`).

## Architecture

### Decision 1 — user suspension: structured 401 + dedicated standalone route

A suspended user cannot pass `jwt.strategy` — every authenticated request 401s, and the
existing `lib/api.ts` refresh flow turns a bare 401 into a `session-expired` redirect.
The single choke point is the JWT strategy throw; make it structured so the frontend can
tell "suspended" apart from "expired".

- **Backend:** `jwt.strategy.validate` throws
  `new UnauthorizedException({ statusCode: 401, error: 'Unauthorized', code: 'ACCOUNT_SUSPENDED', reason: user.suspendedReason ?? 'manual', message: 'Your account has been suspended.' })`.
  `findOneWithSuspension` already returns `isActive` + `suspendedReason` — no query change.
- **Frontend:** `ApiError.data` already preserves the response body, so consumers can
  read `error.data?.code`. The **login mutation** (`use-login-mutation.ts`) and the
  **auth bootstrap** `/auth/me` failure (`auth-context.tsx`) detect
  `code === 'ACCOUNT_SUSPENDED'` and navigate to a new **standalone `/account-suspended`
  route** carrying the reason (via router navigation state), instead of the normal
  toast / `session-expired` path. This route follows the existing standalone
  status-route pattern (`/session-expired`, `/403`, ...) and is reachable while
  unauthenticated. Logout is always allowed.

Rejected: a global 401 interceptor in `lib/api.ts` — it interacts badly with the refresh
queue, and a suspended user never gets far enough in for a per-request interceptor to
help. The two entry points (login, bootstrap) are the only places a suspended user's 401
actually originates.

### Decision 2 — manual workspace suspension: enforce in the guard, gate off /auth/me data (zero new requests)

**Key as-built finding:** `/auth/me` (`whoAmI`) already returns the full workspace row —
including `isActive`, `suspendedReason`, `suspendedAt` — for every workspace (no column
projection, no `isActive` filtering). The frontend simply doesn't *type* those fields.
So the manual-suspend reason is **already on the wire**; no 403-reason threading and no
extra request are needed.

- **Backend (defense-in-depth + correctness):** extend `WorkspaceSuspendedGuard` so that
  after the existing subscription check it also loads `workspace.isActive` +
  `suspendedReason` for the resolved `workspaceId`. If `isActive === false` -> throw the
  structured 403 `WORKSPACE_SUSPENDED` with `reason: suspendedReason ?? 'manual'`. The
  billing path keeps working but now also carries `reason: 'billing'` so the two are
  distinguishable. Preserve all early-outs (`@SkipSuspendCheck()`, no `workspaceId`
  param, no workspace row). Keep it fast — the guard runs on every workspace-scoped
  request; one extra cheap select on the workspace row.
- **Frontend:** add `isActive` / `suspendedReason` / `suspendedAt` to the `Workspace`
  type (`src/types/auth.ts`) — surfacing fields already in the payload. In
  `SubscriptionGate`, after the existing status-driven billing branch, look up the
  resolved workspace from `useAuth()` (`workspaces` / `lastAccessedWorkspace`) and, if
  `isActive === false` and not on a billing-allowlist path, render the
  `workspace-manual` variant of `AccountSuspendedScreen` with its `reason`. No new query.

### Decision 3 — one screen, three variants

Generalize `AccountSuspendedScreen` (`src/features/billing/components/`) from its current
`{ workspaceId }`-only, hardcoded-non-payment shape to accept a `variant` and optional
`reason`:

- `user` — "Your account is suspended" + friendly reason + `Contact support` (mailto,
  prefilled with the account email) + `Back to login`.
- `workspace-manual` — "This workspace is suspended" + friendly reason +
  `Contact support` + `Log out`.
- `workspace-billing` — existing payment copy + `Update payment method` + `Log out`
  (behaviour unchanged; `workspaceId` still required for the billing route).

All built on `StatusPage variant="branded"` (which already renders the shared "Contact
support" affordance via `StatusShell`/`SUPPORT_EMAIL`). Existing call site
(`SubscriptionGate` billing) migrates to `variant="workspace-billing" workspaceId={...}`.

## Components & data flow

### Backend (`socialmedia-workspace`)

1. **`src/auth/strategies/jwt.strategy.ts`** — replace the plain-string suspended throw
   with the structured `{ code: 'ACCOUNT_SUSPENDED', reason }` body (see Decision 1).
   No query change (`findOneWithSuspension` already returns the fields).
2. **`src/auth/guards/workspace-suspended.guard.ts`** — after the subscription check,
   also load and enforce `workspace.isActive`; add `reason` to both 403 paths
   (`'billing'` for the status path, `suspendedReason ?? 'manual'` for the manual path).
   Keep early-outs and speed.
3. **Tests** — extend `workspace-suspended.guard.spec.ts` (manual-suspend case + reason
   propagation on both paths + assert the structured body shape, which the current spec
   does not); add a `jwt.strategy` suspended-user case asserting the structured 401 body.

### Frontend (`socialmedia-frontend`)

1. **`src/types/auth.ts`** — add `isActive: boolean`, `suspendedReason: string | null`,
   `suspendedAt: string | null` to the `Workspace` interface (already in the `/auth/me`
   payload).
2. **`src/features/billing/lib/suspension-reason.ts`** (new) — pure
   `friendlySuspensionReason(reason?: string): string`:
   ```
   non_payment      -> "A billing issue on your account."
   policy_violation -> "A violation of our usage policies."
   abuse            -> "Activity that violated our terms of service."
   inactivity       -> "Your account was closed after a long period of inactivity."
   user_request     -> "This account was closed at your request."
   billing          -> "We could not process payment for this workspace."
   manual / unknown -> "Your account is currently under review."
   ```
3. **`AccountSuspendedScreen`** — generalize to `{ variant, reason?, workspaceId? }`
   (see Decision 3), all on `StatusPage`.
4. **`/account-suspended` route** — thin standalone page (guard-free, like
   `/session-expired`) that reads `reason` from navigation state and renders the `user`
   variant. Registered in `src/router.tsx` beside the other standalone status routes.
5. **Login mutation / auth bootstrap** — on a 401 whose `error.data.code ===
   'ACCOUNT_SUSPENDED'`, suppress the normal toast / `session-expired` and navigate to
   `/account-suspended` with the reason.
6. **`SubscriptionGate`** — after the billing-status branch, branch on the resolved
   workspace's `isActive === false` (from `useAuth()`) -> `workspace-manual` variant with
   `reason: workspace.suspendedReason`. Billing branch -> `workspace-billing`. Preserve
   the `isLoading` fail-open and the billing allowlist.

## Error / loading / empty / edge states

- **Loading:** preserve `SubscriptionGate`'s `isLoading` -> `<Outlet/>` fail-open; never
  flash-lock. The manual-suspend branch reads already-loaded `useAuth()` data, so it has
  no independent loading state.
- **Missing reason:** always fall back to `manual` friendly copy; never render empty.
- **Reason enum drift:** unknown reason -> `manual` copy (safe default).
- **Super admin:** cannot be suspended (guarded); no special-casing.
- **Recovery dead-ends avoided:** billing routes stay in the allowlist so a
  billing-suspended user can still pay; `Contact support` mailto works fully logged-out.
- **Reduced motion / focus / keyboard:** inherited from `StatusPage` (shadcn) — no new
  primitives.

## Testing strategy

- **Backend:** guard spec (manual + billing + skip + no-param + structured-body shape),
  jwt-strategy suspended case. Run `npx tsc --noEmit` + affected Jest specs.
- **Frontend:** `friendlySuspensionReason` unit test (each enum + unknown fallback); a
  render test per `AccountSuspendedScreen` variant (title + reason + actions). Run
  `npm run build` (tsc -b + vite) + eslint. No test runner beyond what exists.
- **Full-stack (CLAUDE.md rule 4):** backend `npm run build` + frontend `npm run build`
  both green.

## Out of scope

- No new suspension *reasons* or admin UI (admin app is separate — `schedura-admin`).
- No self-service un-suspend.
- No schema changes / migrations.
- Email infrastructure (ImprovMX/DNS) — handled by the user out-of-band.
- Reworking the `WorkspaceService.findOne` plain-string 403 (the global guard now covers
  manual suspend; findOne's check is left as a redundant inner guard).
