import { BadRequestException } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Pool } from 'pg';
import * as schema from '../drizzle/schema';
import type { User } from '../drizzle/schema';
import { UsersService, toPublicUser } from './users.service';

/** The first argument of a mock's first call, typed (mock.calls is any[][]). */
function firstArg<T>(mock: jest.Mock): T {
  return (mock.mock.calls as unknown[][])[0][0] as T;
}

const dialect = new PgDialect();
const render = (where: SQL) => dialect.sqlToQuery(where);

describe('UsersService email matching', () => {
  it('findByEmail compares lower(email) against the normalised input', async () => {
    // Accounts were stored exactly as typed until now, so `Sara@Daybreak.co`
    // exists on prod. An exact match would lock that person out the moment
    // they type their address in lowercase.
    const findFirst = jest.fn().mockResolvedValue(undefined);
    const service = new UsersService(
      {
        query: { users: { findFirst } },
      } as never,
      {} as never,
      {} as never,
    );

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
    const service = new UsersService(
      {
        query: { users: { findFirst } },
        insert,
      } as never,
      {} as never,
      {} as never,
    );

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

describe('UsersService.createFromGoogle', () => {
  const input = { email: 'sara@gmail.com', name: 'Sara', googleSub: 'g-1' };
  const build = (rejection: unknown, findFirst: jest.Mock) => {
    const returning = jest.fn().mockRejectedValue(rejection);
    const insert = jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({ returning }),
    });
    return new UsersService(
      {
        query: { users: { findFirst } },
        insert,
      } as never,
      {} as never,
      {} as never,
    );
  };

  it('returns the row a racing callback created (unique violation by sub)', async () => {
    const row = { id: 'won' };
    const findFirst = jest.fn().mockResolvedValue(row);
    const service = build({ code: '23505' }, findFirst);
    await expect(service.createFromGoogle(input)).resolves.toBe(row);
  });

  it('falls back to the email when the wrapped violation finds no sub match', async () => {
    const row = { id: 'by-email' };
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(row);
    const service = build({ cause: { code: '23505' } }, findFirst);
    await expect(service.createFromGoogle(input)).resolves.toBe(row);
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it('rethrows anything that is not a unique violation', async () => {
    const boom = new Error('connection lost');
    const service = build(boom, jest.fn());
    await expect(service.createFromGoogle(input)).rejects.toBe(boom);
  });
});

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
    const returning = jest
      .fn()
      .mockResolvedValue([{ ...row, useCase: 'clients' }]);
    const where = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where });
    const update = jest.fn().mockReturnValue({ set });
    const service = new UsersService(
      {
        query: { users: { findFirst: jest.fn().mockResolvedValue(row) } },
        update,
      } as never,
      {} as never,
      {} as never,
    );

    const result = await service.update('u1', { useCase: 'clients' });

    expect(result.useCase).toBe('clients');
    expect(result).not.toHaveProperty('password');
  });

  it('selects useCase for every public read', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'u1' });
    const service = new UsersService(
      {
        query: { users: { findFirst } },
      } as never,
      {} as never,
      {} as never,
    );

    await service.findOne('u1');

    expect(findFirst.mock.calls[0][0].columns).toMatchObject({
      useCase: true,
    });
  });

  it('a name-only update does not touch useCase', async () => {
    const row = { id: 'u1', useCase: 'clients' };
    const returning = jest.fn().mockResolvedValue([row]);
    const where = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where });
    const service = new UsersService(
      {
        query: { users: { findFirst: jest.fn().mockResolvedValue(row) } },
        update: jest.fn().mockReturnValue({ set }),
      } as never,
      {} as never,
      {} as never,
    );

    await service.update('u1', { name: 'Sara' });

    expect(set.mock.calls[0][0]).not.toHaveProperty('useCase');
  });

  it('update returns useCase as null (key present) when the row has none', async () => {
    const row = { id: 'u1', useCase: null };
    const returning = jest.fn().mockResolvedValue([row]);
    const where = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where });
    const service = new UsersService(
      {
        query: { users: { findFirst: jest.fn().mockResolvedValue(row) } },
        update: jest.fn().mockReturnValue({ set }),
      } as never,
      {} as never,
      {} as never,
    );

    const result = await service.update('u1', { name: 'Sara' });

    expect(result).toHaveProperty('useCase', null);
  });
});

