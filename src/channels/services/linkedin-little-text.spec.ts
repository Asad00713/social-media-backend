import { escapeLittleText, toLittleText } from './linkedin-little-text';

/**
 * LinkedIn parses Posts API `commentary` as "little" text. An unescaped
 * reserved character is not shown wrong - parsing STOPS there: a caption was
 * published live as "Schedura publish test", cut at its "(".
 */
describe('LinkedIn little text', () => {
  // The grammar's `Text` rule, character by character.
  const RESERVED = [
    '|',
    '{',
    '}',
    '@',
    '[',
    ']',
    '(',
    ')',
    '<',
    '>',
    '#',
    '\\',
    '*',
    '_',
    '~',
  ];

  /**
   * Undo the escaping the way LinkedIn reads it: `\x` is the character x,
   * and a hashtag template is the `#word` it renders as. A caption sent
   * through `toLittleText` must read back as itself.
   */
  const render = (little: string): string =>
    little
      .replace(
        /\{hashtag\|\\#\|((?:\\.|[^\\}])+)\}/g,
        (_m, v: string) => `#${v}`,
      )
      .replace(/\\(.)/g, '$1');

  /** True when every reserved char in `little` is escaped or part of an element. */
  const hasNoBareReserved = (little: string): boolean => {
    const withoutElements = little
      .replace(/\{hashtag\|\\#\|(?:\\.|[^\\}])+\}/g, '')
      .replace(/@\[(?:\\.|[^\]\\])+\]\(urn:li:[a-zA-Z]+:[A-Za-z0-9_-]+\)/g, '')
      .replace(/\\./g, '');
    return !RESERVED.some((c) => withoutElements.includes(c));
  };

  describe('escapeLittleText', () => {
    it.each(RESERVED)('escapes %s with a backslash', (c) => {
      expect(escapeLittleText(`a${c}b`)).toBe(`a\\${c}b`);
    });

    it('leaves text without reserved characters unchanged', () => {
      const plain =
        "Hello, world! It's 50% off - today only. Café ✓ 🎉\nNew line.";
      expect(escapeLittleText(plain)).toBe(plain);
      expect(toLittleText(plain)).toBe(plain);
    });
  });

  describe('toLittleText', () => {
    it('fixes the caption LinkedIn truncated at "("', () => {
      const caption =
        'Schedura publish test (LinkedIn, 2 photos + first comment). Please ignore — this will be deleted. #test';
      const little = toLittleText(caption);
      expect(little).toBe(
        'Schedura publish test \\(LinkedIn, 2 photos + first comment\\). Please ignore — this will be deleted. {hashtag|\\#|test}',
      );
      expect(hasNoBareReserved(little)).toBe(true);
      expect(render(little)).toBe(caption);
    });

    it.each(RESERVED)(
      'never leaves %s bare, wherever it sits in a caption',
      (c) => {
        for (const caption of [
          `${c}`,
          `${c}start`,
          `end${c}`,
          `mid ${c} dle`,
          `${c}${c}${c}`,
          `#tag${c}`,
        ]) {
          const little = toLittleText(caption);
          expect(hasNoBareReserved(little)).toBe(true);
          expect(render(little)).toBe(caption);
        }
      },
    );

    it('turns #word into the hashtag template', () => {
      expect(toLittleText('#coding')).toBe('{hashtag|\\#|coding}');
      expect(toLittleText('Follow best practices #coding')).toBe(
        'Follow best practices {hashtag|\\#|coding}',
      );
      expect(toLittleText('#one #two\n#three')).toBe(
        '{hashtag|\\#|one} {hashtag|\\#|two}\n{hashtag|\\#|three}',
      );
    });

    it('keeps non-Latin hashtags and escapes an underscore inside one', () => {
      expect(toLittleText('#café #مرحبا #my_tag')).toBe(
        '{hashtag|\\#|café} {hashtag|\\#|مرحبا} {hashtag|\\#|my\\_tag}',
      );
    });

    it('ends a hashtag at punctuation', () => {
      expect(toLittleText('(#launch).')).toBe('\\({hashtag|\\#|launch}\\).');
    });

    it.each([
      ['C#', 'C\\#'],
      ['a page#section anchor', 'a page\\#section anchor'],
      ['https://example.com/#top', 'https://example.com/\\#top'],
      ['We are #1!', 'We are \\#1!'],
      ['## heading', '\\#\\# heading'],
      ['&#123;', '&\\#123;'],
      ['# alone', '\\# alone'],
    ])('leaves %s as text, not a hashtag', (caption, little) => {
      expect(toLittleText(caption)).toBe(little);
    });

    it('keeps a well-formed mention intact', () => {
      for (const mention of [
        '@[Eddy](urn:li:person:1234)',
        '@[DevtestCo](urn:li:organization:2414183)',
        '@[Brand](urn:li:organizationBrand:99)',
        '@[Jane Smith](urn:li:person:5abc_dEfgH)',
      ]) {
        expect(toLittleText(`Hi ${mention} (thanks) #team`)).toBe(
          `Hi ${mention} \\(thanks\\) {hashtag|\\#|team}`,
        );
      }
    });

    it("escapes the reserved characters in a mention's name", () => {
      expect(toLittleText('@[Acme (UK) #1](urn:li:organization:7)')).toBe(
        '@[Acme \\(UK\\) \\#1](urn:li:organization:7)',
      );
    });

    it('escapes anything that only looks like a mention', () => {
      expect(toLittleText('@handle')).toBe('\\@handle');
      expect(toLittleText('mail me@example.com')).toBe('mail me\\@example.com');
      expect(toLittleText('@[x](https://evil.test)')).toBe(
        '\\@\\[x\\]\\(https://evil.test\\)',
      );
      expect(toLittleText('@[x](urn:li:share:1)')).toBe(
        '\\@\\[x\\]\\(urn:li:share:1\\)',
      );
    });

    it('escapes markdown-looking text and a literal backslash', () => {
      expect(toLittleText('* Point 1\n_em_ ~strike~ C:\\temp')).toBe(
        '\\* Point 1\n\\_em\\_ \\~strike\\~ C:\\\\temp',
      );
    });

    it('is empty for an empty caption', () => {
      expect(toLittleText('')).toBe('');
    });
  });
});
