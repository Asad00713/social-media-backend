# Launch Allowlist Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict the whole app to an email allowlist before public launch — every other authenticated user (including new signups) is blocked at the API (403 `NOT_LAUNCHED`) and sent to an Under-development page; clearing one env var disables the gate at launch.

**Architecture:** A new backend global `APP_GUARD` (`AllowlistGuard`) verifies the JWT itself (JWT is per-controller, not global, so `req.user` isn't available to a global guard), checks the caller's email + role against a comma-separated env allowlist, and 403s non-allowlisted callers. `/auth/me` gains a derived `isAllowlisted` boolean. Frontend adds an `Under Development` status page and a `LaunchGate` route wrapper that redirects `isAllowlisted === false` users there.

**Tech Stack:** NestJS + Drizzle + `@nestjs/jwt` (backend), React 19 + Vite + TS + react-router + shadcn (frontend), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-13-launch-allowlist-gate-design.md`

## Global Constraints

- **Access-gate ONLY — never a role/permission grant.** The allowlist decides reachability, nothing else. Never derive roles or promote anyone from it.
- **The allowlist never reaches the client.** `/auth/me` exposes only `isAllowlisted: boolean`.
- **Empty/unset `ALLOWLIST_EMAILS` = gate OFF (everyone allowed).** A missing env var must never lock out users. Gate is ON only when the var is non-empty.
- **Super admins always pass** the gate.
- **Email comparison is case-insensitive + trimmed.**
- **No schema changes / no migrations.** The assistant runs NO `db:*` command.
- **Shadcn-only** frontend; the page reuses `StatusPage`/`StatusShell`. Contact = `support@schedura.ai` via the existing `openSupportEmail()` (Gmail-compose) flow; NO social links.
- **403 body is exactly** `{ statusCode: 403, error: 'Forbidden', code: 'NOT_LAUNCHED', message: 'Schedura is not yet publicly available. You will get access at launch.' }`.
- **`/auth/me` MUST never be gated** (it is the signal source) — mark it `@SkipLaunchGate()`.
- **Staging:** stage exact files per task; verify `git diff --cached --name-only`; never `git add -A`; never stage `.env`.
- **No push / no PR / no merge** unless the user later asks.
- Backend typecheck `npx tsc --noEmit`; there are 3 PRE-EXISTING unrelated tsc errors — verify (via `git stash`) you introduce no new ones. Frontend `npm run build` + `npm run test` (Vitest).

## File Structure

**Backend (`socialmedia-workspace`)**
- Create: `src/auth/allowlist.ts` — `parseAllowlist()` + `isEmailAllowlisted(email, role)` pure helpers.
- Create: `src/auth/allowlist.spec.ts` — unit tests for the helper.
- Create: `src/auth/decorators/skip-launch-gate.decorator.ts` — `@SkipLaunchGate()` (mirrors `skip-suspend-check.decorator.ts`).
- Create: `src/auth/guards/allowlist.guard.ts` — the global guard.
- Create: `src/auth/guards/allowlist.guard.spec.ts` — guard tests.
- Modify: `src/app.module.ts` — register `AllowlistGuard` as a second `APP_GUARD`.
- Modify: `src/auth/auth.service.ts` — add `isAllowlisted` to `MeResponse` + `whoAmI`.
- Modify: `src/auth/auth.controller.ts` (wherever the `/auth/me` route is) — add `@SkipLaunchGate()`.
- Modify: `.env.example` — document `ALLOWLIST_EMAILS`.

**Frontend (`socialmedia-frontend`)**
- Create: `src/pages/under-development.tsx` — thin status page.
- Create: `src/components/routes/launch-gate.tsx` — the route wrapper.
- Modify: `src/types/auth.ts` — add `isAllowlisted: boolean` to `MeResponse`.
- Modify: `src/contexts/auth-context.tsx` — expose `isAllowlisted` from `useAuth()`.
- Modify: `src/router.tsx` — add `/under-development` standalone route + wrap authenticated app sections in `LaunchGate`.

---

## Task 1: Allowlist config helper (backend)

**Files:**
- Create: `src/auth/allowlist.ts`
- Test: `src/auth/allowlist.spec.ts`

**Interfaces:**
- Produces:
  - `parseAllowlist(raw: string | undefined): string[]` — comma-split, trimmed, lowercased, empties dropped.
  - `isEmailAllowlisted(email: string | undefined | null, role: string | undefined): boolean` — reads `process.env.ALLOWLIST_EMAILS` at call time; returns `true` if the parsed list is empty (gate off) OR `role === 'SUPER_ADMIN'` OR the trimmed+lowercased email is in the list; else `false`.

- [ ] **Step 1: Write the failing test**

```ts
// src/auth/allowlist.spec.ts
import { parseAllowlist, isEmailAllowlisted } from './allowlist';

describe('parseAllowlist', () => {
  it('splits, trims, lowercases, drops empties', () => {
    expect(parseAllowlist(' A@x.com , b@Y.com ,, ')).toEqual(['a@x.com', 'b@y.com']);
  });
  it('returns [] for undefined/empty', () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist('   ')).toEqual([]);
  });
});

