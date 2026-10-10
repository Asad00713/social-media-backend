import {
  buildDoneUrl,
  decideGoogleSignIn,
  type GoogleCandidate,
} from './google-sign-in.decision';

const claims = {
  sub: 'g-1',
  email: 'sara@gmail.com',
  emailVerified: true,
  name: 'Sara',
};
const user = (over: Partial<GoogleCandidate> = {}): GoogleCandidate => ({
  id: 'u1',
  email: 'sara@gmail.com',
  role: 'USER',
  isActive: true,
  googleSub: null,
  ...over,
});

describe('decideGoogleSignIn', () => {
  it('creates an account for an unknown verified email', () => {
    expect(decideGoogleSignIn({ claims, bySub: null, byEmail: null })).toEqual({
      kind: 'create',
    });
  });

  it('refuses an unverified Google email before looking at accounts', () => {
    expect(
      decideGoogleSignIn({
        claims: { ...claims, emailVerified: false },
        bySub: user(),
        byEmail: null,
      }),
    ).toEqual({ kind: 'refuse', code: 'EMAIL_UNVERIFIED' });
  });

  it('signs in by sub without relinking', () => {
    const u = user({ googleSub: 'g-1' });
    expect(decideGoogleSignIn({ claims, bySub: u, byEmail: null })).toEqual({
      kind: 'existing',
      user: u,
      linkSub: false,
    });
  });

  it('prefers the sub match when the email now points elsewhere', () => {
    const bySub = user({ id: 'u1', googleSub: 'g-1' });
    const byEmail = user({ id: 'u2' });
    expect(decideGoogleSignIn({ claims, bySub, byEmail })).toMatchObject({
      user: bySub,
    });
  });

  it('links a password account with the same email (Review Focus 3)', () => {
    const u = user();
    expect(decideGoogleSignIn({ claims, bySub: null, byEmail: u })).toEqual({
      kind: 'existing',
      user: u,
      linkSub: true,
    });
  });

  it('refuses when that email is already linked to another Google account', () => {
    expect(
      decideGoogleSignIn({
        claims,
        bySub: null,
        byEmail: user({ googleSub: 'g-OTHER' }),
      }),
    ).toEqual({ kind: 'refuse', code: 'GOOGLE_ACCOUNT_MISMATCH' });
  });

  it('refuses a suspended account', () => {
    expect(
      decideGoogleSignIn({
        claims,
        bySub: user({ isActive: false }),
        byEmail: null,
      }),
    ).toEqual({
      kind: 'refuse',
      code: 'ACCOUNT_SUSPENDED',
    });
  });

  it.each(['SUPER_ADMIN', 'ADMIN'])(
    'refuses a %s — admins keep their second factor',
    (role) => {
      expect(
        decideGoogleSignIn({ claims, bySub: null, byEmail: user({ role }) }),
      ).toEqual({
        kind: 'refuse',
        code: 'ADMIN_ACCOUNT',
      });
    },
  );
});

describe('buildDoneUrl', () => {
  it('builds the success URL without a code', () => {
    expect(
      buildDoneUrl('https://app.schedura.com', {
        status: 'success',
        mode: 'popup',
      }),
    ).toBe(
      'https://app.schedura.com/auth/google/done?status=success&mode=popup',
    );
  });

  it('includes the code and tolerates a trailing slash', () => {
    expect(
      buildDoneUrl('https://app.schedura.com/', {
        status: 'error',
        code: 'ADMIN_ACCOUNT',
        mode: 'redirect',
      }),
    ).toBe(
      'https://app.schedura.com/auth/google/done?status=error&code=ADMIN_ACCOUNT&mode=redirect',
    );
  });
});
