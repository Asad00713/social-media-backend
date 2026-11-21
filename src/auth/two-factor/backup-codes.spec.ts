import {
  BACKUP_CODE_COUNT,
  CROCKFORD,
  hashBackupCode,
  newBackupCodes,
  normalizeBackupCode,
} from './backup-codes';

const SHAPE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

describe('backup codes', () => {
  it('the alphabet is Crockford base32 (no I, L, O, U)', () => {
    expect(CROCKFORD).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
    expect(CROCKFORD).toHaveLength(32);
  });

  it('newBackupCodes makes 10 unique XXXX-XXXX codes', () => {
    const codes = newBackupCodes();
    expect(BACKUP_CODE_COUNT).toBe(10);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(SHAPE);
  });

  it('newBackupCodes honours a count and every code normalises to itself', () => {
    const codes = newBackupCodes(3);
    expect(codes).toHaveLength(3);
    for (const c of codes) expect(normalizeBackupCode(c)).toBe(c.replace('-', ''));
  });

  it('draws every Crockford symbol over many codes (not a narrowed alphabet)', () => {
    const seen = new Set(newBackupCodes(400).join('').replace(/-/g, ''));
    expect(seen.size).toBe(32);
  });

  it('normalizeBackupCode uppercases and strips dashes and spaces', () => {
    expect(normalizeBackupCode(' abcd-efgh ')).toBe('ABCDEFGH');
    expect(normalizeBackupCode('ab cd ef gh')).toBe('ABCDEFGH');
  });

  it('normalizeBackupCode maps O to 0 and I/L to 1', () => {
    expect(normalizeBackupCode('0OIL-1234')).toBe('0011' + '1234');
    expect(normalizeBackupCode('oil0-1234')).toBe('0110' + '1234');
  });

  it('normalizeBackupCode rejects the wrong length and non-Crockford letters', () => {
    expect(normalizeBackupCode('ABCD-EFG')).toBeNull();
    expect(normalizeBackupCode('ABCD-EFGHJ')).toBeNull();
    expect(normalizeBackupCode('ABCD-EFGU')).toBeNull();
    expect(normalizeBackupCode('')).toBeNull();
    expect(normalizeBackupCode('ABCD_EFGH')).toBeNull();
  });

  it('hashBackupCode is 64 hex and depends on the pepper', () => {
    const h = hashBackupCode('ABCDEFGH', 'p');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashBackupCode('ABCDEFGH', 'q')).not.toBe(h);
    expect(hashBackupCode('ABCDEFGH', 'p')).toBe(h);
    expect(hashBackupCode('ABCDEFGJ', 'p')).not.toBe(h);
  });
});
