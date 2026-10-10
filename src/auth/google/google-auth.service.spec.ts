import { JwtService } from '@nestjs/jwt';
import { GoogleAuthService } from './google-auth.service';

const FRONTEND = 'https://app.schedura.com';
const SECRET = 'state-secret';
const config = {
  get: (k: string) =>
    ({
      FRONTEND_URL: FRONTEND,
      GOOGLE_AUTH_STATE_SECRET: SECRET,
      GOOGLE_AUTH_CLIENT_ID: 'cid',
      GOOGLE_AUTH_CLIENT_SECRET: 'csecret',
      GOOGLE_AUTH_REDIRECT_URI: 'https://api.schedura.com/auth/google/callback',
    })[k],
};

const claims = {
  sub: 'g-1',
  email: 'Sara@Gmail.com',
  emailVerified: true,
  name: 'Sara',
};

function build(
  over: {
    configured?: boolean;
    noSecrets?: boolean;
    users?: Record<string, jest.Mock>;
  } = {},
) {
  const jwt = new JwtService({});
  const client = {
    isConfigured: jest.fn().mockReturnValue(over.configured ?? true),
    buildAuthUrl: jest
      .fn()
      .mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?x=1'),
    exchangeForClaims: jest.fn().mockResolvedValue(claims),
  };
  const users = {
    findByGoogleSub: jest.fn().mockResolvedValue(undefined),
    findByEmail: jest.fn().mockResolvedValue(undefined),
    createFromGoogle: jest
      .fn()
      .mockResolvedValue({ id: 'new', email: 'sara@gmail.com' }),
    applyGoogleSignIn: jest.fn(),
    ...over.users,
  };
  const loginActivity = { record: jest.fn(), recordSync: jest.fn() };
  const service = new GoogleAuthService(
    client as never,
    jwt,
    (over.noSecrets
      ? { get: (k: string) => (k === 'FRONTEND_URL' ? FRONTEND : undefined) }
      : config) as never,
    users as never,
    loginActivity as never,
  );
  return { service, client, users, loginActivity, jwt };
}

/** A real state cookie from start(), plus the state Google would echo back. */
function begin(
  b: ReturnType<typeof build>,
  mode: 'popup' | 'redirect' = 'popup',
) {
  const { stateCookie } = b.service.start(mode);
  const state = b.client.buildAuthUrl.mock.calls[0][0] as string;
  return { stateCookie: stateCookie!, state };
}

describe('GoogleAuthService.start', () => {
  it('signs a state cookie and sends the user to Google', () => {
    const b = build();
    const { redirectUrl, stateCookie } = b.service.start('popup');
    expect(redirectUrl).toContain('accounts.google.com');
    expect(stateCookie).toEqual(expect.any(String));
  });

  it('lands on the done page with GOOGLE_NOT_CONFIGURED when env is missing', () => {
    const b = build({ configured: false });
    expect(b.service.start('redirect')).toEqual({
      redirectUrl: `${FRONTEND}/auth/google/done?status=error&code=GOOGLE_NOT_CONFIGURED&mode=redirect`,
      stateCookie: null,
    });
  });
});

describe('GoogleAuthService.start without secrets', () => {
  it('lands on the done page with GOOGLE_NOT_CONFIGURED instead of throwing', () => {
    const b = build({ noSecrets: true });
    expect(b.service.start('popup')).toEqual({
      redirectUrl: `${FRONTEND}/auth/google/done?status=error&code=GOOGLE_NOT_CONFIGURED&mode=popup`,
      stateCookie: null,
    });
  });
});

