import {
  BRAND_VOICE_LIMITS,
  BrandVoiceFields,
  BrandVoiceRow,
  DEFAULT_BRAND_VOICE_FIELDS,
  codePointLength,
  fieldsOf,
  hasVoice,
  toBrandVoice,
} from './brand-voice.types';

function row(over: Partial<BrandVoiceRow> = {}): BrandVoiceRow {
  return {
    workspaceId: '00000000-0000-0000-0000-000000000001',
    tone: [],
    description: null,
    wordsUse: [],
    wordsAvoid: [],
    emojiLevel: 'few',
    hashtagsMode: 'few',
    channelTweaks: {},
    version: 1,
    previous: null,
    createdAt: new Date('2026-11-23T00:00:00Z'),
    updatedAt: new Date('2026-11-23T00:00:00Z'),
    ...over,
  };
}

describe('brand-voice types', () => {
  it('pins the limits the DB checks and the DTO share', () => {
    expect(BRAND_VOICE_LIMITS).toEqual({
      tones: 4,
      description: 240,
      words: 20,
      word: 40,
      tweak: 120,
    });
  });

  it('defaults are empty, with few emoji and few hashtags', () => {
    expect(DEFAULT_BRAND_VOICE_FIELDS).toEqual({
      tone: [],
      description: null,
      wordsUse: [],
      wordsAvoid: [],
      emojiLevel: 'few',
      hashtagsMode: 'few',
      channelTweaks: {},
    });
  });

  describe('hasVoice', () => {
    it('is false for the defaults', () => {
      expect(hasVoice(DEFAULT_BRAND_VOICE_FIELDS)).toBe(false);
    });

    it.each<[string, Partial<BrandVoiceFields>]>([
      ['tone', { tone: ['Warm'] }],
      ['description', { description: 'Coffee' }],
      ['wordsUse', { wordsUse: ['fresh'] }],
      ['wordsAvoid', { wordsAvoid: ['cheap'] }],
    ])('is true when %s is set', (_name, over) => {
      expect(hasVoice({ ...DEFAULT_BRAND_VOICE_FIELDS, ...over })).toBe(true);
    });

    it('ignores emoji, hashtags and tweaks', () => {
      const styled: BrandVoiceFields = {
        ...DEFAULT_BRAND_VOICE_FIELDS,
        emojiLevel: 'lots',
        hashtagsMode: 'many',
        channelTweaks: { linkedin: 'formal' },
      };
      expect(hasVoice(styled)).toBe(false);
    });
  });

  describe('codePointLength', () => {
    it('counts an emoji with a variation selector as 2, a surrogate pair as 1', () => {
      expect(codePointLength('☕️')).toBe(2);
      expect(codePointLength('\u{1F600}')).toBe(1);
      expect(codePointLength('abc')).toBe(3);
      expect(codePointLength('')).toBe(0);
    });
  });

  describe('toBrandVoice', () => {
    it('null is the defaults at version 1 with hasVoice false', () => {
      expect(toBrandVoice(null)).toEqual({
        ...DEFAULT_BRAND_VOICE_FIELDS,
        version: 1,
        hasVoice: false,
      });
    });

    it('maps a row to the wire shape without leaking row-only columns', () => {
      const result = toBrandVoice(
        row({
          tone: ['Warm', 'Witty'],
          description: 'Coffee',
          wordsUse: ['fresh'],
          version: 3,
          previous: DEFAULT_BRAND_VOICE_FIELDS,
        }),
      );
      expect(result).toEqual({
        tone: ['Warm', 'Witty'],
        description: 'Coffee',
        wordsUse: ['fresh'],
        wordsAvoid: [],
        emojiLevel: 'few',
        hashtagsMode: 'few',
        channelTweaks: {},
        version: 3,
        hasVoice: true,
      });
      expect(result).not.toHaveProperty('previous');
      expect(result).not.toHaveProperty('workspaceId');
    });

    it('does not hand out the shared defaults to be mutated', () => {
      const a = toBrandVoice(null);
      a.tone.push('Warm');
      expect(toBrandVoice(null).tone).toEqual([]);
      expect(DEFAULT_BRAND_VOICE_FIELDS.tone).toEqual([]);
    });
  });

  describe('fieldsOf', () => {
    it('picks exactly the seven editable fields', () => {
      expect(Object.keys(fieldsOf(row())).sort()).toEqual(
        [
          'channelTweaks',
          'description',
          'emojiLevel',
          'hashtagsMode',
          'tone',
          'wordsAvoid',
          'wordsUse',
        ].sort(),
      );
    });

    it('answers tone in canonical order whatever order the row stored', () => {
      // A first-week seed or the 0101 backfill stores voice order.
      const seeded = row({ tone: ['Bold', 'Warm'] });
      expect(fieldsOf(seeded).tone).toEqual(['Warm', 'Bold']);
      expect(toBrandVoice(seeded).tone).toEqual(['Warm', 'Bold']);
    });
  });
});
