# Auth redesign (Auth A): design

**Date:** 2026-10-10
**Status:** revised in chat 2026-10-10, after the user chose classic email-and-password plus Google over passwordless. This document awaits review.
**Repos:** backend `socialmedia-workspace` (branch `feat/passwordless-auth`), frontend `socialmedia-frontend` (branch `feat/passwordless-auth`). The branch name predates the revision and is kept.
**Figma:** file `jpea2SB4466G0j2rSfQPyx`, section "1 · Sign up and sign in" (4064:228):

| Frame | Node | Route |
|---|---|---|
| 1 · Sign up | 4100:6843 | `/signup` (plus full name and password fields) |
| 1a · Sign in (returning user) | 4100:6263 | `/login` (plus a password field and "Forgot password?") |
| 2 · Email code | 4092:4704 | `/check-email` (signup verification) |
| 2a · Wrong code | 4092:5285 | `/check-email` (error state) |
| Notes · Auth behaviour | 4100:7419 | — |

This is part A of the four-part auth and onboarding redesign. B (two-step onboarding), C and D get their own specs later.

## 1. Goal

A normal sign-up and sign-in, restyled to the Figma frames, with Google added.

**Sign up:**
- "Continue with Google", **or**
- full name, email and password, then a 6-digit code emailed to verify the address.

**Sign in:**
- "Continue with Google", **or**
- email plus password, with a "Forgot password?" link.

**Google-only users:**
- They have no password.
- They can set one later in **Profile**: the existing "New password" field, `PATCH /users/:id`.
- They can also set one through "Forgot password?", which works the same for them.

**Decisions from the user (2026-10-10):**
- **Password at signup:** the Figma frames have no password field, and the user chose to keep passwords anyway. The reference is ClickUp's standard form: Google, then "or", then full name, email and password; on login, email and password with "Forgot password?" under the button.
- **No Figma update first:** the fields are added in code, with the design's Input and Field styling.
- **Kept simple:** no email-code sign-in.

**Success means:**
- A new person reaches onboarding through either method.
- All ~910 existing users sign in exactly as before, with email and password.
- The admin dashboard is unchanged.
- The screens match the frames (copy, tokens, Hugeicons) in light and dark, at 375px and at 1280px or wider. The only differences are the added name and password fields and their links.

**Out of scope:**
- Onboarding (B).
- Microsoft sign-in.
- Passkeys.
- Email-code sign-in.
- A Figma update.
- Google's personalised "Continue as {name}" button, as in the ClickUp screenshot. It needs Google Identity Services and its iframe, so this round uses our own button.

## 2. Backend

### 2.1 Data (migration `0038_auth_google.sql`, hand-written and idempotent)

- **`users.password` becomes nullable** (`ALTER COLUMN password DROP NOT NULL`). Google-created users have `NULL`.
- **New `users.google_sub varchar(255)`** with a unique index: Google's stable account id.
- **New `users.email_verification_attempts integer not null default 0`.** The signup code has no attempt limit today: six digits and ten minutes, with unlimited guesses.

The migration is verified on local Postgres with `BEGIN … ROLLBACK`. The user applies it on prod by hand.

### 2.2 Signup and verification (existing endpoints, tightened)

**`POST /auth/register`**
- **Name:** `CreateUserDto` is unchanged: name is required, 2–60 characters. Onboarding (B) can prefill "Your name" from it.
- **Email:** new registrations store the email **lowercased and trimmed**.
- **Password rule:** unchanged, at least 8 characters with upper, lower and a digit.

**`POST /auth/verify-otp`** (JWT)
- **Before comparing:** if `email_verification_attempts >= 5`, clear the token and answer `401 { code: 'CODE_LOCKED' }`.
- **Wrong code:** increment the attempts atomically (`SET attempts = attempts + 1 … RETURNING`) and answer `{ code: 'CODE_INVALID', attemptsLeft }`. On the 5th wrong try, clear the token.
- **Expired or missing token:** `{ code: 'CODE_EXPIRED' }`.
- **Codes on the response:** today these errors are bare 400s with prose only. Adding a `code` lets the frontend map each one to the design's copy.

