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
      { via: 'refresh', sid: null },
    );
    expect(b.sessions.touch).not.toHaveBeenCalled();
    expect(b.sessions.create).toHaveBeenCalledTimes(1);
    expect(result.sid).toBe(NEW_SID);
    expect(b.knownDevices.track).toHaveBeenCalledWith(
      'u1',
      DEVICE,
      expect.any(Object),
      { silent: true },
    );
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
