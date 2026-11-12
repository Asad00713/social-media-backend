import {
  countGraphemes,
  countMastodonChars,
  countThreadsChars,
  countXChars,
  textLength,
  utf8Bytes,
  youtubeTagsLength,
} from './text-length';

const LONG_URL = `https://example.com/${'a'.repeat(200)}`;
const FAMILY = '👨‍👩‍👧‍👦'; // one grapheme, 11 UTF-16 units, 25 UTF-8 bytes

/**
 * One table per network: the same text, measured the way each one counts.
 * The composer's `text-length.test.ts` holds the same rows, so a change to
 * either side that the other does not share fails one of the two.
 */
describe('textLength — each network counts its own way', () => {
  const rows: Array<[string, string, string, number]> = [
    // platform, case, text, expected
    ['twitter', 'plain Latin', 'hello', 5],
    ['twitter', 'a long URL is 23', LONG_URL, 23],
    ['twitter', 'an emoji is 2', '👋', 2],
    ['twitter', 'a ZWJ family is 2', FAMILY, 2],
    ['twitter', 'CJK is 2 each', '日本', 4],
    ['twitter', 'text + URL + emoji', `hi 👋 ${LONG_URL}`, 3 + 2 + 1 + 23],
    ['bluesky', 'a family is one grapheme', FAMILY, 1],
    ['bluesky', 'a flag is one grapheme', '🇵🇰', 1],
    ['bluesky', 'a URL counts in full', 'https://a.io/x', 14],
    ['mastodon', 'a long URL is 23', LONG_URL, 23],
    ['mastodon', 'a remote mention is its username', '@alice@example.social', 6],
    ['mastodon', 'graphemes', FAMILY, 1],
    ['threads', 'plain text is 1 each', 'hello', 5],
    ['threads', 'a 4-byte emoji is 4', '😀', 4],
    ['threads', 'a family emoji is its 25 bytes', FAMILY, 25],
    ['threads', 'a bare © is text, 1', '©', 1],
    ['pinterest', 'code points', '😀a', 2],
    ['tiktok', 'UTF-16 units', '😀', 2],
    ['linkedin', 'UTF-16 units', 'abc', 3],
  ];

  it.each(rows)('%s: %s', (platform, _case, text, expected) => {
    expect(textLength(platform, text)).toBe(expected);
  });

  it('charges Mastodon its content warning', () => {
    expect(textLength('mastodon', 'body', { contentWarning: 'cw' })).toBe(6);
    expect(countMastodonChars('body', '   ')).toBe(4);
  });

  it('the X case the audit reproduced: 331 characters, mostly one URL, fits', () => {
    const url = `https://example.com/${'p'.repeat(300)}`;
    const text = `Read this ${url}`;
    expect(text.length).toBeGreaterThan(280);
    expect(countXChars(text)).toBe(10 + 23);
  });

  it('the Bluesky case the audit reproduced: 60 emoji are 60, not 120', () => {
    const text = '😀'.repeat(60);
    expect(text.length).toBe(120);
    expect(countGraphemes(text)).toBe(60);
  });

  it('empty text is 0 everywhere', () => {
    for (const p of ['twitter', 'bluesky', 'mastodon', 'threads', 'pinterest', 'x']) {
      expect(textLength(p, '')).toBe(0);
    }
    expect(countThreadsChars('')).toBe(0);
  });
});

describe('YouTube units', () => {
  it('counts the description in UTF-8 bytes', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('é')).toBe(2);
    expect(utf8Bytes('😀')).toBe(4);
  });

  it('counts tags the way YouTube does: commas, and quotes around spaces', () => {
    expect(youtubeTagsLength(['Foo-Baz'])).toBe(7);
    expect(youtubeTagsLength(['Foo Baz'])).toBe(9);
    expect(youtubeTagsLength(['a', 'b'])).toBe(3);
    expect(youtubeTagsLength(['  ', ''])).toBe(0);
  });
});
