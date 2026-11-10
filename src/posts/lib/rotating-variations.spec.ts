import {
  advanceSources,
  applyVariationSources,
  hasVariations,
  parseVariationSources,
  resolveVariationAt,
  VARIATION_SOURCE_LIMITS,
} from './rotating-variations';

/**
 * The same vectors as the composer's `variation-picks.test.ts`, which
 * previews these wordings: the two must agree to the character.
 */
const CAPTION =
  'Iced Spanish latte is {back|here again|on the bar}. {Try it|Grab one} this weekend.';

describe('resolveVariationAt — the composer’s order', () => {
  it('changes the first group fastest', () => {
    expect(resolveVariationAt(CAPTION, 0)).toBe(
      'Iced Spanish latte is back. Try it this weekend.',
    );
    expect(resolveVariationAt(CAPTION, 1)).toContain('is here again. Try it');
    expect(resolveVariationAt(CAPTION, 2)).toContain('is on the bar. Try it');
    expect(resolveVariationAt(CAPTION, 3)).toContain('is back. Grab one');
    expect(resolveVariationAt(CAPTION, 4)).toContain('is here again. Grab one');
    expect(resolveVariationAt(CAPTION, 5)).toContain('is on the bar. Grab one');
  });

  it('wraps past the last one — repeats rotate', () => {
    expect(resolveVariationAt(CAPTION, 6)).toBe(resolveVariationAt(CAPTION, 0));
    expect(resolveVariationAt(CAPTION, 10)).toBe(
      resolveVariationAt(CAPTION, 4),
    );
  });

  it('groups of different lengths go through every combination before one repeats', () => {
    const seen = [0, 1, 2, 3, 4, 5].map((k) => resolveVariationAt(CAPTION, k));
    expect(new Set(seen).size).toBe(6);
  });

  it('reaches every combination where groups share a length', () => {
    // Turning both groups by one index would give only 2 of these 4.
    const seen = new Set(
      [0, 1, 2, 3].map((k) => resolveVariationAt('{a|b} {c|d}', k)),
    );
    expect(seen).toEqual(new Set(['a c', 'b c', 'a d', 'b d']));
  });

  it('leaves braces without a pipe, and a caption without groups, alone', () => {
    expect(resolveVariationAt('Use {brackets} like this', 3)).toBe(
      'Use {brackets} like this',
    );
    expect(resolveVariationAt('Iced latte is back', 5)).toBe(
      'Iced latte is back',
    );
    expect(hasVariations('Use {brackets}')).toBe(false);
    expect(hasVariations('{a|b}')).toBe(true);
  });

  it('allows an empty option, which makes a group optional', () => {
    expect(resolveVariationAt('Iced latte{ today|}', 0)).toBe(
      'Iced latte today',
    );
    expect(resolveVariationAt('Iced latte{ today|}', 1)).toBe('Iced latte');
  });
});

