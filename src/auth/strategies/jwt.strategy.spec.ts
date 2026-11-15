import { UnauthorizedException } from '@nestjs/common';
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
