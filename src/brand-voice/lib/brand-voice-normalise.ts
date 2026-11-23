import {
  BrandVoiceFields,
  ChannelTweaks,
  sortTones,
  TWEAK_PLATFORMS,
  TweakPlatform,
} from '../brand-voice.types';

/**
 * What the server stores. The DTO has already checked shapes and lengths; this
 * makes the stored form canonical so equal voices compare equal and the prompt
 * never carries stray whitespace. Pure: no I/O, no mutation of the input.
 */

/** Tones in the canonical BRAND_TONES order, each once. */
export { sortTones };

/** Trim and collapse every whitespace run to one space. */
export function normaliseText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Blank becomes null: an empty description is stored as no description. */
export function normaliseDescription(s: string | null): string | null {
  if (s === null) return null;
  const text = normaliseText(s);
  return text === '' ? null : text;
}

/** Trimmed, empties dropped, case-insensitive duplicates dropped (first kept). */
export function normaliseWords(words: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of words) {
    const text = normaliseText(word);
    if (text === '') continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

const KNOWN_PLATFORMS: ReadonlySet<string> = new Set(TWEAK_PLATFORMS);

/**
 * Trimmed lines, empty ones dropped (an empty line removes the tweak). A key
 * that is not a known platform is dropped too: the DTO rejects those first, so
 * this is only a guard against a caller that skipped it.
 */
export function normaliseTweaks(map: Record<string, string>): ChannelTweaks {
  const out: ChannelTweaks = {};
  for (const [platform, line] of Object.entries(map)) {
    if (!KNOWN_PLATFORMS.has(platform)) continue;
    const text = normaliseText(line);
    if (text !== '') out[platform as TweakPlatform] = text;
  }
  return out;
}

/** Normalise a patch; only the keys that were present appear in the result. */
export function normalisePatch(
  patch: Partial<BrandVoiceFields>,
): Partial<BrandVoiceFields> {
  const out: Partial<BrandVoiceFields> = {};
  if (patch.tone !== undefined) out.tone = sortTones(patch.tone);
  if (patch.description !== undefined) {
    out.description = normaliseDescription(patch.description);
  }
  if (patch.wordsUse !== undefined)
    out.wordsUse = normaliseWords(patch.wordsUse);
  if (patch.wordsAvoid !== undefined) {
    out.wordsAvoid = normaliseWords(patch.wordsAvoid);
  }
  if (patch.emojiLevel !== undefined) out.emojiLevel = patch.emojiLevel;
  if (patch.hashtagsMode !== undefined) out.hashtagsMode = patch.hashtagsMode;
  if (patch.channelTweaks !== undefined) {
    out.channelTweaks = normaliseTweaks(patch.channelTweaks);
  }
  return out;
}
