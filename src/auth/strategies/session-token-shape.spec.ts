import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtRefreshStrategy } from './jwt-refresh.strategy';
import {
  JwtStrategy,
  assertSessionTokenShape,
  type JwtPayload,
} from './jwt.strategy';

/** A SessionCheck that finds every session live (the floor tests below use sid-less tokens). */
const LIVE = { isLive: jest.fn().mockResolvedValue(true) };

/**
 * Several non-session tokens are signed with JWT_ACCESS_SECRET (or fall back
 * to it): the super-admin challenge token, the Google state cookie, the TikTok
 * media proxy token. The admin challenge token carries `sub` + `email`, so
 * without a shape check it is accepted as a 5-minute access token, issued
 * after the emailed code and BEFORE the password step.
 */
const ACTIVE_USER = {
  id: 'u1',
  email: 'a@b.com',
  role: 'SUPER_ADMIN',
  isActive: true,
  suspendedReason: null,
  sessionsRevokedAt: null,
  deletedAt: null,
};

function users() {
  return {
    findOneWithSuspension: jest.fn().mockResolvedValue(ACTIVE_USER),
  };
}

const config = { get: jest.fn().mockReturnValue('test-secret') };

describe('assertSessionTokenShape', () => {
  it('accepts a session token payload', () => {
    expect(() =>
      assertSessionTokenShape({ sub: 'u1', email: 'a@b.com', iat: 1 }),
    ).not.toThrow();
  });

  it.each([
    [
      'a purpose claim',
      { sub: 'u1', email: 'a@b.com', purpose: 'admin-login' },
    ],
    ['an audience claim', { sub: 'u1', aud: 'email-security' }],
    ['no subject', { url: 'https://example.com/a.mp4' }],
    ['a non-string subject', { sub: 42 }],
  ])('rejects a token with %s', (_label, payload) => {
    expect(() => assertSessionTokenShape(payload)).toThrow(
      UnauthorizedException,
    );
  });
});

describe('JwtStrategy refuses non-session tokens', () => {
  it('refuses the super-admin challenge token signed with the access secret', async () => {
    // The real shape AdminChallengeService signs, round-tripped through JWT.
    const jwt = new JwtService();
    const token = jwt.sign(
      { sub: 'u1', email: 'a@b.com', purpose: 'admin-login' },
      { secret: 'test-secret', expiresIn: '5m' },
    );
    const payload = jwt.verify<JwtPayload>(token, { secret: 'test-secret' });

    const usersService = users();
    const strategy = new JwtStrategy(
      config as never,
      usersService as never,
      LIVE as never,
    );

    await expect(strategy.validate(payload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    // Refused before any user lookup.
    expect(usersService.findOneWithSuspension).not.toHaveBeenCalled();
  });

  it('still accepts a normal access token payload', async () => {
    const strategy = new JwtStrategy(
      config as never,
      users() as never,
      LIVE as never,
    );
    await expect(
      strategy.validate({ sub: 'u1', email: 'a@b.com', iat: 1 }),
    ).resolves.toMatchObject({ userId: 'u1' });
  });
});

describe('JwtRefreshStrategy refuses non-session tokens', () => {
  it('refuses a token carrying a purpose claim', async () => {
    const usersService = users();
    const strategy = new JwtRefreshStrategy(
      config as never,
      usersService as never,
      LIVE as never,
    );
    const req = { cookies: { refreshToken: 'x' } };

    await expect(
      strategy.validate(
        req as never,
        {
          sub: 'u1',
          email: 'a@b.com',
          purpose: 'admin-login',
        } as never,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(usersService.findOneWithSuspension).not.toHaveBeenCalled();
  });
});
