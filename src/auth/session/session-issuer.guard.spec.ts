import * as fs from 'fs';
import * as path from 'path';

/**
 * SessionIssuer is the only code that mints a session (spec §7.2, "One
 * session issuer"). Two-step sign-in is enforced there and nowhere else, so
 * any other file that signs a session JWT, sets the refresh cookie or
 * borrows a reissue `via` is a way around the second factor. Each check
 * below reads the source text, so a new path fails here before it ships.
 *
 * Modelled on billing/providers/provider-isolation.spec.ts.
 */

const SRC = path.join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts'))
      out.push(full);
  }
  return out;
}

/** `auth/session/session-issuer.ts`, forward slashes on every OS. */
const rel = (file: string): string =>
  path.relative(SRC, file).split(path.sep).join('/');

const ISSUER = 'auth/session/session-issuer.ts';

/**
 * Files that may sign a JWT with JWT_ACCESS_SECRET or JWT_REFRESH_SECRET in
 * their text. Every one except the issuer signs a NON-session token, which
 * JwtStrategy refuses (`assertSessionTokenShape`: no string `sub`, or a
 * `purpose` / `aud` claim).
 * The two-step challenge (`auth/two-factor/mfa-challenge.service.ts`, signed
 * with a key derived from JWT_ACCESS_SECRET) joins this list when it lands.
 */
const SIGNERS_ALLOWED: Record<string, string> = {
  [ISSUER]: 'the issuer',
  'auth/admin-challenge.service.ts':
    'super-admin emailed challenge (purpose: admin-login)',
  'auth/google/google-auth.service.ts': 'OAuth state cookie, no sub',
  'email/tokens/email-tokens.service.ts': 'audience-scoped, no sub',
  'insights/reports/report-tokens.service.ts': 'audience-scoped, no sub',
  'media/tiktok-media-proxy.service.ts': '{url} only, no sub',
};

/**
 * The vias that reuse a proven session and so can never be challenged (B6).
 * Each belongs to one caller; a second caller would be minting without the
 * second factor. "At most these files": the two-step owners arrive later.
 */
const REISSUE_OWNERS: Record<string, string> = {
  refresh: 'auth/auth.controller.ts',
  password_change: 'users/account-security.controller.ts',
  two_factor_enable: 'auth/two-factor/two-factor.service.ts',
  two_factor: 'auth/two-factor/two-factor-auth.controller.ts',
};

describe('SessionIssuer is the only session minter', () => {
  const files = walk(SRC);
  const read = (f: string) => fs.readFileSync(f, 'utf8');

  it('finds source files to check (the walker is not silently empty)', () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.map(rel)).toContain(ISSUER);
  });

  it('nothing outside the issuer names generateAccessToken / generateRefreshToken', () => {
    const offenders = files
      .filter((f) => rel(f) !== ISSUER)
      .filter((f) => /\bgenerate(Access|Refresh)Token\b/.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('only allow-listed files sign with JWT_ACCESS_SECRET or JWT_REFRESH_SECRET', () => {
    const offenders = files
      .filter((f) => {
        const text = read(f);
        return (
          /\.(sign|signAsync)\(/.test(text) &&
          /JWT_(ACCESS|REFRESH)_SECRET/.test(text)
        );
      })
      .map(rel)
      .filter((f) => !(f in SIGNERS_ALLOWED));
    expect(offenders).toEqual([]);
  });

  it('the issuer itself signs with both secrets (the check above is not vacuous)', () => {
    const text = read(path.join(SRC, ISSUER));
    expect(text).toMatch(/\.(sign|signAsync)\(/);
    expect(text).toMatch(/JWT_ACCESS_SECRET/);
    expect(text).toMatch(/JWT_REFRESH_SECRET/);
  });

  it('only refresh-cookie.ts sets the refreshToken cookie', () => {
    const offenders = files
      .filter((f) => /cookie\(\s*['"`]refreshToken['"`]/.test(read(f)))
      .map(rel)
      .filter((f) => f !== 'auth/refresh-cookie.ts');
    expect(offenders).toEqual([]);
  });

  it('only the issuer calls setRefreshCookie', () => {
    const offenders = files
      .filter((f) => /\bsetRefreshCookie\(/.test(read(f)))
      .map(rel)
      .filter((f) => f !== ISSUER && f !== 'auth/refresh-cookie.ts');
    expect(offenders).toEqual([]);
  });

  it.each(Object.entries(REISSUE_OWNERS))(
    "via '%s' is used only by %s",
    (via, owner) => {
      const pattern = new RegExp(`via:\\s*['"\`]${via}['"\`]`);
      const users = files.filter((f) => pattern.test(read(f))).map(rel);
      expect(users.filter((f) => f !== owner)).toEqual([]);
    },
  );

  it('SIGNERS_ALLOWED has no stale entries', () => {
    const missing = Object.keys(SIGNERS_ALLOWED).filter(
      (f) => !fs.existsSync(path.join(SRC, f)),
    );
    expect(missing).toEqual([]);
  });
});
