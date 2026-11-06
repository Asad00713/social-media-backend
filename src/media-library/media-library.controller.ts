import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CategoryService } from './services/category.service';
import { MediaItemService } from './services/media-item.service';
import { TemplateService } from './services/template.service';
import { TextSnippetService } from './services/text-snippet.service';
import { SavedLinkService } from './services/saved-link.service';
import { AltTextService } from './services/alt-text.service';
import { RecycleBinService } from './services/recycle-bin.service';
import { MediaUsageService } from './services/media-usage.service';
import { CategoryZipService } from './services/category-zip.service';
import { readZipTicketSecret, signZipTicket } from './lib/zip-ticket';
import { LibraryStatsService } from './services/library-stats.service';
import {
  CreateCategoryDto,
  UpdateCategoryDto,
  CategoryQueryDto,
  ReorderCategoriesDto,
  CreateMediaItemDto,
  UpdateMediaItemDto,
  MediaItemQueryDto,
  BulkActionDto,
  CreateTemplateDto,
  UpdateTemplateDto,
  TemplateQueryDto,
  TemplateBulkDto,
  CreateTextSnippetDto,
  UpdateTextSnippetDto,
  TextSnippetQueryDto,
  SnippetBulkDto,
  CreateSavedLinkDto,
  UpdateSavedLinkDto,
  SavedLinkQueryDto,
  LinkBulkDto,
  RecycleBinQueryDto,
  BinItemsDto,
} from './dto/media-library.dto';
import {
  WorkspaceRoleGuard,
  assertRoleCan,
} from '../workspace-members/workspace-role.guard';
import { RequireCapability } from '../workspace-members/require-capability.decorator';
import { CurrentWorkspaceRole } from '../workspace-members/current-workspace-role.decorator';
import type { WorkspaceRole } from '../workspace-members/role-capabilities';

const logger = new Logger('MediaLibraryController');

