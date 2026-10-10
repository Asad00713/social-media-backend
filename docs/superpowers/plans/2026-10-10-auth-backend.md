# Auth A — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Google sign-in, a 5-attempt limit on the signup code, case-insensitive email lookups, and fix the invitation launch-gate 403. Email-and-password signup and login keep working exactly as today.

**Architecture:**
- Decision logic lives in small pure functions so jest can test it without a database:
  - `normalizeEmail`;
  - `decideGoogleSignIn`;
  - `buildDoneUrl`;
  - `readIdTokenClaims`.
- The services stay thin and call `UsersService` methods, which own every SQL statement.
- Google OAuth is a new `auth/google/` folder with its own client, service and controller. It reuses `AuthService` for tokens.

**Tech Stack:** NestJS 11, Drizzle ORM (node-postgres), jest 30 + ts-jest, `@nestjs/jwt`, `@nestjs/throttler`, `cookie-parser`. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-10-10-passwordless-auth-design.md`. Read it first. This plan argues from it.

## Global Constraints

- **Worktree:** `D:\My Documents\MyProjects\FullStackProjects\socialmedia-workspace-auth`, branch `feat/passwordless-auth`.
  - Create a node_modules junction first: `cmd /c mklink /J node_modules "..\socialmedia-workspace\node_modules"`.
  - Remove it with `cmd /c rmdir node_modules` before any `git worktree remove`.
- **Never run `db:push` or `db:migrate` against prod.** The user applies SQL by hand.
- **Local DB only:** the backend `.env` points at localhost Postgres 17. `.env.local` points at Neon; never use it.
- **Every code error from `verify-otp` is HTTP 400, never 401.** The frontend replays 401s after a token refresh, which would spend a second attempt.
- **Error body shape:** `{ statusCode, error, code, message, ...extra }`. `code` is one of:
  - `CODE_INVALID`
  - `CODE_LOCKED`
  - `CODE_EXPIRED`
  - `CODE_COOLDOWN`
- **Max code attempts:** `5`. Resend cooldown `60s`. Code TTL `10 min`. The last two are unchanged.
- **Google env:**
  - `GOOGLE_AUTH_CLIENT_ID`, `GOOGLE_AUTH_CLIENT_SECRET`, `GOOGLE_AUTH_REDIRECT_URI`;
  - optionally `GOOGLE_AUTH_STATE_SECRET`, falling back to `JWT_ACCESS_SECRET`;
  - `FRONTEND_URL`, which already exists.
- **Google done redirect:** `${FRONTEND_URL}/auth/google/done?status=success|cancelled|error[&code=X]&mode=popup|redirect`.
- **Admins** (`SUPER_ADMIN`, `ADMIN`) are refused on Google sign-in with code `ADMIN_ACCOUNT`.
- **Prettier:** single quotes, trailing commas. Comments explain *why*, matching the surrounding files.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Don't push or merge without asking.** The user merges on GitHub.

## Review Focus

1. **Legacy mixed-case account:** a user registered as `Sara@Daybreak.co` signs in by typing `sara@daybreak.co` and must reach the same account, not get "Invalid credentials". Pinned in Task 2 (`findByEmail` SQL) and proved on local PG in Task 7.
2. **Parallel wrong guesses:** two requests with wrong codes arrive together at attempts=4. Exactly one may be counted as the 5th; the other must answer `CODE_LOCKED`, never `CODE_INVALID` with `attemptsLeft: -1`. Pinned in Task 3 (`incrementVerificationAttempts` returns `null` → LOCKED) and proved on local PG in Task 7.
3. **Google email already registered with a password:** it must sign in to that account and link `google_sub`, not create a duplicate or error. Pinned in Task 5 (decision) and Task 6 (service).
4. **The state cookie is missing on callback**, for example from a different browser or after it expired. The popup must land on `/auth/google/done?status=error&code=STATE_INVALID`, never a JSON 500. Pinned in Task 6.
5. **A Google-only user (null password) submits the password form:** answer 401 "Invalid credentials", never a 500 from bcrypt. Pinned in Task 1.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/drizzle/schema/users.schema.ts` (modify) | `password` nullable, `googleSub`, `emailVerificationAttempts` |
| `drizzle/migrations/0038_auth_google.sql` (create) | The hand-applied, idempotent migration |
| `src/users/normalize-email.ts` (create) | `normalizeEmail()`: trim and lowercase |
| `src/users/users.service.ts` (modify) | Case-insensitive `findByEmail`; lowercased `create`; new Google and attempt methods |
| `src/auth/auth.service.ts` (modify) | `validateUser` null guard, the `login` destructure, `verifyEmailWithOtp` attempts, resend 429 |
| `src/auth/verification-code-error.ts` (create) | `verificationCodeError()`, which builds the 400 body |
| `src/auth/google/google-claims.ts` (create) | `readIdTokenClaims()`, pure |
| `src/auth/google/google-sign-in.decision.ts` (create) | `decideGoogleSignIn()` and `buildDoneUrl()`, pure |
| `src/auth/google/google-oauth.client.ts` (create) | Auth URL and token exchange (`fetch`) |
| `src/auth/google/google-auth.service.ts` (create) | Orchestrates `start` and `callback` |
| `src/auth/google/google-auth.controller.ts` (create) | `GET /auth/google/start` and `/callback`; cookies and redirects |
| `src/auth/refresh-cookie.ts` (create) | `setRefreshCookie()`: the same options `AuthController` uses |
| `src/auth/auth.module.ts` (modify) | Register the Google providers and controller |
| `src/workspace-members/workspace-members.controller.ts` (modify) | `@SkipLaunchGate()` on `acceptInvitation` |
| `src/auth/launch-gate-routes.spec.ts` (modify) | Assert the new exemptions |

---

### Task 0: Worktree setup (no commit)

- [ ] **Step 1: Junction node_modules and confirm the baseline**

```bash
cd "/d/My Documents/MyProjects/FullStackProjects/socialmedia-workspace-auth"
cmd //c mklink /J node_modules "..\\socialmedia-workspace\\node_modules"
npx jest src/auth src/users 2>&1 | tail -5
```

Expected: every suite passes. Note the count, because later tasks must only add to it.

---

### Task 1: Schema, migration, and null-password safety

**Files:**
- Modify: `src/drizzle/schema/users.schema.ts`
- Create: `drizzle/migrations/0038_auth_google.sql`
- Modify: `src/auth/auth.service.ts` (`validateUser`, `login` destructure)
- Test: `src/auth/auth.service.spec.ts` (create)

**Interfaces:**
- Produces:
  - `users.password: string | null`
  - `users.googleSub: string | null`
  - `users.emailVerificationAttempts: number`
  - the test helper `makeAuthService(overrides)` in `auth.service.spec.ts`, which later tasks extend

- [ ] **Step 1: Write the failing test**

Create `src/auth/auth.service.spec.ts`:

```ts
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';

jest.mock('bcrypt', () => ({ compare: jest.fn(), hash: jest.fn() }));

/**
 * AuthService takes eight collaborators. Each test overrides only the ones it
 * exercises; the rest are inert stubs that fail loudly if reached.
 */
export function makeAuthService(overrides: {
  db?: unknown;
  usersService?: Record<string, jest.Mock>;
  emailService?: Record<string, jest.Mock>;
} = {}) {
  const db = overrides.db ?? { query: { users: { findFirst: jest.fn() } } };
  const usersService = overrides.usersService ?? {};
  const emailService = overrides.emailService ?? {
    sendVerificationEmail: jest.fn().mockResolvedValue({ success: true }),
  };
  const service = new AuthService(
    db as never,
    usersService as never,
    { sign: jest.fn().mockReturnValue('signed') } as never,
    { get: jest.fn().mockReturnValue('secret') } as never,
    emailService as never,
    { emailVerified: jest.fn(), passwordChanged: jest.fn() } as never,
    { verifyChallengeToken: jest.fn() } as never,
    { record: jest.fn(), recordSync: jest.fn() } as never,
  );
  return { service, db, usersService, emailService };
}

describe('AuthService.validateUser', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns null for a Google-only account without asking bcrypt', async () => {
    // bcrypt.compare(plain, null) throws, which would turn a wrong-method
    // sign-in into a 500 instead of "Invalid credentials".
    const { service } = makeAuthService({
      usersService: {
        findByEmail: jest
          .fn()
          .mockResolvedValue({ id: 'u1', email: 'a@b.co', password: null }),
      },
    });

    await expect(service.validateUser('a@b.co', 'whatever')).resolves.toBeNull();
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });

  it('still checks the hash for a password account', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    const user = { id: 'u1', email: 'a@b.co', password: 'hash' };
    const { service } = makeAuthService({
      usersService: { findByEmail: jest.fn().mockResolvedValue(user) },
    });

    await expect(service.validateUser('a@b.co', 'pw')).resolves.toBe(user);
    expect(bcrypt.compare).toHaveBeenCalledWith('pw', 'hash');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx jest src/auth/auth.service.spec.ts`

