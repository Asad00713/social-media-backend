import { createHash } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as jsonwebtoken from 'jsonwebtoken';
import { SessionIssuer } from './session-issuer';

const SECRETS: Record<string, string> = {
  JWT_ACCESS_SECRET: 'access-secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
};
const SID = '11111111-1111-4111-8111-111111111111';
const NEW_SID = '22222222-2222-4222-8222-222222222222';
const DEVICE = 'v'.repeat(43);
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const USER = {
  id: 'u1',
  email: 'current@example.test',
  role: 'USER',
  isActive: true,
  totpEnabledAt: null,
};
const DAY_MS = 24 * 60 * 60 * 1000;

interface Decoded {
  sub: string;
  email: string;
  sid: string;
  exp: number;
  iat: number;
}

function build(
  over: {
    user?: unknown;
    touch?: boolean;
    geo?: Promise<unknown>;
    secrets?: Record<string, string | undefined>;
    /** What KnownDevicesService.isMfaTrusted answers. */
    trusted?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const db = {
    query: {
      users: {
        findFirst: jest
          .fn()
          .mockResolvedValue('user' in over ? over.user : USER),
      },
    },
  };
  const sessions = {
    create: jest.fn(() => {
      calls.push('create');
      return Promise.resolve({ id: NEW_SID, expiresAt: new Date() });
    }),
    touch: jest.fn(() => {
      calls.push('touch');
      return Promise.resolve(over.touch ?? true);
    }),
    setCountry: jest.fn(() => {
      calls.push('setCountry');
      return Promise.resolve();
    }),
  };
  const knownDevices = {
    track: jest.fn(() => {
      calls.push('track');
    }),
    isMfaTrusted: jest.fn(() => Promise.resolve(over.trusted ?? false)),
    markMfaTrusted: jest.fn(() => {
      calls.push('markMfaTrusted');
      return Promise.resolve();
    }),
  };
  const challenges = {
    create: jest.fn(() => {
      calls.push('challenge');
      return Promise.resolve('challenge-token');
    }),
  };
  const loginActivity = {
    record: jest.fn(() => {
      calls.push('record');
      return Promise.resolve();
    }),
  };
  const geoip = {
    lookup: jest.fn(() => {
      calls.push('lookup');
      return over.geo ?? Promise.resolve({ country: 'Pakistan' });
    }),
  };
  const secrets = over.secrets ?? SECRETS;
  const config = { get: (key: string) => secrets[key] };
  const issuer = new SessionIssuer(
    db as never,
    new JwtService({}),
    config as never,
    sessions as never,
    knownDevices as never,
    loginActivity as never,
    geoip as never,
    challenges as never,
  );
  const res = {
    cookie: jest.fn((name: string) => {
      calls.push(`cookie:${name}`);
    }),
  };
  return {
    issuer,
    db,
    sessions,
    challenges,
    knownDevices,
    loginActivity,
    geoip,
    res,
    calls,
  };
}

function request(
  over: { cookies?: Record<string, unknown>; ip?: string } = {},
): never {
  return {
    cookies: over.cookies ?? {},
    headers: { 'user-agent': UA, 'x-real-ip': over.ip ?? '203.0.113.7' },
    ip: '10.0.0.1',
  } as never;
}

const decode = (t: string) => jsonwebtoken.decode(t) as Decoded;

function refreshCookie(res: { cookie: jest.Mock }) {
  const call = (res.cookie.mock.calls as unknown[][]).find(
    (c) => c[0] === 'refreshToken',
  );
  return call as [string, string, { maxAge: number; httpOnly: boolean }];
}

function deviceCookie(res: { cookie: jest.Mock }): unknown {
  const call = (res.cookie.mock.calls as unknown[][]).find(
    (c) => c[0] === 'sd_device',
  );
  return call?.[1];
}

const flush = () => new Promise((r) => setImmediate(r));

describe('SessionIssuer', () => {
  it('password: creates a row, signs {sub,email,sid} on both tokens, sets a 30-day cookie', async () => {
    const b = build();
    const result = await b.issuer.issue(
      'u1',
      request({ cookies: { sd_device: DEVICE } }),
      b.res as never,
      { via: 'password' },
    );

    expect(result).toMatchObject({ kind: 'session', sid: NEW_SID });
    if (result.kind !== 'session') throw new Error('expected a session');
    expect(b.sessions.create).toHaveBeenCalledWith({
      userId: 'u1',
      deviceHash: createHash('sha256').update(DEVICE).digest('hex'),
      label: 'Chrome on Windows',
      deviceType: 'desktop',
      ip: '203.0.113.7',
    });

    const [, refresh, options] = refreshCookie(b.res);
    const access = decode(result.accessToken);
    const refreshClaims = decode(refresh);
    for (const claims of [access, refreshClaims]) {
      expect(claims).toMatchObject({
        sub: 'u1',
        email: 'current@example.test',
        sid: NEW_SID,
      });
    }
    expect(access.exp - access.iat).toBe(15 * 60);
    expect(refreshClaims.exp - refreshClaims.iat).toBe(30 * 24 * 60 * 60);
    // Each token verifies only with its own secret.
    expect(() =>
      jsonwebtoken.verify(result.accessToken, 'access-secret'),
    ).not.toThrow();
    expect(() => jsonwebtoken.verify(refresh, 'refresh-secret')).not.toThrow();
    expect(() => jsonwebtoken.verify(refresh, 'access-secret')).toThrow();
    expect(options).toMatchObject({ httpOnly: true, maxAge: 30 * DAY_MS });

    // The device is the one the cookie names, and it is tracked after the
    // session exists (refresh cookie first), with an A6 for a new device.
    expect(deviceCookie(b.res)).toBe(DEVICE);
    expect(b.knownDevices.track).toHaveBeenCalledWith(
      'u1',
      DEVICE,
      { ip: '203.0.113.7', userAgent: UA },
      { silent: false },
    );
    expect(b.calls.indexOf('cookie:refreshToken')).toBeLessThan(
      b.calls.indexOf('track'),
    );
    expect(b.loginActivity.record).toHaveBeenCalledWith('u1', '203.0.113.7');
  });

  it('the email comes from the user row, never from a caller claim', async () => {
    const b = build();
    const result = await b.issuer.issue('u1', request(), b.res as never, {
      via: 'refresh',
      sid: SID,
    });
    expect(b.db.query.users.findFirst).toHaveBeenCalledTimes(1);
    expect(decode(result.accessToken).email).toBe('current@example.test');
  });

  it.each([
    ['a JSON-decoded array', [DEVICE]],
    ['an object', {}],
    ['a number', 7],
    ['no cookie', undefined],
  ])('a bad device cookie (%s) gets a fresh id', async (_n, cookie) => {
    const b = build();
    await b.issuer.issue(
      'u1',
      request({ cookies: { sd_device: cookie } }),
      b.res as never,
      { via: 'password' },
    );
    const set = deviceCookie(b.res);
    expect(set).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(set).not.toBe(DEVICE);
    const tracked = (b.knownDevices.track.mock.calls as unknown[][])[0];
    expect(tracked[1]).toBe(set);
  });

  it('refresh with sid: touches the same row and re-signs the same sid', async () => {
    const b = build();
    const result = await b.issuer.issue('u1', request(), b.res as never, {
      via: 'refresh',
      sid: SID,
    });
    expect(b.sessions.touch).toHaveBeenCalledWith(SID, 'u1');
    expect(b.sessions.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: 'session', sid: SID });
    expect(decode(result.accessToken).sid).toBe(SID);
    expect(decode(refreshCookie(b.res)[1]).sid).toBe(SID);
    // Not a new sign-in: no device cookie, no tracking, no GeoIP.
    expect(deviceCookie(b.res)).toBeUndefined();
    expect(b.knownDevices.track).not.toHaveBeenCalled();
    expect(b.geoip.lookup).not.toHaveBeenCalled();
    expect(b.loginActivity.record).toHaveBeenCalledWith('u1', '203.0.113.7');
  });

  it('refresh with a revoked sid: 401 SESSION_ENDED, no cookie, no token', async () => {
    const b = build({ touch: false });
    const attempt = b.issuer.issue('u1', request(), b.res as never, {
      via: 'refresh',
      sid: SID,
    });
    await expect(attempt).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(attempt).rejects.toMatchObject({
      response: { code: 'SESSION_ENDED' },
    });
    expect(b.res.cookie).not.toHaveBeenCalled();
    expect(b.sessions.create).not.toHaveBeenCalled();
    expect(b.loginActivity.record).not.toHaveBeenCalled();
  });

  it('password_change with a revoked sid is refused the same way', async () => {
    const b = build({ touch: false });
    await expect(
      b.issuer.issue('u1', request(), b.res as never, {
        via: 'password_change',
        sid: SID,
      }),
    ).rejects.toMatchObject({ response: { code: 'SESSION_ENDED' } });
    expect(b.res.cookie).not.toHaveBeenCalled();
  });

  it('refresh without sid (pre-deploy token): creates a row, device recorded silently', async () => {
    const b = build();
    const result = await b.issuer.issue(
      'u1',
      request({ cookies: { sd_device: DEVICE } }),
      b.res as never,
      { via: 'refresh', sid: null, legacyIssuedAt: 1_700_000_000 },
    );
    expect(b.sessions.touch).not.toHaveBeenCalled();
    expect(b.sessions.create).toHaveBeenCalledTimes(1);
    // The row "started" when the old token was issued, not now: it never
    // passes for a fresh sign-in (the Google-only re-auth window).
    expect(b.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ createdAt: new Date(1_700_000_000_000) }),
    );
    expect(result.sid).toBe(NEW_SID);
    expect(b.knownDevices.track).toHaveBeenCalledWith(
      'u1',
      DEVICE,
      expect.any(Object),
      { silent: true },
    );
  });

  it.each([
    ['refresh without an iat', { via: 'refresh' as const, sid: null }],
    [
      'a sid-less password change',
      { via: 'password_change' as const, sid: null },
    ],
  ])(
    '%s: the new row starts at the epoch, never "now"',
    async (_label, opts) => {
      const b = build();
      await b.issuer.issue('u1', request(), b.res as never, opts);
      expect(b.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({ createdAt: new Date(0) }),
      );
    },
  );

  it('a real sign-in row carries no createdAt (the database default, now)', async () => {
    const b = build();
    await b.issuer.issue('u1', request(), b.res as never, { via: 'password' });
    const input = (b.sessions.create.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(input.createdAt).toBeUndefined();
  });

  it('password_change keeps the same sid and records no sign-in', async () => {
    const b = build();
    const result = await b.issuer.issue('u1', request(), b.res as never, {
      via: 'password_change',
      sid: SID,
    });
    expect(result.sid).toBe(SID);
    expect(b.loginActivity.record).not.toHaveBeenCalled();
    expect(refreshCookie(b.res)).toBeDefined();
  });

  it('register: device tracked silently, recordSync not repeated', async () => {
    const b = build();
    await b.issuer.issue('u1', request(), b.res as never, {
      via: 'register',
      silentDevice: false, // register is silent whatever the caller says
    });
    expect(b.sessions.create).toHaveBeenCalledTimes(1);
    expect(b.knownDevices.track).toHaveBeenCalledWith(
      'u1',
      expect.any(String),
      expect.any(Object),
      { silent: true },
    );
    expect(b.loginActivity.record).not.toHaveBeenCalled();
  });

  it('google: silentDevice is honoured and the Google service records the sign-in itself', async () => {
    const b = build();
    await b.issuer.issue('u1', request(), b.res as never, {
      via: 'google',
      silentDevice: true,
    });
    expect(b.knownDevices.track).toHaveBeenCalledWith(
      'u1',
      expect.any(String),
      expect.any(Object),
      { silent: true },
    );
    expect(b.loginActivity.record).not.toHaveBeenCalled();
  });

  it('country is written after the row, and a GeoIP failure never fails issue', async () => {
    const ok = build();
    await ok.issuer.issue('u1', request(), ok.res as never, {
      via: 'password',
    });
    await flush();
    expect(ok.sessions.setCountry).toHaveBeenCalledWith(NEW_SID, 'Pakistan');
    expect(ok.calls.indexOf('create')).toBeLessThan(
      ok.calls.indexOf('setCountry'),
    );
    expect(ok.geoip.lookup).toHaveBeenCalledWith('203.0.113.7');

    const failing = build({ geo: Promise.reject(new Error('ip-api down')) });
    await expect(
      failing.issuer.issue('u1', request(), failing.res as never, {
        via: 'password',
      }),
    ).resolves.toMatchObject({ kind: 'session' });
    await flush();
    expect(failing.sessions.setCountry).not.toHaveBeenCalled();

    // A lookup that never answers does not hold up the sign-in.
    const hanging = build({ geo: new Promise(() => undefined) });
    await expect(
      hanging.issuer.issue('u1', request(), hanging.res as never, {
        via: 'password',
      }),
    ).resolves.toMatchObject({ kind: 'session' });
  });

  it('an unknown user: 401 and nothing minted', async () => {
    const b = build({ user: undefined });
    await expect(
      b.issuer.issue('u1', request(), b.res as never, { via: 'password' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(b.res.cookie).not.toHaveBeenCalled();
    expect(b.sessions.create).not.toHaveBeenCalled();
  });

  it('a missing signing secret fails before any row, cookie or device', async () => {
    const b = build({
      secrets: { JWT_ACCESS_SECRET: 'access-secret' },
    });
    await expect(
      b.issuer.issue('u1', request(), b.res as never, { via: 'password' }),
    ).rejects.toThrow('JWT_REFRESH_SECRET');
    expect(b.sessions.create).not.toHaveBeenCalled();
    expect(b.res.cookie).not.toHaveBeenCalled();
    expect(b.knownDevices.track).not.toHaveBeenCalled();
  });
});

describe('SessionIssuer two-step branch (Task 10)', () => {
  const TOTP_USER = { ...USER, totpEnabledAt: new Date('2026-11-01') };
  const ADMIN = { ...TOTP_USER, role: 'SUPER_ADMIN' };
  const sha = (v: string) => createHash('sha256').update(v).digest('hex');

  /** The invariant of every "mints nothing" path. */
  function expectNothingMinted(b: ReturnType<typeof build>, result: unknown) {
    expect(result).toEqual({ kind: 'mfa', challengeToken: 'challenge-token' });
    expect(
      (b.res.cookie.mock.calls as unknown[][]).some(
        (c) => c[0] === 'refreshToken',
      ),
    ).toBe(false);
    expect(b.sessions.create).not.toHaveBeenCalled();
    expect(b.knownDevices.track).not.toHaveBeenCalled();
    expect(b.loginActivity.record).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('accessToken');
  }

  it('password: 2FA user on an untrusted device → mfaRequired, no row, no cookie, no track, no record', async () => {
    const b = build({ user: TOTP_USER, trusted: false });
    const result = await b.issuer.issue(
      'u1',
      request({ cookies: { sd_device: DEVICE } }),
      b.res as never,
      { via: 'password' },
    );
    expectNothingMinted(b, result);
    // The challenge is bound to this browser, and its cookie is (re)set so
    // /auth/2fa/verify sees the same device.
    expect(b.challenges.create).toHaveBeenCalledWith('u1', sha(DEVICE));
    expect(deviceCookie(b.res)).toBe(DEVICE);
    expect(b.knownDevices.isMfaTrusted).toHaveBeenCalledWith('u1', DEVICE);
  });

  it('password: 2FA user on a trusted device → session', async () => {
    const b = build({ user: TOTP_USER, trusted: true });
    const result = await b.issuer.issue(
      'u1',
      request({ cookies: { sd_device: DEVICE } }),
      b.res as never,
      { via: 'password' },
    );
    expect(result.kind).toBe('session');
    expect(b.challenges.create).not.toHaveBeenCalled();
    expect(b.sessions.create).toHaveBeenCalledTimes(1);
  });

  it('password: no sd_device cookie → never trusted (a minted id is not looked up)', async () => {
    const b = build({ user: TOTP_USER, trusted: true });
    const result = await b.issuer.issue('u1', request(), b.res as never, {
      via: 'password',
    });
    expectNothingMinted(b, result);
    expect(b.knownDevices.isMfaTrusted).not.toHaveBeenCalled();
    // A fresh device cookie is minted and the challenge bound to it.
    const minted = deviceCookie(b.res) as string;
    expect(minted).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b.challenges.create).toHaveBeenCalledWith('u1', sha(minted));
  });

  it('admin: SUPER_ADMIN with a trusted device is still challenged (B5)', async () => {
    const b = build({ user: ADMIN, trusted: true });
    const result = await b.issuer.issue(
      'u1',
      request({ cookies: { sd_device: DEVICE } }),
      b.res as never,
      { via: 'admin' },
    );
    expectNothingMinted(b, result);
    expect(b.knownDevices.isMfaTrusted).not.toHaveBeenCalled();
  });

  it('password: a SUPER_ADMIN on a trusted device is still challenged - the ROLE decides, not the via (B5)', async () => {
    // Super admins sign in through via 'password' until the admin path is
    // split out, so a check keyed on via === 'admin' would let a trusted
    // super admin skip TOTP here.
    const b = build({ user: ADMIN, trusted: true });
    const result = await b.issuer.issue(
      'u1',
      request({ cookies: { sd_device: DEVICE } }),
      b.res as never,
      { via: 'password' },
    );
    expectNothingMinted(b, result);
    expect(b.knownDevices.isMfaTrusted).not.toHaveBeenCalled();
  });

  it('register: a user row with totpEnabledAt (impossible today) is still challenged', async () => {
    const b = build({ user: TOTP_USER, trusted: true });
    const result = await b.issuer.issue(
      'u1',
      request({ cookies: { sd_device: DEVICE } }),
      b.res as never,
      { via: 'register' },
    );
    expectNothingMinted(b, result);
  });

  it('google: 2FA user → mfaRequired', async () => {
    const b = build({ user: TOTP_USER });
    const result = await b.issuer.issue('u1', request(), b.res as never, {
      via: 'google',
      silentDevice: false,
    });
    expectNothingMinted(b, result);
  });

  it('a user without 2FA is never challenged and trust is never read', async () => {
    const b = build({ user: USER });
    const result = await b.issuer.issue(
      'u1',
      request({ cookies: { sd_device: DEVICE } }),
      b.res as never,
      { via: 'password' },
    );
    expect(result.kind).toBe('session');
    expect(b.knownDevices.isMfaTrusted).not.toHaveBeenCalled();
    expect(b.challenges.create).not.toHaveBeenCalled();
  });

  it('two_factor with a matching device hash marks trust and does not call track', async () => {
    const b = build({ user: TOTP_USER });
    const result = await b.issuer.issue(
      'u1',
      request({ cookies: { sd_device: DEVICE } }),
      b.res as never,
      { via: 'two_factor', trustDeviceHash: sha(DEVICE) },
    );
    expect(result.kind).toBe('session');
    expect(b.sessions.create).toHaveBeenCalledTimes(1);
    expect(b.knownDevices.markMfaTrusted).toHaveBeenCalledWith('u1', DEVICE, {
      ip: '203.0.113.7',
      userAgent: UA,
    });
    expect(b.knownDevices.track).not.toHaveBeenCalled();
    expect(b.loginActivity.record).toHaveBeenCalledWith('u1', '203.0.113.7');
  });

  it('two_factor for a SUPER_ADMIN writes no trust (it is never honoured, and would outlive a demotion): the sighting goes through track', async () => {
    const b = build({ user: { ...TOTP_USER, role: 'SUPER_ADMIN' } });
    const result = await b.issuer.issue(
      'u1',
      request({ cookies: { sd_device: DEVICE } }),
      b.res as never,
      { via: 'two_factor', trustDeviceHash: sha(DEVICE) },
    );
    expect(result.kind).toBe('session');
    expect(b.knownDevices.markMfaTrusted).not.toHaveBeenCalled();
    expect(b.knownDevices.track).toHaveBeenCalledWith(
      'u1',
      DEVICE,
      expect.any(Object),
      { silent: false },
    );
  });

  it.each([
    [
      'suspended',
      { isActive: false, suspendedReason: 'abuse' },
      { code: 'ACCOUNT_SUSPENDED', reason: 'abuse' },
    ],
    [
      'deleted',
      { isActive: false, deletedAt: new Date() },
      { code: 'ACCOUNT_DELETED' },
    ],
  ])(
    'two_factor for an account %s since the challenge: 401, nothing minted',
    async (_label, over, response) => {
      const b = build({ user: { ...TOTP_USER, ...over } });
      await expect(
        b.issuer.issue(
          'u1',
          request({ cookies: { sd_device: DEVICE } }),
          b.res as never,
          { via: 'two_factor', trustDeviceHash: sha(DEVICE) },
        ),
      ).rejects.toMatchObject({ status: 401, response });
      expect(b.sessions.create).not.toHaveBeenCalled();
      expect(b.res.cookie).not.toHaveBeenCalled();
      expect(b.knownDevices.markMfaTrusted).not.toHaveBeenCalled();
    },
  );

  it('two_factor: issue does not answer until the trust write has finished (R9)', async () => {
    const b = build({ user: TOTP_USER });
    let finishTrust!: () => void;
    b.knownDevices.markMfaTrusted.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishTrust = resolve;
        }),
    );
    let answered = false;
    const pending = b.issuer
      .issue(
        'u1',
        request({ cookies: { sd_device: DEVICE } }),
        b.res as never,
        {
          via: 'two_factor',
          trustDeviceHash: sha(DEVICE),
        },
      )
      .then((r) => {
        answered = true;
        return r;
      });
    // Let every other step run; only the trust write is still open.
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(b.knownDevices.markMfaTrusted).toHaveBeenCalledTimes(1);
    expect(answered).toBe(false);
    finishTrust();
    await expect(pending).resolves.toMatchObject({ kind: 'session' });
    expect(answered).toBe(true);
  });

  it('two_factor with another device (cookie swapped since the challenge) tracks, no trust', async () => {
    const b = build({ user: TOTP_USER });
    await b.issuer.issue(
      'u1',
      request({ cookies: { sd_device: DEVICE } }),
      b.res as never,
      { via: 'two_factor', trustDeviceHash: sha('w'.repeat(43)) },
    );
    expect(b.knownDevices.markMfaTrusted).not.toHaveBeenCalled();
    expect(b.knownDevices.track).toHaveBeenCalledTimes(1);
  });

  it('refresh: 2FA user with a live sid is not re-challenged (same sid back)', async () => {
    const b = build({ user: TOTP_USER });
    const result = await b.issuer.issue('u1', request(), b.res as never, {
      via: 'refresh',
      sid: SID,
    });
    expect(result).toMatchObject({ kind: 'session', sid: SID });
    expect(b.challenges.create).not.toHaveBeenCalled();
  });

  it('refresh: revoked sid → 401, no cookie', async () => {
    const b = build({ user: TOTP_USER, touch: false });
    await expect(
      b.issuer.issue('u1', request(), b.res as never, {
        via: 'refresh',
        sid: SID,
      }),
    ).rejects.toMatchObject({ response: { code: 'SESSION_ENDED' } });
    expect(b.res.cookie).not.toHaveBeenCalled();
  });

  it.each(['refresh', 'password_change', 'two_factor_enable'] as const)(
    '%s: a sid-less token for a user with 2FA on → 401, no cookie, no row',
    async (via) => {
      // A legacy token predates 2FA; refuse rather than mint around it.
      const b = build({ user: TOTP_USER });
      await expect(
        b.issuer.issue('u1', request(), b.res as never, { via, sid: null }),
      ).rejects.toMatchObject({ response: { code: 'SESSION_ENDED' } });
      expect(b.res.cookie).not.toHaveBeenCalled();
      expect(b.sessions.create).not.toHaveBeenCalled();
    },
  );

  it('password_change: 2FA user keeps the same sid (not re-challenged)', async () => {
    const b = build({ user: TOTP_USER });
    const result = await b.issuer.issue('u1', request(), b.res as never, {
      via: 'password_change',
      sid: SID,
    });
    expect(result).toMatchObject({ kind: 'session', sid: SID });
    expect(b.challenges.create).not.toHaveBeenCalled();
  });
});
