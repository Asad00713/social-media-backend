import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import {
  INTEGRATION_PLATFORMS,
  socialMediaChannels,
} from '../drizzle/schema/channels.schema';
import { channelSyncState } from '../drizzle/schema/channel-sync-state.schema';
import { posts } from '../drizzle/schema/posts.schema';
import { workspace } from '../drizzle/schema/workspace.schema';
import {
  workspaceBrandProfiles,
  type BrandProfileRow,
  type BrandProfileSource,
  type FirstWeekStatus,
} from '../drizzle/schema/workspace-brand-profile.schema';
import type { BrandInput } from './first-week.types';
import { FIRST_WEEK_SOURCE } from './lib/first-week-metadata';
import {
  MAX_CAPTIONS,
  cleanCaptions,
  type ChannelLite,
  type SourceCandidate,
} from './lib/first-week-targets';

export type PostRow = typeof posts.$inferSelect;
export type NewDraftRow = typeof posts.$inferInsert;

export interface WorkspaceLite {
  id: string;
  timezone: string;
  ownerId: string;
  logo: string | null;
}

const isFirstWeek = (workspaceId: string) =>
  and(
    eq(posts.workspaceId, workspaceId),
    sql`${posts.metadata}->>'source' = ${FIRST_WEEK_SOURCE}`,
  );