**Code reset:** `sendVerificationEmailInternal` sets `email_verification_attempts = 0` whenever it issues a new code.

**`POST /auth/resend-verification`:** when it is inside the 60s cooldown, it answers `429 { code: 'CODE_COOLDOWN', retryAfterSeconds }` instead of a prose-only 400, so the countdown can resume from the true value.

### 2.3 Login (existing)

- **Email lookup:** `findByEmail` for login matches `lower(email)`. Mixed-case legacy rows stay reachable, and so do new lowercased ones.
- **Null password:** `validateUser` returns `null` when `user.password` is null, before `bcrypt.compare`, which throws on null. A Google-only user typing a password gets the normal "Invalid email or password".
- **Everything else is unchanged:** the suspended check, and the super admin challenge.

**Forgot and reset password:** unchanged. A Google-only user can use them to set a first password.

### 2.4 Google sign-in (new)

**`GET /auth/google/start?mode=popup|redirect`**
- Generates `state` (32 random bytes) and a PKCE `code_verifier`.
- Stores both, plus `mode`, in a **signed** cookie `g_auth`:
  - signed as a JWT with `GOOGLE_AUTH_STATE_SECRET`, falling back to `JWT_ACCESS_SECRET`;
  - cookie settings: 10 min, `httpOnly`, `secure`, `sameSite: 'lax'`, `path: '/auth/google'`.
- Then it 302s to Google with:
  - `scope=openid email profile`;
  - `prompt=select_account`;
  - `S256`.

**`GET /auth/google/callback`**
1. Verify `g_auth` and clear it.
2. Require that `state` matches.
3. Handle Google's `error`: `access_denied` becomes `cancelled`, anything else becomes `error`.
4. Exchange the code with the verifier (server-to-server `fetch`).
5. Verify the `id_token` with `google-auth-library` `OAuth2Client.verifyIdToken`. This is the one new dependency.
6. Require `email_verified === true`, otherwise answer `EMAIL_UNVERIFIED`.
7. **Find the user:**
   - by `google_sub` first;
   - then by `lower(email)`, in which case it links `google_sub`. If that row already holds a different `google_sub`, answer `GOOGLE_ACCOUNT_MISMATCH`.
8. **No user found:** create one with
   - the email lowercased and `name` from Google;
   - `password: null`, `isEmailVerified: true`;
   - `avatarColor: pickAvatarColor()` and `googleSub`.

   A parallel-create unique violation is re-read, never surfaced.
9. **Existing user:**
   - **Suspended:** answer `ACCOUNT_SUSPENDED`.
   - **`SUPER_ADMIN` or `ADMIN`:** answer `ADMIN_ACCOUNT` and refuse. Admins sign in through the admin dashboard and its second factor.
   - **Otherwise:**
     - set `isEmailVerified = true`, because Google proved the mailbox;
     - fill `name` if it is null.
10. Record login activity, then set the refresh cookie exactly as `login` does.
11. 302 to `${FRONTEND_URL}/auth/google/done?status=success|cancelled|error&code=…&mode=…`.

**Every failure redirects there.** The callback never renders JSON in the popup.

**Env:** `GOOGLE_AUTH_CLIENT_ID`, `GOOGLE_AUTH_CLIENT_SECRET` and `GOOGLE_AUTH_REDIRECT_URI`, plus `GOOGLE_AUTH_STATE_SECRET` (optional).
- These belong to a new OAuth client, separate from `YOUTUBE_*`, so the sign-in consent screen never carries the channel scopes.
- When they are missing, `start` redirects to `done?status=error&code=GOOGLE_NOT_CONFIGURED`.

### 2.5 Other

`workspace-members.controller` `POST invitations/accept` gets `@SkipLaunchGate()`.
- **Today:** with the allowlist on, a non-allowlisted invitee gets a 403 and the invite is never accepted.
- **After:** the invite is accepted, and the gate still blocks the rest of the app until launch.

## 3. Frontend

### 3.1 Routes