Expected: the first test FAILS, because `bcrypt.compare` was called with `null`.

- [ ] **Step 3: Schema change**

In `src/drizzle/schema/users.schema.ts`, add `integer` to the `drizzle-orm/pg-core` import. Then change the following.

```ts
  // Null for accounts created through Google sign-in. They can set one later
  // from Profile or "Forgot password?", which work the same for them.
  password: text('password'),
```

Directly after the `emailVerificationTokenExpiresAt` column, add:

```ts
  // Wrong guesses against the current signup code. Six digits is a million
  // combinations — brute-forceable inside ten minutes without a ceiling.
  // Reset to 0 whenever a new code is issued.
  emailVerificationAttempts: integer('email_verification_attempts')
    .default(0)
    .notNull(),
```

Directly after `lastAccessedWorkspaceId`, add:

```ts
  // Google's stable account id (`sub`). Matched before email, so a user who
  // changes the address on their Google account still reaches this row.
  googleSub: varchar('google_sub', { length: 255 }).unique(),
```

- [ ] **Step 4: Fix `validateUser` and the `login` destructure**

In `src/auth/auth.service.ts`, inside `validateUser`, replace `if (!user) { return null; }` with:

```ts
    // A Google-only account has no password. bcrypt.compare throws on null, so
    // answer the way a wrong password does instead of a 500.
    if (!user || !user.password) {
      return null;
    }
```

In `login()`, extend the destructure so the new private columns never reach the client:

```ts
    const {
      password: _password,
      emailVerificationToken: _evt,
      emailVerificationTokenExpiresAt: _evte,
      emailVerificationAttempts: _eva,
      passwordResetToken: _prt,
      passwordResetTokenExpiresAt: _prte,
      googleSub: _gs,
      ...publicUser
    } = user;
```

- [ ] **Step 5: Write the migration**

Create `drizzle/migrations/0038_auth_google.sql`:

```sql
-- 0038 — Google sign-in, and a ceiling on signup-code guesses.
--
-- WHY
-- Sign-up and sign-in gain "Continue with Google". A Google-created account
-- has no password, so `password` must accept NULL; `google_sub` is Google's
-- stable account id and is what a returning Google user is matched by.
--
-- The 6-digit signup code had no attempt limit: a million combinations and
-- ten minutes is brute-forceable. `email_verification_attempts` counts wrong
-- guesses against the current code and is reset whenever a new one is sent.
--
-- SAFETY
-- DROP NOT NULL is catalog-only. ADD COLUMN ... NOT NULL DEFAULT 0 is
-- catalog-only on PG 11+ (no table rewrite). The unique constraint builds an
-- index over a column that is NULL for every existing row, so it is instant.
-- Every statement is idempotent; re-running the file changes nothing.
--
-- ROLLBACK
--   ALTER TABLE users DROP CONSTRAINT IF EXISTS users_google_sub_unique;
--   ALTER TABLE users DROP COLUMN IF EXISTS google_sub;
--   ALTER TABLE users DROP COLUMN IF EXISTS email_verification_attempts;
--   -- Only if no row has a NULL password (Google users would block it):
--   ALTER TABLE users ALTER COLUMN password SET NOT NULL;
--
-- PROD RUNBOOK
--   1. First run the case-duplicate check from the spec (§6); it must return 0 rows.
--   2. Apply this file in the Railway console. Never `db:push` prod.

ALTER TABLE "users" ALTER COLUMN "password" DROP NOT NULL;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "email_verification_attempts" integer NOT NULL DEFAULT 0;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "google_sub" varchar(255);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_google_sub_unique'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_google_sub_unique" UNIQUE ("google_sub");
  END IF;
END $$;
```

- [ ] **Step 6: Run the test, then type-check**

Run: `npx jest src/auth/auth.service.spec.ts && npx tsc --noEmit -p tsconfig.json`

Expected: the tests PASS and tsc reports 0 errors.

- If tsc flags another `user.password` use as `string | null`, guard it the same way: `null` means there is no password.
- Never use a non-null assertion for this.

- [ ] **Step 7: Apply the migration to local PG twice (idempotence)**

```bash
"/c/Program Files/PostgreSQL/17/bin/psql.exe" "$(grep ^DATABASE_URL .env | cut -d= -f2-)" -f drizzle/migrations/0038_auth_google.sql
"/c/Program Files/PostgreSQL/17/bin/psql.exe" "$(grep ^DATABASE_URL .env | cut -d= -f2-)" -f drizzle/migrations/0038_auth_google.sql
"/c/Program Files/PostgreSQL/17/bin/psql.exe" "$(grep ^DATABASE_URL .env | cut -d= -f2-)" -c "\d users" | grep -E "password|google_sub|email_verification_attempts"
```

Expected:
- Both runs complete without an error.
- `password` shows no `not null`.
- `email_verification_attempts` shows `integer not null default 0`.
- `google_sub` is `character varying(255)`.

Confirm the URL host is `localhost` before running.

- [ ] **Step 8: Commit**

```bash
git add src/drizzle/schema/users.schema.ts drizzle/migrations/0038_auth_google.sql src/auth/auth.service.ts src/auth/auth.service.spec.ts
git commit -m "feat(auth): schema for Google sign-in and a ceiling on code guesses"
```

---

### Task 2: Case-insensitive email

**Files:**
- Create: `src/users/normalize-email.ts`
- Modify: `src/users/users.service.ts` (`findByEmail`, `create`)
- Test: `src/users/normalize-email.spec.ts`, `src/users/users.service.spec.ts` (create)

**Interfaces:**
- Produces:
  - `normalizeEmail(raw: string): string`
  - `UsersService.findByEmail(email)` now matches `lower(email)`
  - `UsersService.create` stores `normalizeEmail(dto.email)`

- [ ] **Step 1: Write the failing tests**

`src/users/normalize-email.spec.ts`:

```ts
import { normalizeEmail } from './normalize-email';

describe('normalizeEmail', () => {
  it.each([
    ['Sara@Daybreak.co', 'sara@daybreak.co'],
    ['  sara@daybreak.co  ', 'sara@daybreak.co'],
    ['SARA@DAYBREAK.CO', 'sara@daybreak.co'],
    ['sara@daybreak.co', 'sara@daybreak.co'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeEmail(raw)).toBe(expected);
  });
});
```

`src/users/users.service.spec.ts`:

```ts
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { UsersService } from './users.service';

const dialect = new PgDialect();
const render = (where: SQL) => dialect.sqlToQuery(where);

describe('UsersService email matching', () => {
  it('findByEmail compares lower(email) against the normalised input', async () => {
    // Accounts were stored exactly as typed until now, so `Sara@Daybreak.co`
    // exists on prod. An exact match would lock that person out the moment
    // they type their address in lowercase.
    const findFirst = jest.fn().mockResolvedValue(undefined);
    const service = new UsersService({ query: { users: { findFirst } } } as never);

    await service.findByEmail('  Sara@Daybreak.CO ');

    const { sql, params } = render(findFirst.mock.calls[0][0].where);
    expect(sql).toBe('lower("users"."email") = $1');
    expect(params).toEqual(['sara@daybreak.co']);
  });

  it('create stores the normalised email and checks for it case-insensitively', async () => {
    const findFirst = jest.fn().mockResolvedValue(undefined);
    const returning = jest
      .fn()
      .mockResolvedValue([{ id: 'u1', email: 'sara@daybreak.co' }]);
    const values = jest.fn().mockReturnValue({ returning });
    const insert = jest.fn().mockReturnValue({ values });
    const service = new UsersService({
      query: { users: { findFirst } },
      insert,
    } as never);

    await service.create({
      email: 'Sara@Daybreak.co',
      name: 'Sara',
      password: 'Secret123',
    });

    expect(render(findFirst.mock.calls[0][0].where).params).toEqual([
      'sara@daybreak.co',
    ]);
    expect(values.mock.calls[0][0].email).toBe('sara@daybreak.co');
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx jest src/users/normalize-email.spec.ts src/users/users.service.spec.ts`

Expected: FAIL. The module is not found, and the SQL is `"users"."email" = $1`.

- [ ] **Step 3: Implement**

`src/users/normalize-email.ts`:

