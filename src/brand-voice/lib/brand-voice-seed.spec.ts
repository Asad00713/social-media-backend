import { descriptionFromBrand, toneFromVoice } from './brand-voice-seed';

// The same table as the 0101 backfill spec: these must agree with the SQL.
describe('brand-voice-seed', () => {
  describe('toneFromVoice', () => {
    it('matches case-insensitively, keeps voice order, dedupes and caps at 4', () => {
      expect(
        toneFromVoice([
          'warm',
          'Witty',
          'loud',
          'WARM',
          'clear',
          'calm',
          'bold',
        ]),
      ).toEqual(['Warm', 'Witty', 'Clear', 'Calm']);
    });

    it('trims each word before matching', () => {
      expect(toneFromVoice(['  Bold ', ' expert'])).toEqual(['Bold', 'Expert']);
    });

    it('returns an empty list when nothing is a known tone', () => {
      expect(toneFromVoice(['loud', 'edgy'])).toEqual([]);
      expect(toneFromVoice([])).toEqual([]);
    });
  });

  describe('descriptionFromBrand', () => {
    it('joins sells and audience with " for "', () => {
      expect(
        descriptionFromBrand(' Small-batch  coffee ', 'locals in Karachi'),
      ).toBe('Small-batch coffee for locals in Karachi');
    });

    it('is just sells when the audience is blank or missing', () => {
      expect(descriptionFromBrand('Coffee', '   ')).toBe('Coffee');
      expect(descriptionFromBrand('Coffee', null)).toBe('Coffee');
    });

    it('is null without sells, even with an audience', () => {
      expect(descriptionFromBrand(null, 'locals')).toBeNull();
      expect(descriptionFromBrand('   ', 'locals')).toBeNull();
    });

    it('cuts at 240 code points', () => {
      expect(descriptionFromBrand('a'.repeat(300), null)).toBe('a'.repeat(240));
      const cut = descriptionFromBrand(
        'a'.repeat(239) + '\u{1F600}\u{1F600}',
        null,
      )!;
      expect(Array.from(cut)).toHaveLength(240);
      expect(cut).toBe('a'.repeat(239) + '\u{1F600}');
    });

    it('right-trims after the cut', () => {
      expect(descriptionFromBrand('a'.repeat(239) + ' bbb', null)).toBe(
        'a'.repeat(239),
      );
    });

    it('collapses whitespace inside sells and audience', () => {
      expect(descriptionFromBrand('a\n\nb', 'c \t d')).toBe('a b for c d');
    });
  });
});
