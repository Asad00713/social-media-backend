import { toUserRef } from '../media-library/lib/user-ref';
import { anonymisedEmail } from './account-deletion.service';
import { displayNameOrNull, isAnonymisedEmail } from './display-name';

const ANON = anonymisedEmail('3f2b8c1e-0d4a-4b7e-9c1a-2e5f6a7b8c9d');

describe('isAnonymisedEmail', () => {
  it('matches exactly what account deletion writes', () => {
    expect(isAnonymisedEmail(ANON)).toBe(true);
    expect(isAnonymisedEmail(ANON.toUpperCase())).toBe(true);
  });

  it.each([
    'deleted@deleted.invalid',
    'deleted+x@example.com',
    'someone+deleted@deleted.invalid.com',
    'hina@example.com',
    '',
    null,
    undefined,
  ])('does not match %p', (email) => {
    expect(isAnonymisedEmail(email)).toBe(false);
  });
});

describe('displayNameOrNull', () => {
  it('is null for a deleted account, whatever else is set', () => {
    expect(displayNameOrNull(null, ANON)).toBeNull();
    expect(displayNameOrNull('Left over', ANON, 'A teammate')).toBeNull();
  });

  it('is the name, else the email, else the fallback, for a live account', () => {
    expect(displayNameOrNull('Hina', 'hina@example.com')).toBe('Hina');
    expect(displayNameOrNull('  ', 'hina@example.com')).toBe(
      'hina@example.com',
    );
    expect(displayNameOrNull(null, null, 'A teammate')).toBe('A teammate');
    expect(displayNameOrNull(null, null)).toBeNull();
  });
});

describe('toUserRef', () => {
  it('a deleted account has no name, never the deleted+<uuid> local part', () => {
    expect(
      toUserRef({ id: 'u1', name: null, email: ANON, avatarUrl: null }),
    ).toEqual({ id: 'u1', name: null, avatarUrl: null });
  });

  it('a live account with no name still shows its email local part', () => {
    expect(
      toUserRef({
        id: 'u1',
        name: null,
        email: 'hina@example.com',
        avatarUrl: null,
      })?.name,
    ).toBe('hina');
  });
});