```ts
/**
 * The one canonical form of an email address in this system: trimmed and
 * lowercased. Every lookup compares against lower(users.email), and every row
 * created from now on is stored in this form. Older rows were stored as typed,
 * which is why lookups lower the column rather than trusting it.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
```

In `src/users/users.service.ts`, import `normalizeEmail` from `./normalize-email`.

Replace `findByEmail`:

```ts
  async findByEmail(email: string): Promise<User | undefined> {
    // lower() on the column, not just the input: accounts created before
    // 2026-10 were stored exactly as typed.
    const user = await this.db.query.users.findFirst({
      where: sql`lower(${users.email}) = ${normalizeEmail(email)}`,
    });

    return user;
  }
```

In `create`, normalise before the existence check and the insert:

```ts
    const email = normalizeEmail(createUserDto.email);

    const existingUser = await this.db.query.users.findFirst({
      where: sql`lower(${users.email}) = ${email}`,
    });
```

Then change the insert's `email: createUserDto.email,` to `email,`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx jest src/users`

Expected: PASS. If the rendered SQL text differs only in quoting, adjust the expected string to Drizzle's actual output, keeping both `lower(` and the `$1` param assertion.

- [ ] **Step 5: Commit**

```bash
git add src/users/normalize-email.ts src/users/normalize-email.spec.ts src/users/users.service.ts src/users/users.service.spec.ts
git commit -m "fix(users): email lookups ignore case; new accounts are stored lowercased"
```

---

### Task 3: Five-attempt limit on the signup code

**Files:**
- Create: `src/auth/verification-code-error.ts`
- Modify: `src/users/users.service.ts` (`setEmailVerificationToken`, plus the new `incrementVerificationAttempts` and `clearEmailVerificationToken`)
- Modify: `src/auth/auth.service.ts` (`verifyEmailWithOtp`)
- Test: `src/auth/auth.service.spec.ts` (extend)

**Interfaces:**
- Consumes: `makeAuthService` (Task 1).
- Produces:
  - `MAX_CODE_ATTEMPTS = 5`, exported from `verification-code-error.ts`
  - `type VerificationCodeErrorCode = 'CODE_INVALID' | 'CODE_LOCKED' | 'CODE_EXPIRED' | 'CODE_COOLDOWN'`
  - `verificationCodeError(code, message, extra?) → BadRequestException`
  - `UsersService.incrementVerificationAttempts(userId: string, max: number): Promise<number | null>`. It returns the new count, or `null` when the count was already at `max`.
  - `UsersService.clearEmailVerificationToken(userId: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Append to `src/auth/auth.service.spec.ts`:

```ts
import { BadRequestException } from '@nestjs/common';
import { hash } from '../common/utils/encryption.util';

const CODE = '123456';

function pendingUser(over: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    email: 'a@b.co',
    isEmailVerified: false,
    emailVerificationToken: hash(CODE),
    emailVerificationTokenExpiresAt: new Date(Date.now() + 5 * 60_000),
    emailVerificationAttempts: 0,
    ...over,
  };
}

function otpService(user: unknown, increment: number | null = 1) {
  const findFirst = jest.fn().mockResolvedValue(user);
  const usersService = {
    verifyEmail: jest.fn(),
    incrementVerificationAttempts: jest.fn().mockResolvedValue(increment),
    clearEmailVerificationToken: jest.fn(),
  };
  const built = makeAuthService({
    db: { query: { users: { findFirst } } },
    usersService,
  });
  return { ...built, usersService };
}

async function codeOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).getResponse() as Record<string, unknown>;
  }
  throw new Error('expected a BadRequestException');
}