@Controller('workspaces/:workspaceId/media-library')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class MediaLibraryController {
  constructor(
    private readonly categoryService: CategoryService,
    private readonly mediaItemService: MediaItemService,
    private readonly templateService: TemplateService,
    private readonly textSnippetService: TextSnippetService,
    private readonly savedLinkService: SavedLinkService,
    private readonly recycleBin: RecycleBinService,
    private readonly altText: AltTextService,
    private readonly mediaUsage: MediaUsageService,
    private readonly categoryZip: CategoryZipService,
    private readonly libraryStats: LibraryStatsService,
  ) {}

  /** Storage, Never used, Bin and tab counts in one call. */
  @Get('stats')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async getLibraryStats(@Param('workspaceId') workspaceId: string) {
    return this.libraryStats.getStats(workspaceId);
  }

  // ==========================================================================
  // Categories
  // ==========================================================================

  @Post('categories')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.CREATED)
  async createCategory(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: CreateCategoryDto,
  ) {
    return this.categoryService.create(workspaceId, user.userId, dto);
  }

  @Get('categories')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async getCategories(
    @Param('workspaceId') workspaceId: string,
    @Query() query: CategoryQueryDto,
  ) {
    return this.categoryService.findAll(workspaceId, query);
  }

  @Get('categories/grouped')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async getCategoriesGrouped(@Param('workspaceId') workspaceId: string) {
    return this.categoryService.findAllGroupedByType(workspaceId);
  }

  @Get('categories/:categoryId')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async getCategory(
    @Param('workspaceId') workspaceId: string,
    @Param('categoryId') categoryId: string,
  ) {
    return this.categoryService.findOne(workspaceId, categoryId);
  }

  @Put('categories/:categoryId')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async updateCategory(
    @Param('workspaceId') workspaceId: string,
    @Param('categoryId') categoryId: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.categoryService.update(workspaceId, categoryId, dto);
  }

  @Delete('categories/:categoryId')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async deleteCategory(
    @Param('workspaceId') workspaceId: string,
    @Param('categoryId') categoryId: string,
  ) {
    return this.categoryService.delete(workspaceId, categoryId);
  }

  @Post('categories/reorder')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async reorderCategories(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: ReorderCategoriesDto,
  ) {
    return this.categoryService.reorder(workspaceId, dto.type, dto.categoryIds);
  }

  /**
   * Step one of a folder zip download: a 5-minute ticket URL the browser can
   * navigate to without the bearer token (see LibraryZipController).
   */
  @Post('categories/:categoryId/zip-ticket')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async createCategoryZipTicket(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
    @CurrentUser() user: { userId: string },
  ): Promise<{ url: string; expiresAt: string }> {
    await this.categoryZip.assertZippable(workspaceId, categoryId);

    // Fail closed: never sign with a missing or short key, never hand out a
    // relative or `undefined/…` link.
    const secret = readZipTicketSecret();
    const apiBase = (process.env.API_PUBLIC_URL ?? '')
      .trim()
      .replace(/\/+$/, '');
    if (!secret || !apiBase) {
      const missing = [
        !secret &&
          'LIBRARY_ZIP_TICKET_SECRET is unset or shorter than 32 characters (generate one with `openssl rand -hex 32`)',
        !apiBase && 'API_PUBLIC_URL is unset',
      ].filter(Boolean);
      logger.error(`Folder zip download is disabled: ${missing.join('; ')}`);
      throw new ServiceUnavailableException(
        'Folder download is not configured',
      );
    }

    const { ticket, expiresAt } = signZipTicket(
      { workspaceId, categoryId, userId: user.userId },
      secret,
      new Date(),
    );
    return {
      url: `${apiBase}/workspaces/${workspaceId}/media-library/categories/${categoryId}/zip?ticket=${encodeURIComponent(ticket)}`,
      expiresAt,
    };
  }

  // ==========================================================================
  // Media Items (Images, Videos, GIFs, Documents)
  // ==========================================================================

  @Post('items')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.CREATED)
  async createMediaItem(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: CreateMediaItemDto,
  ) {
    return this.mediaItemService.create(workspaceId, user.userId, dto);
  }

  @Get('items')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async getMediaItems(
    @Param('workspaceId') workspaceId: string,
    @Query() query: MediaItemQueryDto,
  ) {
    return this.mediaItemService.findAll(workspaceId, query);
  }

  @Get('items/recent')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async getRecentMediaItems(
    @Param('workspaceId') workspaceId: string,
    @Query('limit') limit?: number,
  ) {
    return this.mediaItemService.findRecent(workspaceId, limit);
  }

  @Get('items/:itemId')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async getMediaItem(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.mediaItemService.findOne(workspaceId, itemId);
  }

  @Post('items/:itemId/alt-text')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async generateMediaItemAltText(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @CurrentUser() user: { userId: string },
  ) {
    return this.altText.generate(workspaceId, user.userId, itemId);
  }

  @Put('items/:itemId')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async updateMediaItem(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateMediaItemDto,
  ) {
    return this.mediaItemService.update(workspaceId, itemId, dto);
  }

  @Delete('items/:itemId')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async deleteMediaItem(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @CurrentUser() user: { userId: string },
  ) {
    return this.mediaItemService.softDelete(workspaceId, itemId, user.userId);
  }

  @Post('items/:itemId/restore')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async restoreMediaItem(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.mediaItemService.restore(workspaceId, itemId);
  }

  @Delete('items/:itemId/permanent')
  @RequireCapability('posts:publish')
  @HttpCode(HttpStatus.OK)
  async permanentDeleteMediaItem(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.mediaItemService.permanentDelete(workspaceId, itemId);
  }

  /** Called when an asset is placed into a post, so the Library can show what
   *  is actually being used. */
  @Post('items/:itemId/use')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async recordMediaItemUsage(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.mediaItemService.markUsed(workspaceId, itemId);
  }

  /** Where an item is used: posts, campaign slots and evergreen entries. */
  @Get('items/:itemId/usage')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async getMediaItemUsage(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.mediaUsage.getUsage(workspaceId, itemId);
  }

  @Post('items/bulk')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async bulkActionMediaItems(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: BulkActionDto,
    @CurrentWorkspaceRole() role?: WorkspaceRole | 'SUPER_ADMIN',
  ) {
    // Purging deletes files for good: it needs what `items/:id/permanent` and
    // `recycle-bin/empty` need (posts:publish), not the route's posts:draft.
    if (dto.action === 'permanentDelete') {
      assertRoleCan(role, 'posts:publish');
    }
    return this.mediaItemService.bulkAction(workspaceId, user.userId, dto);
  }

  // ==========================================================================
  // Templates
  // ==========================================================================

  @Post('templates')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.CREATED)
  async createTemplate(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: CreateTemplateDto,
  ) {
    return this.templateService.create(workspaceId, user.userId, dto);
  }

  @Get('templates')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async getTemplates(
    @Param('workspaceId') workspaceId: string,
    @Query() query: TemplateQueryDto,
  ) {
    return this.templateService.findAll(workspaceId, query);
  }

  @Post('templates/bulk')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async bulkTemplates(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: TemplateBulkDto,
  ) {
    return this.templateService.bulkAction(workspaceId, user.userId, dto);
  }

  @Get('templates/:templateId')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async getTemplate(
    @Param('workspaceId') workspaceId: string,
    @Param('templateId') templateId: string,
  ) {
    return this.templateService.findOne(workspaceId, templateId);
  }

  @Put('templates/:templateId')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async updateTemplate(
    @Param('workspaceId') workspaceId: string,
    @Param('templateId') templateId: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    return this.templateService.update(workspaceId, templateId, dto);
  }

  @Post('templates/:templateId/clone')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.CREATED)
  async cloneTemplate(
    @Param('workspaceId') workspaceId: string,
    @Param('templateId') templateId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: { name?: string },
  ) {
    return this.templateService.clone(
      workspaceId,
      user.userId,
      templateId,
      dto.name,
    );
  }

  @Delete('templates/:templateId')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async deleteTemplate(
    @Param('workspaceId') workspaceId: string,
    @Param('templateId') templateId: string,
    @CurrentUser() user: { userId: string },
  ) {
    return this.templateService.softDelete(
      workspaceId,
      templateId,
      user.userId,
    );
  }

  @Post('templates/:templateId/restore')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async restoreTemplate(
    @Param('workspaceId') workspaceId: string,
    @Param('templateId') templateId: string,
  ) {
    return this.templateService.restore(workspaceId, templateId);
  }

  @Delete('templates/:templateId/permanent')
  @RequireCapability('posts:publish')
  @HttpCode(HttpStatus.OK)
  async permanentDeleteTemplate(
    @Param('workspaceId') workspaceId: string,
    @Param('templateId') templateId: string,
  ) {
    return this.templateService.permanentDelete(workspaceId, templateId);
  }

  /** Called when a template is applied to a post, so "Recently used" and the
   *  "Most used" sort mean something for templates too. */
  @Post('templates/:templateId/use')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async recordTemplateUsage(
    @Param('workspaceId') workspaceId: string,
    @Param('templateId') templateId: string,
  ) {
    return this.templateService.incrementUsage(workspaceId, templateId);
  }

  // ==========================================================================
  // Text Snippets
  // ==========================================================================

  @Post('snippets')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.CREATED)
  async createTextSnippet(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: CreateTextSnippetDto,
  ) {
    return this.textSnippetService.create(workspaceId, user.userId, dto);
  }

  @Get('snippets')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async getTextSnippets(
    @Param('workspaceId') workspaceId: string,
    @Query() query: TextSnippetQueryDto,
  ) {
    return this.textSnippetService.findAll(workspaceId, query);
  }

  @Post('snippets/bulk')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async bulkTextSnippets(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: SnippetBulkDto,
  ) {
    return this.textSnippetService.bulkAction(workspaceId, user.userId, dto);
  }

  @Get('snippets/:snippetId')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async getTextSnippet(
    @Param('workspaceId') workspaceId: string,
    @Param('snippetId') snippetId: string,
  ) {
    return this.textSnippetService.findOne(workspaceId, snippetId);
  }

  @Put('snippets/:snippetId')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async updateTextSnippet(
    @Param('workspaceId') workspaceId: string,
    @Param('snippetId') snippetId: string,
    @Body() dto: UpdateTextSnippetDto,
  ) {
    return this.textSnippetService.update(workspaceId, snippetId, dto);
  }

  @Delete('snippets/:snippetId')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async deleteTextSnippet(
    @Param('workspaceId') workspaceId: string,
    @Param('snippetId') snippetId: string,
    @CurrentUser() user: { userId: string },
  ) {
    return this.textSnippetService.softDelete(
      workspaceId,
      snippetId,
      user.userId,
    );
  }

  @Post('snippets/:snippetId/restore')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async restoreTextSnippet(
    @Param('workspaceId') workspaceId: string,
    @Param('snippetId') snippetId: string,
  ) {
    return this.textSnippetService.restore(workspaceId, snippetId);
  }

  @Delete('snippets/:snippetId/permanent')
  @RequireCapability('posts:publish')
  @HttpCode(HttpStatus.OK)
  async permanentDeleteTextSnippet(
    @Param('workspaceId') workspaceId: string,
    @Param('snippetId') snippetId: string,
  ) {
    return this.textSnippetService.permanentDelete(workspaceId, snippetId);
  }

  /** Called when a snippet is copied or inserted into a post. */
  @Post('snippets/:snippetId/use')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async recordTextSnippetUsage(
    @Param('workspaceId') workspaceId: string,
    @Param('snippetId') snippetId: string,
  ) {
    return this.textSnippetService.markUsed(workspaceId, snippetId);
  }

  // ==========================================================================
  // Saved Links
  // ==========================================================================

  @Post('links')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.CREATED)
  async createSavedLink(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: CreateSavedLinkDto,
  ) {
    return this.savedLinkService.create(workspaceId, user.userId, dto);
  }

  @Get('links')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async getSavedLinks(
    @Param('workspaceId') workspaceId: string,
    @Query() query: SavedLinkQueryDto,
  ) {
    return this.savedLinkService.findAll(workspaceId, query);
  }

  @Post('links/bulk')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async bulkSavedLinks(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: LinkBulkDto,
  ) {
    return this.savedLinkService.bulkAction(workspaceId, user.userId, dto);
  }

  @Get('links/:linkId')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async getSavedLink(
    @Param('workspaceId') workspaceId: string,
    @Param('linkId') linkId: string,
  ) {
    return this.savedLinkService.findOne(workspaceId, linkId);
  }

  @Put('links/:linkId')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async updateSavedLink(
    @Param('workspaceId') workspaceId: string,
    @Param('linkId') linkId: string,
    @Body() dto: UpdateSavedLinkDto,
  ) {
    return this.savedLinkService.update(workspaceId, linkId, dto);
  }

  @Post('links/:linkId/refresh-preview')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async refreshLinkPreview(
    @Param('workspaceId') workspaceId: string,
    @Param('linkId') linkId: string,
  ) {
    return this.savedLinkService.refreshPreview(workspaceId, linkId);
  }

  @Delete('links/:linkId')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async deleteSavedLink(
    @Param('workspaceId') workspaceId: string,
    @Param('linkId') linkId: string,
    @CurrentUser() user: { userId: string },
  ) {
    return this.savedLinkService.softDelete(workspaceId, linkId, user.userId);
  }

  @Post('links/:linkId/restore')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async restoreSavedLink(
    @Param('workspaceId') workspaceId: string,
    @Param('linkId') linkId: string,
  ) {
    return this.savedLinkService.restore(workspaceId, linkId);
  }

  @Delete('links/:linkId/permanent')
  @RequireCapability('posts:publish')
  @HttpCode(HttpStatus.OK)
  async permanentDeleteSavedLink(
    @Param('workspaceId') workspaceId: string,
    @Param('linkId') linkId: string,
  ) {
    return this.savedLinkService.permanentDelete(workspaceId, linkId);
  }

  /** Called when a saved link is opened or added to a post. */
  @Post('links/:linkId/use')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async recordSavedLinkUsage(
    @Param('workspaceId') workspaceId: string,
    @Param('linkId') linkId: string,
  ) {
    return this.savedLinkService.markUsed(workspaceId, linkId);
  }

  // ==========================================================================
  // Recycle Bin
  // ==========================================================================

  /** One list across media, templates, snippets and links (contract). */
  @Get('recycle-bin')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async getRecycleBin(
    @Param('workspaceId') workspaceId: string,
    @Query() query: RecycleBinQueryDto,
  ) {
    return this.recycleBin.list(workspaceId, query);
  }

  @Post('recycle-bin/restore')
  @RequireCapability('posts:draft')
  @HttpCode(HttpStatus.OK)
  async restoreRecycleBinItems(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: BinItemsDto,
  ) {
    return this.recycleBin.restore(workspaceId, dto.items);
  }

  @Post('recycle-bin/delete')
  @RequireCapability('posts:publish')
  @HttpCode(HttpStatus.OK)
  async deleteRecycleBinItems(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: BinItemsDto,
  ) {
    return this.recycleBin.deleteForever(workspaceId, dto.items);
  }

  @Post('recycle-bin/empty')
  @RequireCapability('posts:publish')
  @HttpCode(HttpStatus.OK)
  async emptyRecycleBin(@Param('workspaceId') workspaceId: string) {
    return this.recycleBin.empty(workspaceId);
  }
}
