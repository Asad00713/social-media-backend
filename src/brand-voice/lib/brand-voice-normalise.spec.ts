import {
  normaliseDescription,
  normalisePatch,
  normaliseText,
  normaliseTweaks,
  normaliseWords,
  sortTones,
} from './brand-voice-normalise';

describe('brand-voice-normalise', () => {
  it('sortTones puts tones in BRAND_TONES order', () => {
    expect(sortTones(['Witty', 'Warm'])).toEqual(['Warm', 'Witty']);
  });

  it('sortTones does not mutate its input', () => {
    const input = ['Witty', 'Warm'] as const;
    sortTones(input);
    expect(input).toEqual(['Witty', 'Warm']);
  });

  it('normaliseText trims and collapses every whitespace run to one space', () => {
    expect(normaliseText('  a \t b\n\nc  ')).toBe('a b c');
  });

  it('normaliseWords trims, collapses spaces, drops empties and case-insensitive duplicates', () => {
    expect(
      normaliseWords([' small  batch ', '', 'Small batch', 'fresh roast']),
    ).toEqual(['small batch', 'fresh roast']);
  });

  it('normaliseWords drops whitespace-only entries', () => {
    expect(normaliseWords(['   ', '\t'])).toEqual([]);
  });

  describe('normaliseDescription', () => {
    it('maps blank and null to null', () => {
      expect(normaliseDescription('')).toBeNull();
      expect(normaliseDescription('   ')).toBeNull();
      expect(normaliseDescription(null)).toBeNull();
    });

    it('collapses whitespace', () => {
      expect(normaliseDescription('  Small   batch  coffee ')).toBe(
        'Small batch coffee',
      );
    });
  });

  describe('normaliseTweaks', () => {
    it('trims and drops empty lines', () => {
      expect(normaliseTweaks({ linkedin: ' formal ', twitter: '  ' })).toEqual({
        linkedin: 'formal',
      });
    });

    it('drops keys that are not a known platform', () => {
      expect(normaliseTweaks({ linkedin: 'formal', myspace: 'hello' })).toEqual(
        { linkedin: 'formal' },
      );
    });
  });

  describe('normalisePatch', () => {
    it('keeps only the keys it was given', () => {
      expect(Object.keys(normalisePatch({ emojiLevel: 'none' }))).toEqual([
        'emojiLevel',
      ]);
    });

    it('keeps an explicit null description as null', () => {
      expect(normalisePatch({ description: null })).toEqual({
        description: null,
      });
    });

    it('normalises each field it carries', () => {
      expect(
        normalisePatch({
          tone: ['Witty', 'Warm'],
          description: '  Hi   there ',
          wordsUse: [' a ', 'A'],
          wordsAvoid: ['b  c'],
          channelTweaks: { linkedin: ' x ', slack: '' },
          hashtagsMode: 'many',
        }),
      ).toEqual({
        tone: ['Warm', 'Witty'],
        description: 'Hi there',
        wordsUse: ['a'],
        wordsAvoid: ['b c'],
        channelTweaks: { linkedin: 'x' },
        hashtagsMode: 'many',
      });
    });

    it('does not add a key for an undefined value', () => {
      expect(
        Object.keys(normalisePatch({ tone: undefined, emojiLevel: 'lots' })),
      ).toEqual(['emojiLevel']);
    });
  });
});
