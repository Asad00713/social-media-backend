import { UnauthorizedException } from '@nestjs/common';
import { AuthController } from './auth.controller';

const SID = '11111111-1111-4111-8111-111111111111';
// A full user row as AuthService.login returns it: the controller must narrow
// it to the public allow-list.
const ROW = {
  id: 'u1',
  email: 'a@b.co',
  name: 'A',
  password: '$2b$10$hash',
  totpSecretEnc: 'iv:tag:ct',
};
const PUBLIC_USER = { id: 'u1', email: 'a@b.co' };

function build(
  over: { loginError?: Error; issueError?: Error; mfa?: boolean } = {},
) {
  const authService = {
    login: over.loginError
      ? jest.fn().mockRejectedValue(over.loginError)
      : jest.fn().mockResolvedValue(ROW),
    register: jest.fn().mockResolvedValue({ user: PUBLIC_USER, message: 'ok' }),
  };
  const issuer = {
    issue: over.issueError
      ? jest.fn().mockRejectedValue(over.issueError)
      : jest
          .fn()
          .mockResolvedValue(
            over.mfa
              ? { kind: 'mfa', challengeToken: 'challenge' }
              : { kind: 'session', accessToken: 'access', sid: SID },
          ),
  };
  const res = { cookie: jest.fn(), clearCookie: jest.fn() };
  const sessions = { revoke: jest.fn().mockResolvedValue(true) };
  const controller = new AuthController(
    authService as never,
    {} as never,
    issuer as never,
    sessions as never,
  );
  return { controller, authService, issuer, res, sessions };
}

const req = { cookies: {}, headers: {} } as never;
const credentials = { email: 'a@b.co', password: 'pw' };

describe('AuthController.login', () => {
  it('checks the first factor, then mints through the issuer with via password', async () => {
    const b = build();
    const result = await b.controller.login(credentials, req, b.res as never);
    expect(b.authService.login).toHaveBeenCalledWith(credentials);
    expect(b.issuer.issue).toHaveBeenCalledWith('u1', req, b.res, {
      via: 'password',
    });
    expect(result).toMatchObject({
      accessToken: 'access',
      user: { id: 'u1', email: 'a@b.co' },
    });
    expect(Object.keys(result)).toEqual(['accessToken', 'user']);
  });

  it('answers with the public user only (no password hash, no secret column)', async () => {
    const b = build();
    const result = await b.controller.login(credentials, req, b.res as never);
    if (!('user' in result) || !result.user)
      throw new Error('expected a session body');
    const keys = Object.keys(result.user);
    expect(keys).not.toContain('password');
    expect(keys.some((k) => /totp|mfa/i.test(k))).toBe(false);
  });

  it('a failed sign-in never reaches the issuer and sets no cookie', async () => {
    const b = build({ loginError: new UnauthorizedException() });
    await expect(
      b.controller.login(credentials, req, b.res as never),
    ).rejects.toThrow(UnauthorizedException);
    expect(b.issuer.issue).not.toHaveBeenCalled();
    expect(b.res.cookie).not.toHaveBeenCalled();
  });

  it('a failed mint is the response (nothing swallowed)', async () => {
    const b = build({ issueError: new Error('JWT_REFRESH_SECRET missing') });
    await expect(
      b.controller.login(credentials, req, b.res as never),
    ).rejects.toThrow('JWT_REFRESH_SECRET missing');
  });

  it('an mfa answer is passed on as {mfaRequired, challengeToken} with no token', async () => {
    const b = build({ mfa: true });
    const result = await b.controller.login(credentials, req, b.res as never);
    expect(result).toEqual({ mfaRequired: true, challengeToken: 'challenge' });
  });
});

describe('AuthController.login for a super admin (Task 12)', () => {
  it('mints through the issuer with via admin, so TOTP stacks on the emailed code', async () => {
    const b = build();
    b.authService.login.mockResolvedValue({ ...ROW, role: 'SUPER_ADMIN' });
    await b.controller.login(credentials, req, b.res as never);
    expect(b.issuer.issue).toHaveBeenCalledWith('u1', req, b.res, {
      via: 'admin',
    });
  });

  it('super-admin with TOTP on: correct password + emailed token -> 200 {mfaRequired:true, challengeToken}, no cookie', async () => {
    const b = build({ mfa: true });
    b.authService.login.mockResolvedValue({ ...ROW, role: 'SUPER_ADMIN' });
    const result = await b.controller.login(
      { ...credentials, challengeToken: 'emailed' } as never,
      req,
      b.res as never,
    );
    expect(result).toEqual({ mfaRequired: true, challengeToken: 'challenge' });
    expect(b.res.cookie).not.toHaveBeenCalled();
  });

  it('super-admin: a wrong password never reaches the issuer (the emailed token is not consumed there)', async () => {
    const b = build({ loginError: new UnauthorizedException() });
    await expect(
      b.controller.login(credentials, req, b.res as never),
    ).rejects.toThrow(UnauthorizedException);
    expect(b.issuer.issue).not.toHaveBeenCalled();
  });
});

