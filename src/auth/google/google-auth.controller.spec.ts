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
  const controller = new GoogleAuthController(google as never, auth as never);
  return { controller, google, auth, res };
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
  });
});
