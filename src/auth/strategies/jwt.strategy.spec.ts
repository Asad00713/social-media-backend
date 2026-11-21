import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SessionIssuer } from '../session/session-issuer';
import { JwtRefreshStrategy } from './jwt-refresh.strategy';
import { JwtStrategy, assertTokenLive, type JwtPayload } from './jwt.strategy';

/** A SessionCheck that finds every session live (the floor tests below use sid-less tokens). */
const LIVE = { isLive: jest.fn().mockResolvedValue(true) };
const LIVE_SID = '22222222-2222-4222-8222-222222222222';

describe('JwtStrategy suspension', () => {
  function make(userOverrides: Record<string, unknown>) {
    const usersService = {
      findOneWithSuspension: jest.fn().mockResolvedValue(userOverrides),
    };
    const config = { get: jest.fn().mockReturnValue('test-secret') };
    return new JwtStrategy(
      config as never,
      usersService as never,
      LIVE as never,
    );
  }

  it('throws a structured ACCOUNT_SUSPENDED 401 when the user is inactive', async () => {
    const strategy = make({
      id: 'u1',
      email: 'a@b.com',
      role: 'USER',
      isActive: false,
      suspendedReason: 'policy_violation',
    });
    await expect(
      strategy.validate({ sub: 'u1', email: 'a@b.com' }),
    ).rejects.toMatchObject({
      response: { code: 'ACCOUNT_SUSPENDED', reason: 'policy_violation' },
    });
  });

  it('passes an active user through', async () => {
    const strategy = make({
      id: 'u1',
      email: 'a@b.com',
      role: 'USER',
      isActive: true,
      suspendedReason: null,
    });
    await expect(
      strategy.validate({ sub: 'u1', email: 'a@b.com', sid: LIVE_SID }),
    ).resolves.toMatchObject({ userId: 'u1', role: 'USER' });
  });
});

// Revoked at 1_700_000_000.500 s: the cutoff is the whole second 1_700_000_000.
const REVOKED_AT = new Date(1_700_000_000_500);
const ACTIVE = {
  id: 'u1',
  email: 'a@b.com',
  role: 'USER',
  isActive: true,
  suspendedReason: null,
};

function usersWith(sessionsRevokedAt: Date | null) {
  return {
    findOneWithSuspension: jest
      .fn()
      .mockResolvedValue({ ...ACTIVE, sessionsRevokedAt }),
  };
}

const config = { get: jest.fn().mockReturnValue('test-secret') };

describe('JwtStrategy session revocation', () => {
  const make = (revokedAt: Date | null) =>
    new JwtStrategy(
      config as never,
      usersWith(revokedAt) as never,
      LIVE as never,
    );

  it('jwt strategy rejects a sid-less token issued before sessions_revoked_at', async () => {
    const before = make(REVOKED_AT).validate({
      sub: 'u1',
      email: 'a@b.com',
      iat: 1_699_999_999,
    });
    await expect(before).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(before).rejects.toThrow('Session ended');
  });

  it('a sid-less ACCESS token is refused even in the revocation second or with nothing revoked (review ruling 4)', async () => {
    // Only the refresh strategy still takes sid-less tokens; an access token
    // minted outside the issuer has no row and so opens nothing.
    await expect(
      make(REVOKED_AT).validate({
        sub: 'u1',
        email: 'a@b.com',
        iat: 1_700_000_000,
      }),
    ).rejects.toThrow('Session ended');
    await expect(
      make(null).validate({ sub: 'u1', email: 'a@b.com', iat: 1 }),
    ).rejects.toThrow('Session ended');
  });

  it('accepts a sid token when nothing was ever revoked', async () => {
    await expect(
      make(null).validate({
        sub: 'u1',
        email: 'a@b.com',
        iat: 1,
        sid: LIVE_SID,
      }),
    ).resolves.toMatchObject({ userId: 'u1' });
  });

  it('rejects a token with no iat once sessions were revoked', async () => {
    await expect(
      make(REVOKED_AT).validate({ sub: 'u1', email: 'a@b.com' }),
    ).rejects.toThrow('Session ended');
  });
});