| Route | Guard | Screen |
|---|---|---|
| `/signup` | PublicRoute | Frame 1: Google, then "or", then Full name, Email and Password (show and hide), then "Sign up". Footer: "Already have an account? Sign in". |
| `/login` | PublicRoute | Frame 1a: Google, then "or", then Email and Password (show and hide), then "Sign in", with a "Forgot password?" link under the button. Footer: "New to Schedura? Create an account". |
| `/check-email` | ProtectedRoute, authed but unverified | Frames 2 and 2a. Replaces `/verify-email-pending`, which now redirects here. |
| `/forgot-password`, `/reset-password` | PublicRoute | The existing flows, moved into the new layout. They have no Figma frame and reuse the design's components. |
| `/auth/google/done` | none | A spinner while it finishes the Google flow (§3.3). |

`/verify-email`, the legacy link handler, stays.

### 3.2 Components (`src/features/auth/components/`)

- **`auth-layout.tsx`:** the two-column shell, which replaces `auth-shell` and `auth-side-panel`.
  - **Left:** logo, form slot, and a footer with "© 2026 Schedura · Privacy · Terms · Help".
  - **Right:** the blue panel, "Plan, write and publish in one place", plus the product preview.
  - **Preview image:** exported from Figma to `src/assets/auth/`, so swapping it later is a file change.
  - **Panel accessibility:** `aria-hidden`, `hidden lg:flex`, and no motion under `prefers-reduced-motion`.
- **`google-button.tsx`:** "Continue with Google", an outline Button with the Google mark exported from Figma.
- **Forms:** `signup-form.tsx`, `login-form.tsx`, `forgot-password-form.tsx` and `reset-password-form.tsx`.
  - They are restyled onto the new layout and keep shadcn `Form` with RHF and Zod. Signup keeps its fields: name, email and password.
  - **Invite prefill:** `?email=` prefills the email. While a pending invite exists, the email field is read-only.
- **`check-email-card.tsx`:** the title, "We sent a 6-digit code to {email}", and `InputOTP`:
  - six slots;
  - `autoComplete="one-time-code"`;
  - pasting fills all six;
  - submits on the sixth digit.
- **Error state (frame 2a):** every slot gets `aria-invalid`, with the message underneath:
  - `CODE_INVALID`: "That code didn't work. Check the email and try again."
  - `CODE_LOCKED` and `CODE_EXPIRED`: "This code has expired. Send a new one."

  The next keystroke clears the slots.
- **`resend-row.tsx`:**
  - While counting: "Resend code in 0:42 · Use a different email".
  - At zero: "Didn't get it? Resend code · Use a different email".
  - **"Use a different email":** signs out and returns to `/signup`.
- **`open-inbox-buttons.tsx`:** "Open Gmail" and "Open Outlook".
  - **Which buttons:** both by default. A known consumer domain shows only its own: gmail.com and googlemail.com show Gmail; outlook.com, hotmail.com and live.com show Outlook. This runs on the frontend only, with no DNS lookup.
  - **Gmail link:** `https://mail.google.com/mail/u/0/#search/from%3A{sender}+newer_than%3A1h`.
  - **Outlook link:** `https://outlook.live.com/mail/0/`.
  - **Sender:** comes from `VITE_AUTH_EMAIL_FROM`.

**Icons and styling:** all icons are Hugeicons per `docs/design/icon-map.md`, and all colours use the design tokens. No hex anywhere.

### 3.3 Google popup

**Popup flow:**
1. On click, `openOAuthPopup('google-auth')` runs synchronously (existing util), then the popup navigates to `${API_URL}/auth/google/start?mode=popup`.
2. `/auth/google/done` in popup mode posts `{ type: 'schedura:google-auth', status, code }` to `window.opener`, with the app's origin as `targetOrigin`.
3. The parent checks `event.origin` and calls `event.source.close()`.
   - It closes from the parent side because COOP makes the popup's own `window.close()` a no-op on prod.
