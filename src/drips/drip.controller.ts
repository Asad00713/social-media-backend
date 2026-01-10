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
import { DripService } from './drip.service';
import {
  CreateDripCampaignDto,
  UpdateDripCampaignDto,
  DripCampaignQueryDto,
  DripPostQueryDto,
  UpdateDripPostContentDto,
} from './dto/drip.dto';

@Controller('drips')
@UseGuards(JwtAuthGuard)
export class DripController {
  constructor(private readonly dripService: DripService) {}

  // ==========================================================================
  // Drip Campaign CRUD
  // ==========================================================================

  /**
   * Create a new drip campaign
   */
  @Post('workspaces/:workspaceId')
  @HttpCode(HttpStatus.CREATED)
  async createDripCampaign(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: CreateDripCampaignDto,
  ) {
    const campaign = await this.dripService.createDripCampaign(
      workspaceId,
      user.userId,
      dto,
    );

    return {
      campaign,
      message: `Drip campaign created with ${campaign.totalOccurrences} scheduled occurrences`,
    };
  }

  /**
   * Get all drip campaigns for a workspace
   */
  @Get('workspaces/:workspaceId')
  async getWorkspaceDripCampaigns(
    @Param('workspaceId') workspaceId: string,
    @Query() query: DripCampaignQueryDto,
  ) {
    const result = await this.dripService.getWorkspaceDripCampaigns(
      workspaceId,
      {
        status: query.status,
        limit: query.limit,
        offset: query.offset,
      },
    );

    return {
      campaigns: result.campaigns,
      total: result.total,
      limit: query.limit || 50,
      offset: query.offset || 0,
    };
  }

  /**
   * Get a specific drip campaign
   */
  @Get('workspaces/:workspaceId/:campaignId')
  async getDripCampaign(
    @Param('workspaceId') workspaceId: string,
    @Param('campaignId') campaignId: string,
  ) {
    const campaign = await this.dripService.getDripCampaign(
      campaignId,
      workspaceId,
    );
    return { campaign };
  }

  /**
   * Update a drip campaign (only draft campaigns can be modified)
   */
  @Put('workspaces/:workspaceId/:campaignId')
  async updateDripCampaign(
    @Param('workspaceId') workspaceId: string,
    @Param('campaignId') campaignId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: UpdateDripCampaignDto,
  ) {
    const campaign = await this.dripService.updateDripCampaign(
      campaignId,
      workspaceId,
      user.userId,
      dto,
    );

    return {
      campaign,
      message: 'Drip campaign updated successfully',
    };
  }

  /**
   * Delete a drip campaign
   */
  @Delete('workspaces/:workspaceId/:campaignId')
  @HttpCode(HttpStatus.OK)
  async deleteDripCampaign(
    @Param('workspaceId') workspaceId: string,
    @Param('campaignId') campaignId: string,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    await this.dripService.deleteDripCampaign(
      campaignId,
      workspaceId,
      user.userId,
    );
    return { message: 'Drip campaign deleted successfully' };
  }

  // ==========================================================================
  // Campaign Actions
  // ==========================================================================

  /**
   * Activate a drip campaign (starts generating posts and scheduling jobs)
   */
  @Post('workspaces/:workspaceId/:campaignId/activate')
  @HttpCode(HttpStatus.OK)
  async activateDripCampaign(
    @Param('workspaceId') workspaceId: string,
    @Param('campaignId') campaignId: string,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    const campaign = await this.dripService.activateDripCampaign(
      campaignId,
      workspaceId,
      user.userId,
    );

    return {
      campaign,
      message: `Drip campaign activated! ${campaign.totalOccurrences} posts scheduled.`,
    };
  }

  /**
   * Pause a drip campaign (stops new posts, keeps existing posts)
   */
  @Post('workspaces/:workspaceId/:campaignId/pause')
  @HttpCode(HttpStatus.OK)
  async pauseDripCampaign(
    @Param('workspaceId') workspaceId: string,
    @Param('campaignId') campaignId: string,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    const campaign = await this.dripService.pauseDripCampaign(
      campaignId,
      workspaceId,
      user.userId,
    );

    return {
      campaign,
      message: 'Drip campaign paused. You can resume it later.',
    };
  }