describe('AuthController.register', () => {
  it('creates the account, then mints through the issuer with via register', async () => {
    const b = build();
    const dto = { email: 'a@b.co', password: 'Passw0rd!', name: 'A' } as never;
    const withIp = {
      cookies: {},
      headers: { 'x-real-ip': '203.0.113.9' },
      ip: '10.0.0.1',
    } as never;
    const result = await b.controller.register(dto, withIp, b.res as never);
    // The visitor's address, not the proxy's req.ip.
    expect(b.authService.register).toHaveBeenCalledWith(dto, '203.0.113.9');
    expect(b.issuer.issue).toHaveBeenCalledWith('u1', withIp, b.res, {
      via: 'register',
    });
    expect(result).toEqual({
      accessToken: 'access',
      user: PUBLIC_USER,
      message: 'ok',
    });
  });

  it('a failed mint is the response', async () => {
    const b = build({ issueError: new Error('boom') });
    await expect(
      b.controller.register({} as never, req, b.res as never),
    ).rejects.toThrow('boom');
  });
});

describe('AuthController two-step answers (Task 10)', () => {
  it('POST /auth/login: issuer answers mfa -> 200 {mfaRequired:true, challengeToken}, no refreshToken cookie', async () => {
    const b = build({ mfa: true });
    const result = await b.controller.login(credentials, req, b.res as never);
    expect(result).toEqual({ mfaRequired: true, challengeToken: 'challenge' });
    expect(result).not.toHaveProperty('accessToken');
    expect(b.res.cookie).not.toHaveBeenCalled();
  });

  it('POST /auth/register: issuer answers mfa -> 200 {mfaRequired:true, challengeToken}, no cookie', async () => {
    const b = build({ mfa: true });
    const result = await b.controller.register(
      { email: 'a@b.co' } as never,
      req,
      b.res as never,
    );
    expect(result).toEqual({ mfaRequired: true, challengeToken: 'challenge' });
    expect(b.res.cookie).not.toHaveBeenCalled();
  });
});

describe('AuthController.refreshTokens', () => {
  it('reissues the caller session through the issuer (same sid)', async () => {
    const b = build();
    const result = await b.controller.refreshTokens(
      { userId: 'u1', sid: SID },
      req,
      b.res as never,
    );
    expect(b.issuer.issue).toHaveBeenCalledWith('u1', req, b.res, {
      via: 'refresh',
      sid: SID,
    });
    expect(result).toEqual({ accessToken: 'access' });
  });

  it('a pre-deploy refresh token (no sid) asks the issuer for a new row', async () => {
    const b = build();
    await b.controller.refreshTokens(
      { userId: 'u1', iat: 1_700_000_000 },
      req,
      b.res as never,
    );
    // The old token's iat: the new row must not pass for a fresh sign-in.
    expect(b.issuer.issue).toHaveBeenCalledWith('u1', req, b.res, {
      via: 'refresh',
      sid: null,
      legacyIssuedAt: 1_700_000_000,
    });
  });

  it('a revoked session is a 401 from the issuer, passed straight through', async () => {
    const ended = new UnauthorizedException({ code: 'SESSION_ENDED' });
    const b = build({ issueError: ended });
    await expect(
      b.controller.refreshTokens(
        { userId: 'u1', sid: SID },
        req,
        b.res as never,
      ),
    ).rejects.toBe(ended);
    expect(b.res.cookie).not.toHaveBeenCalled();
  });
});

describe('AuthController.logout (Task 13)', () => {
  const caller = (sid: string | null) =>
    ({ userId: 'u1', email: 'a@b.co', role: 'USER', sid, iat: 1 }) as never;

  it("revokes the caller's own session row, then clears the cookie", async () => {
    const b = build();
    const order: string[] = [];
    b.sessions.revoke.mockImplementation(() => {
      order.push('revoke');
      return Promise.resolve(true);
    });
    b.res.clearCookie.mockImplementation(() => {
      order.push('clear');
    });
    await expect(
      b.controller.logout(caller(SID), b.res as never),
    ).resolves.toEqual({ message: 'Logged out successfully' });
    expect(b.sessions.revoke).toHaveBeenCalledWith('u1', SID);
    expect(order).toEqual(['revoke', 'clear']);
  });

  it('a sid-less caller revokes nothing and is still logged out', async () => {
    const b = build();
    await b.controller.logout(caller(null), b.res as never);
    expect(b.sessions.revoke).not.toHaveBeenCalled();
    expect(b.res.clearCookie).toHaveBeenCalled();
  });
});