describe('AuthService.verifyEmailWithOtp attempt limit', () => {
  it('verifies a correct code without counting an attempt', async () => {
    const { service, usersService } = otpService(pendingUser());
    await service.verifyEmailWithOtp('u1', CODE);
    expect(usersService.verifyEmail).toHaveBeenCalledWith('u1');
    expect(usersService.incrementVerificationAttempts).not.toHaveBeenCalled();
  });

  it('answers CODE_INVALID with attemptsLeft after a wrong guess', async () => {
    const { service } = otpService(pendingUser(), 2);
    const body = await codeOf(service.verifyEmailWithOtp('u1', '000000'));
    expect(body).toMatchObject({ code: 'CODE_INVALID', attemptsLeft: 3 });
  });

  it('locks and clears the code on the fifth wrong guess', async () => {
    const { service, usersService } = otpService(pendingUser(), 5);
    const body = await codeOf(service.verifyEmailWithOtp('u1', '000000'));
    expect(body.code).toBe('CODE_LOCKED');
    expect(usersService.clearEmailVerificationToken).toHaveBeenCalledWith('u1');
  });

  it('locks when a parallel request already spent the last attempt', async () => {
    // incrementVerificationAttempts returns null when the guarded UPDATE
    // matched nothing — the count was already at the ceiling.
    const { service } = otpService(pendingUser({ emailVerificationAttempts: 4 }), null);
    const body = await codeOf(service.verifyEmailWithOtp('u1', '000000'));
    expect(body.code).toBe('CODE_LOCKED');
  });

  it('refuses even a correct code once the ceiling is reached', async () => {
    const { service, usersService } = otpService(
      pendingUser({ emailVerificationAttempts: 5 }),
    );
    const body = await codeOf(service.verifyEmailWithOtp('u1', CODE));
    expect(body.code).toBe('CODE_LOCKED');
    expect(usersService.verifyEmail).not.toHaveBeenCalled();
  });

  it.each([
    ['expired', { emailVerificationTokenExpiresAt: new Date(Date.now() - 1000) }],
    ['missing', { emailVerificationToken: null, emailVerificationTokenExpiresAt: null }],
  ])('answers CODE_EXPIRED when the code is %s', async (_label, over) => {
    const { service } = otpService(pendingUser(over));
    const body = await codeOf(service.verifyEmailWithOtp('u1', CODE));
    expect(body.code).toBe('CODE_EXPIRED');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx jest src/auth/auth.service.spec.ts`

Expected: FAIL. There is no `code` on the responses, and `incrementVerificationAttempts` is never called.

- [ ] **Step 3: Implement the error helper**

`src/auth/verification-code-error.ts`:

```ts
import { BadRequestException } from '@nestjs/common';

/** Wrong guesses allowed against one code before it is cancelled. */
export const MAX_CODE_ATTEMPTS = 5;

export type VerificationCodeErrorCode =
  | 'CODE_INVALID'
  | 'CODE_LOCKED'
  | 'CODE_EXPIRED'
  | 'CODE_COOLDOWN';

/**
 * Always a 400. The frontend's API client answers any 401 by refreshing the
 * session and replaying the request, so a wrong code sent back as 401 would be
 * submitted twice and burn two attempts.
 */
export function verificationCodeError(
  code: VerificationCodeErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code,
    message,
    ...extra,
  });
}
```

- [ ] **Step 4: Implement the `UsersService` methods**

In `src/users/users.service.ts`, add `and, lt` to the `drizzle-orm` import.

In `setEmailVerificationToken`, add `emailVerificationAttempts: 0,` inside `.set({...})`, with this comment:

```ts
        // A new code starts with a clean slate of guesses.
        emailVerificationAttempts: 0,
```

Add these methods after `verifyEmail`:

```ts
  /**
   * Counts one wrong guess and returns the new total — or null when the count
   * was already at `max`. The ceiling is in the WHERE clause, not compared in
   * JS afterwards, so two parallel wrong guesses at 4 cannot both be counted
   * as the fifth: Postgres serialises the row update and the second matches
   * nothing.
   */
  async incrementVerificationAttempts(
    userId: string,
    max: number,
  ): Promise<number | null> {
    const rows = await this.db
      .update(users)
      .set({
        emailVerificationAttempts: sql`${users.emailVerificationAttempts} + 1`,
      })
      .where(and(eq(users.id, userId), lt(users.emailVerificationAttempts, max)))
      .returning({ attempts: users.emailVerificationAttempts });

    return rows[0]?.attempts ?? null;
  }

  /** Cancels the pending code so the next try has to send a fresh one. */
  async clearEmailVerificationToken(userId: string): Promise<void> {
    // Raw SQL for the same reason as verifyEmail: Drizzle's timestamp mapping
    // mishandles explicit nulls here.
    await this.db.execute(sql`
            UPDATE users
            SET
                email_verification_token = NULL,
                email_verification_token_expires_at = NULL,
                updated_at = ${new Date()}
            WHERE id = ${userId}
        `);
  }
```

- [ ] **Step 5: Rewrite `verifyEmailWithOtp`**

In `src/auth/auth.service.ts`:
- import `{ MAX_CODE_ATTEMPTS, verificationCodeError } from './verification-code-error'`;
- add `secureCompare` to the `encryption.util` import.

Then replace the body after the `isEmailVerified` early return:

```ts
    if (
      !user.emailVerificationToken ||
      !user.emailVerificationTokenExpiresAt ||
      user.emailVerificationTokenExpiresAt < new Date()
    ) {
      throw verificationCodeError(
        'CODE_EXPIRED',
        'This code has expired. Send a new one.',
      );
    }

    // Checked before the comparison: once the ceiling is reached even the right
    // code is refused, otherwise the limit only slows a brute force down.
    if (user.emailVerificationAttempts >= MAX_CODE_ATTEMPTS) {
      await this.usersService.clearEmailVerificationToken(user.id);
      throw verificationCodeError(
        'CODE_LOCKED',
        'This code has expired. Send a new one.',
      );
    }

    if (secureCompare(hash(otp), user.emailVerificationToken)) {
      await this.usersService.verifyEmail(user.id);
      await this.notificationEmitter.emailVerified(user.id);
      return { message: 'Email verified successfully.' };
    }

    const attempts = await this.usersService.incrementVerificationAttempts(
      user.id,
      MAX_CODE_ATTEMPTS,
    );

    if (attempts === null || attempts >= MAX_CODE_ATTEMPTS) {
      await this.usersService.clearEmailVerificationToken(user.id);
      throw verificationCodeError(
        'CODE_LOCKED',
        'This code has expired. Send a new one.',
      );
    }

    throw verificationCodeError(
      'CODE_INVALID',
      'That code didn’t work. Check the email and try again.',
      { attemptsLeft: MAX_CODE_ATTEMPTS - attempts },
    );
```

Check `secureCompare` in `encryption.util.ts` before relying on it. If it does not handle unequal lengths, guard with `a.length === b.length &&`. Both values are 64-character hex strings, so the lengths match in practice.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `npx jest src/auth src/users`

Expected: PASS.

- [ ] **Step 7: Mutation check (Review Focus 2)**

1. Temporarily change `lt(users.emailVerificationAttempts, max)` to `lte(...)`. The Task 7 SQL proof must catch it, but no unit test can, so note that here.
2. Temporarily delete the `user.emailVerificationAttempts >= MAX_CODE_ATTEMPTS` block. The test "refuses even a correct code once the ceiling is reached" must FAIL.
3. Restore both, and confirm with `git diff` that only the intended lines changed.

- [ ] **Step 8: Commit**

```bash
git add src/auth/verification-code-error.ts src/auth/auth.service.ts src/auth/auth.service.spec.ts src/users/users.service.ts
git commit -m "fix(auth): the signup code is cancelled after five wrong guesses"
```

---

### Task 4: Resend cooldown answers 429 with `retryAfterSeconds`

**Files:**
- Modify: `src/auth/auth.service.ts` (`resendVerificationEmail`)
- Test: `src/auth/auth.service.spec.ts` (extend)

**Interfaces:**
- Produces: a 429 body `{ statusCode: 429, error, code: 'CODE_COOLDOWN', message, retryAfterSeconds: number }`.

- [ ] **Step 1: Write the failing test**

Append:

```ts
import { HttpException, HttpStatus } from '@nestjs/common';

describe('AuthService.resendVerificationEmail cooldown', () => {
  it('answers 429 CODE_COOLDOWN with the seconds left', async () => {
    // Issued 20s ago → 10-minute expiry is 9m40s away → 40s of cooldown left.
    const issuedAt = Date.now() - 20_000;
    const { service } = makeAuthService({
      usersService: {
        findByEmail: jest.fn().mockResolvedValue({
          id: 'u1',
          email: 'a@b.co',
          isEmailVerified: false,
          emailVerificationTokenExpiresAt: new Date(issuedAt + 10 * 60_000),
        }),
      },
    });

    try {
      await service.resendVerificationEmail('a@b.co');
      throw new Error('expected a 429');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      const body = (e as HttpException).getResponse() as Record<string, unknown>;
      expect(body.code).toBe('CODE_COOLDOWN');
      expect(body.retryAfterSeconds).toBeGreaterThanOrEqual(39);
      expect(body.retryAfterSeconds).toBeLessThanOrEqual(41);
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx jest src/auth/auth.service.spec.ts -t cooldown`

Expected: FAIL. Today the method throws a `BadRequestException`.

- [ ] **Step 3: Implement**

Add `HttpException, HttpStatus` to the `@nestjs/common` import. In `resendVerificationEmail`, replace the cooldown `throw new BadRequestException(...)` with:

```ts
        // 429 with the true remaining wait, so the countdown on the code screen
        // resumes from the server's clock instead of restarting at 60.
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((RESEND_COOLDOWN_MS - ageMs) / 1000),
        );
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            error: 'Too Many Requests',
            code: 'CODE_COOLDOWN',
            message: `Wait ${retryAfterSeconds}s before requesting another code.`,
            retryAfterSeconds,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx jest src/auth`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth/auth.service.ts src/auth/auth.service.spec.ts
git commit -m "fix(auth): resend inside the cooldown says how long to wait"
```

---

### Task 5: Google pure logic (claims, decision, done URL)

**Files:**
- Create: `src/auth/google/google-claims.ts`, `src/auth/google/google-sign-in.decision.ts`
- Test: `src/auth/google/google-claims.spec.ts`, `src/auth/google/google-sign-in.decision.spec.ts`

**Interfaces:**
- Produces:

```ts
// google-claims.ts
export interface GoogleClaims { sub: string; email: string; emailVerified: boolean; name: string | null }
export class GoogleIdTokenError extends Error {}
export function readIdTokenClaims(idToken: string, clientId: string, nowSeconds: number): GoogleClaims

// google-sign-in.decision.ts
export type GoogleAuthMode = 'popup' | 'redirect';
export type GoogleDoneStatus = 'success' | 'cancelled' | 'error';
export type GoogleRefusalCode = 'EMAIL_UNVERIFIED' | 'GOOGLE_ACCOUNT_MISMATCH' | 'ACCOUNT_SUSPENDED' | 'ADMIN_ACCOUNT';
export interface GoogleCandidate { id: string; email: string; role: string; isActive: boolean; googleSub: string | null }
export type GoogleSignInDecision =
  | { kind: 'refuse'; code: GoogleRefusalCode }
  | { kind: 'create' }
  | { kind: 'existing'; user: GoogleCandidate; linkSub: boolean };
export function decideGoogleSignIn(input: { claims: GoogleClaims; bySub: GoogleCandidate | null; byEmail: GoogleCandidate | null }): GoogleSignInDecision
export function buildDoneUrl(frontendUrl: string, result: { status: GoogleDoneStatus; code?: string; mode: GoogleAuthMode }): string
```

- [ ] **Step 1: Write the failing tests**

`src/auth/google/google-claims.spec.ts`:

```ts
import { GoogleIdTokenError, readIdTokenClaims } from './google-claims';

const CLIENT = 'client-123.apps.googleusercontent.com';
const NOW = 1_800_000_000;

function token(payload: Record<string, unknown>) {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.sig`;
}

const good = {
  iss: 'https://accounts.google.com',
  aud: CLIENT,
  exp: NOW + 600,
  sub: '1078',
  email: 'Sara@Gmail.com',
  email_verified: true,
  name: 'Sara Khan',
};

describe('readIdTokenClaims', () => {
  it('reads sub, email, verification and name', () => {
    expect(readIdTokenClaims(token(good), CLIENT, NOW)).toEqual({
      sub: '1078',
      email: 'Sara@Gmail.com',
      emailVerified: true,
      name: 'Sara Khan',
    });
  });

  it('accepts the bare issuer form Google also uses', () => {
    expect(() =>
      readIdTokenClaims(token({ ...good, iss: 'accounts.google.com' }), CLIENT, NOW),
    ).not.toThrow();
  });

  it.each([
    ['a foreign issuer', { iss: 'https://evil.example' }],
    ['another audience', { aud: 'someone-else' }],
    ['an expired token', { exp: NOW - 1 }],
    ['no sub', { sub: undefined }],
    ['no email', { email: undefined }],
  ])('rejects %s', (_l, over) => {
    expect(() => readIdTokenClaims(token({ ...good, ...over }), CLIENT, NOW)).toThrow(
      GoogleIdTokenError,
    );
  });

  it('treats a missing email_verified as unverified', () => {
    expect(
      readIdTokenClaims(token({ ...good, email_verified: undefined }), CLIENT, NOW)
        .emailVerified,
    ).toBe(false);
  });

  it('rejects a malformed token', () => {
    expect(() => readIdTokenClaims('not-a-jwt', CLIENT, NOW)).toThrow(GoogleIdTokenError);
  });
});
```

`src/auth/google/google-sign-in.decision.spec.ts`:

```ts
import { buildDoneUrl, decideGoogleSignIn, type GoogleCandidate } from './google-sign-in.decision';

const claims = { sub: 'g-1', email: 'sara@gmail.com', emailVerified: true, name: 'Sara' };
const user = (over: Partial<GoogleCandidate> = {}): GoogleCandidate => ({
  id: 'u1',
  email: 'sara@gmail.com',
  role: 'USER',
  isActive: true,
  googleSub: null,
  ...over,
});

describe('decideGoogleSignIn', () => {
  it('creates an account for an unknown verified email', () => {
    expect(decideGoogleSignIn({ claims, bySub: null, byEmail: null })).toEqual({ kind: 'create' });
  });

  it('refuses an unverified Google email before looking at accounts', () => {
    expect(
      decideGoogleSignIn({ claims: { ...claims, emailVerified: false }, bySub: user(), byEmail: null }),
    ).toEqual({ kind: 'refuse', code: 'EMAIL_UNVERIFIED' });
  });

  it('signs in by sub without relinking', () => {
    const u = user({ googleSub: 'g-1' });
    expect(decideGoogleSignIn({ claims, bySub: u, byEmail: null })).toEqual({
      kind: 'existing',
      user: u,
      linkSub: false,
    });
  });

  it('prefers the sub match when the email now points elsewhere', () => {
    const bySub = user({ id: 'u1', googleSub: 'g-1' });
    const byEmail = user({ id: 'u2' });
    expect(decideGoogleSignIn({ claims, bySub, byEmail })).toMatchObject({ user: bySub });
  });

  it('links a password account with the same email (Review Focus 3)', () => {
    const u = user();
    expect(decideGoogleSignIn({ claims, bySub: null, byEmail: u })).toEqual({
      kind: 'existing',
      user: u,
      linkSub: true,
    });
  });

  it('refuses when that email is already linked to another Google account', () => {
    expect(
      decideGoogleSignIn({ claims, bySub: null, byEmail: user({ googleSub: 'g-OTHER' }) }),
    ).toEqual({ kind: 'refuse', code: 'GOOGLE_ACCOUNT_MISMATCH' });
  });

  it('refuses a suspended account', () => {
    expect(decideGoogleSignIn({ claims, bySub: user({ isActive: false }), byEmail: null })).toEqual({
      kind: 'refuse',
      code: 'ACCOUNT_SUSPENDED',
    });
  });

  it.each(['SUPER_ADMIN', 'ADMIN'])('refuses a %s — admins keep their second factor', (role) => {
    expect(decideGoogleSignIn({ claims, bySub: null, byEmail: user({ role }) })).toEqual({
      kind: 'refuse',
      code: 'ADMIN_ACCOUNT',
    });
  });
});

describe('buildDoneUrl', () => {
  it('builds the success URL without a code', () => {
    expect(buildDoneUrl('https://app.schedura.com', { status: 'success', mode: 'popup' })).toBe(
      'https://app.schedura.com/auth/google/done?status=success&mode=popup',
    );
  });

  it('includes the code and tolerates a trailing slash', () => {
    expect(
      buildDoneUrl('https://app.schedura.com/', { status: 'error', code: 'ADMIN_ACCOUNT', mode: 'redirect' }),
    ).toBe('https://app.schedura.com/auth/google/done?status=error&code=ADMIN_ACCOUNT&mode=redirect');
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx jest src/auth/google`

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `google-claims.ts`**

```ts
export interface GoogleClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export class GoogleIdTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleIdTokenError';
  }
}

const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

/**
 * Reads and checks an id_token received DIRECTLY from Google's token endpoint.
 *
 * The signature is deliberately not verified: OIDC Core §3.1.3.7 lets TLS
 * stand in for it when the token comes straight from the token endpoint over
 * an authenticated (client-secret) channel — which is the only way this code
 * ever obtains one. Never call this on a token that arrived from a browser.
 */
export function readIdTokenClaims(
  idToken: string,
  clientId: string,
  nowSeconds: number,
): GoogleClaims {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new GoogleIdTokenError('malformed id_token');

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new GoogleIdTokenError('unreadable id_token payload');
  }

  if (typeof payload.iss !== 'string' || !ISSUERS.has(payload.iss)) {
    throw new GoogleIdTokenError('unexpected issuer');
  }
  if (payload.aud !== clientId) throw new GoogleIdTokenError('unexpected audience');
  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) {
    throw new GoogleIdTokenError('id_token expired');
  }
  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new GoogleIdTokenError('id_token has no sub');
  }
  if (typeof payload.email !== 'string' || !payload.email) {
    throw new GoogleIdTokenError('id_token has no email');
  }

  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === 'string' && payload.name ? payload.name : null,
  };
}
```

- [ ] **Step 4: Implement `google-sign-in.decision.ts`**

```ts
import type { GoogleClaims } from './google-claims';

export type GoogleAuthMode = 'popup' | 'redirect';
export type GoogleDoneStatus = 'success' | 'cancelled' | 'error';
export type GoogleRefusalCode =
  | 'EMAIL_UNVERIFIED'
  | 'GOOGLE_ACCOUNT_MISMATCH'
  | 'ACCOUNT_SUSPENDED'
  | 'ADMIN_ACCOUNT';

export interface GoogleCandidate {
  id: string;
  email: string;
  role: string;
  isActive: boolean;
  googleSub: string | null;
}

export type GoogleSignInDecision =
  | { kind: 'refuse'; code: GoogleRefusalCode }
  | { kind: 'create' }
  | { kind: 'existing'; user: GoogleCandidate; linkSub: boolean };

const ADMIN_ROLES = new Set(['SUPER_ADMIN', 'ADMIN']);

/**
 * Who a Google sign-in belongs to. Matched by `sub` first — it survives the
 * person changing the address on their Google account — then by email, which
 * links a password account the first time its owner chooses Google.
 */
export function decideGoogleSignIn(input: {
  claims: GoogleClaims;
  bySub: GoogleCandidate | null;
  byEmail: GoogleCandidate | null;
}): GoogleSignInDecision {
  const { claims, bySub, byEmail } = input;

  // An unverified Google address proves nothing about the mailbox; linking it
  // to an existing account would hand that account to whoever typed it.
  if (!claims.emailVerified) return { kind: 'refuse', code: 'EMAIL_UNVERIFIED' };

  let user = bySub;
  let linkSub = false;

  if (!user && byEmail) {
    if (byEmail.googleSub && byEmail.googleSub !== claims.sub) {
      return { kind: 'refuse', code: 'GOOGLE_ACCOUNT_MISMATCH' };
    }
    user = byEmail;
    linkSub = true;
  }

  if (!user) return { kind: 'create' };
  if (!user.isActive) return { kind: 'refuse', code: 'ACCOUNT_SUSPENDED' };
  // Admins sign in through the admin dashboard, behind an emailed second
  // factor. Google here would be a way around it.
  if (ADMIN_ROLES.has(user.role)) return { kind: 'refuse', code: 'ADMIN_ACCOUNT' };

  return { kind: 'existing', user, linkSub };
}

/** Where the popup (or the full page) lands when the Google round-trip ends. */
export function buildDoneUrl(
  frontendUrl: string,
  result: { status: GoogleDoneStatus; code?: string; mode: GoogleAuthMode },
): string {
  const params = new URLSearchParams({ status: result.status });
  if (result.code) params.set('code', result.code);
  params.set('mode', result.mode);
  return `${frontendUrl.replace(/\/+$/, '')}/auth/google/done?${params.toString()}`;
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx jest src/auth/google`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/auth/google/google-claims.ts src/auth/google/google-claims.spec.ts src/auth/google/google-sign-in.decision.ts src/auth/google/google-sign-in.decision.spec.ts
git commit -m "feat(auth): who a Google sign-in belongs to, decided in one pure function"
```

---

### Task 6: Google OAuth client, service, controller, and wiring

**Files:**
- Create:
  - `src/auth/google/google-oauth.client.ts`
  - `src/auth/google/google-auth.service.ts`
  - `src/auth/google/google-auth.controller.ts`
  - `src/auth/refresh-cookie.ts`
- Modify:
  - `src/users/users.service.ts` (`findByGoogleSub`, `createFromGoogle`, `applyGoogleSignIn`)
  - `src/auth/auth.module.ts`
- Test: `src/auth/google/google-auth.service.spec.ts`

**Interfaces:**
- Consumes:
  - from Task 5: `readIdTokenClaims`, `decideGoogleSignIn`, `buildDoneUrl` and their types;
  - from Task 2: `normalizeEmail`;
  - `AuthService.generateRefreshToken(userId, email)`, which already exists.
- Produces:
  - `UsersService.findByGoogleSub(sub: string): Promise<User | undefined>`
  - `UsersService.createFromGoogle(input: { email: string; name: string | null; googleSub: string }): Promise<User>`
  - `UsersService.applyGoogleSignIn(userId: string, input: { googleSub: string | null; name: string | null }): Promise<void>`
  - `GoogleAuthService.start(mode): { redirectUrl: string; stateCookie: string | null }`
  - `GoogleAuthService.callback(query, stateCookie, ip?): Promise<{ redirectUrl: string; session: { userId: string; email: string } | null }>`
  - `GOOGLE_STATE_COOKIE = 'g_auth'`
  - `setRefreshCookie(res: Response, token: string): void`

- [ ] **Step 1: Write the failing service tests**

`src/auth/google/google-auth.service.spec.ts`:

```ts
import { JwtService } from '@nestjs/jwt';
import { GoogleAuthService } from './google-auth.service';

const FRONTEND = 'https://app.schedura.com';
const SECRET = 'state-secret';
const config = {
  get: (k: string) =>
    ({
      FRONTEND_URL: FRONTEND,
      GOOGLE_AUTH_STATE_SECRET: SECRET,
      GOOGLE_AUTH_CLIENT_ID: 'cid',
      GOOGLE_AUTH_CLIENT_SECRET: 'csecret',
      GOOGLE_AUTH_REDIRECT_URI: 'https://api.schedura.com/auth/google/callback',
    })[k],
};

const claims = { sub: 'g-1', email: 'Sara@Gmail.com', emailVerified: true, name: 'Sara' };

function build(over: { configured?: boolean; users?: Record<string, jest.Mock> } = {}) {
  const jwt = new JwtService({});
  const client = {
    isConfigured: jest.fn().mockReturnValue(over.configured ?? true),
    buildAuthUrl: jest.fn().mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?x=1'),
    exchangeForClaims: jest.fn().mockResolvedValue(claims),
  };
  const users = {
    findByGoogleSub: jest.fn().mockResolvedValue(undefined),
    findByEmail: jest.fn().mockResolvedValue(undefined),
    createFromGoogle: jest.fn().mockResolvedValue({ id: 'new', email: 'sara@gmail.com' }),
    applyGoogleSignIn: jest.fn(),
    ...over.users,
  };
  const loginActivity = { record: jest.fn(), recordSync: jest.fn() };
  const service = new GoogleAuthService(
    client as never,
    jwt,
    config as never,
    users as never,
    loginActivity as never,
  );
  return { service, client, users, loginActivity, jwt };
}

/** A real state cookie from start(), plus the state Google would echo back. */
function begin(b: ReturnType<typeof build>, mode: 'popup' | 'redirect' = 'popup') {
  const { stateCookie } = b.service.start(mode);
  const state = b.client.buildAuthUrl.mock.calls[0][0] as string;
  return { stateCookie: stateCookie!, state };
}

describe('GoogleAuthService.start', () => {
  it('signs a state cookie and sends the user to Google', () => {
    const b = build();
    const { redirectUrl, stateCookie } = b.service.start('popup');
    expect(redirectUrl).toContain('accounts.google.com');
    expect(stateCookie).toEqual(expect.any(String));
  });

  it('lands on the done page with GOOGLE_NOT_CONFIGURED when env is missing', () => {
    const b = build({ configured: false });
    expect(b.service.start('redirect')).toEqual({
      redirectUrl: `${FRONTEND}/auth/google/done?status=error&code=GOOGLE_NOT_CONFIGURED&mode=redirect`,
      stateCookie: null,
    });
  });
});

describe('GoogleAuthService.callback', () => {
  it('rejects a missing state cookie with STATE_INVALID (Review Focus 4)', async () => {
    const b = build();
    const r = await b.service.callback({ code: 'c', state: 's' }, undefined);
    expect(r).toEqual({
      redirectUrl: `${FRONTEND}/auth/google/done?status=error&code=STATE_INVALID&mode=redirect`,
      session: null,
    });
  });

  it('rejects a state that does not match the cookie', async () => {
    const b = build();
    const { stateCookie } = begin(b);
    const r = await b.service.callback({ code: 'c', state: 'forged' }, stateCookie);
    expect(r.redirectUrl).toContain('code=STATE_INVALID');
    expect(r.session).toBeNull();
  });

  it('reports a user who cancelled at Google as cancelled, in the original mode', async () => {
    const b = build();
    const { stateCookie, state } = begin(b, 'popup');
    const r = await b.service.callback({ state, error: 'access_denied' }, stateCookie);
    expect(r.redirectUrl).toBe(`${FRONTEND}/auth/google/done?status=cancelled&mode=popup`);
  });

  it('reports a failed exchange as GOOGLE_ERROR', async () => {
    const b = build();
    b.client.exchangeForClaims.mockRejectedValue(new Error('boom'));
    const { stateCookie, state } = begin(b);
    const r = await b.service.callback({ code: 'c', state }, stateCookie);
    expect(r.redirectUrl).toContain('code=GOOGLE_ERROR');
  });

  it('creates a new account with the normalised email and returns a session', async () => {
    const b = build();
    const { stateCookie, state } = begin(b);
    const r = await b.service.callback({ code: 'c', state }, stateCookie, '1.2.3.4');

    expect(b.users.createFromGoogle).toHaveBeenCalledWith({
      email: 'sara@gmail.com',
      name: 'Sara',
      googleSub: 'g-1',
    });
    expect(b.loginActivity.recordSync).toHaveBeenCalledWith('new', '1.2.3.4');
    expect(r).toEqual({
      redirectUrl: `${FRONTEND}/auth/google/done?status=success&mode=popup`,
      session: { userId: 'new', email: 'sara@gmail.com' },
    });
  });

  it('links an existing password account and keeps its stored email (Review Focus 3)', async () => {
    const existing = {
      id: 'u1',
      email: 'Sara@Gmail.com',
      role: 'USER',
      isActive: true,
      googleSub: null,
    };
    const b = build({ users: { findByEmail: jest.fn().mockResolvedValue(existing) } });
    const { stateCookie, state } = begin(b);
    const r = await b.service.callback({ code: 'c', state }, stateCookie);

    expect(b.users.createFromGoogle).not.toHaveBeenCalled();
    expect(b.users.applyGoogleSignIn).toHaveBeenCalledWith('u1', { googleSub: 'g-1', name: 'Sara' });
    expect(r.session).toEqual({ userId: 'u1', email: 'Sara@Gmail.com' });
  });

  it('refuses an admin without touching the account', async () => {
    const admin = { id: 'a1', email: 'sara@gmail.com', role: 'SUPER_ADMIN', isActive: true, googleSub: null };
    const b = build({ users: { findByEmail: jest.fn().mockResolvedValue(admin) } });
    const { stateCookie, state } = begin(b);
    const r = await b.service.callback({ code: 'c', state }, stateCookie);

    expect(r).toEqual({
      redirectUrl: `${FRONTEND}/auth/google/done?status=error&code=ADMIN_ACCOUNT&mode=popup`,
      session: null,
    });
    expect(b.users.applyGoogleSignIn).not.toHaveBeenCalled();
  });
});
```

The test reads `state` from `buildAuthUrl`'s first argument. The real client gets `(state, codeChallenge)`, so the mock captures the state the cookie was signed with.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx jest src/auth/google/google-auth.service.spec.ts`

Expected: FAIL with "Cannot find module './google-auth.service'".

- [ ] **Step 3: Implement the OAuth client**

`src/auth/google/google-oauth.client.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readIdTokenClaims, type GoogleClaims } from './google-claims';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Talks to Google for sign-in only. Deliberately its own OAuth client
 * (GOOGLE_AUTH_*), not the YouTube one: the sign-in consent screen should ask
 * for openid/email/profile and nothing that sounds like channel access.
 */
@Injectable()
export class GoogleOAuthClient {
  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.clientId() && this.clientSecret() && this.redirectUri());
  }

  buildAuthUrl(state: string, codeChallenge: string): string {
    const url = new URL(AUTH_URL);
    url.searchParams.set('client_id', this.clientId());
    url.searchParams.set('redirect_uri', this.redirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    // Lets someone signed into two Google accounts pick the right one instead
    // of being silently signed in as whichever was last used.
    url.searchParams.set('prompt', 'select_account');
    return url.toString();
  }

  /** Trades the authorization code for the person's verified claims. */
  async exchangeForClaims(code: string, codeVerifier: string): Promise<GoogleClaims> {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.clientId(),
        client_secret: this.clientSecret(),
        redirect_uri: this.redirectUri(),
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
      }),
    });

    if (!res.ok) {
      throw new Error(`Google token endpoint answered ${res.status}`);
    }

    const body = (await res.json()) as { id_token?: string };
    if (!body.id_token) throw new Error('Google token response had no id_token');

    return readIdTokenClaims(
      body.id_token,
      this.clientId(),
      Math.floor(Date.now() / 1000),
    );
  }

  private clientId(): string {
    return this.config.get<string>('GOOGLE_AUTH_CLIENT_ID') ?? '';
  }

  private clientSecret(): string {
    return this.config.get<string>('GOOGLE_AUTH_CLIENT_SECRET') ?? '';
  }

  private redirectUri(): string {
    return this.config.get<string>('GOOGLE_AUTH_REDIRECT_URI') ?? '';
  }
}
```

- [ ] **Step 4: Implement the `UsersService` Google methods**

Add to `src/users/users.service.ts`:

```ts
  async findByGoogleSub(sub: string): Promise<User | undefined> {
    return this.db.query.users.findFirst({ where: eq(users.googleSub, sub) });
  }

  /**
   * An account born from Google sign-in: no password, email already proven.
   * A parallel callback for the same person can win the insert race; that
   * surfaces as a unique violation, and the row it created is the answer.
   */
  async createFromGoogle(input: {
    email: string;
    name: string | null;
    googleSub: string;
  }): Promise<User> {
    try {
      const [row] = await this.db
        .insert(users)
        .values({
          email: input.email,
          name: input.name,
          password: null,
          role: 'USER',
          isEmailVerified: true,
          googleSub: input.googleSub,
          avatarColor: pickAvatarColor(),
        })
        .returning();
      return row;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing =
        (await this.findByGoogleSub(input.googleSub)) ??
        (await this.findByEmail(input.email));
      if (!existing) throw error;
      return existing;
    }
  }

  /**
   * Google proved the mailbox, so the address is verified. The sub is linked
   * only when the row has none, and a name only fills an empty one — a name
   * the person typed themselves is never overwritten by Google's.
   */
  async applyGoogleSignIn(
    userId: string,
    input: { googleSub: string | null; name: string | null },
  ): Promise<void> {
    await this.db.execute(sql`
            UPDATE users
            SET
                is_email_verified = true,
                google_sub = COALESCE(google_sub, ${input.googleSub}),
                name = COALESCE(name, ${input.name}),
                updated_at = ${new Date()}
            WHERE id = ${userId}
        `);
  }
```

Add the module-level helper at the bottom of the file, outside the class:

```ts
/** node-postgres reports unique violations as 23505, sometimes wrapped by Drizzle. */
function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}
```

- [ ] **Step 5: Implement `GoogleAuthService`**

`src/auth/google/google-auth.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../../users/users.service';
import { normalizeEmail } from '../../users/normalize-email';
import { LoginActivityService } from '../services/login-activity.service';
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateSecureToken,
} from '../../common/utils/encryption.util';
import { GoogleOAuthClient } from './google-oauth.client';
import {
  buildDoneUrl,
  decideGoogleSignIn,
  type GoogleAuthMode,
  type GoogleCandidate,
  type GoogleDoneStatus,
} from './google-sign-in.decision';

export const GOOGLE_STATE_COOKIE = 'g_auth';
const STATE_TTL = '10m';

interface StatePayload {
  state: string;
  verifier: string;
  mode: GoogleAuthMode;
  purpose: 'google-auth';
}

export interface GoogleCallbackResult {
  redirectUrl: string;
  session: { userId: string; email: string } | null;
}

@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name);

  constructor(
    private readonly client: GoogleOAuthClient,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly users: UsersService,
    private readonly loginActivity: LoginActivityService,
  ) {}

  start(mode: GoogleAuthMode): { redirectUrl: string; stateCookie: string | null } {
    if (!this.client.isConfigured()) {
      return {
        redirectUrl: this.done('error', mode, 'GOOGLE_NOT_CONFIGURED'),
        stateCookie: null,
      };
    }

    const state = generateSecureToken(32);
    const verifier = generateCodeVerifier();
    // The state and PKCE verifier ride in a signed cookie rather than a table:
    // there is no user yet to hang a row on, and a signature is all that is
    // needed to know the callback is answering OUR redirect.
    const payload: StatePayload = { state, verifier, mode, purpose: 'google-auth' };
    const stateCookie = this.jwt.sign(payload, {
      secret: this.stateSecret(),
      expiresIn: STATE_TTL,
    });

    return {
      redirectUrl: this.client.buildAuthUrl(state, generateCodeChallenge(verifier)),
      stateCookie,
    };
  }

  async callback(
    query: { code?: string; state?: string; error?: string },
    stateCookie: string | undefined,
    ip?: string,
  ): Promise<GoogleCallbackResult> {
    let saved: StatePayload;
    try {
      saved = this.jwt.verify<StatePayload>(stateCookie ?? '', {
        secret: this.stateSecret(),
      });
    } catch {
      // No cookie means no mode either; redirect mode is the one that works
      // whether or not this window has an opener.
      return this.fail('error', 'redirect', 'STATE_INVALID');
    }

    const mode = saved.mode;
    if (saved.purpose !== 'google-auth' || !query.state || query.state !== saved.state) {
      return this.fail('error', mode, 'STATE_INVALID');
    }

    if (query.error) {
      return query.error === 'access_denied'
        ? this.fail('cancelled', mode)
        : this.fail('error', mode, 'GOOGLE_ERROR');
    }
    if (!query.code) return this.fail('error', mode, 'GOOGLE_ERROR');

    let claims;
    try {
      claims = await this.client.exchangeForClaims(query.code, saved.verifier);
    } catch (error) {
      this.logger.warn(
        `Google sign-in exchange failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return this.fail('error', mode, 'GOOGLE_ERROR');
    }

    const email = normalizeEmail(claims.email);
    const [bySub, byEmail] = await Promise.all([
      this.users.findByGoogleSub(claims.sub),
      this.users.findByEmail(email),
    ]);

    const decision = decideGoogleSignIn({
      claims,
      bySub: toCandidate(bySub),
      byEmail: toCandidate(byEmail),
    });

    if (decision.kind === 'refuse') return this.fail('error', mode, decision.code);

    if (decision.kind === 'create') {
      const created = await this.users.createFromGoogle({
        email,
        name: claims.name,
        googleSub: claims.sub,
      });
      await this.loginActivity.recordSync(created.id, ip);
      return this.succeed(mode, created.id, created.email);
    }

    await this.users.applyGoogleSignIn(decision.user.id, {
      googleSub: decision.linkSub ? claims.sub : null,
      name: claims.name,
    });
    await this.loginActivity.record(decision.user.id, ip);
    // The stored email, not Google's spelling: the session's email claim is
    // compared against the allowlist and shown back to the user.
    return this.succeed(mode, decision.user.id, decision.user.email);
  }

  private succeed(mode: GoogleAuthMode, userId: string, email: string): GoogleCallbackResult {
    return { redirectUrl: this.done('success', mode), session: { userId, email } };
  }

  private fail(status: GoogleDoneStatus, mode: GoogleAuthMode, code?: string): GoogleCallbackResult {
    return { redirectUrl: this.done(status, mode, code), session: null };
  }

  private done(status: GoogleDoneStatus, mode: GoogleAuthMode, code?: string): string {
    const frontendUrl = this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3001';
    return buildDoneUrl(frontendUrl, { status, code, mode });
  }

  private stateSecret(): string {
    const secret =
      this.config.get<string>('GOOGLE_AUTH_STATE_SECRET') ??
      this.config.get<string>('JWT_ACCESS_SECRET');
    if (!secret) throw new Error('No secret available to sign Google auth state');
    return secret;
  }
}

function toCandidate(
  user: { id: string; email: string; role: string; isActive: boolean; googleSub: string | null } | undefined,
): GoogleCandidate | null {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    googleSub: user.googleSub,
  };
}
```

- [ ] **Step 6: Run the service tests and confirm they pass**

Run: `npx jest src/auth/google`

Expected: PASS.

- [ ] **Step 7: Refresh-cookie helper and controller**

`src/auth/refresh-cookie.ts`:

```ts
import type { Response } from 'express';

