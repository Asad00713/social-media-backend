import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { textSnippets } from '../drizzle/schema/media-library.schema';
import {
  DEFAULT_BRAND_VOICE_FIELDS,
  fieldsOf,
  hasVoice,
  toBrandVoice,
  workspaceBrandVoice,
  type BrandVoice,
  type BrandVoiceFields,
  type BrandVoicePatch,
} from './brand-voice.types';
import {
  nothingToSave,
  nothingToUndo,
  versionConflict,
} from './brand-voice.errors';
import { normalisePatch } from './lib/brand-voice-normalise';
import { brandVoicePrompt } from './lib/brand-voice-prompt';
import { descriptionFromBrand, toneFromVoice } from './lib/brand-voice-seed';
import { savedHashtagsFrom } from './lib/saved-hashtags';

/** What every AI helper reads: the voice, and the saved hashtags it may use. */
export interface BrandVoicePromptSource {
  voice: BrandVoiceFields;
  savedHashtags: string[];
}

/**
 * The source of a workspace with no voice. Deep-frozen, so a spec stub that
 * hands it out cannot be mutated by the code under test; the service itself
 * always answers a fresh copy (`emptyPromptSource`).
 */
export const EMPTY_PROMPT_SOURCE: Readonly<BrandVoicePromptSource> =
  Object.freeze({
    voice: Object.freeze({
      ...DEFAULT_BRAND_VOICE_FIELDS,
      tone: Object.freeze([...DEFAULT_BRAND_VOICE_FIELDS.tone]),
      wordsUse: Object.freeze([...DEFAULT_BRAND_VOICE_FIELDS.wordsUse]),
      wordsAvoid: Object.freeze([...DEFAULT_BRAND_VOICE_FIELDS.wordsAvoid]),
      channelTweaks: Object.freeze({
        ...DEFAULT_BRAND_VOICE_FIELDS.channelTweaks,
      }),
    }) as BrandVoiceFields,
    savedHashtags: Object.freeze([]) as unknown as string[],
  });

/** How many hashtag snippets feed "Use saved groups". */
const SAVED_GROUPS_LIMIT = 10;

/** A fresh, mutable copy of EMPTY_PROMPT_SOURCE. */
function emptyPromptSource(): BrandVoicePromptSource {
  return {
    voice: snapshotFields(EMPTY_PROMPT_SOURCE.voice),
    savedHashtags: [],
  };
}

/**
 * The seven fields of a stored `previous` snapshot. Any key a snapshot lacks
 * falls back to its default, so Undo always writes a whole voice.
 */
function snapshotFields(s: Partial<BrandVoiceFields>): BrandVoiceFields {
  const d = DEFAULT_BRAND_VOICE_FIELDS;
  return {
    tone: [...(s.tone ?? d.tone)],
    description: s.description ?? d.description,
    wordsUse: [...(s.wordsUse ?? d.wordsUse)],
    wordsAvoid: [...(s.wordsAvoid ?? d.wordsAvoid)],
    emojiLevel: s.emojiLevel ?? d.emojiLevel,
    hashtagsMode: s.hashtagsMode ?? d.hashtagsMode,
    channelTweaks: { ...(s.channelTweaks ?? d.channelTweaks) },
  };
}

/**
 * The error's class and Postgres code, never its message: drizzle puts the
 * query parameters (the workspace's own words) in the message.
 */
function errorKind(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  let e: unknown = err;
  for (let i = 0; e && i < 3; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return `${name} (${code})`;
    e = (e as { cause?: unknown }).cause;
  }
  return name;
}

/** A column of the existing row inside ON CONFLICT DO UPDATE. */
const existing = (column: string) =>
  sql`${workspaceBrandVoice}.${sql.identifier(column)}`;

/**
 * The workspace brand voice (Settings > Brand voice) and the prompt block
 * every AI helper reads from it.
 *
 * Saves are optimistic: each names the version it read, a stale one is 409
 * VERSION_CONFLICT, and the fields as they were before the save become
 * `previous` for one Undo. A workspace that never saved has no row; it reads
 * as the defaults at version 1. Nothing here touches
 * workspace_brand_profiles, whose rows start a new workspace's first week.
 */