describe('UsersService.update refuses the email and password fields', () => {
  function build() {
    const row = { id: 'u1', name: 'Sara', password: 'hash' };
    const returning = jest.fn().mockResolvedValue([{ ...row, name: 'Sana' }]);
    const where = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where });
    const update = jest.fn().mockReturnValue({ set });
    const service = new UsersService(
      {
        query: { users: { findFirst: jest.fn().mockResolvedValue(row) } },
        update,
      } as never,
      {} as never,
      {} as never,
    );
    return { service, update, set };
  }

  async function bodyOf(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      return (e as BadRequestException).getResponse();
    }
    throw new Error('expected a BadRequestException');
  }

  it('PATCH /users/:id with email → USE_EMAIL_CHANGE_FLOW; with name only → updates', async () => {
    const { service, update, set } = build();

    await expect(
      bodyOf(service.update('u1', { email: 'new@x.co', name: 'Sana' })),
    ).resolves.toEqual({
      statusCode: 400,
      error: 'Bad Request',
      code: 'USE_EMAIL_CHANGE_FLOW',
      message: 'Change your email from Settings → Profile.',
    });
    expect(update).not.toHaveBeenCalled();

    const result = await service.update('u1', { name: 'Sana' });
    expect(result.name).toBe('Sana');
    expect(firstArg<object>(set)).toMatchObject({ name: 'Sana' });
  });

  it('with password → USE_PASSWORD_CHANGE_FLOW and nothing is written', async () => {
    const { service, update } = build();
    await expect(
      bodyOf(service.update('u1', { password: 'Secret123' })),
    ).resolves.toEqual({
      statusCode: 400,
      error: 'Bad Request',
      code: 'USE_PASSWORD_CHANGE_FLOW',
      message: 'Change your password from Settings → Profile.',
    });
    expect(update).not.toHaveBeenCalled();
  });
});

describe('UsersService hasPassword', () => {
  const row = {
    id: 'u1',
    email: 'sara@daybreak.co',
    name: 'Sara',
    role: 'USER',
    isEmailVerified: true,
    lastAccessedWorkspaceId: null,
    onboardingCompletedAt: null,
    maestroTone: 'professional',
    useCase: null,
    avatarUrl: null,
    avatarColor: 'amber',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    password: 'hash',
    passwordResetToken: 'reset-hash',
    sessionsRevokedAt: new Date(0),
  } as unknown as User;

  it('toPublicUser exposes hasPassword and never password', () => {
    const withPassword = toPublicUser(row);
    expect(withPassword.hasPassword).toBe(true);
    expect(withPassword).not.toHaveProperty('password');
    expect(withPassword).not.toHaveProperty('passwordResetToken');
    expect(withPassword).not.toHaveProperty('sessionsRevokedAt');

    expect(toPublicUser({ ...row, password: null }).hasPassword).toBe(false);
  });

  it('every public read derives hasPassword in SQL and never selects the hash', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'u1' });
    const service = new UsersService(
      {
        query: { users: { findFirst } },
      } as never,
      {} as never,
      {} as never,
    );

    await service.findOne('u1');

    // Replay the same query on a client-less Drizzle instance to see its SQL.
    const real = drizzle({ client: {} as Pool, schema });
    const { sql } = real.query.users
      .findFirst(
        firstArg<Parameters<typeof real.query.users.findFirst>[0]>(findFirst),
      )
      .toSQL();
    expect(sql).toMatch(/"password" is not null/i);
    expect(sql).not.toMatch(/"password"(?! is not null)/i);
  });

  it('findOneWithSuspension also reads sessionsRevokedAt for the JWT strategies', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'u1' });
    const service = new UsersService(
      {
        query: { users: { findFirst } },
      } as never,
      {} as never,
      {} as never,
    );

    await service.findOneWithSuspension('u1');

    expect(firstArg<{ columns: object }>(findFirst).columns).toMatchObject({
      sessionsRevokedAt: true,
      isActive: true,
    });
  });
});

