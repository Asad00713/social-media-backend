import { GoogleIdTokenError, readIdTokenClaims } from './google-claims';

const CLIENT = 'client-123.apps.googleusercontent.com';
const NOW = 1_800_000_000;

function token(payload: Record<string, unknown>) {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.sig`;
}

const good = {
  iss: 'https://accounts.google.com',
  aud: CLIENT,
  exp: NOW + 600,
  sub: '1078',
  email: 'Sara@Gmail.com',
  email_verified: true,
  name: 'Sara Khan',
};

describe('readIdTokenClaims', () => {
  it('reads sub, email, verification and name', () => {
    expect(readIdTokenClaims(token(good), CLIENT, NOW)).toEqual({
      sub: '1078',
      email: 'Sara@Gmail.com',
      emailVerified: true,
      name: 'Sara Khan',
    });
  });

  it('accepts the bare issuer form Google also uses', () => {
    expect(() =>
      readIdTokenClaims(
        token({ ...good, iss: 'accounts.google.com' }),
        CLIENT,
        NOW,
      ),
    ).not.toThrow();
  });

  it.each([
    ['a foreign issuer', { iss: 'https://evil.example' }],
    ['another audience', { aud: 'someone-else' }],
    ['an expired token', { exp: NOW - 1 }],
    ['no sub', { sub: undefined }],
    ['no email', { email: undefined }],
  ])('rejects %s', (_l, over) => {
    expect(() =>
      readIdTokenClaims(token({ ...good, ...over }), CLIENT, NOW),
    ).toThrow(GoogleIdTokenError);
  });

  it('treats a missing email_verified as unverified', () => {
    expect(
      readIdTokenClaims(
        token({ ...good, email_verified: undefined }),
        CLIENT,
        NOW,
      ).emailVerified,
    ).toBe(false);
  });

  it('rejects a malformed token', () => {
    expect(() => readIdTokenClaims('not-a-jwt', CLIENT, NOW)).toThrow(
      GoogleIdTokenError,
    );
  });
});
