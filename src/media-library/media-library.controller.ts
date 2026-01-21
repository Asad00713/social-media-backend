import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CategoryService } from './services/category.service';
import { MediaItemService } from './services/media-item.service';
import { TemplateService } from './services/template.service';
import { TextSnippetService } from './services/text-snippet.service';
import { SavedLinkService } from './services/saved-link.service';
import {
  MEDIA_LIBRARY_TYPES,
  type MediaLibraryType,
} from '../drizzle/schema/media-library.schema';
import {
  CreateCategoryDto,
  UpdateCategoryDto,
  CategoryQueryDto,
  CreateMediaItemDto,
  UpdateMediaItemDto,
  MediaItemQueryDto,
  BulkActionDto,
  CreateTemplateDto,
  UpdateTemplateDto,
  TemplateQueryDto,
  CreateTextSnippetDto,
  UpdateTextSnippetDto,
  TextSnippetQueryDto,
  CreateSavedLinkDto,
  UpdateSavedLinkDto,
  SavedLinkQueryDto,
  RecycleBinQueryDto,
} from './dto/media-library.dto';

@Controller('workspaces/:workspaceId/media-library')
@UseGuards(JwtAuthGuard)
export class MediaLibraryController {
  constructor(
    private readonly categoryService: CategoryService,
    private readonly mediaItemService: MediaItemService,
    private readonly templateService: TemplateService,
    private readonly textSnippetService: TextSnippetService,
    private readonly savedLinkService: SavedLinkService,
  ) {}

  // ==========================================================================
  // Categories
  // ==========================================================================

  @Post('categories')
  @HttpCode(HttpStatus.CREATED)
  async createCategory(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateCategoryDto,
  ) {
    return this.categoryService.create(workspaceId, dto);
  }

  @Get('categories')
  @HttpCode(HttpStatus.OK)
  async getCategories(
    @Param('workspaceId') workspaceId: string,
    @Query() query: CategoryQueryDto,
  ) {
    return this.categoryService.findAll(workspaceId, query);
  }

  @Get('categories/grouped')
  @HttpCode(HttpStatus.OK)
  async getCategoriesGrouped(@Param('workspaceId') workspaceId: string) {
    return this.categoryService.findAllGroupedByType(workspaceId);
  }

  @Get('categories/:categoryId')
  @HttpCode(HttpStatus.OK)
  async getCategory(
    @Param('workspaceId') workspaceId: string,
    @Param('categoryId') categoryId: string,
  ) {
    return this.categoryService.findOne(workspaceId, categoryId);
  }

  @Put('categories/:categoryId')
  @HttpCode(HttpStatus.OK)
  async updateCategory(
    @Param('workspaceId') workspaceId: string,
    @Param('categoryId') categoryId: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.categoryService.update(workspaceId, categoryId, dto);
  }

  @Delete('categories/:categoryId')
  @HttpCode(HttpStatus.OK)
  async deleteCategory(
    @Param('workspaceId') workspaceId: string,
    @Param('categoryId') categoryId: string,
  ) {
    return this.categoryService.delete(workspaceId, categoryId);
  }

  @Post('categories/reorder')
  @HttpCode(HttpStatus.OK)
  async reorderCategories(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: { type: MediaLibraryType; categoryIds: string[] },
  ) {
    return this.categoryService.reorder(workspaceId, dto.type, dto.categoryIds);
  }

  // ==========================================================================
  // Media Items (Images, Videos, GIFs, Documents)
  // ==========================================================================

  @Post('items')
  @HttpCode(HttpStatus.CREATED)
  async createMediaItem(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: CreateMediaItemDto,
  ) {
    return this.mediaItemService.create(workspaceId, user.userId, dto);
  }

  @Get('items')
  @HttpCode(HttpStatus.OK)
  async getMediaItems(
    @Param('workspaceId') workspaceId: string,
    @Query() query: MediaItemQueryDto,
  ) {
    return this.mediaItemService.findAll(workspaceId, query);
  }

  @Get('items/recent')
  @HttpCode(HttpStatus.OK)
  async getRecentMediaItems(
    @Param('workspaceId') workspaceId: string,
    @Query('limit') limit?: number,
  ) {
    return this.mediaItemService.findRecent(workspaceId, limit);
  }

  @Get('items/:itemId')
  @HttpCode(HttpStatus.OK)
  async getMediaItem(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.mediaItemService.findOne(workspaceId, itemId);
  }

  @Put('items/:itemId')
  @HttpCode(HttpStatus.OK)
  async updateMediaItem(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateMediaItemDto,
  ) {
    return this.mediaItemService.update(workspaceId, itemId, dto);
  }

  @Delete('items/:itemId')
  @HttpCode(HttpStatus.OK)
  async deleteMediaItem(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @CurrentUser() user: { userId: string },
  ) {
    return this.mediaItemService.softDelete(workspaceId, itemId, user.userId);
  }