describe('JwtRefreshStrategy session revocation', () => {
  const make = (revokedAt: Date | null) =>
    new JwtRefreshStrategy(
      config as never,
      usersWith(revokedAt) as never,
      LIVE as never,
    );
  const req = { cookies: { refreshToken: 'rt' } } as never;

  it('rejects a refresh token issued before sessions_revoked_at', async () => {
    await expect(
      make(REVOKED_AT).validate(req, {
        sub: 'u1',
        email: 'a@b.com',
        iat: 1_699_999_999,
      }),
    ).rejects.toThrow('Session ended');
  });

  it('accepts a refresh token issued in the revocation second', async () => {
    await expect(
      make(REVOKED_AT).validate(req, {
        sub: 'u1',
        email: 'a@b.com',
        iat: 1_700_000_000,
      }),
    ).resolves.toMatchObject({ userId: 'u1', refreshToken: 'rt' });
  });
});

describe('the email the strategies hand on comes from the row, not the claim', () => {
  // The token was minted before the email change; the row has the new address.
  const STALE = {
    sub: 'u1',
    email: 'old@example.test',
    iat: 1_800_000_000,
    sid: LIVE_SID,
  };
  const users = {
    findOneWithSuspension: jest.fn().mockResolvedValue({
      ...ACTIVE,
      email: 'new@example.test',
      sessionsRevokedAt: null,
    }),
  };

  it('the access strategy gives handlers the current address', async () => {
    const strategy = new JwtStrategy(
      config as never,
      users as never,
      LIVE as never,
    );

    await expect(strategy.validate(STALE)).resolves.toMatchObject({
      userId: 'u1',
      email: 'new@example.test',
    });
  });

  it('after an email change, refresh mints tokens carrying the new email', async () => {
    const strategy = new JwtRefreshStrategy(
      config as never,
      users as never,
      LIVE as never,
    );
    const jwt = new JwtService({});
    // The issuer reads the address from the row itself; only the row read,
    // the session touch and the last-seen write run on this path.
    const db = {
      query: {
        users: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'u1',
            email: 'new@example.test',
            role: 'USER',
            isActive: true,
            totpEnabledAt: null,
          }),
        },
      },
    };
    const none = null as never;
    const issuer = new SessionIssuer(
      db as never,
      jwt,
      config as never,
      { touch: jest.fn().mockResolvedValue(true) } as never,
      none,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
      none,
      none,
    );
    const res = { cookie: jest.fn() };

    // What /auth/refresh does with the strategy's result.
    const caller = await strategy.validate(
      { cookies: { refreshToken: 'rt' } } as never,
      { ...STALE, sid: '11111111-1111-4111-8111-111111111111' },
    );
    const { accessToken } = await issuer.issue(
      caller.userId,
      { cookies: {}, headers: {} } as never,
      res as never,
      { via: 'refresh', sid: caller.sid },
    );
    const refresh = (res.cookie.mock.calls as unknown[][]).find(
      (c) => c[0] === 'refreshToken',
    )?.[1] as string;

    for (const token of [accessToken, refresh]) {
      expect(jwt.decode<{ email: string }>(token).email).toBe(
        'new@example.test',
      );
    }
  });
});

