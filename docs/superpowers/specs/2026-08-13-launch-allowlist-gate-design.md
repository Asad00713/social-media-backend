# Launch Allowlist Gate ("Under Development") — Design

**Date:** 2026-08-13
**Repos:** `socialmedia-workspace` (backend), `socialmedia-frontend` (frontend)
**Branch:** `feat/launch-allowlist-gate` (both repos, off `main`)

## Goal

Before public launch, restrict the entire app to a small allowlist of email
addresses. Every other authenticated user — including brand-new signups — is
sent to an "Under development" page and can access **nothing** in the app.
Enforcement is real (backend blocks every API call), not just a frontend
redirect. When launch happens, the gate is turned off by clearing one env var
(no code change).

Allowed for now: `muhammadrehmanyousaf786@gmail.com`, `tryschedura@gmail.com`.

## Approach (chosen)

**Global backend `APP_GUARD` + frontend gate**, mirroring the existing
`WorkspaceSuspendedGuard` pattern (already registered as an `APP_GUARD` in
`app.module.ts:106`). The backend is the real lock; the frontend gate is UX.

Rejected: frontend-only redirect (bypassable — a blocked user could call the
API directly and get data). Rejected: a global on/off flag with no per-user
allowlist (would block the allowed testers too).

## Global Constraints

- **Access-gate ONLY — never a role/permission grant.** The allowlist decides
  *reachability*, nothing else. It must NOT derive roles or promote anyone.
  (The codebase deliberately removed `SUPER_ADMIN_EMAILS`-driven role
  promotion — `auth.service.ts:88-94` — for exactly this reason. Do not
  reintroduce email-driven privilege.)
- **The allowlist never reaches the client.** `/auth/me` exposes only a
  boolean `isAllowlisted`, never the list of addresses.
- **Empty/unset `ALLOWLIST_EMAILS` = gate OFF** (everyone allowed). This is the
  safe default: a missing env var must never lock out paying users, and local
  dev without the var stays usable. The gate is ON only when the var is
  non-empty.
