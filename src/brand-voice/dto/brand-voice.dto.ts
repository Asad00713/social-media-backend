import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  BRAND_TONES,
  BRAND_VOICE_LIMITS,
  EMOJI_LEVELS,
  HASHTAGS_MODES,
  type BrandTone,
  type BrandVoicePatch,
  type ChannelTweaks,
  type EmojiLevel,
  type HashtagsMode,
} from '../brand-voice.types';
import {
  IsChannelTweaks,
  MaxCodePoints,
  NoLineBreaks,
  NoNulChars,
  WellFormedText,
} from './max-code-points';

/** Skips the validators when the field is left out; `null` still fails. */
const whenPresent = (_dto: unknown, value: unknown) => value !== undefined;

/** Skips the validators when the field is left out or `null`. */
const whenNotNull = (_dto: unknown, value: unknown) => value != null;

export class UpdateBrandVoiceDto implements BrandVoicePatch {
  /** The version the client read; the save is refused if it moved on. */
  @IsInt()
  @Min(1)
  version!: number;

  @ValidateIf(whenPresent)
  @IsArray()
  @ArrayMaxSize(BRAND_VOICE_LIMITS.tones)
  @ArrayUnique()
  @IsIn(BRAND_TONES, { each: true })
  tone?: BrandTone[];

  /** One sentence, or `null` to clear it. */
  @ValidateIf(whenNotNull)
  @IsString()
  @NoLineBreaks()
  @NoNulChars()
  @WellFormedText()
  @MaxCodePoints(BRAND_VOICE_LIMITS.description)
  description?: string | null;

  @ValidateIf(whenPresent)
  @IsArray()
  @ArrayMaxSize(BRAND_VOICE_LIMITS.words)
  @IsString({ each: true })
  @NoNulChars({ each: true })
  @WellFormedText({ each: true })
  @MaxCodePoints(BRAND_VOICE_LIMITS.word, { each: true })
  wordsUse?: string[];

  @ValidateIf(whenPresent)
  @IsArray()
  @ArrayMaxSize(BRAND_VOICE_LIMITS.words)
  @IsString({ each: true })
  @NoNulChars({ each: true })
  @WellFormedText({ each: true })
  @MaxCodePoints(BRAND_VOICE_LIMITS.word, { each: true })
  wordsAvoid?: string[];

  /** A level, or `null` to reset it to not set. */
  @ValidateIf(whenNotNull)
  @IsIn(EMOJI_LEVELS)
  emojiLevel?: EmojiLevel | null;

  /** A mode, or `null` to reset it to not set. */
  @ValidateIf(whenNotNull)
  @IsIn(HASHTAGS_MODES)
  hashtagsMode?: HashtagsMode | null;

  /** Replaces the whole map; `''` removes that platform's line. */
  @ValidateIf(whenPresent)
  @IsChannelTweaks()
  channelTweaks?: ChannelTweaks;
}

export class RevertBrandVoiceDto {
  /** The version the save answered with. */
  @IsInt()
  @Min(1)
  version!: number;
}
