# Account & Workspace Status Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a deactivated/suspended user, and a manually- or billing-suspended workspace, a standardized status screen stating what happened, a user-safe reason, and how to recover (contact support / update payment) — instead of a silent logout or raw error.

**Architecture:** Backend emits *structured* auth errors carrying a `code` + coarse `reason` at every suspension choke point (login, jwt.strategy, workspace-suspended guard). Frontend maps the coarse reason to friendly copy and renders one reusable `StatusPage`-based screen in three variants (user / workspace-manual / workspace-billing). No schema changes.

**Tech Stack:** NestJS + Drizzle (backend), React 19 + Vite + Tailwind + shadcn (frontend), React Query, react-router.

## Global Constraints

- **No schema changes / no migrations.** All columns already exist (`users.isActive/suspendedReason`, `workspace.isActive/suspendedReason`). The assistant runs NO `db:*` command.
- **Shadcn-only** frontend UI. Reuse `StatusPage` / `StatusShell`; no hand-rolled panels.
- **Support email constant already exists** — `SUPPORT_EMAIL = 'support@schedura.ai'` in `src/features/status/components/status-footer.tsx`. Do NOT create another. Only remove the stale `TODO: confirm` comment.
- **Never leak `suspensionNote`** to the client — only the coarse `reason` enum crosses the wire.
- **Reason enum in lockstep:** backend `SUSPENSION_REASONS` = `non_payment | policy_violation | abuse | user_request | inactivity | manual`; the frontend friendly-text map must cover all of these + a `billing` case + an unknown fallback.
- **Super admins are never suspendable** (already guarded — do not change).
- **Staging only in git:** stage exact files per task, verify `git diff --cached --name-only`. Never `git add -A`. Never stage any `.env`.
- **No push / no PR / no merge** unless the user later asks.
- Backend typecheck: `npx tsc --noEmit`. Frontend: `npm run build`.

## File Structure

**Backend (`socialmedia-workspace`)**
- Modify: `src/auth/auth.service.ts` — add suspension check in `login()`.
- Modify: `src/auth/strategies/jwt.strategy.ts` — structured 401 body.
- Modify: `src/auth/guards/workspace-suspended.guard.ts` — also enforce `workspace.isActive`, attach `reason`.
- Modify: `src/auth/guards/workspace-suspended.guard.spec.ts` — manual-suspend + reason cases.
- Create: `src/auth/strategies/jwt.strategy.spec.ts` — suspended-user structured-401 case (if no spec exists yet).

**Frontend (`socialmedia-frontend`)**
- Create: `src/features/billing/lib/suspension-reason.ts` — `friendlySuspensionReason()`.
- Create: `src/features/billing/lib/suspension-reason.spec.ts` — map coverage.
- Modify: `src/features/status/components/status-footer.tsx` — drop stale TODO comment.
- Modify: `src/features/billing/components/account-suspended-screen.tsx` — add `variant` (`user` | `workspace-manual` | `workspace-billing`) + reason.
- Create: `src/pages/account-suspended.tsx` — thin page rendering the `user` variant from router state.
- Modify: `src/router.tsx` — add `/account-suspended` top-level route.
- Modify: `src/features/auth/hooks/use-login-mutation.ts` — detect `ACCOUNT_SUSPENDED` 401 → navigate to `/account-suspended`.
- Modify: `src/types/auth.ts` — type `isActive` / `suspendedReason` / `suspendedAt` on `Workspace` (already in the `/auth/me` payload).
- Modify: `src/features/billing/components/subscription-gate.tsx` — render `workspace-manual` variant, read from `useAuth()` workspace data (zero new requests).
- Modify: `src/contexts/auth-context.tsx` — on `/auth/me` 401 with `ACCOUNT_SUSPENDED`, surface the reason so a reload lands on the screen (not a blank logout).

---

## Task 1: Structured user-suspension errors (backend auth)

**Files:**
- Modify: `src/auth/auth.service.ts:90-133` (`login`)
- Modify: `src/auth/strategies/jwt.strategy.ts:40-55` (`validate`)
- Test: `src/auth/strategies/jwt.strategy.spec.ts` (create if absent)

**Interfaces:**
- Produces: a 401 error body shape used by the frontend —
  ```ts
  { statusCode: 401, error: 'Unauthorized', code: 'ACCOUNT_SUSPENDED', reason: string, message: string }
  ```
  `reason` is one of the `SUSPENSION_REASONS` values or `'manual'` fallback.

