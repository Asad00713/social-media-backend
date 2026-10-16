# Onboarding B1 — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store who a user posts for (`use_case`: own brand or clients). It is set through the existing `PATCH /users/:id` and returned on `/auth/me`.

**Architecture:**
- One additive, nullable enum column on `users`, added by a hand-written idempotent migration (0039). It is applied at boot by `src/drizzle/migrate`.
- The value flows through the existing `UpdateUserDto`, then `UsersService.update` (which spreads the DTO), then `PublicUser` and `PUBLIC_USER_COLUMNS`.
- `whoAmI`, and therefore `/auth/me`, reads `PUBLIC_USER_COLUMNS`.

**Tech Stack:** NestJS, Drizzle ORM (pg), class-validator, Jest, local Postgres 17 for the migration proof.

**Spec:** `D:\My Documents\MyProjects\FullStackProjects\socialmedia-frontend-onb\docs\superpowers\specs\2026-10-12-onboarding-wizard-design.md`, section 2 "Backend".

## Global Constraints

- **Values:** the enum name is `user_use_case`, with values exactly `'own_brand'` and `'clients'`. The column is `users.use_case`: nullable, no default, no backfill.
- **Migration file:** `drizzle/migrations/0039_user_use_case.sql`. It is hand-written; the drizzle journal stops at 0023, so do NOT run `drizzle-kit generate`.
- **Idempotent:** the migration must run twice cleanly. Use `CREATE TYPE` in a `DO $$ … EXCEPTION WHEN duplicate_object THEN NULL; END $$;` block, then `ADD COLUMN IF NOT EXISTS`.
- **Boot safety:** the boot migrator runs every pending file in its own transaction and crash-loops the API if one fails. Nothing in 0039 may depend on existing row data.
- **Never** run `db:push` or `db:migrate` against any remote database. Local Postgres only (see `.env` `DATABASE_URL`, which must be localhost).
- **Git:** never use `git stash`. Commit only the files a task names. Prettier style: single quotes, trailing commas.

## Review Focus

1. A client sending `useCase: 'agency'`, `''` or a number must get a 400, not a stored value. Covered in Task 2: the DTO test rejects all three.
2. A `PATCH` without `useCase` must leave the stored value untouched, not null it. Covered in Task 2: `update({ name })` must not put `useCase` in the SET.
3. `/auth/me` for a legacy user with no row value must return `useCase: null`, not omit the key. Covered in Task 1: `toPublicUser` and `PUBLIC_USER_COLUMNS` both include the key.
4. Running 0039 on a database that already has the type and column must be a no-op. Covered in Task 1: the migration is applied twice on local PG.
5. `PATCH /users/:id` with `useCase: null` (clearing it) is not needed by the frontend. Ruling: `@IsOptional` accepts null and stores null, which is harmless. No extra test.

---

### Task 1: `use_case` column, schema, public user

**Files:**
- Create: `drizzle/migrations/0039_user_use_case.sql`
- Modify: `src/drizzle/schema/users.schema.ts` (enum block near the `MAESTRO_TONES` lines 24-26; column near `maestroTone` around line 109)
- Modify: `src/users/users.service.ts` (`PublicUser` Pick list around lines 24-37, `PUBLIC_USER_COLUMNS` around 47-60, `toPublicUser` around 64-79)
- Test: `src/users/users.service.spec.ts` (append a describe block)

**Interfaces:**
- Produces:
  - `USER_USE_CASES = ['own_brand', 'clients'] as const`;
  - `type UserUseCase = (typeof USER_USE_CASES)[number]`;
  - `userUseCaseEnum`;
  - `users.useCase: UserUseCase | null`;
  - `PublicUser.useCase`.

- [ ] **Step 1: Write the failing test.** Append to `src/users/users.service.spec.ts`:

```ts
describe('UsersService public user shape', () => {
  it('update returns useCase, null for a user who never answered', async () => {
    // The onboarding wizard reads useCase back from /auth/me to preselect
    // "Who are you posting for?". A key that is missing instead of null
    // would read as undefined on the client and silently break that default.
    const row = {
      id: 'u1',
      email: 'sara@daybreak.co',
      name: 'Sara',
      role: 'USER',
      isEmailVerified: true,
      lastAccessedWorkspaceId: null,
      onboardingCompletedAt: null,
      maestroTone: 'professional',
      avatarUrl: null,
      avatarColor: 'amber',
      useCase: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      password: 'hash',
    };
    const returning = jest.fn().mockResolvedValue([{ ...row, useCase: 'clients' }]);
    const where = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where });
    const update = jest.fn().mockReturnValue({ set });
    const service = new UsersService({
      query: { users: { findFirst: jest.fn().mockResolvedValue(row) } },
      update,
    } as never);

    const result = await service.update('u1', { useCase: 'clients' });

    expect(result.useCase).toBe('clients');
    expect(result).not.toHaveProperty('password');
  });

  it('selects useCase for every public read', async () => {
    const findFirst = jest.fn().mockResolvedValue(undefined);
    const service = new UsersService({ query: { users: { findFirst } } } as never);

    await service.findOne('u1');

    expect(findFirst.mock.calls[0][0].columns).toMatchObject({ useCase: true });
  });
});
```