/**
 * The refresh cookie exactly as AuthController sets it on login and register.
 * Cross-origin frontend, so SameSite=None and Secure are both required.
 */
export function setRefreshCookie(response: Response, token: string): void {
  response.cookie('refreshToken', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}
```

`src/auth/google/google-auth.controller.ts`:

```ts
import { Controller, Get, Ip, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService } from '../auth.service';
import { SkipLaunchGate } from '../decorators/skip-launch-gate.decorator';
import { setRefreshCookie } from '../refresh-cookie';
import { GOOGLE_STATE_COOKIE, GoogleAuthService } from './google-auth.service';
import type { GoogleAuthMode } from './google-sign-in.decision';

const STATE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  // Lax, not None: the callback is a top-level GET navigation from Google,
  // which Lax cookies ride along on, and nothing else needs to read it.
  sameSite: 'lax' as const,
  path: '/auth/google',
};

/**
 * Unauthenticated by nature — this IS how a session begins. Gate-exempt for
 * the same reason login's own setup routes are: the launch gate only ever
 * looks at an existing bearer token, and these never carry one.
 */
@Controller('auth/google')
@SkipLaunchGate()
export class GoogleAuthController {
  constructor(
    private readonly google: GoogleAuthService,
    private readonly auth: AuthService,
  ) {}