@Injectable()
export class BrandVoiceService {
  private readonly logger = new Logger(BrandVoiceService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /** The stored voice, or the defaults at version 1. Never inserts. */
  async get(workspaceId: string): Promise<BrandVoice> {
    const [row] = await this.db
      .select()
      .from(workspaceBrandVoice)
      .where(eq(workspaceBrandVoice.workspaceId, workspaceId))
      .limit(1);
    return toBrandVoice(row ?? null);
  }

  /**
   * Applies the fields present in `patch` when `patch.version` is the stored
   * version (1 for a workspace with no row yet).
   */
  async update(
    workspaceId: string,
    patch: BrandVoicePatch,
  ): Promise<BrandVoice> {
    const { version, ...fields } = patch;
    const changes = normalisePatch(fields);
    if (Object.keys(changes).length === 0) throw nothingToSave();

    const row = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(workspaceBrandVoice)
        .where(eq(workspaceBrandVoice.workspaceId, workspaceId))
        .for('update')
        .limit(1);

      if (!current) {
        if (version !== 1) throw versionConflict();
        // Two first saves both find no row to lock. The second insert waits
        // for the first to commit, then inserts nothing: it lost the race.
        const [inserted] = await tx
          .insert(workspaceBrandVoice)
          .values({
            workspaceId,
            ...DEFAULT_BRAND_VOICE_FIELDS,
            ...changes,
            version: 2,
            previous: snapshotFields(DEFAULT_BRAND_VOICE_FIELDS),
          })
          .onConflictDoNothing({ target: workspaceBrandVoice.workspaceId })
          .returning();
        if (!inserted) throw versionConflict();
        return inserted;
      }

      if (current.version !== version) throw versionConflict();
      const [updated] = await tx
        .update(workspaceBrandVoice)
        .set({
          ...changes,
          previous: fieldsOf(current),
          version: current.version + 1,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(workspaceBrandVoice.workspaceId, workspaceId),
            // Guards the write on its own, not only through the row lock.
            eq(workspaceBrandVoice.version, current.version),
          ),
        )
        .returning();
      if (!updated) throw versionConflict();
      return updated;
    });
    return toBrandVoice(row);
  }

  /**
   * One-level Undo: writes `previous` back and clears it. `version` is the
   * version the save answered; a newer save since is 409 VERSION_CONFLICT.
   */
  async revert(workspaceId: string, version: number): Promise<BrandVoice> {
    const row = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(workspaceBrandVoice)
        .where(eq(workspaceBrandVoice.workspaceId, workspaceId))
        .for('update')
        .limit(1);
      if (!current || current.previous === null) throw nothingToUndo();
      if (current.version !== version) throw versionConflict();

      const [updated] = await tx
        .update(workspaceBrandVoice)
        .set({
          ...snapshotFields(current.previous),
          previous: null,
          version: current.version + 1,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(workspaceBrandVoice.workspaceId, workspaceId),
            // Guards the write on its own, not only through the row lock.
            eq(workspaceBrandVoice.version, current.version),
          ),
        )
        .returning();
      if (!updated) throw versionConflict();
      return updated;
    });
    return toBrandVoice(row);
  }

  /**
   * After first-week writes a brand, fills `tone` and `description` while
   * each is still empty. Bumps `version` only when it changed something, so
   * an open editor gets a 409 rather than overwriting the seed; a new row
   * starts at version 2 for the same reason (a client read the defaults at
   * 1). Never touches `previous`. Skips a brand learned from Threads posts:
   * Threads data never reaches an LLM. Never throws.
   */
  async seedFromBrand(
    workspaceId: string,
    brand: { sells: string | null; voice: string[]; audience: string | null },
    opts: { sourcePlatform: string | null },
  ): Promise<void> {
    if (opts.sourcePlatform === 'threads') return;
    try {
      const tone = toneFromVoice(brand.voice);
      const description = descriptionFromBrand(brand.sells, brand.audience);
      if (tone.length === 0 && description === null) return;

      await this.db
        .insert(workspaceBrandVoice)
        .values({ workspaceId, tone, description, version: 2 })
        .onConflictDoUpdate({
          target: workspaceBrandVoice.workspaceId,
          set: {
            tone: sql`CASE WHEN cardinality(${existing('tone')}) = 0 THEN excluded.tone ELSE ${existing('tone')} END`,
            description: sql`COALESCE(${existing('description')}, excluded.description)`,
            version: sql`${existing('version')} + 1`,
            updatedAt: sql`now()`,
          },
          setWhere: sql`(cardinality(${existing('tone')}) = 0 AND cardinality(excluded.tone) > 0)
            OR (${existing('description')} IS NULL AND excluded.description IS NOT NULL)`,
        });
    } catch (err) {
      this.logger.warn(
        `Brand voice seed failed for workspace ${workspaceId}: ${errorKind(err)}`,
      );
    }
  }

  /**
   * The voice and, for "Use saved groups", the workspace's own live hashtag
   * snippets (never the sample, never binned). Never throws: any failure
   * answers the empty source, so an AI call never fails over its voice.
   */
  async loadPromptSource(workspaceId: string): Promise<BrandVoicePromptSource> {
    try {
      const [row] = await this.db
        .select()
        .from(workspaceBrandVoice)
        .where(eq(workspaceBrandVoice.workspaceId, workspaceId))
        .limit(1);
      if (!row) return emptyPromptSource();
      const voice = fieldsOf(row);
      if (!hasVoice(voice) || voice.hashtagsMode !== 'saved_groups') {
        return { voice, savedHashtags: [] };
      }

      const snippets = await this.db
        .select({ content: textSnippets.content })
        .from(textSnippets)
        .where(
          and(
            eq(textSnippets.workspaceId, workspaceId),
            eq(textSnippets.snippetType, 'hashtags'),
            sql`NOT COALESCE(${textSnippets.isDeleted}, false)`,
            eq(textSnippets.isSample, false),
          ),
        )
        .orderBy(
          sql`COALESCE(${textSnippets.isStarred}, false) DESC`,
          sql`${textSnippets.usageCount} DESC NULLS LAST`,
          desc(textSnippets.createdAt),
        )
        .limit(SAVED_GROUPS_LIMIT);
      return {
        voice,
        savedHashtags: savedHashtagsFrom(snippets.map((s) => s.content)),
      };
    } catch (err) {
      this.logger.warn(
        `Brand voice read failed for workspace ${workspaceId}: ${errorKind(err)}`,
      );
      return emptyPromptSource();
    }
  }

  /**
   * The brand-voice block for a system prompt; `''` when the workspace has
   * no voice or the read failed. Never throws.
   */
  async promptFor(
    workspaceId: string,
    ctx: { platform?: string; omitHashtags?: boolean } = {},
  ): Promise<string> {
    try {
      const source = await this.loadPromptSource(workspaceId);
      return brandVoicePrompt({ ...source, ...ctx });
    } catch (err) {
      this.logger.warn(
        `Brand voice prompt failed for workspace ${workspaceId}: ${errorKind(err)}`,
      );
      return '';
    }
  }
}