Before writing the second test, check how `findOne` calls `findFirst` (read `findOne` in users.service.ts). If it passes the columns under another key (e.g. via `PUBLIC_USER_COLUMNS` as `columns`), keep the assertion on that key. If `findOne` does not use `PUBLIC_USER_COLUMNS`, assert on the public read that does (`whoAmI`'s user query, or `findPublicById`), whichever function selects `PUBLIC_USER_COLUMNS`.

- [ ] **Step 2: Run it and confirm it fails.**

Run: `npx jest src/users/users.service.spec.ts -t "public user shape"`
Expected: FAIL. TypeScript errors on `useCase` (property does not exist on `UpdateUserDto` / `PublicUser`), or `result.useCase` is `undefined`.

Note: Task 2 adds `useCase` to `UpdateUserDto`. If ts-jest refuses to compile `service.update('u1', { useCase: 'clients' })` before then, cast the argument as `{ useCase: 'clients' } as never` in this test. Task 2's own test covers the DTO.

- [ ] **Step 3: Implement the schema.** In `src/drizzle/schema/users.schema.ts`, after the `maestroToneEnum` line, add:

```ts
// Who the person posts for, asked once in onboarding step 1. It picks the
// copy and Home cards for an agency ("My clients") vs a single brand.
// Nullable: everyone who signed up before the question existed has no answer.
export const USER_USE_CASES = ['own_brand', 'clients'] as const;
export type UserUseCase = (typeof USER_USE_CASES)[number];
export const userUseCaseEnum = pgEnum('user_use_case', USER_USE_CASES);
```

Inside the `users` table, directly after the `maestroTone` column definition, add:

```ts
  useCase: userUseCaseEnum('use_case'),
```

- [ ] **Step 4: Implement the public shape.** In `src/users/users.service.ts`:
  - add `| 'useCase'` to the `PublicUser` Pick list, after `'maestroTone'`;
  - add `useCase: true,` to `PUBLIC_USER_COLUMNS`, after `maestroTone: true,`;
  - add `useCase: row.useCase,` to `toPublicUser`, after `maestroTone: row.maestroTone,`.

- [ ] **Step 5: Write the migration.** Create `drizzle/migrations/0039_user_use_case.sql`:

```sql
-- 0039 — who a person posts for: their own brand, or clients (an agency).
--
-- WHY
-- Onboarding step 1 now asks "Who are you posting for?". The answer changes
-- copy ("Brand name" vs "Client name"), and later the Home cards and where
-- "Add client" shows. It belongs to the person, not a workspace: an agency
-- owns many client workspaces and answers once.
--
-- SAFETY
-- Additive only: a new enum type and one nullable column with no default, a
-- catalog-only change in PG 11+ (no table rewrite). No backfill: users who
-- signed up before the question have no answer, and NULL says exactly that.
-- Idempotent: the type is created in a duplicate_object guard and the column
-- with IF NOT EXISTS, so a re-run is a no-op. Nothing here reads row data, so
-- it cannot fail on what prod happens to contain (see 0038's outage).
--
-- ROLLBACK
--   ALTER TABLE users DROP COLUMN IF EXISTS use_case;
--   DROP TYPE IF EXISTS "public"."user_use_case";
--
-- Never run `db:push` against prod. The boot migrator applies this file.

DO $$
BEGIN
  CREATE TYPE "public"."user_use_case" AS ENUM('own_brand', 'clients');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "use_case" "public"."user_use_case";
```

- [ ] **Step 6: Run the tests and confirm they pass.**

Run: `npx jest src/users`
Expected: PASS (all users specs).

- [ ] **Step 7: Prove the migration on local Postgres, twice.** First confirm `.env` `DATABASE_URL` points at `localhost` (abort if not). Then:

```bash
node -e "require('dotenv').config(); const u=new URL(process.env.DATABASE_URL); if(!['localhost','127.0.0.1'].includes(u.hostname)) {console.error('NOT LOCAL', u.hostname); process.exit(1)} console.log('local ok')"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle/migrations/0039_user_use_case.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle/migrations/0039_user_use_case.sql
psql "$DATABASE_URL" -c "SELECT column_name, udt_name, is_nullable, column_default FROM information_schema.columns WHERE table_name='users' AND column_name='use_case';"
```

If `psql` is not on PATH, use a short `ts-node`/`node` script with `pg` that reads the file and runs it twice (recipe: memory `reference_local_postgres_sql_verification`).

Expected: both runs succeed. The SELECT shows `use_case | user_use_case | YES | (null)`. Paste the output into the report.

- [ ] **Step 8: Build and commit.**

Run: `npx nest build`
Expected: no errors.

```bash
git add drizzle/migrations/0039_user_use_case.sql src/drizzle/schema/users.schema.ts src/users/users.service.ts src/users/users.service.spec.ts
git commit -m "feat(users): remember who a person posts for (use_case)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `useCase` on `PATCH /users/:id`

**Files:**
- Modify: `src/users/dto/update-user.dto.ts`
- Create: `src/users/dto/update-user.dto.spec.ts`
- Test: `src/users/users.service.spec.ts` (one more case in the Task 1 describe block)

**Interfaces:**
- Consumes: `USER_USE_CASES` and `UserUseCase` from `src/drizzle/schema/users.schema.ts` (Task 1).
- Produces: `UpdateUserDto.useCase?: UserUseCase`. The frontend sends `PATCH /users/:id { useCase }` or `{ name, useCase }`.

- [ ] **Step 1: Write the failing DTO test.** Create `src/users/dto/update-user.dto.spec.ts`:

```ts
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateUserDto } from './update-user.dto';