  @Get('start')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 15 * 60 * 1000 } })
  start(@Query('mode') mode: string | undefined, @Res() res: Response) {
    const resolved: GoogleAuthMode = mode === 'redirect' ? 'redirect' : 'popup';
    const { redirectUrl, stateCookie } = this.google.start(resolved);
    if (stateCookie) {
      res.cookie(GOOGLE_STATE_COOKIE, stateCookie, {
        ...STATE_COOKIE_OPTIONS,
        maxAge: 10 * 60 * 1000,
      });
    }
    return res.redirect(302, redirectUrl);
  }

  @Get('callback')
  async callback(
    @Query() query: { code?: string; state?: string; error?: string },
    @Req() req: Request,
    @Ip() ip: string,
    @Res() res: Response,
  ) {
    const stateCookie = (req.cookies as Record<string, string> | undefined)?.[
      GOOGLE_STATE_COOKIE
    ];
    // Single use: cleared before anything else so a replayed callback has no
    // state to match.
    res.clearCookie(GOOGLE_STATE_COOKIE, STATE_COOKIE_OPTIONS);

    const { redirectUrl, session } = await this.google.callback(query, stateCookie, ip);
    if (session) {
      setRefreshCookie(
        res,
        await this.auth.generateRefreshToken(session.userId, session.email),
      );
    }
    return res.redirect(302, redirectUrl);
  }
}
```

In `src/auth/auth.module.ts`:
- import the three Google classes;
- add `GoogleOAuthClient` and `GoogleAuthService` to `providers`;
- change `controllers` to `[AuthController, GoogleAuthController]`.

- [ ] **Step 8: Assert the controller skips the launch gate**

In `src/auth/launch-gate-routes.spec.ts`:
- import `GoogleAuthController` from `./google/google-auth.controller`;
- add this block inside the outer `describe`:

```ts
  describe('Google sign-in stays reachable', () => {
    it('the whole Google controller skips the gate', () => {
      expect(reflector.get<boolean>(SKIP_LAUNCH_GATE, GoogleAuthController)).toBe(true);
    });
  });
