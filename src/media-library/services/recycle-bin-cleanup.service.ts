import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MediaItemService } from './media-item.service';
import { TemplateService } from './template.service';
import { TextSnippetService } from './text-snippet.service';
import { SavedLinkService } from './saved-link.service';

/**
 * Scheduled service to clean up items in recycle bin older than 30 days
 * Runs daily at 3:00 AM
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

  /**
   * Run cleanup every day at 3:00 AM
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleRecycleBinCleanup() {
    this.logger.log('Starting recycle bin cleanup (items older than 30 days)...');

    try {
      // Clean up media items
      const mediaResult = await this.mediaItemService.cleanupRecycleBin();
      this.logger.log(`Cleaned up ${mediaResult.deletedCount} media items`);

      // Clean up templates
      const templateResult = await this.templateService.cleanupRecycleBin();
      this.logger.log(`Cleaned up ${templateResult.deletedCount} templates`);

      // Clean up text snippets
      const snippetResult = await this.textSnippetService.cleanupRecycleBin();
      this.logger.log(`Cleaned up ${snippetResult.deletedCount} text snippets`);

      // Clean up saved links
      const linkResult = await this.savedLinkService.cleanupRecycleBin();
      this.logger.log(`Cleaned up ${linkResult.deletedCount} saved links`);

      const totalDeleted =
        mediaResult.deletedCount +
        templateResult.deletedCount +
        snippetResult.deletedCount +
        linkResult.deletedCount;

      this.logger.log(
        `Recycle bin cleanup completed. Total items deleted: ${totalDeleted}`,
      );
    } catch (error) {
      this.logger.error('Recycle bin cleanup failed:', error);
    }
  }

  /**
   * Manual trigger for cleanup (can be called via API if needed)
   */
  async runCleanupManually() {
    return this.handleRecycleBinCleanup();
  }
}
