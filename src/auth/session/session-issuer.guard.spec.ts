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
 */
const SIGNERS_ALLOWED: Record<string, string> = {
  [ISSUER]: 'the issuer',
  'auth/two-factor/mfa-challenge.service.ts':
    'two-step challenge: purpose mfa, key derived from JWT_ACCESS_SECRET',
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

/**
 * The ways a file can mint a JWT. Every hit outside SIGNERS_ALLOWED is an
 * offender, whatever secret it uses: a minter does not have to spell the
 * secret's name (a module default secret, a key from a helper or constant).
 */
const SIGN_CALL = /\.(sign|signAsync)\s*\(/;
const JSONWEBTOKEN =
  /(from\s+['"]jsonwebtoken['"]|require\(\s*['"]jsonwebtoken['"]\s*\))/;
const JSONWEBTOKEN_SIGN =
  /import\s*\{[^}]*\bsign\b[^}]*\}\s*from\s*['"]jsonwebtoken['"]|\{[^}]*\bsign\b[^}]*\}\s*=\s*require\(\s*['"]jsonwebtoken['"]\s*\)/;

function callsSign(text: string): boolean {
  return SIGN_CALL.test(text) || JSONWEBTOKEN_SIGN.test(text);
}

/** The text of every `JwtModule.register(...)` / `registerAsync(...)` call. */
function jwtModuleRegistrations(text: string): string[] {
  const out: string[] = [];
  const re = /JwtModule\.register(?:Async)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (depth > 0 && i < text.length) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
      i++;
    }
    out.push(text.slice(m.index, i));
  }
  return out;
}

/**
 * Why a file could mint a token outside the issuer, or [] when it cannot:
 *   - it calls `.sign(` / `.signAsync(` (JwtService or jsonwebtoken) or
 *     imports `sign` from jsonwebtoken, and is not allow-listed;
 *   - it imports jsonwebtoken at all outside the allow-list (a namespace
 *     import reaches `sign` too);
 *   - it gives JwtModule a default secret (any `secret` / key option in a
 *     `register` / `registerAsync` call): every provider in that module
 *     could then sign without naming a secret. No file may do this.
 */
function signerFindings(file: string, text: string): string[] {
  const found: string[] = [];
  const allowed = file in SIGNERS_ALLOWED;
  if (!allowed && callsSign(text)) found.push(`${file}: signs a JWT`);
  if (!allowed && JSONWEBTOKEN.test(text))
    found.push(`${file}: imports jsonwebtoken`);
  for (const call of jwtModuleRegistrations(text)) {
    if (/\b(secret|secretOrPrivateKey|privateKey)\b/.test(call))
      found.push(`${file}: JwtModule default secret`);
  }
  return found;
}

describe('the signer scanner flags every bypass (fixtures)', () => {
  const flagged = (file: string, text: string) =>
    signerFindings(file, text).length > 0;

  it('a module default secret (registerAsync with JWT_ACCESS_SECRET)', () => {
    expect(
      flagged(
        'realtime/realtime.module.ts',
        `JwtModule.registerAsync({ inject: [ConfigService],
           useFactory: (c: ConfigService) => ({ secret: c.get('JWT_ACCESS_SECRET') }) })`,
      ),
    ).toBe(true);
    expect(
      flagged('x/x.module.ts', `JwtModule.register({ secret: KEY })`),
    ).toBe(true);
  });

  it('a JwtService sign that never names a secret (module default)', () => {
    expect(
      flagged(
        'realtime/sneaky-minter.service.ts',
        `constructor(private readonly jwt: JwtService) {}
         mint(u: U) { return this.jwt.sign({ sub: u.id, email: u.email }, { expiresIn: '15m' }); }`,
      ),
    ).toBe(true);
    expect(
      flagged('a/b.ts', `await this.jwtService.signAsync({ sub }, opts)`),
    ).toBe(true);
  });

  it('a bare jsonwebtoken sign with a key imported from elsewhere', () => {
    expect(
      flagged(
        'auth/sneaky2.ts',
        `import { sign } from 'jsonwebtoken';\nimport { KEY } from './key';\nexport const t = sign({ sub: 'u1', email: 'e' }, KEY);`,
      ),
    ).toBe(true);
    expect(
      flagged(
        'auth/sneaky3.ts',
        `import * as jwt from 'jsonwebtoken';\nexport const t = jwt.sign({ sub: 'u1' }, k);`,
      ),
    ).toBe(true);
    expect(
      flagged('auth/sneaky4.ts', `const { sign } = require('jsonwebtoken');`),
    ).toBe(true);
  });

  it('an allow-listed signer passes; text that only mentions a secret is not a signer', () => {
    expect(
      flagged(ISSUER, `this.jwt.sign(payload, { secret: s.access })`),
    ).toBe(false);
    expect(
      flagged('a/notes.ts', `// JWT_ACCESS_SECRET is read by JwtStrategy`),
    ).toBe(false);
    expect(flagged('a/a.module.ts', `JwtModule.register({})`)).toBe(false);
    expect(flagged('a/v.ts', `this.jwt.verify(t, { secret: KEY })`)).toBe(
      false,
    );
  });

  it('even an allow-listed file may not set a JwtModule default secret', () => {
    expect(flagged(ISSUER, `JwtModule.register({ secret: 'x' })`)).toBe(true);
  });
});

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

  it('no file outside SIGNERS_ALLOWED can sign a JWT (any secret, any spelling)', () => {
    const offenders = files.flatMap((f) => signerFindings(rel(f), read(f)));
    expect(offenders).toEqual([]);
  });

  it('every SIGNERS_ALLOWED file really signs (the list is not padding)', () => {
    for (const f of Object.keys(SIGNERS_ALLOWED)) {
      expect(callsSign(read(path.join(SRC, f)))).toBe(true);
    }
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

  it('only SessionStore and AccountDeletionService write sessions_revoked_at', () => {
    // B1: the floor judges sid-less tokens only, and every write of it must
    // also revoke the session rows - so it lives in SessionStore. The account
    // delete also deletes the rows itself. A read (`sessionsRevokedAt: true`,
    // a `Date | null` type, `users.sessionsRevokedAt`) is not a write.
    const WRITE =
      /sessionsRevokedAt\s*:(?!\s*(?:true\b|Date\b|users\.|timestamp\())|sessions_revoked_at\s*=(?!=)/;
    const ALLOWED = [
      'auth/session/session-store.ts',
      'users/account-deletion.service.ts',
    ];
    const writers = files.filter((f) => WRITE.test(read(f))).map(rel);
    expect(writers.filter((f) => !ALLOWED.includes(f))).toEqual([]);
    // Not vacuous: the store itself matches.
    expect(writers).toContain('auth/session/session-store.ts');
  });

  it('SIGNERS_ALLOWED has no stale entries', () => {
    const missing = Object.keys(SIGNERS_ALLOWED).filter(
      (f) => !fs.existsSync(path.join(SRC, f)),
    );
    expect(missing).toEqual([]);
  });
});