```

- [ ] **Step 9: Run the tests, build, and boot**

```bash
npx jest src/auth src/users
npm run build
```

Expected: PASS, and the build exits 0. Then start the server with `npm run start:dev` and check the unconfigured path:

```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" "http://localhost:3000/auth/google/start?mode=popup"
```

Expected: `302 http://localhost:3001/auth/google/done?status=error&code=GOOGLE_NOT_CONFIGURED&mode=popup` (or your `FRONTEND_URL`).

On Windows, stop the dev server by killing its node process by command line afterwards. TaskStop leaves the port held.

- [ ] **Step 10: Commit**

```bash
git add src/auth/google src/auth/refresh-cookie.ts src/auth/auth.module.ts src/auth/launch-gate-routes.spec.ts src/users/users.service.ts
git commit -m "feat(auth): Continue with Google — popup or full-page, linked by Google account id"
```

---

### Task 7: Invitation accept skips the gate, plus the SQL proof

**Files:**
- Modify: `src/workspace-members/workspace-members.controller.ts`
- Modify: `src/auth/launch-gate-routes.spec.ts`
- Scratchpad (not committed): `auth-sql-proof.ts`

- [ ] **Step 1: Write the failing test**

In `src/auth/launch-gate-routes.spec.ts`:
- import `WorkspaceMembersController` from `../workspace-members/workspace-members.controller`;
- add:

