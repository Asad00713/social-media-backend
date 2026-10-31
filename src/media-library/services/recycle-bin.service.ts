import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import {
  mediaTemplates,
  savedLinks,
  textSnippets,
} from '../../drizzle/schema/media-library.schema';
import { MediaItemService } from './media-item.service';

@Injectable()
export class RecycleBinService {
  private readonly logger = new Logger(RecycleBinService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly mediaItems: MediaItemService,
  ) {}

  /**
   * Permanently deletes everything in the workspace's bin. Media goes through
   * the batched purge (files first, then rows), so rows whose file will not
   * delete stay in the bin and a retry picks them up. The other kinds have no
   * file behind them and go in one statement each.
   */
  async empty(workspaceId: string): Promise<{ deleted: number }> {
    const media = await this.mediaItems.purgeDeleted({ workspaceId });
    if (media.failed > 0) {
      this.logger.warn(
        `Emptying bin of workspace ${workspaceId}: ${media.failed} media items kept (file deletion failed)`,
      );
    }

    const templates = await this.db
      .delete(mediaTemplates)
      .where(
        and(
          eq(mediaTemplates.workspaceId, workspaceId),
          eq(mediaTemplates.isDeleted, true),
        ),
      )
      .returning({ id: mediaTemplates.id });
    const snippets = await this.db
      .delete(textSnippets)
      .where(
        and(
          eq(textSnippets.workspaceId, workspaceId),
          eq(textSnippets.isDeleted, true),
        ),
      )
      .returning({ id: textSnippets.id });
    const links = await this.db
      .delete(savedLinks)
      .where(
        and(
          eq(savedLinks.workspaceId, workspaceId),
          eq(savedLinks.isDeleted, true),
        ),
      )
      .returning({ id: savedLinks.id });

    return {
      deleted:
        media.deleted + templates.length + snippets.length + links.length,
    };
  }
}
