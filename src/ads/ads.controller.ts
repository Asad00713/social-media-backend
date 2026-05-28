import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { AdAccountsService } from './services/ad-accounts.service'
import { AdDraftsService } from './services/ad-drafts.service'
import { UpsertDraftDto } from './dto/draft.dto'

interface AuthUser {
  userId: string
  email: string
}

@Controller('ads/workspaces/:workspaceId')
@UseGuards(JwtAuthGuard)
export class AdsController {
  constructor(
    private readonly adAccounts: AdAccountsService,
    private readonly drafts: AdDraftsService,
  ) {}

  // ==========================================================================
  // Ad accounts
  // ==========================================================================

  /**
   * List synced Meta ad accounts for a workspace.
   * GET /ads/workspaces/:workspaceId/ad-accounts
   */
  @Get('ad-accounts')
  async list(@Param('workspaceId') wid: string) {
    const rows = await this.adAccounts.list(wid)
    return {
      adAccounts: rows.map((r) => ({
        id: r.id,
        metaId: r.metaAdAccountId,
        name: r.name,
        currency: r.currency,
        timezone: r.timezoneName,
        status: r.accountStatus,
        disableReason: r.disableReason,
        canRunAds: r.accountStatus === 1,
      })),
    }
  }

  /**
   * Trigger an ad account sync for a connected Facebook channel.
   * POST /ads/workspaces/:workspaceId/ad-accounts/sync/:channelId
   */
  @Post('ad-accounts/sync/:channelId')
  async sync(
    @Param('workspaceId') wid: string,
    @Param('channelId') channelId: string,
  ) {
    await this.adAccounts.syncForChannel(wid, Number(channelId))
    return { success: true }
  }

  /**
   * List recent FB Page posts available for boosting (boost-wizard picker).
   * GET /ads/workspaces/:workspaceId/channels/:channelId/posts-for-boost
   */
  @Get('channels/:channelId/posts-for-boost')
  async postsForBoost(
    @Param('workspaceId') wid: string,
    @Param('channelId') channelId: string,
  ) {
    const posts = await this.adAccounts.listPagePostsForBoost(wid, Number(channelId))
    return { posts }
  }

  // ==========================================================================
  // Ad drafts — wizard auto-save / resume
  // ==========================================================================

  /**
   * List all drafts for the authenticated user in a workspace.
   * GET /ads/workspaces/:workspaceId/drafts
   */
  @Get('drafts')
  listDrafts(
    @Param('workspaceId') wid: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.drafts.list(wid, user.userId)
  }

  /**
   * Create or update a draft.
   * POST /ads/workspaces/:workspaceId/drafts
   * Body: UpsertDraftDto — include `id` to update, omit to create.
   */
  @Post('drafts')
  upsertDraft(
    @Param('workspaceId') wid: string,
    @CurrentUser() user: AuthUser,
    @Body() body: UpsertDraftDto,
  ) {
    return this.drafts.upsert(wid, user.userId, body)
  }

  /**
   * Get a single draft by id.
   * GET /ads/workspaces/:workspaceId/drafts/:id
   */
  @Get('drafts/:id')
  getDraft(
    @Param('workspaceId') wid: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.drafts.get(wid, user.userId, id)
  }

  /**
   * Delete a draft by id.
   * DELETE /ads/workspaces/:workspaceId/drafts/:id
   */
  @Delete('drafts/:id')
  @HttpCode(HttpStatus.OK)
  deleteDraft(
    @Param('workspaceId') wid: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.drafts.delete(wid, user.userId, id)
  }
}
