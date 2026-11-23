import {
  BRAND_TONES,
  BRAND_VOICE_LIMITS,
  BrandTone,
} from '../brand-voice.types';

/**
 * First-week learns a brand (`voice` words, `sells`, `audience`); these two map
 * it onto the brand-voice fields. They must give the same answers as the
 * backfill in drizzle/migrations/0101_brand_voice.sql, so a workspace seeded
 * today and one backfilled yesterday end up the same.
 */

/**
 * The known tones named in `voice`: matched case-insensitively after trimming,
 * in the order the voice words give them, each once, at most four.
 */
export function toneFromVoice(voice: readonly string[]): BrandTone[] {
  const picked: BrandTone[] = [];
  for (const word of voice) {
    const key = word.trim().toLowerCase();
    const tone = BRAND_TONES.find((t) => t.toLowerCase() === key);
    if (tone && !picked.includes(tone)) picked.push(tone);
    if (picked.length === BRAND_VOICE_LIMITS.tones) break;
  }
  return picked;
}

/**
 * "<sells> for <audience>", whitespace runs collapsed to one space, cut to 240
 * code points and right-trimmed. Null when there is nothing to sell: an
 * audience alone says nothing about the brand.
 */
export function descriptionFromBrand(
  sells: string | null,
  audience: string | null,
): string | null {
  const what = (sells ?? '').trim();
  if (what === '') return null;
  const who = (audience ?? '').trim();
  const joined = who === '' ? what : `${what} for ${who}`;
  const collapsed = joined.replace(/\s+/g, ' ');
  return Array.from(collapsed)
    .slice(0, BRAND_VOICE_LIMITS.description)
    .join('')
    .trimEnd();
}
