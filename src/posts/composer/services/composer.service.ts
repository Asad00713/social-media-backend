import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, desc } from 'drizzle-orm';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { posts } from '../../../drizzle/schema/posts.schema';
import type {
  Draft,
  BaseContent,
  PlatformOverrides,
  ChannelTarget,
  ScheduleConfig,
} from '../types/draft.types';
import type { CreateDraftDto } from '../dto/create-draft.dto';
import type { UpdateDraftDto } from '../dto/update-draft.dto';

/**
 * Draft CRUD against the existing posts table. Drafts are posts rows with
 * status='draft'. No schema migration — posts.platformContent (jsonb)
 * already supports per-platform overrides, posts.targets (jsonb) supports
 * channel selection. Hashtags / mentions / linkPreview / schedule live
 * in posts.metadata.
 */
@Injectable()
export class ComposerService {
  constructor(@Inject(DRIZZLE) private readonly db: any) {}

  async create(workspaceId: string, userId: string, _dto: CreateDraftDto): Promise<Draft> {
    const inserted = await this.db
      .insert(posts)
      .values({
        workspaceId,
        createdById: userId,
        content: '',
        mediaItems: [],
        targets: [],
        status: 'draft',
        platformContent: {},
        metadata: {},
      })
      .returning();

    return this.toDraft(inserted[0]);
  }

  async findById(workspaceId: string, draftId: string): Promise<Draft> {
    const rows = await this.db
      .select()
      .from(posts)
      .where(and(eq(posts.id, draftId), eq(posts.workspaceId, workspaceId)))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundException(`Draft ${draftId} not found`);
    }
    return this.toDraft(rows[0]);
  }

  async listDrafts(workspaceId: string, limit = 50): Promise<Draft[]> {
    const rows = await this.db
      .select()
      .from(posts)
      .where(and(eq(posts.workspaceId, workspaceId), eq(posts.status, 'draft')))
      .orderBy(desc(posts.updatedAt))
      .limit(limit);

    return rows.map((r: any) => this.toDraft(r));
  }

  async update(workspaceId: string, draftId: string, dto: UpdateDraftDto): Promise<Draft> {
    const existing = await this.findById(workspaceId, draftId);
    const newBase: BaseContent = dto.base
      ? { ...existing.base, ...dto.base }
      : existing.base;

    const updated = await this.db
      .update(posts)
      .set({
        content: newBase.text,
        mediaItems: newBase.mediaItems,
        platformContent: dto.perPlatform ?? existing.perPlatform,
        targets: (dto.channels ?? existing.channels) as any,
        scheduledAt: dto.schedule?.scheduleAt ? new Date(dto.schedule.scheduleAt) : null,
        metadata: {
          hashtags: newBase.hashtags,
          mentions: newBase.mentions,
          linkPreview: newBase.linkPreview,
          schedule: dto.schedule ?? existing.schedule,
        },
        updatedAt: new Date(),
      })
      .where(and(eq(posts.id, draftId), eq(posts.workspaceId, workspaceId)))
      .returning();

    return this.toDraft(updated[0]);
  }

  async delete(workspaceId: string, draftId: string): Promise<{ success: true }> {
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
      createdAt: row.createdAt?.toISOString?.() ?? new Date().toISOString(),
      updatedAt: row.updatedAt?.toISOString?.() ?? new Date().toISOString(),
    };
  }
}