4. On `success` the parent calls `refreshAccessToken()` (the cookie is already set), then `fetchQuery(me)` and `navigate('/')`.
5. On `error` the parent shows a toast for the `code`.
6. On `cancelled` the parent resets quietly.

**Fallbacks:**
- **Popup blocked:** `window.location.assign(...?mode=redirect)`. The done page then does step 4 itself.
- **`window.opener` is null:** the done page behaves as in redirect mode.

**Routing after sign-in:** the existing guards handle it. Onboarding comes when `onboardingCompletedAt` is null. `IndexRedirect` already forwards a pending invite.

### 3.4 Lib and hooks

- **`lib/auth-code.ts`**, pure and unit-tested:
  - `inboxProviderForEmail`;
  - `inboxLinks`;
  - `formatCountdown`;
  - `codeErrorMessage`;
  - `readAuthErrorCode`.
- **Hooks:**
  - `use-google-sign-in`, which is new;
  - the existing verify and resend hooks, updated for the error `code`s and `retryAfterSeconds`.

## 4. Error handling

| Situation | What the user sees |
|---|---|
| Wrong password | Inline: "Invalid email or password" (existing). |
| Google-only user tries a password | Same message. "Forgot password?" sets one. |
| Wrong code (1–4) | Frame 2a. |
| 5th wrong code / expired | "This code has expired. Send a new one." Resend is enabled. |
| Resend inside 60s | The countdown resumes from `retryAfterSeconds`. |
| Suspended | `/account-suspended` (existing). |
| Google: cancelled | Nothing; the button resets. |
| Google: admin / unverified / mismatch / not configured | Toast with a specific sentence per code. |

## 5. Testing

**Backend (jest):**
- **verify-otp:**
  - attempts count down;
  - the 5th wrong try locks the code;
  - a new code resets the attempts;
  - expired;
  - the codes on the error bodies.
- **Mutation check:** mutate the lock test to confirm it isn't vacuous.
- **Resend:** a 429 with `retryAfterSeconds`.
- **Register:** stores a lowercased email (the name is still required).
- **Login:** a mixed-case legacy email matches; a null password returns "Invalid credentials".
- **Google:**
  - state mismatch or missing cookie;
  - `access_denied` → cancelled;
  - unverified;
  - link by sub;
  - link by email;
  - mismatch;
  - admin refused;
  - suspended;
  - create.

  The token and JWKS endpoints are stubbed.
- **`launch-gate-routes.spec`:** covers invitation accept.
- **Migration:** on local Postgres in `BEGIN … ROLLBACK`.

**Frontend (vitest):**
- `lib/auth-code` unit tests.
- Static-markup tests:
  - signup vs login, including the password field and the forgot link;
  - the check-email countdown vs resend;
  - the error state;
  - the inbox buttons.
- The google-done message handler, tested for the origin check and the status mapping.

**Visual and live:**
- Preview screenshots at 375 and 1280, light and dark, against the frames.
- The live check is the user's:
  - signup with name and password, then the code;
  - login;
  - forgot password;
  - Google popup;
  - Google with the popup blocked;
  - an invite link;
  - setting a password from Profile as a Google user.

## 6. Rollout

1. **Prod pre-check.** The user runs this in the Railway console; it must return 0 rows, because login will match on `lower(email)`:
   ```sql
   SELECT lower(email), count(*) FROM users GROUP BY 1 HAVING count(*) > 1;
   ```
2. **Backend PR.** Merge it, then the user applies `0038_auth_google.sql` by hand.
3. **Google setup.** The user creates a Google OAuth client (Web):
   - redirect `https://<api>/auth/google/callback`;
   - scopes `openid email profile`.

   Then they set the `GOOGLE_AUTH_*` vars on Railway and `VITE_AUTH_EMAIL_FROM` on Vercel.
4. **Frontend PR.** Merge it, then the user does the live check.

## 7. Noted, not in this PR

- **Admin challenges are never purged.** `AdminChallengeService.purgeExpired()` exists, but nothing calls it.
- **Inconsistent password rules.** The Profile form accepts 6-character passwords with no current-password check, while signup demands 8 characters with mixed case and a digit.
