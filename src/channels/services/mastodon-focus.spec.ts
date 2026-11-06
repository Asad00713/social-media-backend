import { toMastodonFocus } from './mastodon-focus';

/**
 * The composer stores a focal point as fractions from the TOP LEFT; Mastodon's
 * `focus` is -1..1 from the CENTRE with Y pointing UP. These pin the mapping
 * at the points where a flipped axis would show.
 */
describe('toMastodonFocus', () => {
  it('maps the centre to 0,0, which is also what Mastodon assumes', () => {
    expect(toMastodonFocus({ x: 0.5, y: 0.5 })).toBe('0,0');
  });

  it('flips Y: the top of the picture is +1, the bottom is -1', () => {
    // The mistake worth a test: our y grows downward, Mastodon's grows up.
    expect(toMastodonFocus({ x: 0.5, y: 0 })).toBe('0,1');
    expect(toMastodonFocus({ x: 0.5, y: 1 })).toBe('0,-1');
  });

  it('keeps X as it is: the left edge is -1, the right edge is +1', () => {
    expect(toMastodonFocus({ x: 0, y: 0.5 })).toBe('-1,0');
    expect(toMastodonFocus({ x: 1, y: 0.5 })).toBe('1,0');
  });

  it('maps all four corners', () => {
    expect(toMastodonFocus({ x: 0, y: 0 })).toBe('-1,1'); // top left
    expect(toMastodonFocus({ x: 1, y: 0 })).toBe('1,1'); // top right
    expect(toMastodonFocus({ x: 0, y: 1 })).toBe('-1,-1'); // bottom left
    expect(toMastodonFocus({ x: 1, y: 1 })).toBe('1,-1'); // bottom right
  });

  it('maps a point inside the picture linearly', () => {
    // A fifth in from the left, near the bottom: left of centre, below it.
    expect(toMastodonFocus({ x: 0.2, y: 0.8 })).toBe('-0.6,-0.6');
    expect(toMastodonFocus({ x: 0.75, y: 0.25 })).toBe('0.5,0.5');
  });

  it('rounds to two decimals, as the composer does', () => {
    expect(toMastodonFocus({ x: 1 / 3, y: 1 / 3 })).toBe('-0.33,0.33');
  });

  it('never prints a negative zero', () => {
    // A point a hair off centre rounds to zero on one axis.
    expect(toMastodonFocus({ x: 0.499, y: 0.501 })).toBe('0,0');
    expect(toMastodonFocus({ x: 0.5004, y: 0.4996 })).toBe('0,0');
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a string', '0.5,0.5'],
    ['a number', 0.5],
    ['an array', [0.5, 0.5]],
    ['an empty object', {}],
    ['a missing y', { x: 0.5 }],
    ['a missing x', { y: 0.5 }],
    ['numbers as strings', { x: '0.5', y: '0.5' }],
    ['NaN', { x: Number.NaN, y: 0.5 }],
    ['Infinity', { x: 0.5, y: Number.POSITIVE_INFINITY }],
    ['x beyond the picture', { x: 1.01, y: 0.5 }],
    ['x before the picture', { x: -0.01, y: 0.5 }],
    ['y beyond the picture', { x: 0.5, y: 1.01 }],
    ['y before the picture', { x: 0.5, y: -0.01 }],
  ])('sends no focus for %s', (_name, value) => {
    // A malformed draft value leaves Mastodon to centre rather than being
    // sent a number it would reject.
    expect(toMastodonFocus(value)).toBeUndefined();
  });
});