describe('isEmailAllowlisted', () => {
  const OLD = process.env.ALLOWLIST_EMAILS;
  afterEach(() => { process.env.ALLOWLIST_EMAILS = OLD; });

  it('gate OFF (empty env) → anyone allowed', () => {
    delete process.env.ALLOWLIST_EMAILS;
    expect(isEmailAllowlisted('nobody@x.com', 'USER')).toBe(true);
  });
  it('listed email allowed (case-insensitive)', () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com,b@y.com';
    expect(isEmailAllowlisted('A@X.com', 'USER')).toBe(true);
  });
  it('unlisted email blocked', () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    expect(isEmailAllowlisted('c@z.com', 'USER')).toBe(false);
  });
  it('super admin always allowed even if unlisted', () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    expect(isEmailAllowlisted('c@z.com', 'SUPER_ADMIN')).toBe(true);
  });
  it('missing email blocked when gate on', () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    expect(isEmailAllowlisted(undefined, 'USER')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/auth/allowlist.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

```ts
// src/auth/allowlist.ts

/**
 * Parses the ALLOWLIST_EMAILS env var (comma-separated) into a normalized
 * lowercase list. An empty result means "gate off" — see isEmailAllowlisted.
 */
export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

/**
 * Launch gate check. The allowlist is an ACCESS gate only — it never grants a
 * role. Returns true (allowed) when the gate is off (empty list), when the
 * caller is a super admin, or when the caller's email is listed. Otherwise
 * false. Reads process.env at call time so a redeploy with a changed var takes
 * effect without code changes.
 */
export function isEmailAllowlisted(
  email: string | undefined | null,
  role: string | undefined,
): boolean {
  const list = parseAllowlist(process.env.ALLOWLIST_EMAILS);
  if (list.length === 0) return true; // gate off
  if (role === 'SUPER_ADMIN') return true;
  if (!email) return false;
  return list.includes(email.trim().toLowerCase());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/auth/allowlist.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/allowlist.ts src/auth/allowlist.spec.ts
git commit -m "feat(auth): allowlist config helper (parse + isEmailAllowlisted)"
```

---

## Task 2: `@SkipLaunchGate()` decorator + AllowlistGuard (backend)

**Files:**
- Create: `src/auth/decorators/skip-launch-gate.decorator.ts`
- Create: `src/auth/guards/allowlist.guard.ts`
- Test: `src/auth/guards/allowlist.guard.spec.ts`

**Interfaces:**
- Consumes: `isEmailAllowlisted` (Task 1); `JwtService` + `ConfigService` (for token verify); `UsersService.findOneWithSuspension(sub)` (returns `role`).
- Produces:
  - `SKIP_LAUNCH_GATE` metadata key + `SkipLaunchGate()` decorator.
  - `AllowlistGuard` (implements `CanActivate`), throws 403 `NOT_LAUNCHED` for blocked callers, passes otherwise.

- [ ] **Step 1: Write the decorator**

```ts
// src/auth/decorators/skip-launch-gate.decorator.ts
import { SetMetadata } from '@nestjs/common';

export const SKIP_LAUNCH_GATE = 'skipLaunchGate';

/**
 * Marks a route/controller as exempt from AllowlistGuard, so it stays reachable
 * even for a non-allowlisted user. Applied to `/auth/me` (the frontend must be
 * able to read `isAllowlisted` to render the Under-development page).
 */
export const SkipLaunchGate = () => SetMetadata(SKIP_LAUNCH_GATE, true);
```

- [ ] **Step 2: Write the failing guard test**

```ts
// src/auth/guards/allowlist.guard.spec.ts
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AllowlistGuard } from './allowlist.guard';

function ctx(headers: Record<string, string | undefined>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}
const reflector = (skip: boolean) =>
  ({ getAllAndOverride: jest.fn().mockReturnValue(skip) }) as unknown as Reflector;

function make(opts: {
  skip?: boolean;
  verify?: (t: string) => { sub: string; email: string };
  role?: string;
}) {
  const jwtService = {
    verify: jest.fn((t: string) =>
      opts.verify ? opts.verify(t) : { sub: 'u1', email: 'x@x.com' },
    ),
  };
  const config = { get: jest.fn().mockReturnValue('secret') };
  const usersService = {
    findOneWithSuspension: jest.fn().mockResolvedValue({ role: opts.role ?? 'USER' }),
  };
  return new AllowlistGuard(
    reflector(!!opts.skip),
    jwtService as never,
    config as never,
    usersService as never,
  );
}

describe('AllowlistGuard', () => {
  const OLD = process.env.ALLOWLIST_EMAILS;
  afterEach(() => { process.env.ALLOWLIST_EMAILS = OLD; });

  it('passes when gate is off (no env)', async () => {
    delete process.env.ALLOWLIST_EMAILS;
    const g = make({});
    await expect(g.canActivate(ctx({ authorization: 'Bearer t' }))).resolves.toBe(true);
  });

  it('passes @SkipLaunchGate routes without checking', async () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    const g = make({ skip: true });
    await expect(g.canActivate(ctx({ authorization: 'Bearer t' }))).resolves.toBe(true);
  });

  it('passes when there is no/invalid token (let JwtAuthGuard handle auth)', async () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    const g = make({ verify: () => { throw new Error('bad'); } });
    await expect(g.canActivate(ctx({}))).resolves.toBe(true);
  });

  it('blocks an unlisted user with 403 NOT_LAUNCHED', async () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    const g = make({ verify: () => ({ sub: 'u1', email: 'c@z.com' }), role: 'USER' });
    await expect(g.canActivate(ctx({ authorization: 'Bearer t' }))).rejects.toMatchObject({
      response: { code: 'NOT_LAUNCHED' },
    });
  });

  it('passes a listed user', async () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    const g = make({ verify: () => ({ sub: 'u1', email: 'a@x.com' }), role: 'USER' });
    await expect(g.canActivate(ctx({ authorization: 'Bearer t' }))).resolves.toBe(true);
  });

  it('passes a super admin even if unlisted', async () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    const g = make({ verify: () => ({ sub: 'u1', email: 'c@z.com' }), role: 'SUPER_ADMIN' });
    await expect(g.canActivate(ctx({ authorization: 'Bearer t' }))).resolves.toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest src/auth/guards/allowlist.guard.spec.ts`
Expected: FAIL — guard not implemented.

- [ ] **Step 4: Implement the guard**

```ts
// src/auth/guards/allowlist.guard.ts
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../../users/users.service';
import { isEmailAllowlisted, parseAllowlist } from '../allowlist';
import { SKIP_LAUNCH_GATE } from '../decorators/skip-launch-gate.decorator';

/**
 * Global launch gate. Before public launch, only allowlisted emails (and super
 * admins) may reach the app; everyone else gets 403 NOT_LAUNCHED. The gate is
 * OFF (pass-through) when ALLOWLIST_EMAILS is empty/unset.
 *
 * JwtAuthGuard is per-controller, not global, so this global guard cannot rely
 * on req.user. It verifies the bearer token itself (best-effort): no/invalid
 * token → pass (the route's own auth guard, if any, will reject). It is an
 * access gate only and never grants a role.
 */
@Injectable()
export class AllowlistGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Gate off → nothing to do, cheapest path first.
    if (parseAllowlist(process.env.ALLOWLIST_EMAILS).length === 0) return true;

    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_LAUNCH_GATE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const req = context
      .switchToHttp()
      .getRequest<{ headers?: Record<string, string | undefined> }>();
    const auth = req.headers?.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return true; // unauthenticated → not our job

    let payload: { sub?: string; email?: string };
    try {
      payload = this.jwtService.verify(auth.slice(7), {
        secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      });
    } catch {
      return true; // invalid/expired token → let JwtAuthGuard 401 it
    }

    // Need the role to honor "super admin always passes".
    let role: string | undefined;
    try {
      const user = await this.usersService.findOneWithSuspension(
        payload.sub as string,
      );
      role = user?.role;
    } catch {
      role = undefined;
    }

    if (isEmailAllowlisted(payload.email, role)) return true;

    throw new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      code: 'NOT_LAUNCHED',
      message:
        'Schedura is not yet publicly available. You will get access at launch.',
    });
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/auth/guards/allowlist.guard.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no NEW errors (3 pre-existing unrelated ones may remain).

- [ ] **Step 7: Commit**

```bash
git add src/auth/decorators/skip-launch-gate.decorator.ts src/auth/guards/allowlist.guard.ts src/auth/guards/allowlist.guard.spec.ts
git commit -m "feat(auth): AllowlistGuard + SkipLaunchGate decorator (launch gate)"
```

---

## Task 3: Register guard + `/auth/me` isAllowlisted + env docs (backend)

**Files:**
- Modify: `src/app.module.ts` (register second `APP_GUARD`)
- Modify: `src/auth/auth.service.ts` (`MeResponse` + `whoAmI`)
- Modify: `src/auth/auth.controller.ts` (mark `/auth/me` `@SkipLaunchGate()`)
- Modify: `.env.example`

**Interfaces:**
- Consumes: `AllowlistGuard` (Task 2), `isEmailAllowlisted` (Task 1), `SkipLaunchGate` (Task 2).
- Produces: `MeResponse.isAllowlisted: boolean` on the `/auth/me` payload.

- [ ] **Step 1: Register the guard**

In `src/app.module.ts` providers, add a second `APP_GUARD` after the existing `WorkspaceSuspendedGuard` line:

```ts
{ provide: APP_GUARD, useClass: AllowlistGuard },
```

Add the import: `import { AllowlistGuard } from './auth/guards/allowlist.guard';`. Ensure `JwtModule`, `ConfigModule`, and the module exporting `UsersService` are available to the app module's injector (they already are — `AuthModule`/`UsersModule` are imported app-wide; if the guard can't resolve `UsersService`/`JwtService` at boot, import the providing module into `AppModule` or move the `APP_GUARD` provider into a module that already has them, e.g. `AuthModule`). The registration must not break cold boot.

- [ ] **Step 2: Add `isAllowlisted` to the me-response**

In `src/auth/auth.service.ts`:
- Import `isEmailAllowlisted` from `./allowlist`.
- Add `isAllowlisted: boolean;` to the `MeResponse` interface.
- In `whoAmI`, compute and return it:

```ts
isAllowlisted: isEmailAllowlisted(user.email, user.role),
```

(`user` here is the `PublicUser` from `usersService.findOne(userId)`; confirm it carries `email` and `role` — it does, per the PublicUser columns. Add them to the projection if missing.)

- [ ] **Step 3: Mark `/auth/me` as skip**

In `src/auth/auth.controller.ts`, add `@SkipLaunchGate()` to the `/auth/me` (`me`/`whoAmI`) route handler, and import the decorator. This guarantees a blocked user can still fetch `/auth/me` (200 with `isAllowlisted:false`) to render the page.

- [ ] **Step 4: Document the env var**

In `.env.example`, add:

```
# Launch gate: comma-separated emails allowed into the app before public launch.
# Empty/unset = gate OFF (everyone allowed). Super admins always bypass.
ALLOWLIST_EMAILS=
```

- [ ] **Step 5: Verify boot + tests + typecheck**

Run: `npx jest src/auth` then `npx tsc --noEmit`
Expected: auth suites pass; no NEW tsc errors. (If a spec for `whoAmI`/auth.service exists, ensure the new field doesn't break it.)

- [ ] **Step 6: Commit**

```bash
git add src/app.module.ts src/auth/auth.service.ts src/auth/auth.controller.ts .env.example
git commit -m "feat(auth): register AllowlistGuard + expose isAllowlisted on /auth/me"
```

---

## Task 4: Under-development page (frontend)

**Files:**
- Create: `src/pages/under-development.tsx`

**Interfaces:**
- Consumes: `StatusPage` (`src/features/status/components/status-page.tsx`, `variant="branded"`), `openSupportEmail` (`src/features/status/components/status-footer.tsx`), `useAuth` (for logout).
- Produces: `UnderDevelopmentPage` (default export, matching the other status pages' export style — verify `session-expired.tsx` and match it).

- [ ] **Step 1: Implement the page**

Match the export style of the sibling status pages (check `src/pages/session-expired.tsx` — if it's `export default function`, use that). Thin shell:

```tsx
import { useNavigate } from 'react-router'
import { Hammer, LogOut, LifeBuoy } from 'lucide-react'
import { StatusPage } from '@/features/status/components/status-page'
import { openSupportEmail } from '@/features/status/components/status-footer'
import { useAuth } from '@/contexts/auth-context'

export default function UnderDevelopmentPage() {
  const navigate = useNavigate()
  const { logout } = useAuth()

  return (
    <StatusPage
      variant="branded"
      icon={Hammer}
      tone="default"
      title="We're putting on the finishing touches"
      description="Schedura is almost ready. We're not open to everyone just yet — you'll get access the moment we launch."
      actions={[
        {
          label: 'Contact support',
          icon: LifeBuoy,
          variant: 'outline',
          onClick: () => openSupportEmail('Early access request'),
        },
        {
          label: 'Log out',
          variant: 'outline',
          icon: LogOut,
          onClick: async () => {
            await logout()
            navigate('/login', { replace: true })
          },
        },
      ]}
    />
  )
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add src/pages/under-development.tsx
git commit -m "feat(status): Under-development page for the launch gate"
```

---

## Task 5: Type isAllowlisted + expose from useAuth (frontend)

**Files:**
- Modify: `src/types/auth.ts`
- Modify: `src/contexts/auth-context.tsx`

**Interfaces:**
- Consumes: the `/auth/me` `isAllowlisted` field (Task 3).
- Produces: `useAuth().isAllowlisted: boolean` (defaults to `true` when unknown/loading — fail-open, consistent with the gate).

- [ ] **Step 1: Add the field to the type**

In `src/types/auth.ts`, add to `MeResponse`:

```ts
isAllowlisted: boolean
```

- [ ] **Step 2: Expose it from the context**

In `src/contexts/auth-context.tsx`:
- Add `isAllowlisted: boolean` to `AuthContextValue`.
- Derive it from the `meQuery` data: `const isAllowlisted = meQuery.data?.isAllowlisted ?? true` (fail-open while loading / before `/auth/me` resolves — matches SubscriptionGate's no-flash-lock principle).
- Include `isAllowlisted` in the context `value`.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add src/types/auth.ts src/contexts/auth-context.tsx
git commit -m "feat(auth): expose isAllowlisted from useAuth"
```

---

## Task 6: LaunchGate wrapper + routes (frontend)

**Files:**
- Create: `src/components/routes/launch-gate.tsx`
- Modify: `src/router.tsx`

**Interfaces:**
- Consumes: `useAuth().isAllowlisted` (Task 5), `UnderDevelopmentPage` (Task 4).
- Produces: `LaunchGate` route element.

- [ ] **Step 1: Implement the gate**

```tsx
// src/components/routes/launch-gate.tsx
import { Navigate, Outlet } from 'react-router'
import { useAuth } from '@/contexts/auth-context'

/**
 * Launch allowlist gate. When the signed-in user is not allowlisted
 * (isAllowlisted === false), every wrapped app route is replaced by the
 * Under-development page. Allowed users (and everyone while the gate is off on
 * the backend, which makes isAllowlisted true) pass through. Fails open while
 * `/auth/me` is still resolving (isAllowlisted defaults to true) so there's no
 * flash-lock.
 */
export function LaunchGate() {
  const { isAllowlisted } = useAuth()
  if (isAllowlisted === false) {
    return <Navigate to="/under-development" replace />
  }
  return <Outlet />
}
```

- [ ] **Step 2: Wire the routes**

In `src/router.tsx`:
1. Import both: `import { LaunchGate } from '@/components/routes/launch-gate'` and `import UnderDevelopmentPage from '@/pages/under-development'`.
2. Add the standalone route next to the other guard-free status routes (near `/session-expired`, `/account-suspended`):
   ```tsx
   <Route path="/under-development" element={<UnderDevelopmentPage />} />
   ```
3. Wrap the authenticated app sections in `LaunchGate`. Place it INSIDE `VerifiedRoute` so it covers onboarding, the workspaces hub, account routes, and workspace-scoped routes, but NOT the public/auth routes or the standalone status pages. Concretely, change the `VerifiedRoute` block so its children sit under a `LaunchGate` element, e.g.:
   ```tsx
   <Route element={<VerifiedRoute />}>
     <Route element={<LaunchGate />}>
       <Route path="/onboarding" element={<OnboardingLayout />}> ... </Route>
       <Route path="/workspaces" element={<WorkspacesPage />} />
     </Route>
   </Route>
   ```
   AND wrap the two `OnboardedRoute` blocks (account-level and workspace-scoped) the same way — either by nesting each `OnboardedRoute` under a shared `LaunchGate`, or by adding `<Route element={<LaunchGate />}>` immediately inside each `OnboardedRoute`. The requirement: EVERY authenticated in-app route (onboarding, workspaces, /account/*, /w/:workspaceId/*) is behind `LaunchGate`; `/login`, `/signup`, `/under-development`, and the other standalone status routes are NOT. Verify by reading the final router that no in-app route escapes the gate and no public/status route is trapped by it.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 4: Manual reasoning check**

Read the final router diff and confirm: (a) a non-allowlisted verified user hitting `/onboarding`, `/workspaces`, `/account/profile`, or `/w/:id/home` is redirected to `/under-development`; (b) `/login`, `/signup`, `/under-development` itself, and `/session-expired` are reachable (no gate / no loop); (c) an allowlisted user reaches everything normally; (d) while `/auth/me` loads, `isAllowlisted` defaults true so there's no flash of the under-dev page for allowed users.

- [ ] **Step 5: Commit**

```bash
git add src/components/routes/launch-gate.tsx src/router.tsx
git commit -m "feat(launch): LaunchGate wrapper + /under-development route"
```

---

## Self-Review Notes

- **Spec coverage:** Task 1 = config helper (empty=off, case-insensitive, super-admin); Task 2 = guard (403 NOT_LAUNCHED, self-verifies JWT, skip decorator); Task 3 = registration + `/auth/me` isAllowlisted + `/auth/me` skip + env docs; Task 4 = page; Task 5 = type + context; Task 6 = gate + routes. All spec sections covered.
- **Type consistency:** `isEmailAllowlisted(email, role)` (Task 1) used by guard (Task 2) and whoAmI (Task 3); `isAllowlisted: boolean` produced in Task 3, typed in Task 5, consumed in Task 6; `SkipLaunchGate`/`SKIP_LAUNCH_GATE` produced Task 2, used Task 3.
- **Security invariant:** allowlist never serialized to client (only the boolean); guard is access-only (never sets role); env-off = fail-open by explicit design decision.
- **Open verification for implementers:** Task 3 Step 1 — confirm `AllowlistGuard`'s injected deps (`JwtService`, `ConfigService`, `UsersService`) resolve at the `APP_GUARD` injection point; if not, place the provider in `AuthModule`. Flag to reviewer as a ⚠️ cross-cutting boot concern.
- **No test framework gap:** backend Jest, frontend Vitest — Task 1/2 ship real specs; Tasks 4–6 rely on `npm run build` + explicit reasoning (no react render-test infra).