- **Super admins always pass** the gate (so the owner can test/administer even
  when their own address isn't in the list).
- **Email comparison is case-insensitive**, trimmed, on the whole list.
- **No schema changes / no migrations.** Pure config + guard + a derived
  boolean on an existing response.
- **Shadcn-only** frontend (CLAUDE.md). The Under-development page reuses the
  existing `StatusPage` / `StatusShell` (ambient-orb background, brand logo,
  footer, the Gmail-compose "Contact support" button) — same family as the
  other status screens, professional look. Contact = `support@schedura.ai`
  only; NO social links (no real handles yet).
- **No push / no PR / no merge** without explicit user request.
- Backend typecheck `npx tsc --noEmit`; frontend `npm run build` + Vitest.

## Architecture

### Backend

**1. Allowlist config helper** (`src/auth/allowlist.ts`, new)
- Reads `process.env.ALLOWLIST_EMAILS`, splits on comma, trims, lowercases,
  drops empties → `string[]` (or a `Set`).
- `isEmailAllowlisted(email, role)` → returns `true` when: the parsed list is
  EMPTY (gate off), OR `role === 'SUPER_ADMIN'`, OR the lowercased/trimmed
  email is in the list. Else `false`.
- Parse lazily per call (reads `process.env` at call time) OR memoize — either
  is fine; keep it a pure function of `(process.env, email, role)` so it is
  trivially unit-testable by setting the env in the test.
- **Never** exports the raw list to any controller/response.

**2. `AllowlistGuard`** (`src/auth/guards/allowlist.guard.ts`, new; registered as
`APP_GUARD` in `app.module.ts` next to `WorkspaceSuspendedGuard`)

**AS-BUILT CONSTRAINT (verified 2026-08-13):** `JwtAuthGuard` is NOT global —
it is applied per-controller via `@UseGuards(JwtAuthGuard)`. There is exactly
one existing `APP_GUARD` (`WorkspaceSuspendedGuard`). Global guards run BEFORE
controller-scoped guards, so a global `AllowlistGuard` canNOT rely on
`req.user` being populated (the JWT guard hasn't run yet). Therefore the guard
must obtain the email itself, the same way `WorkspaceSuspendedGuard` does its
own DB work rather than depending on other guards.

- **The guard extracts the JWT itself** (best-effort): read the
  `Authorization: Bearer <token>` header, `jwtService.verify` it with
  `JWT_ACCESS_SECRET` (inject `JwtService` + `ConfigService`, mirroring
  `jwt.strategy.ts`). From the verified payload get `sub`/`email`. If there is
  no token, or verification fails → treat as UNAUTHENTICATED and **pass**
  (return true) — the route's own `JwtAuthGuard` (if any) will reject it later;
  the launch gate never turns a 401 into a 403 and never blocks public/auth
  routes (login, refresh, logout, register, verify, health, webhooks,
  site-verification).
- The payload carries `email` but not `role`. To honor "super admins always
  pass", the guard looks up the user's role — reuse
  `usersService.findOneWithSuspension(sub)` (already returns `role`) or a
  lightweight role read — and calls `isEmailAllowlisted(email, role)`.
  (Acceptable: this is one cheap indexed lookup per request, only when the gate
  is ON and a token is present; when the gate is OFF the guard returns true
  before any lookup.)
- **Pass-through (return true) when:** the gate is off (allowlist empty) — check
  this FIRST, before any token work; OR no/invalid token; OR the route is
  marked `@SkipLaunchGate()`; OR `isEmailAllowlisted(email, role)` is true.
- **Block (403) when** a valid-token user is not allowlisted and not super
  admin:
  `{ statusCode: 403, error: 'Forbidden', code: 'NOT_LAUNCHED', message: 'Schedura is not yet publicly available. You will get access at launch.' }`
- **`@SkipLaunchGate()` decorator** (SetMetadata, mirroring `@SkipSuspendCheck`)
  MUST be applied to the `/auth/me` route (and any other route that a blocked
  user legitimately needs) so `/auth/me` is never 403'd — it is the signal
  source the frontend reads to render the Under-development page. Auth routes
  are already unaffected because a blocked user still has a valid token but
  `/auth/me` must return 200 with `isAllowlisted:false`; mark it skip
  explicitly rather than relying on it being "an auth route".

**3. `/auth/me` (`whoAmI`)** — add `isAllowlisted: boolean` to `MeResponse`,
computed via `isEmailAllowlisted(user.email, user.role)`. This is the ONLY
allowlist signal the client receives. `/auth/me` is never blocked by the guard.

**4. Env** — document `ALLOWLIST_EMAILS` (comma-separated). Set on Railway to
`muhammadrehmanyousaf786@gmail.com,tryschedura@gmail.com`. Add `.env.example`
entry. Clearing the var (or removing it) disables the gate at launch.

### Frontend

**1. `Under Development` page** (`src/pages/under-development.tsx`, new)
- Thin shell rendering `StatusPage variant="branded"`: brand logo + ambient
  background + footer already come from `StatusShell`. Icon e.g. `Hammer` /
  `Wrench` / `Construction` (lucide), `tone="default"`.
- Copy (Schedura-branded, professional): title "We're putting on the finishing
  touches", description "Schedura is almost ready. We're not open to everyone
  just yet — you'll get access the moment we launch." Actions: `Contact
  support` (the Gmail-compose flow) + `Log out`.
- No social links.

**2. Typed `isAllowlisted`** — add `isAllowlisted: boolean` to `MeResponse` in
`src/types/auth.ts`, and expose it from `useAuth()` (auth-context).

**3. `LaunchGate`** (`src/components/routes/launch-gate.tsx`, new) — wraps the
authenticated app shells in `router.tsx`, ABOVE the workspace/dashboard shells
(so it covers desktop + mobile + every workspace route + the account routes),
but it must let the `/under-development` route itself render.
- Reads `isAllowlisted` from `useAuth()`. While `/auth/me` is still loading,
  render children (no flash-lock, same fail-open-on-load principle as
  `SubscriptionGate`).
- If `isAllowlisted === false` → `<Navigate to="/under-development" replace />`.
- If `true` → `<Outlet />` (normal app).
- `/under-development` is a standalone top-level route (like `/session-expired`)
  NOT wrapped by `LaunchGate`, reachable authenticated-or-not.

**4. Signup / login redirect** — because a fresh signup's `isAllowlisted` is
`false`, `LaunchGate` sends them to `/under-development` automatically after
`/auth/me` resolves. No special-casing in the signup flow needed beyond the
gate. (Optional nicety: on a 403 `NOT_LAUNCHED` from any API call, route to
`/under-development` too — but the gate on `/auth/me` data already covers the
normal paths; add the 403 handler only if a gap shows up.)

## Data flow

1. User signs up or logs in → gets a token.
2. Frontend fetches `/auth/me` → backend returns `isAllowlisted`.
3. `isAllowlisted === false` → `LaunchGate` renders `/under-development`; every
   direct API call the user could attempt is independently blocked 403
   `NOT_LAUNCHED` by `AllowlistGuard`.
4. `isAllowlisted === true` (allowed email or super admin, or gate off) → normal
   app, no banner, no restriction.

## Error / edge states

- **Env unset/empty:** gate off, everyone in (safe default).
- **Super admin:** always in.
- **Blocked user tries a deep link / API:** frontend redirects to
  `/under-development`; backend 403s the API regardless.
- **`/auth/me` must never be gated** — it is the signal source; blocking it
  would blank the app for allowed users too.
- **Auth routes never gated** — a blocked user can still log in (to see the
  page) and log out.
- **Loading:** no flash-lock; gate only acts once `isAllowlisted` is known.
- **Case/whitespace:** emails compared lowercased + trimmed.

## Testing

- Backend unit: `isEmailAllowlisted` — empty list → true for anyone; non-empty
  → true only for listed (case-insensitive) + super-admin; false otherwise.
  Guard spec: blocked user → 403 `NOT_LAUNCHED`; allowed user → pass; no
  `req.user` → pass; gate-off → pass; `/auth/me` reachable.
- Frontend: build + Vitest where a pure unit exists; render reasoning for the
  page + gate (no react render-test infra).

## Out of scope

- Admin UI for editing the allowlist (env var + redeploy is enough for a
  temporary launch gate).
- Per-workspace or role-based launch waves.
- Any preview/banner for allowed users (they see the app normally).
- Removing the gate at launch is a one-line env change, not a code task.
