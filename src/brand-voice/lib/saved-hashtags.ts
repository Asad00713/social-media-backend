export const SAVED_HASHTAGS_MAX = 30;

const HASHTAG = /#[\p{L}\p{N}_]+/gu;

/**
 * Every hashtag found in the given snippet texts, in order of first
 * appearance. A tag seen again in a different case is dropped, the first
 * spelling is kept. Capped so the prompt line stays short.
 */
export function savedHashtagsFrom(
  contents: readonly string[],
  max: number = SAVED_HASHTAGS_MAX,
): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const content of contents) {
    for (const tag of content.match(HASHTAG) ?? []) {
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
      if (tags.length >= max) return tags;
    }
  }
  return tags;
}