```ts
  describe('invitations', () => {
    it('accepting an invitation skips the gate', () => {
      // With the allowlist on, a non-allowlisted invitee got a 403 here and
      // the invite was never accepted. The gate still blocks the rest of the
      // app for them until launch; it just no longer eats the invitation.
      expect(
        reflector.get<boolean>(
          SKIP_LAUNCH_GATE,
          WorkspaceMembersController.prototype.acceptInvitation as unknown as () => unknown,
        ),
      ).toBe(true);
    });
  });
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx jest src/auth/launch-gate-routes.spec.ts`

Expected: FAIL (`undefined` is not `true`).

- [ ] **Step 3: Implement**

In `workspace-members.controller.ts`, import `SkipLaunchGate` from `../auth/decorators/skip-launch-gate.decorator` and decorate `acceptInvitation` with `@SkipLaunchGate()`, with this comment:

```ts
  // Gate-exempt: a non-allowlisted invitee must still be able to join the
  // workspace they were invited to. Everything else stays locked until launch.
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx jest src/auth/launch-gate-routes.spec.ts`

Expected: PASS.

- [ ] **Step 5: SQL proof on local Postgres (Review Focus 1 and 2)**

Write the scratchpad script `auth-sql-proof.ts`. It must refuse any non-localhost URL, `BEGIN`, and then:

1. Insert a user `Mixed.Case@Example.com` with a password hash. Assert that `new UsersService(drizzle(client)).findByEmail('mixed.case@example.com')` returns it.
2. Set that user's `email_verification_attempts = 4`. Fire two `incrementVerificationAttempts(id, 5)` calls with `Promise.all` on **two separate pool clients**, each in its own transaction against a committed fixture. Within one client the calls serialise, and the proof would be vacuous.
   - Simplest correct form: commit the fixture in a setup transaction, run the two increments concurrently on two clients, assert the results are exactly `[5, null]` in some order, then delete the fixture in a `finally`.
3. Assert `createFromGoogle` with an email whose case differs from an existing row's still inserts (the unique constraint is on raw `email`). Then document that the login lookup returns the oldest match. That is why the rollout's case-duplicate check exists.
4. `ROLLBACK` (or delete the committed fixtures) and re-count `users` with psql to confirm nothing leaked.

Run it with:

```bash
NODE_PATH="D:/My Documents/MyProjects/FullStackProjects/socialmedia-workspace/node_modules" \
TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node"}' \
npx ts-node -T "<scratchpad>/auth-sql-proof.ts"
```

Expected:
- the mixed-case lookup finds the row;
- the concurrent increments give `[5, null]`;
- the user count is unchanged afterwards.

Paste the console output into the PR description.

- [ ] **Step 6: Full suite, then commit**

```bash
npx jest 2>&1 | tail -15
npm run build
```

Expected: the only failures are the 4 known on main (evergreen, price-provisioning, pool-config, billing.controller), and the build exits 0.

```bash
git add src/workspace-members/workspace-members.controller.ts src/auth/launch-gate-routes.spec.ts
git commit -m "fix(invitations): an invitee can accept before launch"
```

---

### Task 8: PR

- [ ] **Step 1: Push and open the PR.** Opening a PR is pre-approved; merging is not.

```bash
git -c credential.helper= -c credential.helper='!f(){ echo "username=Asad00713"; echo "password=$("/c/Program Files/GitHub CLI/gh.exe" auth token -u Asad00713)"; };f' push -u origin feat/passwordless-auth
"/c/Program Files/GitHub CLI/gh.exe" auth switch --user Asad00713
"/c/Program Files/GitHub CLI/gh.exe" pr create --base main --title "feat(auth): Google sign-in, code attempt limit, case-insensitive email" --body-file <scratchpad>/pr-be-auth.md
```

The PR body covers:
- what changed, per spec section;
- the migration and the **prod pre-check SQL**, with "apply by hand, never db:push";
- the env vars to set;
- the SQL proof output;
- the jest and build results;
- known items: admin challenge purge never wired, and inconsistent Profile password rules.

It ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