describe('GoogleAuthService.callback', () => {
  it('rejects a missing state cookie with STATE_INVALID (Review Focus 4)', async () => {
    const b = build();
    const r = await b.service.callback({ code: 'c', state: 's' }, undefined);
    expect(r).toEqual({
      redirectUrl: `${FRONTEND}/auth/google/done?status=error&code=STATE_INVALID&mode=redirect`,
      session: null,
      mode: 'redirect',
    });
  });

  it('rejects a state that does not match the cookie', async () => {
    const b = build();
    const { stateCookie } = begin(b);
    const r = await b.service.callback(
      { code: 'c', state: 'forged' },
      stateCookie,
    );
    expect(r.redirectUrl).toContain('code=STATE_INVALID');
    expect(r.session).toBeNull();
  });

  it('reports a user who cancelled at Google as cancelled, in the original mode', async () => {
    const b = build();
    const { stateCookie, state } = begin(b, 'popup');
    const r = await b.service.callback(
      { state, error: 'access_denied' },
      stateCookie,
    );
    expect(r.redirectUrl).toBe(
      `${FRONTEND}/auth/google/done?status=cancelled&mode=popup`,
    );
  });

  it('reports a failed exchange as GOOGLE_ERROR', async () => {
    const b = build();
    b.client.exchangeForClaims.mockRejectedValue(new Error('boom'));
    const { stateCookie, state } = begin(b);
    const r = await b.service.callback({ code: 'c', state }, stateCookie);
    expect(r.redirectUrl).toContain('code=GOOGLE_ERROR');
  });

  it('creates a new account with the normalised email and returns a session', async () => {
    const b = build();
    const { stateCookie, state } = begin(b);
    const r = await b.service.callback(
      { code: 'c', state },
      stateCookie,
      '1.2.3.4',
    );

    expect(b.users.createFromGoogle).toHaveBeenCalledWith({
      email: 'sara@gmail.com',
      name: 'Sara',
      googleSub: 'g-1',
    });
    expect(b.loginActivity.recordSync).toHaveBeenCalledWith('new', '1.2.3.4');
    expect(r).toEqual({
      redirectUrl: `${FRONTEND}/auth/google/done?status=success&mode=popup`,
      session: { userId: 'new', email: 'sara@gmail.com' },
      mode: 'popup',
    });
  });

  it('links an existing password account and keeps its stored email (Review Focus 3)', async () => {
    const existing = {
      id: 'u1',
      email: 'Sara@Gmail.com',
      role: 'USER',
      isActive: true,
      googleSub: null,
      isEmailVerified: true,
    };
    const b = build({
      users: { findByEmail: jest.fn().mockResolvedValue(existing) },
    });
    const { stateCookie, state } = begin(b);
    const r = await b.service.callback({ code: 'c', state }, stateCookie);

    expect(b.users.createFromGoogle).not.toHaveBeenCalled();
    expect(b.users.applyGoogleSignIn).toHaveBeenCalledWith('u1', {
      googleSub: 'g-1',
      name: 'Sara',
      clearPassword: false,
    });
    expect(b.loginActivity.record).toHaveBeenCalledWith('u1', undefined);
    expect(r.session).toEqual({ userId: 'u1', email: 'Sara@Gmail.com' });
  });

  it('refuses an admin without touching the account', async () => {
    const admin = {
      id: 'a1',
      email: 'sara@gmail.com',
      role: 'SUPER_ADMIN',
      isActive: true,
      googleSub: null,
      isEmailVerified: true,
    };
    const b = build({
      users: { findByEmail: jest.fn().mockResolvedValue(admin) },
    });
    const { stateCookie, state } = begin(b);
    const r = await b.service.callback({ code: 'c', state }, stateCookie);

    expect(r).toEqual({
      redirectUrl: `${FRONTEND}/auth/google/done?status=error&code=ADMIN_ACCOUNT&mode=popup`,
      session: null,
      mode: 'popup',
    });
    expect(b.users.applyGoogleSignIn).not.toHaveBeenCalled();
  });

  it('turns a database failure after the exchange into GOOGLE_ERROR', async () => {
    const b = build({
      users: { findByEmail: jest.fn().mockRejectedValue(new Error('db down')) },
    });
    const { stateCookie, state } = begin(b);
    const r = await b.service.callback({ code: 'c', state }, stateCookie);
    expect(r.redirectUrl).toContain('code=GOOGLE_ERROR');
    expect(r.session).toBeNull();
  });

  it('refuses a suspended existing user', async () => {
    const suspended = {
      id: 'u2',
      email: 'sara@gmail.com',
      role: 'USER',
      isActive: false,
      googleSub: null,
      isEmailVerified: true,
    };
    const b = build({
      users: { findByEmail: jest.fn().mockResolvedValue(suspended) },
    });
    const { stateCookie, state } = begin(b);
    const r = await b.service.callback({ code: 'c', state }, stateCookie);
    expect(r.redirectUrl).toContain('code=ACCOUNT_SUSPENDED');
    expect(r.session).toBeNull();
    expect(b.users.applyGoogleSignIn).not.toHaveBeenCalled();
  });

  it('drops the password when linking an UNVERIFIED row (pre-hijack)', async () => {
    const unverified = {
      id: 'u3',
      email: 'sara@gmail.com',
      role: 'USER',
      isActive: true,
      googleSub: null,
      isEmailVerified: false,
    };
    const b = build({
      users: { findByEmail: jest.fn().mockResolvedValue(unverified) },
    });
    const { stateCookie, state } = begin(b);
    await b.service.callback({ code: 'c', state }, stateCookie, '9.9.9.9');
    expect(b.users.applyGoogleSignIn).toHaveBeenCalledWith('u3', {
      googleSub: 'g-1',
      name: 'Sara',
      clearPassword: true,
    });
    expect(b.loginActivity.record).toHaveBeenCalledWith('u3', '9.9.9.9');
  });
});