describe('parseVariationSources', () => {
  const opts = { platforms: ['facebook', 'twitter', 'linkedin'] };

  it('keeps a well-formed source', () => {
    expect(
      parseVariationSources({ facebook: { text: CAPTION, index: 1 } }, opts),
    ).toEqual({ facebook: { text: CAPTION, index: 1 } });
  });

  it('keeps a thread whose posts hold the groups', () => {
    const v = {
      twitter: { text: 'one', thread: ['one', '{a|b}'], index: 0 },
    };
    expect(parseVariationSources(v, opts)).toEqual(v);
  });

  it('drops a channel whose wording was picked — a pick wins for the whole series', () => {
    expect(
      parseVariationSources(
        {
          facebook: { text: CAPTION, index: 2 },
          linkedin: { text: CAPTION, index: 1 },
        },
        { ...opts, perPlatform: { facebook: { variationPick: 2 } } },
      ),
    ).toEqual({ linkedin: { text: CAPTION, index: 1 } });
  });

  it('drops a platform the post is not on, and a source with nothing to rotate', () => {
    expect(
      parseVariationSources(
        {
          tiktok: { text: CAPTION, index: 0 },
          facebook: { text: 'no groups here', index: 0 },
        },
        opts,
      ),
    ).toEqual({});
  });

  it('is null for anything malformed, so the request can be refused', () => {
    for (const bad of [
      null,
      [],
      'x',
      { facebook: 'x' },
      { facebook: { text: 1, index: 0 } },
      { facebook: { text: CAPTION } },
      { facebook: { text: CAPTION, index: -1 } },
      { facebook: { text: CAPTION, index: 1.5 } },
      {
        facebook: {
          text: CAPTION,
          index: VARIATION_SOURCE_LIMITS.index + 1,
        },
      },
      {
        facebook: {
          text: 'x'.repeat(VARIATION_SOURCE_LIMITS.text + 1),
          index: 0,
        },
      },
      { twitter: { text: CAPTION, index: 0, thread: 'x' } },
      { twitter: { text: CAPTION, index: 0, thread: [1] } },
      {
        twitter: {
          text: CAPTION,
          index: 0,
          thread: Array(VARIATION_SOURCE_LIMITS.thread + 1).fill('x'),
        },
      },
    ]) {
      expect(parseVariationSources(bad, opts)).toBeNull();
    }
  });
});

describe('advanceSources', () => {
  it('moves every channel one wording on', () => {
    expect(
      advanceSources({
        facebook: { text: CAPTION, index: 0 },
        linkedin: { text: CAPTION, index: 5 },
      }),
    ).toEqual({
      facebook: { text: CAPTION, index: 1 },
      linkedin: { text: CAPTION, index: 6 },
    });
  });
});

describe('applyVariationSources', () => {
  it('writes each source’s wording into its channel’s overrides, leaving the rest', () => {
    const row = {
      content: CAPTION,
      platformContent: {
        facebook: {
          inheritsFromBase: true,
          overrides: { text: 'old', mediaItems: [{ url: 'u' }] },
          platformSpecific: { linkButton: 'LEARN_MORE' },
          variationPick: undefined,
        },
        linkedin: { overrides: { text: 'picked wording' } },
      },
      metadata: { source: 'composer' },
    };
    const out = applyVariationSources(row, {
      facebook: { text: CAPTION, index: 4 },
    });
    expect(out.platformContent.facebook).toEqual({
      ...row.platformContent.facebook,
      overrides: {
        text: 'Iced Spanish latte is here again. Grab one this weekend.',
        mediaItems: [{ url: 'u' }],
      },
    });
    expect(out.platformContent.linkedin).toBe(row.platformContent.linkedin);
    expect(out.content).toBe(CAPTION);
    // The input row is not mutated.
    expect(row.platformContent.facebook.overrides.text).toBe('old');
  });

  it('creates the entry for a channel that had none', () => {
    const out = applyVariationSources(
      { platformContent: {}, metadata: {} },
      { facebook: { text: '{a|b}', index: 1 } },
    );
    expect(out.platformContent).toEqual({
      facebook: {
        inheritsFromBase: true,
        overrides: { text: 'b' },
        platformSpecific: {},
      },
    });
  });

  it('turns a thread with the caption, and X’s metadata copy with it', () => {
    const thread = [
      { text: 'one {a|b}', mediaItems: [] },
      { text: 'two {c|d}', mediaItems: [] },
    ];
    const out = applyVariationSources(
      {
        platformContent: {
          twitter: {
            overrides: { text: 'one a' },
            platformSpecific: { thread },
          },
        },
        metadata: { thread },
      },
      {
        twitter: {
          text: 'one {a|b}',
          thread: ['one {a|b}', 'two {c|d}'],
          index: 1,
        },
      },
    );
    const expected = [
      { text: 'one b', mediaItems: [] },
      { text: 'two d', mediaItems: [] },
    ];
    expect(out.platformContent.twitter.platformSpecific.thread).toEqual(
      expected,
    );
    expect(out.platformContent.twitter.overrides.text).toBe('one b');
    expect(out.metadata.thread).toEqual(expected);
  });
});
