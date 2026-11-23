import { sql } from 'drizzle-orm';
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { SupportedPlatform } from './channels.schema';
import { workspace } from './workspace.schema';

export const BRAND_TONES = [
  'Warm',
  'Clear',
  'Playful',
  'Bold',
  'Calm',
  'Formal',
  'Witty',
  'Expert',
  'Friendly',
] as const;
export type BrandTone = (typeof BRAND_TONES)[number];

export const EMOJI_LEVELS = ['none', 'few', 'lots'] as const;
export type EmojiLevel = (typeof EMOJI_LEVELS)[number];

export const HASHTAGS_MODES = ['none', 'few', 'many', 'saved_groups'] as const;
export type HashtagsMode = (typeof HASHTAGS_MODES)[number];

/**
 * The publishing platforms a per-channel tweak can name: SUPPORTED_PLATFORMS
 * without the integrations (cloud storage, calendars), in that order. Spelled
 * out so the type is a literal union; the spec pins it to the source list.
 */
export const TWEAK_PLATFORMS = [
  'facebook',
  'instagram',
  'youtube',
  'tiktok',
  'pinterest',
  'twitter',
  'linkedin',
  'threads',
  'bluesky',
  'mastodon',
  'google_business',
  'reddit',
  'slack',
  'telegram',
  'discord',
  'whatsapp',
] as const satisfies readonly SupportedPlatform[];
export type TweakPlatform = (typeof TWEAK_PLATFORMS)[number];

/** Platform -> one line of extra guidance for that channel. */
export type ChannelTweaks = Partial<Record<TweakPlatform, string>>;

/**
 * The part of a brand voice a person edits (and `previous` snapshots).
 * `emojiLevel` and `hashtagsMode` are `null` until someone chooses one: the
 * AI prompt then says nothing about emoji or hashtags.
 */
export interface BrandVoiceFields {
  tone: BrandTone[];
  description: string | null;
  wordsUse: string[];
  wordsAvoid: string[];
  emojiLevel: EmojiLevel | null;
  hashtagsMode: HashtagsMode | null;
  channelTweaks: ChannelTweaks;
}

/**
 * One row per workspace: how its posts should sound. Deliberately NOT columns
 * on workspace_brand_profiles, which is first-week's state machine.
 * Migration: drizzle/migrations/0101_brand_voice.sql (hand-written).
 */
export const workspaceBrandVoice = pgTable('workspace_brand_voice', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspace.id, { onDelete: 'cascade' }),
  tone: text('tone')
    .array()
    .$type<BrandTone[]>()
    .notNull()
    .default(sql`'{}'::text[]`),
  description: text('description'),
  wordsUse: text('words_use')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  wordsAvoid: text('words_avoid')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  // NULL = not set; no default, so nobody gets a rule they did not choose.
  emojiLevel: text('emoji_level').$type<EmojiLevel>(),
  hashtagsMode: text('hashtags_mode').$type<HashtagsMode>(),
  channelTweaks: jsonb('channel_tweaks')
    .$type<ChannelTweaks>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  // Optimistic lock: a save names the version it read.
  version: integer('version').notNull().default(1),
  // One-level snapshot for Undo.
  previous: jsonb('previous').$type<BrandVoiceFields>(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type BrandVoiceRow = typeof workspaceBrandVoice.$inferSelect;
