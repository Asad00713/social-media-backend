import { UnauthorizedException } from '@nestjs/common';
import { AuthController } from './auth.controller';

const VALID = 'v'.repeat(43);
const UA = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0.0.0 Safari/537.36';
const USER = { id: 'u1', email: 'a@b.co' };
const ID_RE = /^[A-Za-z0-9_-]{43}$/;

function build(over: { refreshError?: Error; loginError?: Error } = {}) {
  const authService = {
    login: over.loginError
      ? jest.fn().mockRejectedValue(over.loginError)
      : jest.fn().mockResolvedValue({ accessToken: 'access', user: USER }),
    register: jest
      .fn()
      .mockResolvedValue({ accessToken: 'access', user: USER, message: 'ok' }),
    generateRefreshToken: over.refreshError
      ? jest.fn().mockRejectedValue(over.refreshError)
      : jest.fn().mockResolvedValue('refresh'),
  };
  const knownDevices = { track: jest.fn() };
  const res = { cookie: jest.fn() };
  const controller = new AuthController(
    authService as never,
    {} as never,
    knownDevices as never,
  );
  return { controller, authService, knownDevices, res };
}

const req = (cookies: Record<string, unknown>) => ({ cookies }) as never;
const credentials = { email: 'a@b.co', password: 'pw' };

/** The value `sd_device` was set to, if it was set. */
function deviceCookieSet(res: { cookie: jest.Mock }): unknown {
  const call = (res.cookie.mock.calls as unknown[][]).find(
    (c) => c[0] === 'sd_device',
  );
  return call?.[1];
}

describe('AuthController.login device tracking (A6)', () => {
  it('keeps a valid device cookie, sets it again and tracks it after the session', async () => {
    const b = build();
    await b.controller.login(
      credentials,
      '1.2.3.4',
      req({ sd_device: VALID }),
      UA,
      b.res as never,
    );
    expect(b.authService.login).toHaveBeenCalledWith(credentials, '1.2.3.4');
    expect(deviceCookieSet(b.res)).toBe(VALID);
    expect(b.knownDevices.track).toHaveBeenCalledWith('u1', VALID, {
      ip: '1.2.3.4',
      userAgent: UA,
    });
    // The refresh cookie is set first: the session exists before tracking.
    expect((b.res.cookie.mock.calls as unknown[][])[0][0]).toBe('refreshToken');
  });

  it.each([
    ['a JSON-decoded array (j: cookie)', [VALID]],
    ['a JSON-decoded object', {}],
    ['a number', 7],
  ])(
    'a non-string cookie (%s) gets a fresh id, so A6 still runs',
    async (_name, cookie) => {
      const b = build();
      await b.controller.login(
        credentials,
        '1.2.3.4',
        req({ sd_device: cookie }),
        UA,
        b.res as never,
      );
      const set = deviceCookieSet(b.res);
      expect(typeof set).toBe('string');
      expect(set).toMatch(ID_RE);
      expect(set).not.toBe(VALID);
      expect(b.knownDevices.track).toHaveBeenCalledWith('u1', set, {
        ip: '1.2.3.4',
        userAgent: UA,
      });
    },
  );

  it('a failed sign-in records no device and sets no cookie', async () => {
    const b = build({ loginError: new UnauthorizedException() });
    await expect(
      b.controller.login(credentials, 'ip', req({}), UA, b.res as never),
    ).rejects.toThrow(UnauthorizedException);
    expect(b.knownDevices.track).not.toHaveBeenCalled();
    expect(b.res.cookie).not.toHaveBeenCalled();
  });

  it('a failed refresh-token mint records no device and sends no A6', async () => {
    const b = build({ refreshError: new Error('JWT_REFRESH_SECRET missing') });
    await expect(
      b.controller.login(credentials, 'ip', req({}), UA, b.res as never),
    ).rejects.toThrow('JWT_REFRESH_SECRET missing');
    expect(b.knownDevices.track).not.toHaveBeenCalled();
    expect(deviceCookieSet(b.res)).toBeUndefined();
  });
});

describe('AuthController.register device tracking', () => {
  it('records the signup browser silently after the session', async () => {
    const b = build();
    await b.controller.register(
      { email: 'a@b.co', password: 'Passw0rd!', name: 'A' } as never,
      '1.2.3.4',
      req({}),
      undefined,
      b.res as never,
    );
    const set = deviceCookieSet(b.res);
    expect(set).toMatch(ID_RE);
    expect(b.knownDevices.track).toHaveBeenCalledWith(
      'u1',
      set,
      { ip: '1.2.3.4', userAgent: null },
      { silent: true },
    );
  });

  it('a failed refresh-token mint records no device', async () => {
    const b = build({ refreshError: new Error('boom') });
    await expect(
      b.controller.register({} as never, 'ip', req({}), UA, b.res as never),
    ).rejects.toThrow('boom');
    expect(b.knownDevices.track).not.toHaveBeenCalled();
  });
});
