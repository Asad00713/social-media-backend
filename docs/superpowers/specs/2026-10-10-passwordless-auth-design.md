# Passwordless auth (Auth A): design

**Date:** 2026-10-10
**Status:** design approved in chat (2026-10-10); this document awaits review.
**Repos:** backend `socialmedia-workspace` (branch `feat/passwordless-auth`), frontend `socialmedia-frontend` (branch `feat/passwordless-auth`).
**Figma:** file `jpea2SB4466G0j2rSfQPyx`, section "1 · Sign up and sign in" (4064:228):

| Frame | Node | Route |
|---|---|---|
| 1 · Sign up | 4100:6843 | `/signup` |
| 1a · Sign in (returning user) | 4100:6263 | `/login` |
| 2 · Email code | 4092:4704 | `/check-email` |
| 2a · Wrong code | 4092:5285 | `/check-email` (error state) |
| Notes · Auth behaviour | 4100:7419 | — |

This is part A of the four-part auth and onboarding redesign. B (two-step onboarding), C (Maestro's first week on Home) and D (agency and client connect link) get their own specs later.

## 1. Goal

There are two ways in, and neither uses a password:
- **Continue with Google.**
- **Email code:** type an email, receive a 6-digit code, type the code.

Sign up and sign in are the same flow. An email that already has an account signs in. An email without one gets an account at the moment its code is accepted.

**Success means:**
- A new person can reach onboarding with either method, without ever seeing a password field.
- Every existing user (about 910 on prod, all created with passwords) can sign in with an email code, with no migration step on their side.
- The super admin dashboard (`schedura-admin`) keeps working unchanged. It signs in with password plus emailed challenge through `POST /auth/login`.
- The screens match the four Figma frames: copy, tokens and Hugeicons, in light and dark, at 375px and at 1280px or wider.

**Out of scope:**
- Onboarding (B).
- Microsoft sign-in.
- Passkeys.
- Removing the legacy password endpoints. That is a follow-up PR once the new frontend is live; see §6.

## 2. Backend

### 2.1 Data

**New table `login_codes`.** It follows the `admin_login_challenges` pattern, but it is keyed by **email**, not user id, because a sign-up code exists before its user does.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | `defaultRandom()` |
| `email` | varchar(255) not null | Normalised: trimmed and lowercased. |
| `code_hash` | varchar(64) not null | SHA-256 via `hash()`. The code itself is never stored. |
| `attempts` | integer not null default 0 | |
| `expires_at` | timestamptz not null | now + 10 min |
| `consumed_at` | timestamptz null | |
| `request_ip` | varchar(45) null | |
| `created_at` | timestamptz not null default now() | |

- **Indexes:** `(email, created_at)`, plus `(expires_at)` for the purge.
- **Timezone:** every timestamp is `withTimezone: true`. A bare `timestamp` made every admin code expire before it was created on a UTC+5 machine; see the comment in `admin-login-challenge.schema.ts`.

**`users` changes:**
- `password` becomes **nullable**. New passwordless users have `NULL`; existing users keep their hash.
- New column `google_sub varchar(255) null unique`: Google's stable account id.

**Migration:**
- One hand-written SQL file (`0038_passwordless_auth.sql`): create the table and indexes, `ALTER TABLE users ALTER COLUMN password DROP NOT NULL`, and add `google_sub` with a unique index.
- It must be idempotent (`IF NOT EXISTS`), because prod migrations are applied by hand in the Railway console.
- It is verified on local Postgres with `BEGIN … ROLLBACK` before the PR.

**Email case:** emails are stored today exactly as the user typed them. `users.create` does not lowercase them, and `findByEmail` uses `eq`. To keep mixed-case legacy accounts reachable:
- every lookup in the new flows matches `lower(users.email) = $normalised`;
- every user the new flows create is stored lowercased;
- the rollout includes a prod check for case-only duplicates (§6). If any exist, they are resolved by hand before deploy.

### 2.2 Email code

**`LoginCodeService`** (`src/auth/login-code.service.ts`) owns the table.

**`requestCode(email, ip)`:**
1. Normalise the email.
2. **Cooldown:** if an *unconsumed* code for this email was created less than 60s ago, throw `LoginCodeCooldownError(retryAfterSeconds)`. Keying on email rather than user is what makes this safe: unknown and known addresses behave identically, so the cooldown reveals nothing.
3. Otherwise generate `generateOtp(6)` and insert the row. **The previous unconsumed codes for that email are marked consumed in the same transaction**, so only the newest code works.
4. Send the email: subject `"{code} is your Schedura code"`, a short HTML body, "expires in 10 minutes". A send failure throws `LOGIN_EMAIL_FAILED` (500); it is never swallowed. That swallowing is the bug that once stranded real sign-ups.
5. In non-production only, log the code at debug level, exactly as `AdminChallengeService` does.

The suspended state is **not** checked here. Checking it would reveal that the account exists. Suspension is enforced at verify time instead.

**`verifyCode(email, code)`:**
1. Find the newest row for the email where `consumed_at IS NULL` and `expires_at > now()`. If there is none, throw `CODE_EXPIRED`.
2. **Attempts:** increment them atomically, `UPDATE … SET attempts = attempts + 1 WHERE id = $1 AND attempts < 5 RETURNING attempts`.
   - No row returned means the limit has been reached. Mark the code consumed and throw `CODE_LOCKED`.
3. **Wrong code:** throw `CODE_INVALID` with `attemptsLeft = 5 − attempts`. When `attemptsLeft` is 0, consume the code too, so the next try answers `CODE_LOCKED` and does not look for another row.
4. **Right code:** consume it atomically, `UPDATE … SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id`. No row means a parallel request already spent it, so throw `CODE_EXPIRED`.
5. Return the normalised email.

Increment-then-compare is deliberate. Comparing first and then writing would let parallel requests each spend "the same" attempt.

**`purgeExpired()`** deletes the expired rows.
- A new `AuthCleanupCron` (`@Cron` daily at 03:00; `ScheduleModule` is already registered) calls it, and also calls `AdminChallengeService.purgeExpired()`.
- That admin method exists today but nothing calls it, so `admin_login_challenges` has never been purged.

### 2.3 Sign-in outcome (shared by email and Google)

**`AuthService.signInVerifiedEmail(email, { name?, googleSub? }, ip)`:**
1. Find the user by `lower(email)`.
2. **No user:** create one with
   - `email` lowercased, `name` set to the given name or `null`;
   - `password: null`, `role: 'USER'`, `isEmailVerified: true`;
   - `avatarColor: pickAvatarColor()`, and `googleSub` when present.

   A unique violation from a parallel request is caught and re-read, never surfaced as an error.
3. **User exists:**
   - **Suspended** (`!isActive`): throw the same `ACCOUNT_SUSPENDED` 401 body that `login()` throws today (`code`, `reason`, `message`).
   - **Role `SUPER_ADMIN` or `ADMIN`:** throw a plain 401, `'Use the admin dashboard to sign in.'`. Admin accounts must keep their second factor, and a mailbox-only path would bypass it.
   - **Otherwise:**
     - set `isEmailVerified = true` when it was false, because the code has just proved the mailbox;
     - set `googleSub` when present and empty;
     - set `name` when it was null and Google gave one.
4. Record login activity: `recordSync` for a new user, `record` for an existing one.
5. Return `{ accessToken, user: PublicUser }`. The controller sets the refresh cookie, exactly as `login` does.

The response doesn't say whether the account is new. The frontend always navigates to `/`, and the existing guards decide where a user goes: onboarding when `onboardingCompletedAt` is null, the pending invite, or the workspace.

### 2.4 Endpoints

All are on `AuthController`, under `@SkipLaunchGate()` and `ThrottlerGuard`.

**`POST /auth/email/start`**
- **Body:** `{ email }`, validated with `@IsEmail()` and `@MaxLength(255)`.
- **Throttle:** 10 per IP per 15 min.
- **200 response:** `{ retryAfterSeconds: 60, inboxProvider: 'google' | 'microsoft' | null }`. The body is identical for every address, new or existing.
- **429 response:** `{ code: 'CODE_COOLDOWN', retryAfterSeconds }`.

**`POST /auth/email/verify`**
- **Body:** `{ email, code }`, where `code` matches `^\d{6}$`.
- **Throttle:** 20 per IP per 15 min.
- **200 response:** `{ accessToken, user }`, with the refresh cookie set.
- **401 response, one of:**
  - `{ code: 'CODE_INVALID', attemptsLeft }`
  - `{ code: 'CODE_LOCKED' }`
  - `{ code: 'CODE_EXPIRED' }`
  - `{ code: 'ACCOUNT_SUSPENDED', reason }`

**`GET /auth/google/start?mode=popup|redirect`**
- Generates `state` (32 random bytes) and a PKCE `code_verifier`.
- Stores both, plus `mode`, in a **signed** short-lived cookie `g_auth`:
  - signed as a JWT with `GOOGLE_AUTH_STATE_SECRET`, falling back to `JWT_ACCESS_SECRET`, the same fallback the admin challenge uses;
  - cookie settings: 10 min, `httpOnly`, `secure`, `sameSite: 'lax'`, `path: '/auth/google'`.
- Then it 302s to Google's authorisation endpoint with:
  - `scope=openid email profile`;
  - `prompt=select_account`;
  - `code_challenge_method=S256`.

**`GET /auth/google/callback`**
1. Read and verify `g_auth`, then clear it.
2. Require that `state` matches.
3. Handle Google's `error` param: `access_denied` becomes `cancelled`, anything else becomes `error`.
4. Exchange the code with the verifier, server-to-server, using `fetch`. No new SDK.
5. Verify the `id_token`. `google-auth-library` `OAuth2Client.verifyIdToken` checks the signature, `aud` and `iss`, and is the one new dependency.
6. Require `email_verified === true`, otherwise answer `EMAIL_UNVERIFIED`.
7. **Link by `sub`:**
   - Look up by `google_sub` first.
   - If that finds nothing, look up by `lower(email)`.
   - If the email match already holds a *different* `google_sub`, answer `GOOGLE_ACCOUNT_MISMATCH` and change nothing.
8. Call `signInVerifiedEmail(email, { name, googleSub: sub })` and set the refresh cookie.
9. 302 to `${FRONTEND_URL}/auth/google/done?status=success|cancelled|error&code=…&mode=popup|redirect`.

   **Every failure also redirects there.** The callback never renders a JSON error in the popup.

**New env vars:** `GOOGLE_AUTH_CLIENT_ID`, `GOOGLE_AUTH_CLIENT_SECRET` and `GOOGLE_AUTH_REDIRECT_URI`, plus `GOOGLE_AUTH_STATE_SECRET` (optional).
- They are deliberately separate from the `YOUTUBE_*` app. Sign-in should not share consent screens or verification status with the channel-connect scopes.
- When they are missing, `/auth/google/start` redirects to `done?status=error&code=GOOGLE_NOT_CONFIGURED`, so the button fails visibly instead of 500ing.

### 2.5 Inbox provider (`src/auth/inbox-provider.ts`, pure plus one DNS call)

**Known domains:**
- `gmail.com` and `googlemail.com` → `google`.
- `outlook.com`, `hotmail.com`, `live.com` and `msn.com` → `microsoft`.

**Any other domain:** `dns.promises.resolveMx`, raced against a **1.5s timeout**.
- An MX host ending in `google.com` or `googlemail.com` → `google`.
- One ending in `outlook.com` → `microsoft`.
- Anything else, an error or a timeout → `null`.

It depends only on the domain, so it reveals nothing about accounts. It runs in parallel with the code insert so it adds no latency.

### 2.6 Existing code touched

- **`validateUser`:** returns `null` when `user.password` is null, *before* `bcrypt.compare`, which would otherwise throw on null. Password login for a passwordless user answers "Invalid credentials".
- **`users.service` `toPublicUser` and the `login()` destructure:** these already strip `password`, and `password` must stay stripped once it is nullable.
- **`workspace-members.controller` `POST invitations/accept`:** add `@SkipLaunchGate()`. When the allowlist is on, a non-allowlisted invitee gets a 403 there today and the invite is never accepted. After the fix, the invite is accepted and the gate still blocks the rest of the app until launch.
- **Kept untouched in this PR:** `register`, `forgot-password`, `reset-password`, `verify-email`, `verify-otp` and `resend-verification`. The currently deployed frontend calls them until the new one ships. They are removed in the follow-up (§6).

## 3. Frontend

### 3.1 Routes

| Route | Guard | Screen |
|---|---|---|
| `/signup` | PublicRoute | Frame 1. Heading "Create your account", footer link "Already have an account? Sign in". |
| `/login` | PublicRoute | Frame 1a. Heading "Welcome back", footer link "New to Schedura? Create an account". |
| `/check-email` | PublicRoute | Frames 2 and 2a. Reads the email from router state and falls back to `sessionStorage`. With no email it goes back to `/login`. |
| `/auth/google/done` | none | No visible UI beyond a spinner; it finishes the Google flow (§3.4). |
| `/forgot-password`, `/reset-password`, `/verify-email-pending` | — | `<Navigate to="/login" replace />` |

`/verify-email` stays, because old emailed links still exist. Its success path now ends at `/login`.

**Copy:** all of it comes verbatim from the Figma frames. The only difference between `/signup` and `/login` is the heading, subtitle and footer link. The form, the Google button and the behaviour are identical, so a returning user who lands on `/signup` simply signs in.

### 3.2 Components (`src/features/auth/components/`)

- **`auth-layout.tsx`:** the two-column shell, which replaces `auth-shell` and `auth-side-panel`.
  - **Left:** logo, form slot, and a footer with "© 2026 Schedura · Privacy · Terms · Help".
  - **Right:** the blue brand panel, "Plan, write and publish in one place", plus the product preview image.
  - **Preview image:** exported from Figma into `src/assets/auth/`, so swapping it later is a file change.
  - **Panel accessibility:** `aria-hidden`, `hidden lg:flex`, and no motion under `prefers-reduced-motion`.
- **`google-button.tsx`:** "Continue with Google", an outline Button with the Google mark, rendered as an inline SVG asset from Figma.
- **`email-start-form.tsx`:** shadcn `Form` with RHF and Zod (`email`), the "or" divider and Continue.
  - **Invite prefill:** `?email=` prefills the field. When a pending invite exists, the field is read-only.
- **`check-email-card.tsx`:** the title, subtitle "We sent a 6-digit code to {email}", and `InputOTP`:
  - six slots;
  - `autoComplete="one-time-code"` and `inputMode="numeric"`;
  - pasting fills all six slots;
  - `onComplete` submits.
- **Error state (frame 2a):** every slot gets `aria-invalid`, and the message shows underneath:
  - `CODE_INVALID`: "That code didn't work. Check the email and try again."
  - `CODE_LOCKED` and `CODE_EXPIRED`: "This code has expired. Send a new one."

  The next keystroke clears the slots and the error.
- **`resend-row.tsx`:**
  - While counting: "Resend code in 0:42 · Use a different email".
  - At zero: "Didn't get it? Resend code · Use a different email".
  - The countdown starts from the server's `retryAfterSeconds`, including a 429's.
- **`open-inbox-buttons.tsx`:** "Open Gmail" and "Open Outlook".
  - **Which buttons:** both when `inboxProvider` is null, otherwise only the matching one.
  - **Gmail link:** `https://mail.google.com/mail/u/0/#search/from%3A{sender}+newer_than%3A1h`.
  - **Outlook link:** `https://outlook.live.com/mail/0/`.
  - **Sender:** comes from `VITE_AUTH_EMAIL_FROM`.

**Icons and styling:** all icons are Hugeicons per `docs/design/icon-map.md`, and all colours use the design tokens. No hex anywhere.

### 3.3 Hooks, API and lib

- **`api/auth.api.ts`:** add `startEmail`, `verifyEmailCode`, and `googleStartUrl(mode)` (a URL string, not a fetch).
- **Hooks:**
  - `use-email-start-mutation`;
  - `use-email-verify-mutation`, which on success runs `setAccessToken`, `fetchQuery(me)` and `navigate('/')`, and on `ACCOUNT_SUSPENDED` goes to `/account-suspended`;
  - `use-google-sign-in`.
- **`lib/auth-code.ts`**, pure and unit-tested:
  - `inboxLinks(provider, sender)`;
  - `formatCountdown(seconds)`;
  - `codeErrorMessage(code)`;
  - `readAuthErrorCode(error)`.
- **Removed:** the password, forgot, reset and verify-pending components, schemas and hooks, plus `password-input`, together with their tests.

### 3.4 Google popup

**Popup flow:**
1. On click, `openOAuthPopup('google-auth')` runs synchronously (an existing util), then the popup navigates to `googleStartUrl('popup')`.
2. `/auth/google/done` in `popup` mode posts `{ type: 'schedura:google-auth', status, code }` to `window.opener` with the app's own origin as `targetOrigin`.
3. The parent verifies `event.origin === window.location.origin` and calls `event.source.close()`.
   - It closes from the parent side because COOP makes the popup's own `window.close()` a no-op on prod; see the existing channel connect handlers.
4. On `success` the parent calls `refreshAccessToken()` (the refresh cookie is already set), then `fetchQuery(me)` and `navigate('/')`.
5. On `error` the parent shows a toast that maps the `code`.
6. On `cancelled` the parent resets the button quietly.

**Fallbacks:**
- **Popup blocked** (`handle.blocked`): `window.location.assign(googleStartUrl('redirect'))`. In redirect mode the done page does step 4 itself.
- **`window.opener` is null in popup mode:** the done page behaves as in redirect mode inside the popup. The user is signed in either way.
- **Popup closed without a message:** the button resets.

### 3.5 Invites

`accept-invitation-view` already sends a signed-out invitee to `/signup?email=…` and stores the pending token.
- After any successful sign-in the app navigates to `/`, and `IndexRedirect` already forwards a pending invite to `/invite/accept`.
- The backend's accept marks the email as verified and skips onboarding, as it does today.
- The only new behaviour is the read-only email field while an invite is pending.

## 4. Error handling summary

| Situation | What the user sees |
|---|---|
| Resend inside 60s | The countdown continues from the server's `retryAfterSeconds`. |
| Wrong code (1–4) | Frame 2a, red slots. The attempts left aren't shown, because the design doesn't show them. |
| 5th wrong code / expired | "This code has expired. Send a new one." Resend is enabled immediately. |
| Code email failed to send | Toast: "We couldn't send your code. Try again in a moment." The user stays on the email step. |
| Suspended account | `/account-suspended` with its reason (existing screen). |
| Admin account on app sign-in | Inline: "Use the admin dashboard to sign in." |
| Google: cancelled | Nothing; the button resets. |
| Google: unverified email / mismatch / not configured | Toast with a specific sentence per code. |
| Network down | Toast: "Couldn't reach Schedura. Check your connection." |

## 5. Testing

**Backend (jest):**
- **`LoginCodeService`:**
  - cooldown, including after a consumed code, which frees it;
  - a newer code consumes the older ones;
  - TTL;
  - the 5-attempt lock;
  - `attemptsLeft` counts down;
  - consume-once;
  - hash only;
  - the send failure surfaces.
- **Mutation checks:** the attempt-limit test and the newest-code test, each mutated to confirm they are not vacuous.
- **`signInVerifiedEmail`:**
  - creating a new user (lowercased, `password` null, verified);
  - an existing mixed-case email matches;
  - unverified becomes verified;
  - suspended is refused;
  - an admin is refused;
  - a parallel-create unique violation recovers.
- **Controller:** `/email/start` returns a byte-identical body for an existing and a new email, and the error code shapes are correct.
- **Google:**
  - state mismatch;
  - missing cookie;
  - `access_denied` → cancelled;
  - unverified email;
  - link by sub;
  - link by email;
  - mismatch.

  Google's token and JWKS endpoints are stubbed.
- **`inbox-provider`:** known domains, MX mapping, and the timeout → null.
- **`validateUser`** with a null password.
- **`launch-gate-routes.spec`:** covers the new routes and invitation accept.
- **Migration:** applied on local Postgres in `BEGIN … ROLLBACK`.

**Frontend (vitest):**
- `lib/auth-code` unit tests.
- Static-markup tests:
  - signup vs login heading and footer;
  - the check-email countdown vs resend;
  - the error state;
  - inbox buttons for google, microsoft and null.
- The google-done message handler is a pure function, tested for the origin check and the status mapping.
- The redirect routes for the removed pages.

**Visual and live:**
- Preview harness screenshots at 375 and 1280, light and dark, against the four frames.
- The live check is the user's: they sign in with both methods on prod.

## 6. Rollout

1. **Prod pre-check.** The user runs this in the Railway console; it must return 0 rows:
   ```sql
   SELECT lower(email), count(*) FROM users GROUP BY 1 HAVING count(*) > 1;
   ```
2. **Backend PR.** Merge it, then the user applies `0038_passwordless_auth.sql` by hand. The new endpoints are additive, so the old frontend keeps working.
3. **Google setup.** The user creates a Google OAuth client (Web), with:
   - redirect URI `https://<api>/auth/google/callback`;
   - scopes `openid email profile`, which need no verification review.

   Then they set the `GOOGLE_AUTH_*` vars on Railway and `VITE_AUTH_EMAIL_FROM` on Vercel.
4. **Frontend PR.** Merge it.
5. **Live check by the user:**
   - an email code for a new address;
   - an email code for an existing account;
   - Google popup;
   - Google with the popup blocked;
   - an invite link.
6. **Follow-up PR (backend):** remove `register`, `forgot-password`, `reset-password`, `verify-email`, `verify-otp` and `resend-verification`, and their service code. `login` and the admin challenge stay.

## 7. Risks

- **Mail deliverability is now on the sign-in path for everyone.** Resend outages block email sign-in. Google is the independent second path; errors surface instead of being swallowed.
- **Third-party cookie restrictions.** In Safari, for example, the cross-site refresh cookie can be blocked. That already applies to today's login and is unchanged here; noted, not solved.
- **Code brute force.** 5 attempts per code, one live code per email, and 20 verifies per IP per 15 minutes give at most 5 guesses in 1,000,000 per code issued.
