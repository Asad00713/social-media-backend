import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { isViewer, type CallerRole } from '../../guest-rules';
import { carryFirstWeekMeta } from '../../../first-week/lib/first-week-metadata';
import { carryApproval } from '../../lib/draft-approval';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  LABEL_CATALOGUE_LIMIT,
  normaliseLabels,
  readOrganise,
  resolveOrganise,
} from '../lib/draft-organise';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { posts } from '../../../drizzle/schema/posts.schema';
import type { SaveDraftDto } from '../dto/save-draft.dto';
import { snapshotOf } from '../lib/draft-versions';
import { DraftVersionsService } from './draft-versions.service';
import type {
  BaseContent,
  ChannelTarget,
  Draft,
  PlatformOverrides,
  ScheduleConfig,
} from '../types/draft.types';

/**
 * Stores drafts on the server when the user explicitly clicks "Save draft".
 * Reuses the existing posts table with status='draft'. NOT used for
 * autosave — drafts only land here on explicit save / publish / schedule.
 */
@Injectable()
export class DraftStoreService {
  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    // Optional so a unit test can build the store from a db alone; the
    // module always provides it.
    @Optional() private readonly versions?: DraftVersionsService,
  ) {}

  async upsert(
    workspaceId: string,
    userId: string,
    dto: SaveDraftDto,
    role?: CallerRole,
    opts: { restoredFrom?: string } = {},
  ): Promise<Draft> {
    const existing = await this.db
      .select()
      .from(posts)
      .where(and(eq(posts.id, dto.draftId), eq(posts.workspaceId, workspaceId)))
      .limit(1);

    if (existing.length > 0 && isViewer(role)) {
      this.assertViewerOwnsDraft(existing[0], userId);
    }

    const metadata = {
      hashtags: dto.base.hashtags,
      mentions: dto.base.mentions,
      linkPreview: dto.base.linkPreview,
      schedule: dto.schedule,
      title: dto.title,
      // Campaign and labels: absent keeps the stored value (see draft-organise).
      ...(await resolveOrganise(
        this.db,
        workspaceId,
        existing[0]?.metadata,
        dto,
      )),
      // A first-week draft must stay one after a person edits it in the composer.
      ...carryFirstWeekMeta(existing[0]?.metadata),
      // "Needs approval" survives a save; a grant that no longer matches the
      // saved content is withdrawn.
      ...carryApproval(existing[0]?.metadata, {
        content: dto.base.text,
        mediaItems: dto.base.mediaItems,
        platformContent: dto.perPlatform ?? {},
        targets: dto.channels ?? [],
      }),
    };

    if (existing.length === 0) {
      const [inserted] = await this.db
        .insert(posts)
        .values({
          id: dto.draftId,
          workspaceId,
          createdById: userId,
          content: dto.base.text,
          mediaItems: dto.base.mediaItems as any,
          targets: (dto.channels ?? []) as any,
          status: 'draft',
          platformContent: (dto.perPlatform ?? {}) as any,
          metadata: metadata as any,
        })
        .returning();
      await this.versions?.record(dto.draftId, userId, snapshotOf(dto), opts);
      return this.toDraft(inserted);
    }

    const [updated] = await this.db
      .update(posts)
      .set({
        content: dto.base.text,
        mediaItems: dto.base.mediaItems as any,
        targets: (dto.channels ?? []) as any,
        status: 'draft',
        platformContent: (dto.perPlatform ?? {}) as any,
        metadata: metadata as any,
        updatedAt: new Date(),
      })
      .where(and(eq(posts.id, dto.draftId), eq(posts.workspaceId, workspaceId)))
      .returning();
    await this.versions?.record(dto.draftId, userId, snapshotOf(dto), opts);
    return this.toDraft(updated);
  }

  /**
   * Write a saved version back as a NEW save: the version being replaced
   * is itself recorded first, so a restore can be undone by restoring the
   * one before it. The post's schedule and other metadata stay as they are;
   * only its content (caption, media, per-channel edits, channels, title)
   * goes back. Guest rules are the save's own.
   */
  async restoreVersion(
    workspaceId: string,
    draftId: string,
    versionId: string,
    userId: string,
    role?: CallerRole,
  ): Promise<Draft> {
    if (!this.versions) throw new NotFoundException('Version not found');
    const { post, snapshot, createdAt } = await this.versions.loadForRestore(
      workspaceId,
      draftId,
      versionId,
    );
    const meta = (post.metadata ?? {}) as Record<string, any>;
    return this.upsert(
      workspaceId,
      userId,
      {
        draftId,
        base: {
          text: snapshot.text,
          mediaItems: snapshot.mediaItems,
          hashtags: snapshot.hashtags,
          mentions: snapshot.mentions,
          linkPreview: snapshot.linkPreview,
        },
        perPlatform: snapshot.perPlatform,
        channels: snapshot.channels.map((c) => ({
          channelId: c.channelId,
          platform: c.platform,
          publishStatus: 'queued',
          retryCount: 0,
        })),
        schedule: meta.schedule,
        title: snapshot.title,
      },
      role,
      { restoredFrom: createdAt },
    );
  }

  async findById(workspaceId: string, draftId: string): Promise<Draft> {
    const rows = await this.db
      .select()
      .from(posts)
      .where(and(eq(posts.id, draftId), eq(posts.workspaceId, workspaceId)))
      .limit(1);
    if (rows.length === 0)
      throw new NotFoundException(`Draft ${draftId} not found`);
    return this.toDraft(rows[0]);
  }

  async listDrafts(workspaceId: string, limit = 50): Promise<Draft[]> {
    const rows = await this.db
      .select()
      .from(posts)
      .where(
        and(
          eq(posts.workspaceId, workspaceId),
          inArray(posts.status, ['draft', 'scheduled', 'failed']),
        ),
      )
      .orderBy(desc(posts.updatedAt))
      .limit(limit);
    return rows.map((r: any) => this.toDraft(r));
  }

  /**
   * Every label used on a post in this workspace, A to Z. Derived, not
   * stored: a label exists while some post carries it, so there is no
   * catalogue to keep in step and nothing to delete.
   */
  async listLabels(workspaceId: string): Promise<string[]> {
    // The CASE, not a WHERE on jsonb_typeof: Postgres may expand the
    // lateral call before filtering, and expanding a non-array throws.
    const result = await this.db.execute(sql`
      SELECT DISTINCT label
      FROM ${posts},
        jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(${posts.metadata} -> 'labels') = 'array'
            THEN ${posts.metadata} -> 'labels'
            ELSE '[]'::jsonb
          END
        ) AS label
      WHERE ${posts.workspaceId} = ${workspaceId}
      ORDER BY label
      LIMIT ${LABEL_CATALOGUE_LIMIT}
    `);
    const rows = (result?.rows ?? result ?? []) as Array<{ label: unknown }>;
    // "Launch" and "launch" are one label to a person; the first spelling
    // in A-to-Z order is the one offered.
    return normaliseLabels(
      rows.map((r) => r.label),
      LABEL_CATALOGUE_LIMIT,
    );
  }

  /** A viewer may only change drafts they created themselves. */
  private assertViewerOwnsDraft(row: any, userId: string): void {
    if (row.status !== 'draft') {
      throw new ForbiddenException('Viewers can only change drafts');
    }
    if (row.createdById !== userId) {
      throw new ForbiddenException('Viewers can only change their own drafts');
    }
  }

  async delete(
    workspaceId: string,
    draftId: string,
    userId?: string,
    role?: CallerRole,
  ): Promise<{ success: true }> {
    if (isViewer(role)) {
      const rows = await this.db
        .select()
        .from(posts)
        .where(and(eq(posts.id, draftId), eq(posts.workspaceId, workspaceId)))
        .limit(1);
      if (rows.length > 0) this.assertViewerOwnsDraft(rows[0], userId ?? '');
    }
    await this.db
      .delete(posts)
      .where(and(eq(posts.id, draftId), eq(posts.workspaceId, workspaceId)));
    return { success: true };
  }

  private toDraft(row: any): Draft {
    const metadata = (row.metadata ?? {}) as Record<string, any>;
    const base: BaseContent = {
      text: row.content ?? '',
      mediaItems: (row.mediaItems ?? []) as BaseContent['mediaItems'],
      hashtags: (metadata.hashtags ?? []) as string[],
      mentions: (metadata.mentions ?? []) as BaseContent['mentions'],
      linkPreview: metadata.linkPreview,
    };
    const schedule: ScheduleConfig = metadata.schedule ?? {
      mode: row.scheduledAt ? 'all_same_time' : 'now',
      scheduleAt: row.scheduledAt?.toISOString?.(),
    };
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      createdById: row.createdById,
      status: (row.status ?? 'draft') as Draft['status'],
      base,
      perPlatform: (row.platformContent ?? {}) as PlatformOverrides,
      channels: (row.targets ?? []) as ChannelTarget[],
      schedule,
      ...readOrganise(metadata),
      createdAt: row.createdAt?.toISOString?.() ?? new Date().toISOString(),
      updatedAt: row.updatedAt?.toISOString?.() ?? new Date().toISOString(),
    };
  }
}