/** Every SQL statement of the first-week feature lives here. */
@Injectable()
export class FirstWeekRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  async getProfile(workspaceId: string): Promise<BrandProfileRow | null> {
    const [row] = await this.db
      .select()
      .from(workspaceBrandProfiles)
      .where(eq(workspaceBrandProfiles.workspaceId, workspaceId))
      .limit(1);
    return row ?? null;
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceLite | null> {
    const [row] = await this.db
      .select({
        id: workspace.id,
        timezone: workspace.timezone,
        ownerId: workspace.ownerId,
        logo: workspace.logo,
      })
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);
    return row ?? null;
  }

  /** True when this call created the row; false when one already existed. */
  async insertProfileIfAbsent(
    workspaceId: string,
    v: {
      source: BrandProfileSource;
      status: FirstWeekStatus;
      brand?: BrandInput;
    },
  ): Promise<boolean> {
    const rows = await this.db
      .insert(workspaceBrandProfiles)
      .values({
        workspaceId,
        source: v.source,
        status: v.status,
        sells: v.brand?.sells ?? null,
        voice: v.brand?.voice ?? [],
        audience: v.brand?.audience ?? null,
      })
      .onConflictDoNothing({ target: workspaceBrandProfiles.workspaceId })
      .returning({ workspaceId: workspaceBrandProfiles.workspaceId });
    return rows.length > 0;
  }

  /** A person described the brand where nothing had been learned: it becomes the source, and a run follows. */
  async saveDescribedBrand(
    workspaceId: string,
    brand: BrandInput,
  ): Promise<void> {
    await this.db
      .update(workspaceBrandProfiles)
      .set({
        sells: brand.sells,
        voice: brand.voice,
        audience: brand.audience,
        source: 'described',
        sourceChannelId: null,
        sourcePlatform: null,
        postsRead: 0,
        status: 'drafting',
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(workspaceBrandProfiles.workspaceId, workspaceId));
  }

  /** Edit: change the brand fields only. No status change, no redraft. */
  async updateBrand(workspaceId: string, brand: BrandInput): Promise<void> {
    await this.db
      .update(workspaceBrandProfiles)
      .set({
        sells: brand.sells,
        voice: brand.voice,
        audience: brand.audience,
        updatedAt: new Date(),
      })
      .where(eq(workspaceBrandProfiles.workspaceId, workspaceId));
  }

  async setStatus(
    workspaceId: string,
    status: FirstWeekStatus,
    error: string | null = null,
  ): Promise<void> {
    await this.db
      .update(workspaceBrandProfiles)
      .set({ status, error, updatedAt: new Date() })
      .where(eq(workspaceBrandProfiles.workspaceId, workspaceId));
  }

  async saveLearnedBrand(
    workspaceId: string,
    v: {
      brand: BrandInput;
      sourceChannelId: number;
      sourcePlatform: string;
      postsRead: number;
    },
  ): Promise<void> {
    await this.db
      .update(workspaceBrandProfiles)
      .set({
        sells: v.brand.sells,
        voice: v.brand.voice,
        audience: v.brand.audience,
        source: 'posts',
        sourceChannelId: v.sourceChannelId,
        sourcePlatform: v.sourcePlatform,
        postsRead: v.postsRead,
        updatedAt: new Date(),
      })
      .where(eq(workspaceBrandProfiles.workspaceId, workspaceId));
  }

  /** Fix the week and enter 'drafting'. */
  async setWeek(
    workspaceId: string,
    v: { weekStartsOn: string; weekEndsAt: Date },
  ): Promise<void> {
    await this.db
      .update(workspaceBrandProfiles)
      .set({
        weekStartsOn: v.weekStartsOn,
        weekEndsAt: v.weekEndsAt,
        status: 'drafting',
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(workspaceBrandProfiles.workspaceId, workspaceId));
  }

  /** Newest synced captions on one channel (post targets store the channel id as a string). */
  async getCaptionsForChannel(
    workspaceId: string,
    channelId: number,
    limit: number,
  ): Promise<string[]> {
    const result = (await this.db.execute(sql`
      SELECT p.content AS content
      FROM posts p
      WHERE p.workspace_id = ${workspaceId}
        AND p.metadata->>'syncedFrom' = 'platform'
        AND p.targets @> ${JSON.stringify([{ channelId: String(channelId) }])}::jsonb
        AND btrim(COALESCE(p.content, '')) <> ''
      ORDER BY p.published_at DESC NULLS LAST
      LIMIT ${limit}
    `)) as unknown as
      | { rows: Array<{ content: string }> }
      | Array<{ content: string }>;
    const rows = Array.isArray(result) ? result : result.rows;
    return rows.map((r) => r.content);
  }

  async listSourceCandidates(workspaceId: string): Promise<SourceCandidate[]> {
    const channels = await this.db
      .select({
        channelId: socialMediaChannels.id,
        platform: socialMediaChannels.platform,
        profilePictureUrl: socialMediaChannels.profilePictureUrl,
        backfilledAt: channelSyncState.initialBackfillCompletedAt,
      })
      .from(socialMediaChannels)
      .leftJoin(
        channelSyncState,
        eq(channelSyncState.channelId, socialMediaChannels.id),
      )
      .where(
        and(
          eq(socialMediaChannels.workspaceId, workspaceId),
          eq(socialMediaChannels.isActive, true),
          notInArray(socialMediaChannels.platform, INTEGRATION_PLATFORMS),
        ),
      );

    const out: SourceCandidate[] = [];
    for (const c of channels) {
      const raw = await this.getCaptionsForChannel(
        workspaceId,
        c.channelId,
        MAX_CAPTIONS,
      );
      out.push({ ...c, captions: cleanCaptions(raw) });
    }
    return out;
  }

  /** Active publishing channels (integrations such as Drive or calendars never publish). */
  async listPublishingChannels(workspaceId: string): Promise<ChannelLite[]> {
    return this.db
      .select({
        id: socialMediaChannels.id,
        platform: socialMediaChannels.platform,
      })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.workspaceId, workspaceId),
          eq(socialMediaChannels.isActive, true),
          notInArray(socialMediaChannels.platform, INTEGRATION_PLATFORMS),
        ),
      )
      .orderBy(socialMediaChannels.id);
  }

  async countPublishingChannels(workspaceId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.workspaceId, workspaceId),
          eq(socialMediaChannels.isActive, true),
          notInArray(socialMediaChannels.platform, INTEGRATION_PLATFORMS),
        ),
      );
    return Number(row?.n ?? 0);
  }

  async listFirstWeekDrafts(workspaceId: string): Promise<PostRow[]> {
    return this.db.select().from(posts).where(isFirstWeek(workspaceId));
  }

  /** True when inserted; false when the deterministic id already existed. */
  async insertDraft(row: NewDraftRow): Promise<boolean> {
    const rows = await this.db
      .insert(posts)
      .values(row)
      .onConflictDoNothing({ target: posts.id })
      .returning({ id: posts.id });
    return rows.length > 0;
  }

  /** drafted_count = how many first-week posts exist (idempotent, unlike `+ 1`). */
  async refreshDraftedCount(workspaceId: string): Promise<void> {
    await this.db
      .update(workspaceBrandProfiles)
      .set({
        draftedCount: sql`(SELECT count(*)::int FROM posts WHERE workspace_id = ${workspaceId} AND metadata->>'source' = ${FIRST_WEEK_SOURCE})`,
        updatedAt: new Date(),
      })
      .where(eq(workspaceBrandProfiles.workspaceId, workspaceId));
  }

  async setWorkspaceLogoIfEmpty(
    workspaceId: string,
    url: string,
  ): Promise<void> {
    await this.db
      .update(workspace)
      .set({ logo: url, updatedAt: new Date() })
      .where(
        and(
          eq(workspace.id, workspaceId),
          or(isNull(workspace.logo), eq(workspace.logo, '')),
        ),
      );
  }
}