- [ ] **Step 1: Write the failing test** (jwt.strategy suspended user)

```ts
// src/auth/strategies/jwt.strategy.spec.ts
import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy suspension', () => {
  function make(userOverrides: Record<string, unknown>) {
    const usersService = {
      findOneWithSuspension: jest.fn().mockResolvedValue(userOverrides),
    };
    const config = { get: jest.fn().mockReturnValue('test-secret') };
    return new JwtStrategy(config as never, usersService as never);
  }

  it('throws a structured ACCOUNT_SUSPENDED 401 when the user is inactive', async () => {
    const strategy = make({
      id: 'u1', email: 'a@b.com', role: 'USER',
      isActive: false, suspendedReason: 'policy_violation',
    });
    await expect(
      strategy.validate({ sub: 'u1', email: 'a@b.com' }),
    ).rejects.toMatchObject({
      response: { code: 'ACCOUNT_SUSPENDED', reason: 'policy_violation' },
    });
  });

  it('passes an active user through', async () => {
    const strategy = make({
      id: 'u1', email: 'a@b.com', role: 'USER', isActive: true, suspendedReason: null,
    });
    await expect(
      strategy.validate({ sub: 'u1', email: 'a@b.com' }),
    ).resolves.toMatchObject({ userId: 'u1', role: 'USER' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/auth/strategies/jwt.strategy.spec.ts`
Expected: FAIL — the current throw uses a plain string, so `response.code` is undefined.

- [ ] **Step 3: Implement structured throw in jwt.strategy**

Replace the `if (!user.isActive) { ... }` block in `validate()` with:

```ts
if (!user.isActive) {
  throw new UnauthorizedException({
    statusCode: 401,
    error: 'Unauthorized',
    code: 'ACCOUNT_SUSPENDED',
    reason: user.suspendedReason ?? 'manual',
    message: 'Your account has been suspended.',
  });
}
```

- [ ] **Step 4: Add the same guard to `auth.service.login()`**

After the `if (!user) { throw new UnauthorizedException('Invalid credentials'); }` block (line ~95) and before the SUPER_ADMIN email-verify check, add:

```ts
if (!user.isActive) {
  throw new UnauthorizedException({
    statusCode: 401,
    error: 'Unauthorized',
    code: 'ACCOUNT_SUSPENDED',
    reason: user.suspendedReason ?? 'manual',
    message: 'Your account has been suspended.',
  });
}
```