  @Post('items/:itemId/restore')
  @HttpCode(HttpStatus.OK)
  async restoreMediaItem(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.mediaItemService.restore(workspaceId, itemId);
  }

  @Delete('items/:itemId/permanent')
  @HttpCode(HttpStatus.OK)
  async permanentDeleteMediaItem(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.mediaItemService.permanentDelete(workspaceId, itemId);
  }

  @Post('items/bulk')
  @HttpCode(HttpStatus.OK)
  async bulkActionMediaItems(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: BulkActionDto,
  ) {
    return this.mediaItemService.bulkAction(workspaceId, user.userId, dto);
  }

  // ==========================================================================
  // Templates
  // ==========================================================================

  @Post('templates')
  @HttpCode(HttpStatus.CREATED)
  async createTemplate(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: CreateTemplateDto,
  ) {
    return this.templateService.create(workspaceId, user.userId, dto);
  }

  @Get('templates')
  @HttpCode(HttpStatus.OK)
  async getTemplates(
    @Param('workspaceId') workspaceId: string,
    @Query() query: TemplateQueryDto,
  ) {
    return this.templateService.findAll(workspaceId, query);
  }

  @Get('templates/:templateId')
  @HttpCode(HttpStatus.OK)
  async getTemplate(
    @Param('workspaceId') workspaceId: string,
    @Param('templateId') templateId: string,
  ) {
    return this.templateService.findOne(workspaceId, templateId);
  }

  @Put('templates/:templateId')
  @HttpCode(HttpStatus.OK)
  async updateTemplate(
    @Param('workspaceId') workspaceId: string,
    @Param('templateId') templateId: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    return this.templateService.update(workspaceId, templateId, dto);
  }

  @Post('templates/:templateId/clone')
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
  @HttpCode(HttpStatus.OK)
  async deleteTemplate(
    @Param('workspaceId') workspaceId: string,
    @Param('templateId') templateId: string,
    @CurrentUser() user: { userId: string },
  ) {
    return this.templateService.softDelete(workspaceId, templateId, user.userId);
  }

  @Post('templates/:templateId/restore')
  @HttpCode(HttpStatus.OK)
  async restoreTemplate(
    @Param('workspaceId') workspaceId: string,
    @Param('templateId') templateId: string,
  ) {
    return this.templateService.restore(workspaceId, templateId);
  }

  @Delete('templates/:templateId/permanent')
  @HttpCode(HttpStatus.OK)
  async permanentDeleteTemplate(
    @Param('workspaceId') workspaceId: string,
    @Param('templateId') templateId: string,
  ) {
    return this.templateService.permanentDelete(workspaceId, templateId);
  }

  // ==========================================================================
  // Text Snippets
  // ==========================================================================

  @Post('snippets')
  @HttpCode(HttpStatus.CREATED)
  async createTextSnippet(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: CreateTextSnippetDto,
  ) {
    return this.textSnippetService.create(workspaceId, user.userId, dto);
  }

  @Get('snippets')
  @HttpCode(HttpStatus.OK)
  async getTextSnippets(
    @Param('workspaceId') workspaceId: string,
    @Query() query: TextSnippetQueryDto,
  ) {
    return this.textSnippetService.findAll(workspaceId, query);
  }

  @Get('snippets/:snippetId')
  @HttpCode(HttpStatus.OK)
  async getTextSnippet(
    @Param('workspaceId') workspaceId: string,
    @Param('snippetId') snippetId: string,
  ) {
    return this.textSnippetService.findOne(workspaceId, snippetId);
  }

  @Put('snippets/:snippetId')
  @HttpCode(HttpStatus.OK)
  async updateTextSnippet(
    @Param('workspaceId') workspaceId: string,
    @Param('snippetId') snippetId: string,
    @Body() dto: UpdateTextSnippetDto,
  ) {
    return this.textSnippetService.update(workspaceId, snippetId, dto);
  }

  @Delete('snippets/:snippetId')
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
  @HttpCode(HttpStatus.OK)
  async restoreTextSnippet(
    @Param('workspaceId') workspaceId: string,
    @Param('snippetId') snippetId: string,
  ) {
    return this.textSnippetService.restore(workspaceId, snippetId);
  }

  @Delete('snippets/:snippetId/permanent')
  @HttpCode(HttpStatus.OK)
  async permanentDeleteTextSnippet(
    @Param('workspaceId') workspaceId: string,
    @Param('snippetId') snippetId: string,
  ) {
    return this.textSnippetService.permanentDelete(workspaceId, snippetId);
  }

  // ==========================================================================
  // Saved Links
  // ==========================================================================

  @Post('links')
  @HttpCode(HttpStatus.CREATED)
  async createSavedLink(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: CreateSavedLinkDto,
  ) {
    return this.savedLinkService.create(workspaceId, user.userId, dto);
  }

