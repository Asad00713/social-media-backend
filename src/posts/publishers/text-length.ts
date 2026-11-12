// X's weighted counting comes from the official `twitter-text` package (the
// reference implementation X's docs point to). The other rules are each
// network's own published counting rule, one line apiece over
// `Intl.Segmenter` and `Buffer.byteLength`.
//
// This is the backend twin of the composer's
// `src/features/composer/lib/text-length.ts`. The composer's counter, its
// Checks and the publishers' validate() must all count the same way, or a
// post the counter calls fine is refused here — change the two together.

import twitterText from 'twitter-text';

/** The one function we read; the package ships no types. */
const parseTweet = (
  twitterText as unknown as {
    parseTweet: (text: string) => { weightedLength: number };
  }
).parseTweet;

/** The networks whose count is not JavaScript's `.length`. */
export type CountedPlatform =
  | 'twitter'
  | 'bluesky'
  | 'mastodon'
  | 'threads'
  | 'pinterest'
  | string;

export interface TextLengthOptions {
  /** Mastodon's content warning, which shares the post's budget. */
  contentWarning?: string;
}

/** What a URL costs on Mastodon, whatever its length. */
const MASTODON_URL_COST = 23;

/**
 * An emoji grapheme: one drawn as an emoji (`Emoji_Presentation`, or forced
 * by U+FE0F), a flag or a keycap. Threads counts these by UTF-8 bytes.
 */
const EMOJI_GRAPHEME =
  /\p{Emoji_Presentation}|️|\p{Regional_Indicator}|⃣/u;

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function graphemes(text: string): string[] {
  return [...SEGMENTER.segment(text)].map((s) => s.segment);
}

/** User-visible characters — Bluesky's `maxGraphemes`. */
export function countGraphemes(text: string): number {
  return text ? graphemes(text).length : 0;
}

/** UTF-8 bytes — YouTube's description unit. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * X's weighted length: URLs 23, emoji and CJK 2, Latin 1, NFC-normalised —
 * https://docs.x.com/fundamentals/counting-characters.
 */
export function countXChars(text: string): number {
  return text ? parseTweet(text).weightedLength : 0;
}

/**
 * Mastodon's count (`status_length_validator.rb`): graphemes, each URL 23,
 * a remote mention as its username alone, plus the content warning.
 */
export function countMastodonChars(text: string, warning?: string): number {
  const countable = text
    .replace(/https?:\/\/[^\s]+/g, 'x'.repeat(MASTODON_URL_COST))
    .replace(
      /(^|[^\p{L}\p{N}_/])(@[\p{L}\p{N}_]+)@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu,
      '$1$2',
    );
  return countGraphemes(warning?.trim() ? `${warning}${countable}` : countable);
}

/**
 * Threads' count: "Emojis are counted as the number of UTF-8 bytes"
 * (Threads API, Posts); every other character is one.
 */
export function countThreadsChars(text: string): number {
  let count = 0;
  for (const g of graphemes(text)) {
    count += EMOJI_GRAPHEME.test(g) ? utf8Bytes(g) : 1;
  }
  return count;
}

/**
 * How `platform` counts `text`. Everyone not listed uses UTF-16 code units:
 * TikTok states "UTF-16 runes", and the rest publish no rule.
 */
export function textLength(
  platform: CountedPlatform,
  text: string,
  options: TextLengthOptions = {},
): number {
  switch (platform) {
    case 'twitter':
      return countXChars(text);
    case 'bluesky':
      return countGraphemes(text);
    case 'mastodon':
      return countMastodonChars(text, options.contentWarning);
    case 'threads':
      return countThreadsChars(text);
    case 'pinterest':
      return Array.from(text).length;
    default:
      return text.length;
  }
}

/**
 * A YouTube tag list's length as YouTube counts it: commas between tags
 * count, and a tag with a space counts as if quoted ("Foo Baz" is 9).
 */
export function youtubeTagsLength(tags: readonly string[]): number {
  const kept = tags.map((t) => t.trim()).filter(Boolean);
  if (kept.length === 0) return 0;
  const chars = kept.reduce(
    (sum, t) => sum + Array.from(t).length + (/\s/.test(t) ? 2 : 0),
    0,
  );
  return chars + (kept.length - 1);
}
