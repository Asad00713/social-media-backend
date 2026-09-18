import {
  buildSearchPattern,
  isSearchable,
  MIN_SEARCH_LENGTH,
} from './inbox.service';

const BACKSLASH = String.fromCharCode(92);

describe('buildSearchPattern', () => {
  it('wraps a plain query in wildcards', () => {
    expect(buildSearchPattern('webinar')).toBe('%webinar%');
  });

  // Without escaping, `50%` becomes the pattern `%50%%` — the trailing `%` is
  // a wildcard, so it matches every row containing "50", and a bare `%` query
  // would match the entire table.
  it('escapes a literal percent so it is not a wildcard', () => {
    expect(buildSearchPattern('50%')).toBe(`%50${BACKSLASH}%%`);
  });

  // `_` matches any single character in LIKE, so `a_b` would also match `axb`.
  it('escapes a literal underscore', () => {
    expect(buildSearchPattern('a_b')).toBe(`%a${BACKSLASH}_b%`);
  });

  // The backslash must be escaped FIRST. Escaping it last would also escape
  // the backslashes the percent/underscore rules just introduced, turning
  // `50%` into an escaped backslash followed by a live wildcard — which is
  // the bug this ordering prevents.
  it('escapes a backslash without double-escaping the others', () => {
    expect(buildSearchPattern(`a${BACKSLASH}b`)).toBe(
      `%a${BACKSLASH}${BACKSLASH}b%`,
    );
    expect(buildSearchPattern(`${BACKSLASH}%`)).toBe(
      `%${BACKSLASH}${BACKSLASH}${BACKSLASH}%%`,
    );
  });

  it('leaves an @handle searchable as typed', () => {
    expect(buildSearchPattern('@farhan')).toBe('%@farhan%');
  });
});

describe('isSearchable', () => {
  it('ignores empty, whitespace and single-character queries', () => {
    expect(isSearchable(undefined)).toBe(false);
    expect(isSearchable('')).toBe(false);
    expect(isSearchable('   ')).toBe(false);
    expect(isSearchable('a')).toBe(false);
  });

  it('accepts anything at or above the minimum length', () => {
    expect(isSearchable('ab')).toBe(true);
    expect(MIN_SEARCH_LENGTH).toBe(2);
  });
});