describe('a deleted account', () => {
  // Deleted at 1_700_000_000.500 s; the delete also revoked sessions then.
  const DELETED_AT = new Date(1_700_000_000_500);
  const deletedUsers = {
    findOneWithSuspension: jest.fn().mockResolvedValue({
      ...ACTIVE,
      email: 'deleted+u1@deleted.invalid',
      // A deleted row is also inactive: the delete code must still win.
      isActive: false,
      suspendedReason: null,
      sessionsRevokedAt: DELETED_AT,
      deletedAt: DELETED_AT,
    }),
  };
  // Minted in the delete's own second: assertSessionLive alone would let it
  // through (whole seconds), so this proves the deletedAt check.
  const SAME_SECOND = {
    sub: 'u1',
    email: 'old@example.test',
    iat: 1_700_000_000,
  };

  it('jwt strategy: ACCOUNT_DELETED, checked before suspension', async () => {
    const strategy = new JwtStrategy(
      config as never,
      deletedUsers as never,
      LIVE as never,
    );
    const result = strategy.validate(SAME_SECOND);
    await expect(result).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(result).rejects.toMatchObject({
      response: { statusCode: 401, code: 'ACCOUNT_DELETED' },
    });
  });

  it('refresh strategy: an existing refresh token fails with ACCOUNT_DELETED', async () => {
    const strategy = new JwtRefreshStrategy(
      config as never,
      deletedUsers as never,
      LIVE as never,
    );
    const req = { cookies: { refreshToken: 'rt' } } as never;

    // Older than the delete, and from the delete's own second: both refused.
    for (const iat of [1_699_000_000, 1_700_000_000]) {
      await expect(
        strategy.validate(req, { ...SAME_SECOND, iat }),
      ).rejects.toMatchObject({
        response: { statusCode: 401, code: 'ACCOUNT_DELETED' },
      });
    }
  });

  it('a live account (deletedAt null) is unaffected', async () => {
    const live = {
      findOneWithSuspension: jest.fn().mockResolvedValue({
        ...ACTIVE,
        sessionsRevokedAt: null,
        deletedAt: null,
      }),
    };
    await expect(
      new JwtStrategy(config as never, live as never, LIVE as never).validate({
        ...SAME_SECOND,
        sid: LIVE_SID,
      }),
    ).resolves.toMatchObject({ userId: 'u1' });
  });
});

