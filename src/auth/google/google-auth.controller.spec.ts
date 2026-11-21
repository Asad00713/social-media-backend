import { GoogleAuthController } from './google-auth.controller';

const FAIL_URL =
  'https://app/auth/google/done?status=error&code=GOOGLE_ERROR&mode=popup';

function build(callbackResult?: unknown, issueError?: Error) {
  const google = {
    start: jest.fn(),
    callback: jest.fn().mockResolvedValue(callbackResult),
    failureUrl: jest.fn().mockReturnValue(FAIL_URL),
    twoStepUrl: jest.fn(),
    recordSignIn: jest.fn().mockResolvedValue(undefined),
  };
  const issuer = {
    issue: issueError
      ? jest.fn().mockRejectedValue(issueError)
      : jest.fn().mockResolvedValue({
          kind: 'session',
          accessToken: 'access',
          sid: 's1',
        }),
  };
  const res = {
    cookie: jest.fn(),
    clearCookie: jest.fn(),
    redirect: jest.fn(),
  };
  const controller = new GoogleAuthController(google as never, issuer as never);
  return { controller, google, issuer, res };
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
  const req = {
    cookies: { g_auth: 'state-cookie' },
    headers: { 'x-real-ip': '1.1.1.1' },
    ip: '10.0.0.1',
  };

  it('always clears the state cookie and mints nothing on failure', async () => {
    const b = build({
      redirectUrl: 'https://done',
      session: null,
      mode: 'popup',
    });
    await b.controller.callback({}, req as never, b.res as never);
    expect(b.res.clearCookie).toHaveBeenCalledWith(
      'g_auth',
      expect.any(Object),
    );
    expect(b.google.callback).toHaveBeenCalledWith(
      {},
      'state-cookie',
      '1.1.1.1',
    );
    expect(b.issuer.issue).not.toHaveBeenCalled();
    expect(b.res.cookie).not.toHaveBeenCalled();
    expect(b.res.redirect).toHaveBeenCalledWith(302, 'https://done');
  });

  it.each([
    ['an existing account: A6 when the device is new', false],
    ['a new account: recorded silently', true],
  ])(
    'a session is minted by the issuer with via google (%s)',
    async (_name, isNewAccount) => {
      const b = build({
        redirectUrl: 'https://ok',
        session: { userId: 'u1', email: 'a@b.c', isNewAccount },
        mode: 'popup',
      });
      await b.controller.callback({}, req as never, b.res as never);
      expect(b.issuer.issue).toHaveBeenCalledWith('u1', req, b.res, {
        via: 'google',
        silentDevice: isNewAccount,
      });
      expect(b.res.redirect).toHaveBeenCalledWith(302, 'https://ok');
      // Last sign-in only after a session, and not again for a new account.
      if (isNewAccount) expect(b.google.recordSignIn).not.toHaveBeenCalled();
      else expect(b.google.recordSignIn).toHaveBeenCalledWith('u1', '1.1.1.1');
    },
  );

  it('redirects to the failure url when the issuer fails', async () => {
    const b = build(
      {
        redirectUrl: 'https://ok',
        session: { userId: 'u1', email: 'a@b.c', isNewAccount: false },
        mode: 'popup',
      },
      new Error('jwt down'),
    );
    await b.controller.callback({}, req as never, b.res as never);
    expect(b.google.failureUrl).toHaveBeenCalledWith('popup');
    expect(b.res.redirect).toHaveBeenCalledWith(302, FAIL_URL);
    expect(b.res.redirect).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['redirect', 'https://app/auth/two-step?challenge=c'],
    [
      'popup',
      'https://app/auth/google/done?status=mfa_required&challenge=c&mode=popup',
    ],
  ] as const)(
    'callback %s mode, 2FA user -> 302 to the two-step URL, no refreshToken cookie',
    async (mode, url) => {
      const b = build({
        redirectUrl: 'https://ok',
        session: { userId: 'u1', email: 'a@b.c', isNewAccount: false },
        mode,
      });
      b.issuer.issue.mockResolvedValue({ kind: 'mfa', challengeToken: 'c' });
      b.google.twoStepUrl.mockReturnValue(url);
      await b.controller.callback({}, req as never, b.res as never);
      expect(b.google.twoStepUrl).toHaveBeenCalledWith(mode, 'c');
      expect(b.res.redirect).toHaveBeenCalledWith(302, url);
      expect(b.res.redirect).toHaveBeenCalledTimes(1);
      expect(
        (b.res.cookie.mock.calls as unknown[][]).some(
          (c) => c[0] === 'refreshToken',
        ),
      ).toBe(false);
      // First factor only: last sign-in / IP / region do not move (ruling 7).
      expect(b.google.recordSignIn).not.toHaveBeenCalled();
    },
  );

  it('a failed mint records no sign-in', async () => {
    const b = build(
      {
        redirectUrl: 'https://ok',
        session: { userId: 'u1', email: 'a@b.c', isNewAccount: false },
        mode: 'popup',
      },
      new Error('jwt down'),
    );
    await b.controller.callback({}, req as never, b.res as never);
    expect(b.google.recordSignIn).not.toHaveBeenCalled();
  });
});
