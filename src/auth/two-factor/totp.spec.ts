import { Secret, TOTP } from 'otpauth';
import {
  TOTP_DIGITS,
  TOTP_ISSUER,
  TOTP_PERIOD_SECONDS,
  TOTP_WINDOW,
  groupSecret,
  matchTotp,
  newTotpSecret,
  totpUrl,
} from './totp';

const SECRET = 'JBSWY3DPEHPK3PXP';
// A fixed instant in the middle of a 30 s step, so +/-30 s lands squarely in
// the neighbouring steps.
const NOW = 1_700_000_015_000;
const STEP = Math.floor(NOW / 30_000);

function codeAt(timestamp: number, secret = SECRET): string {
  return TOTP.generate({
    secret: Secret.fromBase32(secret),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    timestamp,
  });
}

describe('otpauth', () => {
  it('otpauth loads under Jest and matches RFC 6238 (SHA-1, T=59s)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const lib = require('otpauth') as typeof import('otpauth');
    expect(
      lib.TOTP.generate({
        secret: lib.Secret.fromLatin1('12345678901234567890'),
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        timestamp: 59_000,
      }),
    ).toBe('287082');
  });
});

describe('totp primitives', () => {
  it('pins the constants the spec names', () => {
    expect(TOTP_ISSUER).toBe('Schedura');
    expect(TOTP_DIGITS).toBe(6);
    expect(TOTP_PERIOD_SECONDS).toBe(30);
    expect(TOTP_WINDOW).toBe(1);
  });

  it('newTotpSecret is 160 bits of base32 (32 chars)', () => {
    const s = newTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(Secret.fromBase32(s).bytes).toHaveLength(20);
    expect(newTotpSecret()).not.toBe(s);
  });

  it('totpUrl names issuer, account, SHA1/6/30', () => {
    const u = new URL(totpUrl(SECRET, 'a@b.co'));
    expect(u.protocol).toBe('otpauth:');
    expect(decodeURIComponent(u.pathname)).toContain('Schedura:a@b.co');
    expect(u.searchParams.get('issuer')).toBe('Schedura');
    expect(u.searchParams.get('digits')).toBe('6');
    expect(u.searchParams.get('period')).toBe('30');
    expect(u.searchParams.get('algorithm')).toBe('SHA1');
    expect(u.searchParams.get('secret')).toBe(SECRET);
  });

  it('groupSecret groups by 4', () => {
    expect(groupSecret('ABCDEFGHIJ')).toBe('ABCD EFGH IJ');
    expect(groupSecret('ABCDEFGH')).toBe('ABCD EFGH');
  });

  it('matchTotp accepts the code of step-1, step, step+1 and returns that step', () => {
    expect(matchTotp(SECRET, codeAt(NOW - 30_000), NOW)).toBe(STEP - 1);
    expect(matchTotp(SECRET, codeAt(NOW), NOW)).toBe(STEP);
    expect(matchTotp(SECRET, codeAt(NOW + 30_000), NOW)).toBe(STEP + 1);
  });

  it('matchTotp rejects step+/-2, non-6-digit input and a wrong code', () => {
    expect(matchTotp(SECRET, codeAt(NOW - 60_000), NOW)).toBeNull();
    expect(matchTotp(SECRET, codeAt(NOW + 60_000), NOW)).toBeNull();
    const good = codeAt(NOW);
    expect(matchTotp(SECRET, good.slice(0, 5), NOW)).toBeNull();
    expect(matchTotp(SECRET, ` ${good}`, NOW)).toBeNull();
    expect(matchTotp(SECRET, `${good}0`, NOW)).toBeNull();
    expect(matchTotp(SECRET, 'abcdef', NOW)).toBeNull();
    const wrong = String((Number(good) + 1) % 1_000_000).padStart(6, '0');
    expect(matchTotp(SECRET, wrong, NOW)).toBeNull();
    // A code for another secret does not match this one.
    expect(
      matchTotp(SECRET, codeAt(NOW, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), NOW),
    ).toBeNull();
  });

  it('matchTotp defaults to the current time', () => {
    const now = Date.now();
    const step = matchTotp(SECRET, codeAt(now));
    expect(step).not.toBeNull();
    expect(Math.abs((step as number) - Math.floor(now / 30_000))).toBeLessThanOrEqual(1);
  });
});
