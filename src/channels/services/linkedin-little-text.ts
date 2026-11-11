/**
 * LinkedIn's "little" text format, for the Posts API `commentary` field.
 *
 * Hand-rolled because it is LinkedIn's own wire format: no maintained npm
 * package implements it, and it is ~40 lines against a short grammar.
 *
 * The Post schema types `commentary` as little text, and the format's page
 * says: "Characters reserved for little elements must be escaped to be
 * treated as plaintext" and "All reserved characters need to be escaped with
 * a backslash, even if those characters are not used in one of the supported
 * elements or templates." Its grammar lists them:
 *
 *   Text ::= ( NON_RESERVED_CHAR_SEQUENCES | "\|" | "\{" | "\}" | "\@" |
 *              "\[" | "\]" | "\(" | "\)" | "\<" | "\>" | "\#" | "\\" |
 *              "\*" | "\_" | "\~" )+
 *
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format
 *
 * An unescaped one is not just shown wrong - LinkedIn stops parsing there:
 * "Schedura publish test (LinkedIn, 2 photos ...) #test" was published as
 * "Schedura publish test", cut at the "(".
 *
 * Two things in a caption are elements rather than text, and are kept:
 *  - a hashtag `#word` becomes the HashtagTemplate `{hashtag|\#|word}` - the
 *    form the Posts API itself returns a hashtag in (its "Hashtag a keyword"
 *    sample reads back `{hashtag|\\#|coding}`), so it stays a link;
 *  - a well-formed mention `@[Name](urn:li:person|organization:…)` - the
 *    MentionElement - is passed through, its name escaped as the grammar's
 *    `FallbackText ::= '[' Text ']'` requires.
 *
 * NOT for the Comments API: a comment's `message.text` is plain text whose
 * mentions are `attributes` (start/length) - nothing there is little text.
 * Nor for the legacy `/v2/ugcPosts` `shareCommentary.text`, which is plain
 * text too.
 */

/** The reserved characters, from the grammar's `Text` rule. */
const RESERVED = /[|{}@[\]()<>#\\*_~]/g;

/**
 * One alternation, scanned left to right, so a hashtag-looking run inside a
 * mention's name is never read as a hashtag.
 *
 * 1. A mention: `@[name](urn:li:<person|organization|organizationBrand>:id)`.
 * 2. A hashtag: `#` + letters/digits/underscore with at least one letter
 *    (`#1` is a rank, not a tag). It must not follow a word character, `#`,
 *    `@`, `.`, `/`, `&` or `\` - so `C#`, `page#section`, `example.com/#top`
 *    and `&#123;` stay text. Mirrors the composer's own hashtag pattern
 *    (`caption-tokens.ts`), plus the URL/entity cases.
 */
const ELEMENT =
  /@\[([^\]\n]+)\]\((urn:li:(?:person|organization|organizationBrand):[A-Za-z0-9_-]+)\)|(?<![\p{L}\p{N}_#@./&\\])#((?=[\p{N}_]*\p{L})[\p{L}\p{N}_]+)/gu;

/** Escape every reserved character, so the whole string is plain text. */
export function escapeLittleText(text: string): string {
  return text.replace(RESERVED, (c) => `\\${c}`);
}

/**
 * A caption as LinkedIn little text: plain text escaped, hashtags as the
 * HashtagTemplate, well-formed mentions kept.
 */
export function toLittleText(text: string): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(ELEMENT)) {
    const index = match.index ?? 0;
    out += escapeLittleText(text.slice(last, index));
    const [whole, mentionName, mentionUrn, hashtag] = match;
    if (mentionUrn !== undefined) {
      out += `@[${escapeLittleText(mentionName)}](${mentionUrn})`;
    } else {
      out += `{hashtag|\\#|${escapeLittleText(hashtag)}}`;
    }
    last = index + whole.length;
  }
  return out + escapeLittleText(text.slice(last));
}
