import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { posts } from '../../../drizzle/schema/posts.schema';
import type { SaveDraftDto } from '../dto/save-draft.dto';
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
  constructor(@Inject(DRIZZLE) private readonly db: any) {}

  async upsert(workspaceId: string, userId: string, dto: SaveDraftDto): Promise<Draft> {
    const existing = await this.db
      .select()
      .from(posts)
      .where(and(eq(posts.id, dto.draftId), eq(posts.workspaceId, workspaceId)))
      .limit(1);

    const metadata = {
      hashtags: dto.base.hashtags,
      mentions: dto.base.mentions,
      linkPreview: dto.base.linkPreview,
      schedule: dto.schedule,
      title: dto.title,
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
    return this.toDraft(updated);
  }

  async findById(workspaceId: string, draftId: string): Promise<Draft> {
    const rows = await this.db
      .select()
      .from(posts)
      .where(and(eq(posts.id, draftId), eq(posts.workspaceId, workspaceId)))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException(`Draft ${draftId} not found`);
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