  @Get('links')
  @HttpCode(HttpStatus.OK)
  async getSavedLinks(
    @Param('workspaceId') workspaceId: string,
    @Query() query: SavedLinkQueryDto,
  ) {
    return this.savedLinkService.findAll(workspaceId, query);
  }

  @Get('links/:linkId')
  @HttpCode(HttpStatus.OK)
  async getSavedLink(
    @Param('workspaceId') workspaceId: string,
    @Param('linkId') linkId: string,
  ) {
    return this.savedLinkService.findOne(workspaceId, linkId);
  }

  @Put('links/:linkId')
  @HttpCode(HttpStatus.OK)
  async updateSavedLink(
    @Param('workspaceId') workspaceId: string,
    @Param('linkId') linkId: string,
    @Body() dto: UpdateSavedLinkDto,
  ) {
    return this.savedLinkService.update(workspaceId, linkId, dto);
  }

  @Post('links/:linkId/refresh-preview')
  @HttpCode(HttpStatus.OK)
  async refreshLinkPreview(
    @Param('workspaceId') workspaceId: string,
    @Param('linkId') linkId: string,
  ) {
    return this.savedLinkService.refreshPreview(workspaceId, linkId);
  }

  @Delete('links/:linkId')
  @HttpCode(HttpStatus.OK)
  async deleteSavedLink(
    @Param('workspaceId') workspaceId: string,
    @Param('linkId') linkId: string,
    @CurrentUser() user: { userId: string },
  ) {
    return this.savedLinkService.softDelete(workspaceId, linkId, user.userId);
  }

  @Post('links/:linkId/restore')
  @HttpCode(HttpStatus.OK)
  async restoreSavedLink(
    @Param('workspaceId') workspaceId: string,
    @Param('linkId') linkId: string,
  ) {
    return this.savedLinkService.restore(workspaceId, linkId);
  }

  @Delete('links/:linkId/permanent')
  @HttpCode(HttpStatus.OK)
  async permanentDeleteSavedLink(
    @Param('workspaceId') workspaceId: string,
    @Param('linkId') linkId: string,
  ) {
    return this.savedLinkService.permanentDelete(workspaceId, linkId);
  }

  // ==========================================================================
  // Recycle Bin
  // ==========================================================================

  @Get('recycle-bin')
  @HttpCode(HttpStatus.OK)
  async getRecycleBin(
    @Param('workspaceId') workspaceId: string,
    @Query() query: RecycleBinQueryDto,
  ) {
    const { type, limit = 50, offset = 0 } = query;

    // Get all deleted items based on type filter
    const results: any = {};

    if (!type || type === 'image' || type === 'video' || type === 'gif' || type === 'document') {
      const mediaResult = await this.mediaItemService.getRecycleBin(
        workspaceId,
        limit,
        offset,
      );
      if (!type) {
        results.mediaItems = mediaResult;
      } else {
        // Filter by specific type
        results.mediaItems = {
          ...mediaResult,
          items: mediaResult.items.filter((item) => item.type === type),
        };
      }
    }

    if (!type || type === 'template') {
      results.templates = await this.templateService.getRecycleBin(
        workspaceId,
        limit,
        offset,
      );
    }

    if (!type || type === 'text_snippet') {
      results.textSnippets = await this.textSnippetService.getRecycleBin(
        workspaceId,
        limit,
        offset,
      );
    }

    if (!type || type === 'link') {
      results.savedLinks = await this.savedLinkService.getRecycleBin(
        workspaceId,
        limit,
        offset,
      );
    }

    return results;
  }

  @Post('recycle-bin/empty')
  @HttpCode(HttpStatus.OK)
  async emptyRecycleBin(@Param('workspaceId') workspaceId: string) {
    // Get all items in recycle bin and permanently delete them
    const mediaItems = await this.mediaItemService.getRecycleBin(
      workspaceId,
      1000,
      0,
    );
    const templates = await this.templateService.getRecycleBin(
      workspaceId,
      1000,
      0,
    );
    const snippets = await this.textSnippetService.getRecycleBin(
      workspaceId,
      1000,
      0,
    );
    const links = await this.savedLinkService.getRecycleBin(
      workspaceId,
      1000,
      0,
    );

    let deletedCount = 0;

    // Delete all media items
    for (const item of mediaItems.items) {
      await this.mediaItemService.permanentDelete(workspaceId, item.id);
      deletedCount++;
    }

    // Delete all templates
    for (const template of templates.items) {
      await this.templateService.permanentDelete(workspaceId, template.id);
      deletedCount++;
    }

    // Delete all snippets
    for (const snippet of snippets.items) {
      await this.textSnippetService.permanentDelete(workspaceId, snippet.id);
      deletedCount++;
    }

    // Delete all links
    for (const link of links.items) {
      await this.savedLinkService.permanentDelete(workspaceId, link.id);
      deletedCount++;
    }

    return {
      success: true,
      message: `Permanently deleted ${deletedCount} items from recycle bin`,
      deletedCount,
    };
  }
}
