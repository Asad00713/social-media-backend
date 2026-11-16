import { GoogleAuthController } from './google-auth.controller';

const FAIL_URL =
  'https://app/auth/google/done?status=error&code=GOOGLE_ERROR&mode=popup';

function build(callbackResult?: unknown, tokenError?: Error) {
  const google = {
    start: jest.fn(),
    callback: jest.fn().mockResolvedValue(callbackResult),
    failureUrl: jest.fn().mockReturnValue(FAIL_URL),
  };
  const auth = {
    generateRefreshToken: tokenError
      ? jest.fn().mockRejectedValue(tokenError)
      : jest.fn().mockResolvedValue('refresh-token'),
  };
  const res = {
    cookie: jest.fn(),
    clearCookie: jest.fn(),
    redirect: jest.fn(),
  };
  const knownDevices = { track: jest.fn() };
  const controller = new GoogleAuthController(
    google as never,
    auth as never,
    knownDevices as never,
  );
  return { controller, google, auth, res, knownDevices };
}

describe('GoogleAuthController.start', () => {
  it('sets the state cookie hardened for a top-level GET return', () => {
    const b = build();
    b.google.start.mockReturnValue({
      redirectUrl: 'https://g',
      stateCookie: 'c',
    });
    b.controller.start('redirect', b.res as never);
    expect(b.google.start).toHaveBeenCalledWith('redirect');
    expect(b.res.cookie).toHaveBeenCalledWith(
      'g_auth',
      'c',
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/auth/google',
      }),
    );
    expect(b.res.redirect).toHaveBeenCalledWith(302, 'https://g');
  });

  it('sets no cookie when there is no state, and defaults to popup', () => {
    const b = build();
    b.google.start.mockReturnValue({
      redirectUrl: 'https://done',
      stateCookie: null,
    });
    b.controller.start(undefined, b.res as never);
    expect(b.google.start).toHaveBeenCalledWith('popup');
    expect(b.res.cookie).not.toHaveBeenCalled();
  });
});

describe('GoogleAuthController.callback', () => {
  const req = { cookies: { g_auth: 'state-cookie' } };

  it('always clears the state cookie and sets no session cookie on failure', async () => {
    const b = build({
      redirectUrl: 'https://done',
      session: null,
      mode: 'popup',
    });
    await b.controller.callback({}, req as never, '1.1.1.1', b.res as never);
    expect(b.res.clearCookie).toHaveBeenCalledWith(
      'g_auth',
      expect.any(Object),
    );
    expect(b.google.callback).toHaveBeenCalledWith(
      {},
      'state-cookie',
      '1.1.1.1',
    );
    expect(b.res.cookie).not.toHaveBeenCalled();
    expect(b.knownDevices.track).not.toHaveBeenCalled();
    expect(b.res.redirect).toHaveBeenCalledWith(302, 'https://done');
  });

  it('sets the refresh cookie when there is a session', async () => {
    const b = build({
      redirectUrl: 'https://ok',
      session: { userId: 'u1', email: 'a@b.c' },
      mode: 'popup',
    });
    await b.controller.callback({}, req as never, 'ip', b.res as never);
    expect(b.auth.generateRefreshToken).toHaveBeenCalledWith('u1', 'a@b.c');
    expect(b.res.cookie).toHaveBeenCalledWith(
      'refreshToken',
      'refresh-token',
      expect.objectContaining({ httpOnly: true, secure: true }),
    );
    expect(b.res.redirect).toHaveBeenCalledWith(302, 'https://ok');
  });

  it.each([
    ['an existing account: A6 when the device is new', false],
    ['a new account: recorded silently', true],
  ])(
    'after the session, keeps a valid device cookie and tracks it (%s)',
    async (_name, isNewAccount) => {
      const id = 'k'.repeat(43);
      const b = build({
        redirectUrl: 'https://ok',
        session: { userId: 'u1', email: 'a@b.c', isNewAccount },
        mode: 'popup',
      });
      await b.controller.callback(
        {},
        { cookies: { g_auth: 'state-cookie', sd_device: id } } as never,
        '1.2.3.4',
        b.res as never,
        'Mozilla/5.0',
      );
      expect(b.res.cookie).toHaveBeenCalledWith(
        'sd_device',
        id,
        expect.objectContaining({
          httpOnly: true,
          secure: true,
          sameSite: 'none',
        }),
      );
      expect(b.knownDevices.track).toHaveBeenCalledWith(
        'u1',
        id,
        { ip: '1.2.3.4', userAgent: 'Mozilla/5.0' },
        { silent: isNewAccount },
      );
    },
  );

  it('a JSON-decoded device cookie gets a fresh string id', async () => {
    const b = build({
      redirectUrl: 'https://ok',
      session: { userId: 'u1', email: 'a@b.c', isNewAccount: false },
      mode: 'popup',
    });
    await b.controller.callback(
      {},
      {
        cookies: { g_auth: 'state-cookie', sd_device: ['k'.repeat(43)] },
      } as never,
      'ip',
      b.res as never,
    );
    const tracked = b.knownDevices.track.mock.calls[0] as unknown[];
    expect(typeof tracked[1]).toBe('string');
    expect(tracked[1]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tracked[1]).not.toBe('k'.repeat(43));
  });

  it('redirects to the failure url when minting the refresh token fails', async () => {
    const b = build(
      {
        redirectUrl: 'https://ok',
        session: { userId: 'u1', email: 'a@b.c' },
        mode: 'popup',
      },
      new Error('jwt down'),
    );
    await b.controller.callback({}, req as never, 'ip', b.res as never);
    expect(b.google.failureUrl).toHaveBeenCalledWith('popup');
    expect(b.res.redirect).toHaveBeenCalledWith(302, FAIL_URL);
    expect(b.res.cookie).not.toHaveBeenCalled();
    // No session, so no device row and no A6.
    expect(b.knownDevices.track).not.toHaveBeenCalled();
  });
});