describe('the session behind a token (sid, Task 6)', () => {
  const SID = '11111111-1111-4111-8111-111111111111';
  const checkWith = (live: boolean) => ({
    isLive: jest.fn().mockResolvedValue(live),
  });

  it('a token with a live sid passes and req.user carries sid and iat', async () => {
    const check = checkWith(true);
    const strategy = new JwtStrategy(
      config as never,
      usersWith(null) as never,
      check as never,
    );
    await expect(
      strategy.validate({
        sub: 'u1',
        email: 'a@b.com',
        iat: 1_800_000_000,
        sid: SID,
      }),
    ).resolves.toEqual({
      userId: 'u1',
      email: 'a@b.com',
      role: 'USER',
      sid: SID,
      iat: 1_800_000_000,
    });
    expect(check.isLive).toHaveBeenCalledWith(SID, 'u1');
  });

  it('a token whose sid is revoked → 401 Session ended', async () => {
    const strategy = new JwtStrategy(
      config as never,
      usersWith(null) as never,
      checkWith(false) as never,
    );
    const attempt = strategy.validate({
      sub: 'u1',
      email: 'a@b.com',
      iat: 1_800_000_000,
      sid: SID,
    });
    await expect(attempt).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(attempt).rejects.toThrow('Session ended');
  });

  it('a sid token older than sessionsRevokedAt still passes (row is the authority)', async () => {
    // B1: "log out of other sessions" moves the floor; the caller's own sid
    // token, minted before it, must survive.
    const strategy = new JwtStrategy(
      config as never,
      usersWith(REVOKED_AT) as never,
      checkWith(true) as never,
    );
    await expect(
      strategy.validate({
        sub: 'u1',
        email: 'a@b.com',
        iat: 1_699_000_000,
        sid: SID,
      }),
    ).resolves.toMatchObject({ userId: 'u1', sid: SID });
  });

  it('a sid-less token older than sessionsRevokedAt → 401', async () => {
    const check = checkWith(true);
    const strategy = new JwtStrategy(
      config as never,
      usersWith(REVOKED_AT) as never,
      check as never,
    );
    await expect(
      strategy.validate({ sub: 'u1', email: 'a@b.com', iat: 1_699_000_000 }),
    ).rejects.toThrow('Session ended');
    expect(check.isLive).not.toHaveBeenCalled();
  });

  it('a sid-less access token → 401 even with no floor, never sid null (review ruling 4)', async () => {
    const check = checkWith(true);
    const strategy = new JwtStrategy(
      config as never,
      usersWith(null) as never,
      check as never,
    );
    await expect(
      strategy.validate({ sub: 'u1', email: 'a@b.com', iat: 5 }),
    ).rejects.toThrow('Session ended');
    expect(check.isLive).not.toHaveBeenCalled();
  });

  it('assertTokenLive takes a sid-less token only when the caller opts in (refresh)', async () => {
    const payload = { sub: 'u1', iat: 5 };
    await expect(
      assertTokenLive(payload, { sessionsRevokedAt: null }, checkWith(true)),
    ).rejects.toThrow('Session ended');
    await expect(
      assertTokenLive(payload, { sessionsRevokedAt: null }, checkWith(true), {
        allowSidless: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('refresh strategy: a sid-less (pre-deploy) refresh token still passes with sid null', async () => {
    const strategy = new JwtRefreshStrategy(
      config as never,
      usersWith(null) as never,
      checkWith(true) as never,
    );
    await expect(
      strategy.validate({ cookies: { refreshToken: 'rt' } } as never, {
        sub: 'u1',
        email: 'a@b.com',
        iat: 5,
      }),
    ).resolves.toMatchObject({ userId: 'u1', sid: null });
  });

  it('a malformed sid (not a string) → 401, never the floor path', async () => {
    const strategy = new JwtStrategy(
      config as never,
      usersWith(null) as never,
      checkWith(true) as never,
    );
    await expect(
      strategy.validate({
        sub: 'u1',
        email: 'a@b.com',
        iat: 5,
        sid: 42,
      } as never),
    ).rejects.toThrow('Session ended');
  });

  it.each(['admin-login', 'mfa'])(
    'a payload with purpose:"%s" signed with JWT_ACCESS_SECRET → 401',
    async (purpose) => {
      const jwt = new JwtService({});
      const token = jwt.sign(
        { sub: 'u1', email: 'a@b.com', purpose, cid: 'c1' },
        { secret: 'test-secret', expiresIn: '5m' },
      );
      const payload = jwt.verify<JwtPayload>(token, { secret: 'test-secret' });
      const strategy = new JwtStrategy(
        config as never,
        usersWith(null) as never,
        checkWith(true) as never,
      );
      await expect(strategy.validate(payload)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    },
  );

  it('assertTokenLive itself refuses purpose and aud claims (not only validate)', async () => {
    const check = checkWith(true);
    for (const extra of [{ purpose: 'admin-login' }, { aud: 'report' }]) {
      await expect(
        assertTokenLive(
          { sub: 'u1', iat: 5, sid: SID, ...extra },
          { sessionsRevokedAt: null },
          check,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    expect(check.isLive).not.toHaveBeenCalled();
  });

  it('refresh strategy: a revoked sid → 401; a live one returns {userId, email, refreshToken, sid}', async () => {
    const req = { cookies: { refreshToken: 'rt' } } as never;
    const revoked = new JwtRefreshStrategy(
      config as never,
      usersWith(null) as never,
      checkWith(false) as never,
    );
    await expect(
      revoked.validate(req, { sub: 'u1', email: 'a@b.com', iat: 5, sid: SID }),
    ).rejects.toThrow('Session ended');

    const live = new JwtRefreshStrategy(
      config as never,
      usersWith(null) as never,
      checkWith(true) as never,
    );
    await expect(
      live.validate(req, { sub: 'u1', email: 'a@b.com', iat: 5, sid: SID }),
    ).resolves.toEqual({
      userId: 'u1',
      email: 'a@b.com',
      refreshToken: 'rt',
      sid: SID,
    });
  });
});
