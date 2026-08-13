import { parseAllowlist, isEmailAllowlisted } from './allowlist';

describe('parseAllowlist', () => {
  it('splits, trims, lowercases, drops empties', () => {
    expect(parseAllowlist(' A@x.com , b@Y.com ,, ')).toEqual(['a@x.com', 'b@y.com']);
  });
  it('returns [] for undefined/empty', () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist('   ')).toEqual([]);
  });
});

describe('isEmailAllowlisted', () => {
  const OLD = process.env.ALLOWLIST_EMAILS;
  afterEach(() => { process.env.ALLOWLIST_EMAILS = OLD; });

  it('gate OFF (empty env) → anyone allowed', () => {
    delete process.env.ALLOWLIST_EMAILS;
    expect(isEmailAllowlisted('nobody@x.com', 'USER')).toBe(true);
  });
  it('listed email allowed (case-insensitive)', () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com,b@y.com';
    expect(isEmailAllowlisted('A@X.com', 'USER')).toBe(true);
  });
  it('unlisted email blocked', () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    expect(isEmailAllowlisted('c@z.com', 'USER')).toBe(false);
  });
  it('super admin always allowed even if unlisted', () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    expect(isEmailAllowlisted('c@z.com', 'SUPER_ADMIN')).toBe(true);
  });
  it('missing email blocked when gate on', () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    expect(isEmailAllowlisted(undefined, 'USER')).toBe(false);
  });
});