(Rationale: without this, a suspended user "logs in" successfully, then immediately 401s on `/auth/me` — confusing. `validateUser` returns the full row, so `user.isActive`/`suspendedReason` are available here.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/auth/strategies/jwt.strategy.spec.ts`
Expected: PASS (both cases).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/auth/auth.service.ts src/auth/strategies/jwt.strategy.ts src/auth/strategies/jwt.strategy.spec.ts
git commit -m "feat(auth): structured ACCOUNT_SUSPENDED error on login + jwt validate"
```

---

## Task 2: Enforce manual workspace suspension in the guard (backend)

**Files:**
- Modify: `src/auth/guards/workspace-suspended.guard.ts`
- Test: `src/auth/guards/workspace-suspended.guard.spec.ts`

**Interfaces:**
- Consumes: `workspace.isActive`, `workspace.suspendedReason` from `../../drizzle/schema` (`workspace` table).
- Produces: a 403 error body —
  ```ts
  { statusCode: 403, error: 'Forbidden', code: 'WORKSPACE_SUSPENDED', reason: string, status?: string, message: string }
  ```
  `reason` = `'billing'` for the billing-suspended path, else `workspace.suspendedReason ?? 'manual'`.

- [ ] **Step 1: Write the failing test** (manual-suspend case)

Add to `workspace-suspended.guard.spec.ts` a case where the workspace has no suspended subscription status but `workspace.isActive === false`, asserting a thrown 403 with `code: 'WORKSPACE_SUSPENDED'` and `reason` from `suspendedReason`. Mirror the existing spec's mock-db style (mock the `.select().from().where().limit()` chain used by the guard). Also assert the existing billing path now carries `reason: 'billing'`, and that an active workspace with no bad subscription still returns `true`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/auth/guards/workspace-suspended.guard.spec.ts`
Expected: FAIL — the guard does not read `workspace.isActive` yet.

- [ ] **Step 3: Implement the dual check**

In `canActivate`, keep the early-outs (skip decorator, no `workspaceId`) unchanged. Then:
1. Load the workspace's own state alongside (or before) the subscription check:
   ```ts
   const wsRows = await this.db
     .select({ isActive: workspace.isActive, reason: workspace.suspendedReason })
     .from(workspace)
     .where(eq(workspace.id, workspaceId))
     .limit(1);
   const ws = wsRows[0];
   if (ws && ws.isActive === false) {
     throw new ForbiddenException({
       statusCode: 403,
       error: 'Forbidden',
       code: 'WORKSPACE_SUSPENDED',
       reason: ws.reason ?? 'manual',
       message: 'This workspace has been suspended. Contact support for details.',
     });
   }
   ```
   Import `workspace` from `../../drizzle/schema` (add to the existing import).
2. Keep the existing subscription-status check, but add `reason: 'billing'` to its thrown body (alongside the existing `status`).
3. If no workspace row exists → treat as pass (unchanged early-out semantics).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/auth/guards/workspace-suspended.guard.spec.ts`
Expected: PASS (manual + billing + active + skip).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/auth/guards/workspace-suspended.guard.ts src/auth/guards/workspace-suspended.guard.spec.ts
git commit -m "feat(auth): enforce manual workspace suspension in WorkspaceSuspendedGuard"
```

---

## Task 3: Friendly reason map + confirm support email (frontend)

**Files:**
- Create: `src/features/billing/lib/suspension-reason.ts`
- Test: `src/features/billing/lib/suspension-reason.spec.ts`
- Modify: `src/features/status/components/status-footer.tsx` (drop stale TODO comment only)

**Interfaces:**
- Produces: `friendlySuspensionReason(reason?: string | null): string` — total function, always returns non-empty copy.

- [ ] **Step 1: Write the failing test**

```ts
// src/features/billing/lib/suspension-reason.spec.ts
import { describe, it, expect } from 'vitest'
import { friendlySuspensionReason } from './suspension-reason'

describe('friendlySuspensionReason', () => {
  it('maps every known reason to non-empty copy', () => {
    for (const r of [
      'non_payment', 'policy_violation', 'abuse',
      'user_request', 'inactivity', 'manual', 'billing',
    ]) {
      expect(friendlySuspensionReason(r).length).toBeGreaterThan(0)
    }
  })
  it('falls back to the review copy for unknown / missing reasons', () => {
    expect(friendlySuspensionReason(undefined)).toBe(friendlySuspensionReason('manual'))
    expect(friendlySuspensionReason('something_new')).toBe(friendlySuspensionReason('manual'))
  })
})
```

> NOTE (verified 2026-08-09): the frontend HAS a test runner — **Vitest 4.1.9** (`npm run test` → `vitest run`). Write and run this spec normally. There is NO `@testing-library/react` installed, so pure-function specs like this one are fine, but do NOT add React render tests elsewhere without installing a testing library (out of scope for this effort).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test src/features/billing/lib/suspension-reason.spec.ts`
Expected: FAIL (module not found — the file does not exist yet).

- [ ] **Step 3: Implement the map**

```ts
// src/features/billing/lib/suspension-reason.ts

/**
 * Maps the backend's coarse suspension `reason` enum to user-safe copy.
 * Kept in lockstep with the backend SUSPENSION_REASONS. Internal notes are
 * never surfaced — only this friendly text. Unknown/missing → review copy.
 */
const REASON_COPY: Record<string, string> = {
  non_payment: 'There is a billing issue on your account.',
  policy_violation: 'This was due to a violation of our usage policies.',
  abuse: 'This was due to activity that violated our terms of service.',
  inactivity: 'Your account was closed after a long period of inactivity.',
  user_request: 'This account was closed at your request.',
  billing: "We couldn't process payment for this workspace.",
  manual: 'Your account is currently under review.',
}

export function friendlySuspensionReason(reason?: string | null): string {
  if (!reason) return REASON_COPY.manual
  return REASON_COPY[reason] ?? REASON_COPY.manual
}
```

- [ ] **Step 4: Run test to verify it passes** (or skip per note)

Run: `npm run test 2>/dev/null || echo "no test runner"`
Expected: PASS, or handled per the Step-1 note.

- [ ] **Step 5: Drop the stale TODO comment**

In `status-footer.tsx`, remove the line `// TODO: confirm the real support address — placeholder until then.` above `export const SUPPORT_EMAIL`. Leave the value `'support@schedura.ai'` unchanged.

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 7: Commit**

```bash
git add src/features/billing/lib/suspension-reason.ts src/features/status/components/status-footer.tsx
# add the spec too if a runner exists:
git add src/features/billing/lib/suspension-reason.spec.ts 2>/dev/null || true
git commit -m "feat(billing): friendly suspension-reason map; confirm support email"
```

---

## Task 4: Generalize AccountSuspendedScreen into three variants (frontend)

**Files:**
- Modify: `src/features/billing/components/account-suspended-screen.tsx`

**Interfaces:**
- Consumes: `friendlySuspensionReason` (Task 3), `SUPPORT_EMAIL` (existing), `StatusPage` (existing, `variant="branded"` shows the shared Contact-support button).
- Produces:
  ```ts
  type SuspendedVariant = 'user' | 'workspace-manual' | 'workspace-billing'
  interface AccountSuspendedScreenProps {
    variant: SuspendedVariant
    reason?: string | null
    workspaceId?: string   // required for workspace-billing (Update payment nav)
  }
  ```
  The `workspace-billing` variant keeps its exact current copy + `Update payment` + `Log out` behaviour. `workspaceId` was the prop before; keep backward-compatible by defaulting `variant` to `'workspace-billing'` so existing callers don't break.

- [ ] **Step 1: Implement the variant component**

Rewrite `account-suspended-screen.tsx` so it renders `StatusPage variant="branded"` (which already gives the Contact-support button via `StatusShell`), with per-variant title/description/actions:

```tsx
import { useNavigate } from 'react-router'
import { CreditCard, LogOut, ShieldAlert } from 'lucide-react'
import { StatusPage } from '@/features/status/components/status-page'
import { useAuth } from '@/contexts/auth-context'
import { wsPath } from '@/lib/workspace-path'
import { friendlySuspensionReason } from '@/features/billing/lib/suspension-reason'

export type SuspendedVariant = 'user' | 'workspace-manual' | 'workspace-billing'

interface AccountSuspendedScreenProps {
  variant?: SuspendedVariant
  reason?: string | null
  workspaceId?: string
}

export function AccountSuspendedScreen({
  variant = 'workspace-billing',
  reason,
  workspaceId,
}: AccountSuspendedScreenProps) {
  const navigate = useNavigate()
  const { logout } = useAuth()

  const logoutAction = {
    label: 'Log out',
    variant: 'outline' as const,
    icon: LogOut,
    onClick: async () => {
      await logout()
      navigate('/login', { replace: true })
    },
  }

  if (variant === 'workspace-billing') {
    return (
      <StatusPage
        variant="branded"
        icon={CreditCard}
        tone="destructive"
        title="Workspace suspended"
        description="We couldn't process payment for this workspace, so access is paused. Update your payment method to restore it right away."
        actions={[
          {
            label: 'Update payment method',
            icon: CreditCard,
            onClick: () =>
              navigate(wsPath(workspaceId ?? '', 'settings/billing')),
          },
          logoutAction,
        ]}
      />
    )
  }

  const isUser = variant === 'user'
  return (
    <StatusPage
      variant="branded"
      icon={ShieldAlert}
      tone="destructive"
      title={isUser ? 'Your account is suspended' : 'This workspace is suspended'}
      description={friendlySuspensionReason(reason)}
      actions={
        isUser
          ? [{ label: 'Back to login', variant: 'outline', icon: LogOut,
               onClick: async () => { await logout(); navigate('/login', { replace: true }) } }]
          : [logoutAction]
      }
    />
  )
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: success (existing billing caller still compiles via the default variant).

- [ ] **Step 3: Commit**

```bash
git add src/features/billing/components/account-suspended-screen.tsx
git commit -m "feat(billing): AccountSuspendedScreen supports user + workspace-manual + billing variants"
```

---

## Task 5: `/account-suspended` route + login-time redirect (frontend)

**Files:**
- Create: `src/pages/account-suspended.tsx`
- Modify: `src/router.tsx`
- Modify: `src/features/auth/hooks/use-login-mutation.ts`

**Interfaces:**
- Consumes: `AccountSuspendedScreen` (Task 4, `variant="user"`), `ApiError.data` (the 401 body from Task 1, shape `{ code, reason }`).
- Route: top-level `/account-suspended` (sibling to `/session-expired`, `/403`) — reachable unauthenticated.

- [ ] **Step 1: Create the page**

```tsx
// src/pages/account-suspended.tsx
import { useLocation } from 'react-router'
import { AccountSuspendedScreen } from '@/features/billing/components/account-suspended-screen'

export function AccountSuspendedPage() {
  const location = useLocation()
  const reason = (location.state as { reason?: string } | null)?.reason
  return <AccountSuspendedScreen variant="user" reason={reason} />
}
```

- [ ] **Step 2: Register the route**

In `router.tsx`, next to the other standalone status routes (`/session-expired`, `/403`), add:

```tsx
<Route path="/account-suspended" element={<AccountSuspendedPage />} />
```

Add the matching import at the top with the other page imports.

- [ ] **Step 3: Redirect from the login mutation**

In `use-login-mutation.ts` `onError`, before the existing toast logic, detect the suspended code and navigate instead:

```ts
onError: (error) => {
  if (
    error instanceof ApiError &&
    error.status === 401 &&
    error.data &&
    typeof error.data === 'object' &&
    (error.data as { code?: string }).code === 'ACCOUNT_SUSPENDED'
  ) {
    const reason = (error.data as { reason?: string }).reason
    navigate('/account-suspended', { state: { reason } })
    return
  }
  // ...existing toast logic unchanged
}
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add src/pages/account-suspended.tsx src/router.tsx src/features/auth/hooks/use-login-mutation.ts
git commit -m "feat(auth): route suspended-account login to /account-suspended"
```

---

## Task 6: Auth bootstrap + SubscriptionGate handle suspension on reload (frontend)

**Files:**
- Modify: `src/types/auth.ts` (type the workspace suspension fields — prerequisite for Step 2)
- Modify: `src/contexts/auth-context.tsx`
- Modify: `src/features/billing/components/subscription-gate.tsx`

**Interfaces:**
- Consumes: the `ACCOUNT_SUSPENDED` 401 (Task 1) surfaced through `/auth/me`; `workspace.isActive`/`suspendedReason` already present on `useAuth()` workspaces (typed in Step 2a).

- [ ] **Step 1: auth-context — land a reloaded suspended user on the screen**

In `auth-context.tsx`, where the `/auth/me` query error is handled (the `retry` at line ~79 already special-cases 401), detect the `ACCOUNT_SUSPENDED` code and redirect to `/account-suspended` (with reason) rather than a blank logged-out state. Keep it minimal: on a 401 whose `data.code === 'ACCOUNT_SUSPENDED'`, set the same navigation. If the context has no router access, expose the reason via context state that a top-level effect (or the existing ProtectedRoute) reads to redirect. Pick the smallest wiring consistent with how the context already reacts to a failed `me`.

- [ ] **Step 2: SubscriptionGate — render workspace-manual variant (from `/auth/me` data, ZERO new requests)**

**VERIFIED APPROACH (2026-08-09):** `workspace.isActive` / `suspendedReason` are ALREADY in the `/auth/me` payload and exposed via `useAuth().workspaces` / `lastAccessedWorkspace` once Task 6.0 types them (see below). Do NOT add a `useWorkspaceSuspension` hook and do NOT catch a 403 — just read the already-loaded workspace object. This is simpler, needs no extra request, and works even when the manual-suspend guard 403 would otherwise blank the shell.

- [ ] **Step 2a (prerequisite): type the fields on `Workspace`.**
  In `src/types/auth.ts`, add to the `Workspace` interface (fields already present at runtime in the `/auth/me` response — see the `whoAmI` full-row select):
  ```ts
  isActive: boolean
  suspendedReason: string | null
  suspendedAt: string | null
  ```

- [ ] **Step 2b: branch the gate.**
  Rewrite `subscription-gate.tsx` so that, after the existing `isLoading` early-out, it resolves the active workspace object from `useAuth()` and checks manual suspension BEFORE the billing-status check (manual admin suspend is the stronger lock). Keep the billing allowlist behaviour identical for the billing case. Concrete implementation:

  ```tsx
  import { Outlet, useLocation, useParams } from 'react-router'
  import { useAuth } from '@/contexts/auth-context'
  import { useWorkspaceSubscription } from '@/features/billing/hooks/use-workspace-subscription'
  import { classifySubscription } from '@/features/billing/lib/subscription-status'
  import { AccountSuspendedScreen } from '@/features/billing/components/account-suspended-screen'

  const BILLING_ALLOWLIST = ['settings/billing', 'settings/plans']

  function isBillingPath(pathname: string): boolean {
    const subPath = pathname.replace(/^\/w\/[^/]+\/?/, '')
    return BILLING_ALLOWLIST.some(
      (p) => subPath === p || subPath.startsWith(`${p}/`),
    )
  }

  export function SubscriptionGate() {
    const { workspaceId } = useParams<{ workspaceId: string }>()
    const { pathname } = useLocation()
    const { workspaces, lastAccessedWorkspace } = useAuth()
    const { subscription, isLoading } = useWorkspaceSubscription(workspaceId)

    // Resolve the active workspace object from already-loaded /auth/me data.
    const workspace =
      (workspaceId && workspaces.find((w) => w.id === workspaceId)) ||
      lastAccessedWorkspace ||
      null

    // Manual admin suspension is the strongest lock and is known synchronously
    // from /auth/me — no request, no loading state. Check it first.
    if (workspace && workspace.isActive === false && !isBillingPath(pathname)) {
      return (
        <AccountSuspendedScreen
          variant="workspace-manual"
          reason={workspace.suspendedReason}
        />
      )
    }

    // Billing suspension depends on the subscription query; keep the fail-open.
    if (isLoading) return <Outlet />

    const tier = classifySubscription(subscription?.status)
    if (tier === 'suspended' && workspaceId && !isBillingPath(pathname)) {
      return <AccountSuspendedScreen variant="workspace-billing" workspaceId={workspaceId} />
    }

    return <Outlet />
  }
  ```

  Notes for the implementer: the existing billing call site changes from `<AccountSuspendedScreen workspaceId={workspaceId} />` to the explicit `variant="workspace-billing"` form (Task 4 keeps `workspace-billing` as the default, so either compiles, but be explicit). Do not remove the billing allowlist. The manual branch has no independent loading state because it reads synchronous context data.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 4: Manual reasoning check (no runner for these paths)**

Confirm by reading the final diff: (a) active user unaffected; (b) suspended user on reload → `/account-suspended`; (c) manual-suspended workspace → workspace-manual screen; (d) billing path visuals/behaviour unchanged; (e) billing allowlist still lets a billing-suspended user reach settings/billing.

- [ ] **Step 5: Commit**

```bash
git add src/contexts/auth-context.tsx src/features/billing/components/subscription-gate.tsx
git commit -m "feat(billing): handle suspension on reload + manual workspace-suspend gate"
```

---

## Self-Review Notes

- **Spec coverage:** Task 1 = user structured error (login + jwt); Task 2 = manual workspace enforcement; Task 3 = reason map + support email; Task 4 = screen variants; Task 5 = route + login redirect; Task 6 = reload + gate. All spec sections covered.
- **Type consistency:** the 401 body `{ code, reason }` produced in Task 1 is consumed unchanged in Task 5/6; `friendlySuspensionReason` (Task 3) consumed in Task 4; `AccountSuspendedScreen` variant prop (Task 4) consumed in Task 5/6.
- **RESOLVED (2026-08-09) — how `SubscriptionGate` learns of a manual suspend:** verified that `/auth/me` already returns `workspace.isActive`/`suspendedReason`, exposed via `useAuth()`. Task 6 Step 2 now reads that directly (zero new requests); the old "catch-the-403 hook" idea is dropped.
- **Frontend test runner IS present — Vitest 4.1.9** (`npm run test`). Task 3 ships a real Vitest spec. Tasks 4–6 rely on `npm run build` + explicit manual reasoning checks (no `@testing-library/react` is installed, so no React render tests — adding one is out of scope).
- **Task 1 status: ALREADY DONE** on this branch (commit `c879ca9` — jwt.strategy structured throw + `auth.service.login` isActive check + `jwt.strategy.spec.ts`). Executors must NOT re-dispatch Task 1; start at Task 2.