  /**
   * Cancel a drip campaign (stops and marks as cancelled)
   */
  @Post('workspaces/:workspaceId/:campaignId/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelDripCampaign(
    @Param('workspaceId') workspaceId: string,
    @Param('campaignId') campaignId: string,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    const campaign = await this.dripService.cancelDripCampaign(
      campaignId,
      workspaceId,
      user.userId,
    );

    return {
      campaign,
      message: 'Drip campaign cancelled.',
    };
  }

  // ==========================================================================
  // Drip Posts
  // ==========================================================================

  /**
   * Get all posts for a drip campaign
   */
  @Get('workspaces/:workspaceId/:campaignId/posts')
  async getDripPosts(
    @Param('workspaceId') workspaceId: string,
    @Param('campaignId') campaignId: string,
    @Query() query: DripPostQueryDto,
  ) {
    const posts = await this.dripService.getDripPosts(
      campaignId,
      workspaceId,
      {
        status: query.status,
        limit: query.limit,
        offset: query.offset,
      },
    );

    return {
      posts,
      total: posts.length,
      limit: query.limit || 100,
      offset: query.offset || 0,
    };
  }

  /**
   * Get a specific drip post
   */
  @Get('workspaces/:workspaceId/posts/:dripPostId')
  async getDripPost(
    @Param('workspaceId') workspaceId: string,
    @Param('dripPostId') dripPostId: string,
  ) {
    const post = await this.dripService.getDripPost(dripPostId, workspaceId);
    return { post };
  }

  /**
   * Update drip post content (user edits AI-generated content)
   */
  @Put('workspaces/:workspaceId/posts/:dripPostId')
  async updateDripPostContent(
    @Param('workspaceId') workspaceId: string,
    @Param('dripPostId') dripPostId: string,
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: UpdateDripPostContentDto,
  ) {
    const post = await this.dripService.updateDripPostContent(
      dripPostId,
      workspaceId,
      user.userId,
      dto,
    );

    return {
      post,
      message: 'Post content updated and approved',
    };
  }

  /**
   * Approve a drip post (approve AI-generated content without edits)
   */
  @Post('workspaces/:workspaceId/posts/:dripPostId/approve')
  @HttpCode(HttpStatus.OK)
  async approveDripPost(
    @Param('workspaceId') workspaceId: string,
    @Param('dripPostId') dripPostId: string,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    const post = await this.dripService.approveDripPost(
      dripPostId,
      workspaceId,
      user.userId,
    );

    return {
      post,
      message: 'Post approved for publishing',
    };
  }

  /**
   * Skip a drip post (don't publish this occurrence)
   */
  @Post('workspaces/:workspaceId/posts/:dripPostId/skip')
  @HttpCode(HttpStatus.OK)
  async skipDripPost(
    @Param('workspaceId') workspaceId: string,
    @Param('dripPostId') dripPostId: string,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    const post = await this.dripService.skipDripPost(
      dripPostId,
      workspaceId,
      user.userId,
    );

    return {
      post,
      message: 'Post skipped',
    };
  }

  // ==========================================================================
  // History & Analytics
  // ==========================================================================

  /**
   * Get campaign history (audit log)
   */
  @Get('workspaces/:workspaceId/:campaignId/history')
  async getCampaignHistory(
    @Param('workspaceId') workspaceId: string,
    @Param('campaignId') campaignId: string,
  ) {
    const history = await this.dripService.getCampaignHistory(
      campaignId,
      workspaceId,
    );
    return { history };
  }

  /**
   * Get campaign statistics
   */
  @Get('workspaces/:workspaceId/:campaignId/stats')
  async getCampaignStats(
    @Param('workspaceId') workspaceId: string,
    @Param('campaignId') campaignId: string,
  ) {
    const stats = await this.dripService.getCampaignStats(
      campaignId,
      workspaceId,
    );
    return { stats };
  }
}