const errorsFor = async (body: object) =>
  validate(plainToInstance(UpdateUserDto, body));

describe('UpdateUserDto.useCase', () => {
  it.each(['own_brand', 'clients'])('accepts %s', async (useCase) => {
    expect(await errorsFor({ useCase })).toHaveLength(0);
  });

  it.each([['agency'], [''], [3]])('rejects %p', async (useCase) => {
    // Anything else would reach the enum column and fail as a 500 from
    // Postgres instead of a 400 the client can act on.
    const errors = await errorsFor({ useCase });
    expect(errors.map((e) => e.property)).toContain('useCase');
  });

  it('stays optional, so a name-only update is still valid', async () => {
    expect(await errorsFor({ name: 'Sara' })).toHaveLength(0);
  });
});
```

Add this case to the `UsersService public user shape` describe in `users.service.spec.ts`:

```ts
  it('a name-only update does not touch useCase', async () => {
    const row = { id: 'u1', useCase: 'clients' };
    const returning = jest.fn().mockResolvedValue([row]);
    const where = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where });
    const service = new UsersService({
      query: { users: { findFirst: jest.fn().mockResolvedValue(row) } },
      update: jest.fn().mockReturnValue({ set }),
    } as never);

    await service.update('u1', { name: 'Sara' });

    expect(set.mock.calls[0][0]).not.toHaveProperty('useCase');
  });
```

- [ ] **Step 2: Run them and confirm the DTO test fails.**

Run: `npx jest src/users/dto/update-user.dto.spec.ts src/users/users.service.spec.ts`
Expected: the "rejects" cases FAIL (no validator yet, so no errors). The name-only case passes already, because `update` spreads only the given keys. It guards against a future regression.

- [ ] **Step 3: Implement.** Replace `src/users/dto/update-user.dto.ts` with:

```ts
import { IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import {
  USER_USE_CASES,
  type UserUseCase,
} from '../../drizzle/schema/users.schema';

export class UpdateUserDto {
  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  @MinLength(6, { message: 'Password must be at least 6 characters long' })
  password?: string;

  /** Who the person posts for — onboarding step 1. */
  @IsIn(USER_USE_CASES)
  @IsOptional()
  useCase?: UserUseCase;
}
```

Adjust the import path if `users.schema` is re-exported from a barrel that the other DTOs use (check `create-user.dto.ts` imports). Keep the import style consistent.

- [ ] **Step 4: Run the tests and confirm they pass, then run the full suite.**

Run: `npx jest src/users`
Expected: PASS.

Run: `npx jest`
Expected: only the 4 known failures on main (pool-config, price-provisioning, billing.controller, evergreen.service). Nothing new. Report the counts.

- [ ] **Step 5: Build and commit.**

Run: `npx nest build`
Expected: no errors.

```bash
git add src/users/dto/update-user.dto.ts src/users/dto/update-user.dto.spec.ts src/users/users.service.spec.ts
git commit -m "feat(users): set use_case through PATCH /users/:id

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
