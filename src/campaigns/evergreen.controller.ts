import { Controller, Post, Patch, Delete, Body, Param, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { EvergreenService } from './evergreen.service';
import { EvergreenScoringService } from './evergreen-scoring.service';
import {
  CreateEvergreenCampaignDto,
  CreateEvergreenCategoryDto,
  UpdateEvergreenCategoryDto,
  SetCategoryActiveDto,
  CreateEvergreenPostDto,
  UpdateEvergreenPostDto,
  AddVariationDto,
  GenerateVariationsDto,
} from './dto/evergreen.dto';

@Controller('campaigns')
@UseGuards(JwtAuthGuard)
export class EvergreenController {
  constructor(
    private readonly evergreen: EvergreenService,
    private readonly scoring: EvergreenScoringService,
  ) {}

  // ==========================================================================
  // Campaign
  // ==========================================================================

  @Post('workspaces/:workspaceId/evergreen')
  @HttpCode(HttpStatus.CREATED)
  async createCampaign(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: CreateEvergreenCampaignDto,
  ) {
    return this.evergreen.createCampaign(workspaceId, user.userId, dto);
  }

  // ==========================================================================
  // Categories
  // ==========================================================================

  @Post('workspaces/:workspaceId/evergreen/:id/categories')
  @HttpCode(HttpStatus.OK)
  async addCategory(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: CreateEvergreenCategoryDto,
  ) {
    return this.evergreen.addCategory(workspaceId, id, dto);
  }

  @Patch('workspaces/:workspaceId/evergreen/:id/categories/:catId')
  async updateCategory(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Param('catId') catId: string,
    @Body() dto: UpdateEvergreenCategoryDto,
  ) {
    return this.evergreen.updateCategory(workspaceId, id, catId, dto);
  }

  @Patch('workspaces/:workspaceId/evergreen/:id/categories/:catId/active')
  async setCategoryActive(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Param('catId') catId: string,
    @Body() dto: SetCategoryActiveDto,
  ) {
    return this.evergreen.setCategoryActive(workspaceId, id, catId, dto.isActive);
  }

  @Delete('workspaces/:workspaceId/evergreen/:id/categories/:catId')
  @HttpCode(HttpStatus.OK)
  async removeCategory(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Param('catId') catId: string,
  ) {
    return this.evergreen.removeCategory(workspaceId, id, catId);
  }

  // ==========================================================================
  // Pool posts
  // ==========================================================================

  @Post('workspaces/:workspaceId/evergreen/:id/categories/:catId/posts')
  @HttpCode(HttpStatus.OK)
  async addPost(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Param('catId') catId: string,
    @Body() dto: CreateEvergreenPostDto,
  ) {
    return this.evergreen.addPost(workspaceId, id, catId, dto);
  }

  // NOTE: EvergreenService.updatePost/removePost require categoryId as a
  // positional arg (Task 4, already committed), so these routes carry
  // `:catId` even though the design doc's flatter `.../posts/:postId` shape
  // does not. See task-5-report.md for the full rationale.
  @Patch('workspaces/:workspaceId/evergreen/:id/categories/:catId/posts/:postId')
  async updatePost(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Param('catId') catId: string,
    @Param('postId') postId: string,
    @Body() dto: UpdateEvergreenPostDto,
  ) {
    return this.evergreen.updatePost(workspaceId, id, catId, postId, dto);
  }

  @Delete('workspaces/:workspaceId/evergreen/:id/categories/:catId/posts/:postId')
  @HttpCode(HttpStatus.OK)
  async removePost(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Param('catId') catId: string,
    @Param('postId') postId: string,
  ) {
    return this.evergreen.removePost(workspaceId, id, catId, postId);
  }

  // ==========================================================================
  // Variations (D1 — AI + manual)
  //
  // Same category-scoped path shape as the post CRUD routes above (Task 5's
  // ruling: `EvergreenService`'s post-scoped methods require categoryId as a
  // positional arg, so the route carries `:catId` rather than the flatter
  // `.../posts/:postId/variations` shape).
  // ==========================================================================

  @Post(
    'workspaces/:workspaceId/evergreen/:id/categories/:catId/posts/:postId/variations/generate',
  )
  @HttpCode(HttpStatus.OK)
  async generateVariations(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Param('catId') catId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: GenerateVariationsDto,
  ) {
    return this.evergreen.generateVariations(
      workspaceId,
      user.userId,
      id,
      catId,
      postId,
      dto?.count,
    );
  }

  @Post('workspaces/:workspaceId/evergreen/:id/categories/:catId/posts/:postId/variations')
  @HttpCode(HttpStatus.OK)
  async addVariation(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Param('catId') catId: string,
    @Param('postId') postId: string,
    @Body() dto: AddVariationDto,
  ) {
    return this.evergreen.addVariation(workspaceId, id, catId, postId, dto);
  }

  @Delete(
    'workspaces/:workspaceId/evergreen/:id/categories/:catId/posts/:postId/variations/:variationId',
  )
  @HttpCode(HttpStatus.OK)
  async removeVariation(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Param('catId') catId: string,
    @Param('postId') postId: string,
    @Param('variationId') variationId: string,
  ) {
    return this.evergreen.removeVariation(workspaceId, id, catId, postId, variationId);
  }

  // ==========================================================================
  // Freshness guard (D3) — same category-scoped path shape as the pool-post
  // and variations routes above.
  //
  // Returns the re-assembled `EvergreenCampaignDto` (not just the bare
  // verdict) so the frontend can refresh a single card's stale badge from
  // this response the same way every other mutation route here does,
  // without a second round-trip.
  // ==========================================================================

  @Post(
    'workspaces/:workspaceId/evergreen/:id/categories/:catId/posts/:postId/freshness-check',
  )
  @HttpCode(HttpStatus.OK)
  async checkFreshness(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Param('catId') catId: string,
    @Param('postId') postId: string,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    await this.scoring.checkFreshness(workspaceId, user.userId, id, catId, postId);
    return this.evergreen.assembleEvergreen(id);
  }
}