describe('toPublicUser hasGoogle and passwordChangedAt', () => {
  const stamp = new Date('2026-11-01T00:00:00Z');
  const row = {
    id: 'u1',
    email: 'sara@daybreak.co',
    name: 'Sara',
    role: 'USER',
    isEmailVerified: true,
    lastAccessedWorkspaceId: null,
    onboardingCompletedAt: null,
    maestroTone: 'professional',
    useCase: null,
    avatarUrl: null,
    avatarColor: 'amber',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    password: 'hash',
    googleSub: 'g1',
    passwordChangedAt: stamp,
  } as unknown as User;

  it('maps hasGoogle true and the password date, and never leaks googleSub', () => {
    const out = toPublicUser(row);
    expect(out.hasGoogle).toBe(true);
    expect(out.passwordChangedAt).toBe(stamp);
    expect(out).not.toHaveProperty('googleSub');
  });

  it('hasGoogle is false without a Google link, and a never-changed password is null', () => {
    const out = toPublicUser({
      ...row,
      googleSub: null,
      passwordChangedAt: null,
    });
    expect(out.hasGoogle).toBe(false);
    expect(out.passwordChangedAt).toBeNull();
    expect(out).not.toHaveProperty('googleSub');
  });

  it('every public read derives hasGoogle in SQL, selects passwordChangedAt, and never selects google_sub itself', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'u1' });
    const service = new UsersService(
      {
        query: { users: { findFirst } },
      } as never,
      {} as never,
      {} as never,
    );

    await service.findOne('u1');

    const real = drizzle({ client: {} as Pool, schema });
    const { sql } = real.query.users
      .findFirst(
        firstArg<Parameters<typeof real.query.users.findFirst>[0]>(findFirst),
      )
      .toSQL();
    expect(sql).toMatch(/"google_sub" is not null/i);
    expect(sql).not.toMatch(/"google_sub"(?! is not null)/i);
    expect(sql).toMatch(/"password_changed_at"/i);
  });
});

/** A db whose transaction hands `tx` (with the same execute) to the callback. */
function txDb() {
  const execute = jest.fn().mockResolvedValue(undefined);
  const tx = { execute };
  const transaction = jest.fn((fn: (t: typeof tx) => unknown) => fn(tx));
  const sessions = { revokeAll: jest.fn().mockResolvedValue(2) };
  const secondFactor = { clear: jest.fn().mockResolvedValue(undefined) };
  const service = new UsersService(
    { execute, transaction } as never,
    sessions as never,
    secondFactor as never,
  );
  return { service, execute, tx, transaction, sessions, secondFactor };
}

describe('UsersService.resetPassword', () => {
  it('stamps password_changed_at in the same write as the new password', async () => {
    const { service, execute } = txDb();

    await service.resetPassword('u1', 'Secret123');

    const { sql } = render(firstArg<SQL>(execute));
    expect(sql).toMatch(/password_changed_at = \$\d+/);
    expect(sql).toMatch(/password_reset_token = NULL/);
  });

  it('ends every session through SessionStore.revokeAll, in the same transaction', async () => {
    const { service, execute, tx, transaction, sessions } = txDb();

    await service.resetPassword('u1', 'Secret123');

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(sessions.revokeAll).toHaveBeenCalledWith('u1', tx);
    // The floor is SessionStore's to write, not this UPDATE's.
    expect(render(firstArg<SQL>(execute)).sql).not.toMatch(
      /sessions_revoked_at/,
    );
  });
});

describe('UsersService.applyGoogleSignIn', () => {
  async function run(clearPassword: boolean) {
    const built = txDb();
    await built.service.applyGoogleSignIn('u1', {
      googleSub: 'g-1',
      name: 'Sara',
      clearPassword,
    });
    return { ...render(firstArg<SQL>(built.execute)), ...built };
  }

  it('pre-hijack clear ends the squatter sessions in the same transaction as the password', async () => {
    const { sql, sessions, tx } = await run(true);
    expect(sessions.revokeAll).toHaveBeenCalledWith('u1', tx);
    expect(sql).not.toMatch(/sessions_revoked_at/);
    expect(sql).toMatch(
      /password = CASE WHEN \$\d+ THEN NULL ELSE password END/,
    );
  });

  it('pre-hijack clear also wipes the squatter two-step setup, in the same transaction', async () => {
    const { secondFactor, tx } = await run(true);
    expect(secondFactor.clear).toHaveBeenCalledWith('u1', tx);
  });

  it('a verified link keeps the sessions and the two-step setup', async () => {
    const { sessions, secondFactor } = await run(false);
    expect(sessions.revokeAll).not.toHaveBeenCalled();
    expect(secondFactor.clear).not.toHaveBeenCalled();
  });
});
