import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../auth.service';
import { JwtRefreshStrategy } from './jwt-refresh.strategy';
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
      strategy.validate({ sub: 'u1', email: 'a@b.com' }),
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
    new JwtStrategy(config as never, usersWith(revokedAt) as never);

  it('jwt strategy rejects a token issued before sessions_revoked_at and accepts one issued in the same second', async () => {
    const strategy = make(REVOKED_AT);
    const before = strategy.validate({
      sub: 'u1',
      email: 'a@b.com',
      iat: 1_699_999_999,
    });
    await expect(before).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(before).rejects.toThrow('Session ended');

    await expect(
      strategy.validate({ sub: 'u1', email: 'a@b.com', iat: 1_700_000_000 }),
    ).resolves.toMatchObject({ userId: 'u1' });
  });

  it('accepts any token when nothing was ever revoked', async () => {
    await expect(
      make(null).validate({ sub: 'u1', email: 'a@b.com', iat: 1 }),
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
    new JwtRefreshStrategy(config as never, usersWith(revokedAt) as never);
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
  const STALE = { sub: 'u1', email: 'old@example.test', iat: 1_800_000_000 };
  const users = {
    findOneWithSuspension: jest.fn().mockResolvedValue({
      ...ACTIVE,
      email: 'new@example.test',
      sessionsRevokedAt: null,
    }),
  };

  it('the access strategy gives handlers the current address', async () => {
    const strategy = new JwtStrategy(config as never, users as never);

    await expect(strategy.validate(STALE)).resolves.toMatchObject({
      userId: 'u1',
      email: 'new@example.test',
    });
  });

  it('after an email change, refresh mints tokens carrying the new email', async () => {
    const strategy = new JwtRefreshStrategy(config as never, users as never);
    const jwt = new JwtService({});
    // Only the token minting and the last-seen write run on this path.
    const none = null as never;
    const auth = new AuthService(
      none,
      none,
      jwt,
      config as never,
      none,
      none,
      none,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
      none,
      none,
      none,
    );

    // What /auth/refresh does with the strategy's result.
    const caller = await strategy.validate(
      { cookies: { refreshToken: 'rt' } } as never,
      STALE,
    );
    const access = await auth.refreshTokens(caller.userId, caller.email);
    const refresh = await auth.generateRefreshToken(
      caller.userId,
      caller.email,
    );

    for (const token of [access, refresh]) {
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
    const strategy = new JwtStrategy(config as never, deletedUsers as never);
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
      new JwtStrategy(config as never, live as never).validate(SAME_SECOND),
    ).resolves.toMatchObject({ userId: 'u1' });
  });
});
