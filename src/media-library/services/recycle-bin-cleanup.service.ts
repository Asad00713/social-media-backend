import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { BinKind } from '../dto/contract';
import { MediaItemService } from './media-item.service';
import { TemplateService } from './template.service';
import { TextSnippetService } from './text-snippet.service';
import { SavedLinkService } from './saved-link.service';

/** What one run of the cleanup did. */
export interface CleanupRunResult {
  deleted: number;
  /** Kinds whose purge threw; the others still ran. */
  failedKinds: BinKind[];
}

/**
 * Purges every Bin row whose retention ran out, daily at 3:00 AM.
 *
 * Runs on every replica: harmless, because each kind's purge is idempotent
 * (a second runner finds nothing left to delete). A single-runner lock is the
 * later fix.
 */
@Injectable()
export class RecycleBinCleanupService {
  private readonly logger = new Logger(RecycleBinCleanupService.name);

  constructor(
    private readonly mediaItemService: MediaItemService,
    private readonly templateService: TemplateService,
    private readonly textSnippetService: TextSnippetService,
    private readonly savedLinkService: SavedLinkService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleRecycleBinCleanup(): Promise<CleanupRunResult> {
    this.logger.log('Starting recycle bin cleanup...');

    // Each kind in its own try/catch: one failing purge (storage down for
    // media, say) must not skip the others.
    const kinds: [BinKind, () => Promise<{ deletedCount: number }>][] = [
      ['media', () => this.mediaItemService.cleanupRecycleBin()],
      ['template', () => this.templateService.cleanupRecycleBin()],
      ['snippet', () => this.textSnippetService.cleanupRecycleBin()],
      ['link', () => this.savedLinkService.cleanupRecycleBin()],
    ];

    let deleted = 0;
    const failedKinds: BinKind[] = [];
    for (const [kind, purge] of kinds) {
      try {
        const { deletedCount } = await purge();
        deleted += deletedCount;
        this.logger.log(`Cleaned up ${deletedCount} ${kind} rows`);
      } catch (error) {
        failedKinds.push(kind);
        this.logger.error(`Recycle bin cleanup failed for ${kind}:`, error);
      }
    }

    this.logger.log(
      `Recycle bin cleanup completed. Total items deleted: ${deleted}${
        failedKinds.length ? `; failed: ${failedKinds.join(', ')}` : ''
      }`,
    );
    return { deleted, failedKinds };
  }

  /**
   * Manual trigger for cleanup (can be called via API if needed)
   */
  async runCleanupManually(): Promise<CleanupRunResult> {
    return this.handleRecycleBinCleanup();
  }
}
