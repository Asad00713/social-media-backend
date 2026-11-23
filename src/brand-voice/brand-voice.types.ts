import {
  BRAND_TONES,
  type BrandTone,
  type BrandVoiceFields,
  type BrandVoiceRow,
} from '../drizzle/schema/workspace-brand-voice.schema';

export {
  BRAND_TONES,
  EMOJI_LEVELS,
  HASHTAGS_MODES,
  TWEAK_PLATFORMS,
  workspaceBrandVoice,
} from '../drizzle/schema/workspace-brand-voice.schema';
export type {
  BrandTone,
  BrandVoiceFields,
  BrandVoiceRow,
  ChannelTweaks,
  EmojiLevel,
  HashtagsMode,
  TweakPlatform,
} from '../drizzle/schema/workspace-brand-voice.schema';

/**
 * Every length below is counted in Unicode code points (`codePointLength`),
 * which is what Postgres `char_length` counts. The migration's CHECKs use the
 * same numbers.
 */
export const BRAND_VOICE_LIMITS = {
  tones: 4,
  description: 240,
  words: 20,
  word: 40,
  tweak: 120,
} as const;

export const DEFAULT_BRAND_VOICE_FIELDS: BrandVoiceFields = {
  tone: [],
  description: null,
  wordsUse: [],
  wordsAvoid: [],
  emojiLevel: 'few',
  hashtagsMode: 'few',
  channelTweaks: {},
};

/** What the API returns: the editable fields plus the lock and the gate. */
export interface BrandVoice extends BrandVoiceFields {
  version: number;
  /** False when tone, description, wordsUse and wordsAvoid are all empty. */
  hasVoice: boolean;
}

/** A save: any subset of the fields, plus the version it was read at. */
export type BrandVoicePatch = Partial<BrandVoiceFields> & { version: number };

/**
 * Whether the workspace has said anything about its voice. Emoji, hashtags and
 * tweaks do not count: they have defaults, so on their own they are not a
 * voice and the AI prompts stay exactly as they were.
 */
export function hasVoice(
  v: Pick<BrandVoiceFields, 'tone' | 'description' | 'wordsUse' | 'wordsAvoid'>,
): boolean {
  return (
    v.tone.length > 0 ||
    (v.description !== null && v.description !== '') ||
    v.wordsUse.length > 0 ||
    v.wordsAvoid.length > 0
  );
}

/** Length in Unicode code points, as Postgres `char_length` counts it. */
export function codePointLength(s: string): number {
  return Array.from(s).length;
}

/**
 * Tones in the canonical BRAND_TONES order, each once. Lives here, not in
 * lib/brand-voice-normalise.ts (which re-exports it), because normalise
 * imports this file and every read goes through `copyFields`.
 */
export function sortTones(tones: readonly BrandTone[]): BrandTone[] {
  return BRAND_TONES.filter((t) => tones.includes(t));
}

/**
 * A copy of the seven fields, tone in canonical order: a row seeded or
 * backfilled from first-week stores the order the voice words gave.
 */
function copyFields(f: BrandVoiceFields): BrandVoiceFields {
  return {
    tone: sortTones(f.tone),
    description: f.description,
    wordsUse: [...f.wordsUse],
    wordsAvoid: [...f.wordsAvoid],
    emojiLevel: f.emojiLevel,
    hashtagsMode: f.hashtagsMode,
    channelTweaks: { ...f.channelTweaks },
  };
}

/** The seven editable fields of a row, copied so callers cannot alias it. */
export function fieldsOf(row: BrandVoiceRow): BrandVoiceFields {
  return copyFields(row);
}

/** A row, or the defaults at version 1 for a workspace that never saved one. */
export function toBrandVoice(row: BrandVoiceRow | null): BrandVoice {
  const fields = copyFields(row ?? DEFAULT_BRAND_VOICE_FIELDS);
  return {
    ...fields,
    version: row?.version ?? 1,
    hasVoice: hasVoice(fields),
  };
}
