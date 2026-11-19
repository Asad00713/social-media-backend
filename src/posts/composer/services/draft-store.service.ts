import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { isViewer, type CallerRole } from '../../guest-rules';
import { carryFirstWeekMeta } from '../../../first-week/lib/first-week-metadata';
import { carryApproval, newApprovalRequest } from '../../lib/draft-approval';
import { carryScheduleGroup } from '../lib/per-channel-schedule';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { readOrganise, resolveOrganise } from '../lib/draft-organise';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { LabelsService } from '../../../labels/labels.service';
import { PostLabelsService } from '../../../labels/post-labels.service';
import { posts } from '../../../drizzle/schema/posts.schema';
import type { SaveDraftDto } from '../dto/save-draft.dto';
import { snapshotOf } from '../lib/draft-versions';
import { ApprovalPolicyService } from './approval-policy.service';
import { DraftVersionsService } from './draft-versions.service';
import type {
  BaseContent,
  ChannelTarget,
  Draft,
  PlatformOverrides,
  ScheduleConfig,
} from '../types/draft.types';
import { livePosts } from '../../soft-delete/soft-delete';

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
    // Not @Optional: the module must provide them. Optional in the type only
    // so a unit test that never touches labels can leave them out.
    private readonly postLabels?: PostLabelsService,
    private readonly labelCatalogue?: LabelsService,
    // Not @Optional either; optional in the type for the same reason.
    private readonly approvalPolicy?: ApprovalPolicyService,
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
      .where(
        and(
          eq(posts.id, dto.draftId),
          eq(posts.workspaceId, workspaceId),
          livePosts(),
        ),
      )
      .limit(1);

    if (existing.length > 0 && isViewer(role)) {
      this.assertViewerOwnsDraft(existing[0], userId);
    }

    const metadata: Record<string, unknown> = {
      hashtags: dto.base.hashtags,
      mentions: dto.base.mentions,
      linkPreview: dto.base.linkPreview,
      schedule: dto.schedule,
      title: dto.title,
      // The composer's marker, as the scheduler stamps it: `title` here is
      // the draft's name, never a post title (see sharedMetadataFor). A
      // draft saved with no `schedule` would otherwise read as a legacy row,
      // whose title IS published - and an approval granted on it would not
      // match the same draft once scheduled. A first-week draft's own
      // `source` (carried below) wins.
      source: 'composer',
      // Campaign: absent keeps the stored value (see draft-organise). Labels
      // go to post_labels after the row is written.
      ...(await resolveOrganise(
        this.db,
        workspaceId,
        existing[0]?.metadata,
        dto,
      )),
      // A first-week draft must stay one after a person edits it in the composer.
      ...carryFirstWeekMeta(existing[0]?.metadata),
      // A sibling of a post split by "a time per channel" keeps its family.
      ...carryScheduleGroup(existing[0]?.metadata),
    };
    // "Needs approval" survives a save; a grant that no longer matches the
    // saved content - metadata and repeat rule included - is withdrawn.
    Object.assign(
      metadata,
      carryApproval(existing[0]?.metadata, {
        content: dto.base.text,
        mediaItems: dto.base.mediaItems,
        platformContent: dto.perPlatform ?? {},
        targets: dto.channels ?? [],
        metadata,
      }),
    );

    if (existing.length === 0) {
      // The workspace approval policy: a covered author's new draft starts
      // out needing approval. Written silently; the approvers are told when
      // the author sends it for approval. A draft that already exists keeps
      // whatever it had when the policy changed.
      if (await this.approvalPolicy?.coversAuthor(workspaceId, userId)) {
        Object.assign(metadata, {
          approval: newApprovalRequest(userId, new Date(), { byPolicy: true }),
        });
      }
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
      await this.setLabels(workspaceId, dto);
      await this.versions?.record(dto.draftId, userId, snapshotOf(dto), opts);
      return this.toDraft(inserted, await this.labelsOf(dto.draftId));
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
    await this.setLabels(workspaceId, dto);
    await this.versions?.record(dto.draftId, userId, snapshotOf(dto), opts);
    return this.toDraft(updated, await this.labelsOf(dto.draftId));
  }

  /** "Absent keeps, present sets": only a sent `labels` (null = none) writes. */
  private async setLabels(
    workspaceId: string,
    dto: Pick<SaveDraftDto, 'draftId' | 'labels'>,
  ): Promise<void> {
    if (dto.labels === undefined) return;
    await this.postLabels?.setForPost(
      workspaceId,
      dto.draftId,
      dto.labels ?? [],
    );
  }

  private async labelsOf(postId: string): Promise<string[]> {
    return (await this.namesFor([postId])).get(postId) ?? [];
  }

  /** One batched read for every row a call returns. */
  private async namesFor(postIds: string[]): Promise<Map<string, string[]>> {
    return (await this.postLabels?.namesForPosts(postIds)) ?? new Map();
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
      .where(
        and(
          eq(posts.id, draftId),
          eq(posts.workspaceId, workspaceId),
          livePosts(),
        ),
      )
      .limit(1);
    if (rows.length === 0)
      throw new NotFoundException(`Draft ${draftId} not found`);
    return this.toDraft(rows[0], await this.labelsOf(draftId));
  }

  async listDrafts(workspaceId: string, limit = 50): Promise<Draft[]> {
    const rows = await this.db
      .select()
      .from(posts)
      .where(
        and(
          and(
            eq(posts.workspaceId, workspaceId),
            inArray(posts.status, ['draft', 'scheduled', 'failed']),
          ),
          livePosts(),
        ),
      )
      .orderBy(desc(posts.updatedAt))
      .limit(limit);
    const names = await this.namesFor(rows.map((r: any) => r.id as string));
    return rows.map((r: any) => this.toDraft(r, names.get(r.id) ?? []));
  }

  /** The workspace's live label names, A to Z, for the composer's picker. */
  async listLabels(workspaceId: string): Promise<string[]> {
    return (await this.labelCatalogue?.catalogueNames(workspaceId)) ?? [];
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
        .where(
          and(
            eq(posts.id, draftId),
            eq(posts.workspaceId, workspaceId),
            livePosts(),
          ),
        )
        .limit(1);
      if (rows.length > 0) this.assertViewerOwnsDraft(rows[0], userId ?? '');
    }
    // Soft delete (migration 0088): a discarded draft is recoverable for 30
    // days. See post.service.deletePost for the same treatment of a post.
    await this.db
      .update(posts)
      .set({
        deletedAt: new Date(),
        deletedById: userId ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(posts.id, draftId),
          eq(posts.workspaceId, workspaceId),
          livePosts(),
        ),
      );
    return { success: true };
  }

  private toDraft(row: any, labels: string[]): Draft {
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
      labels,
      createdAt: row.createdAt?.toISOString?.() ?? new Date().toISOString(),
      updatedAt: row.updatedAt?.toISOString?.() ?? new Date().toISOString(),
    };
  }
}
