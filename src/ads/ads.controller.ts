import { Controller, Get, Post, Param, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { AdAccountsService } from './services/ad-accounts.service'

@Controller('ads/workspaces/:workspaceId')
@UseGuards(JwtAuthGuard)
export class AdsController {
  constructor(private readonly adAccounts: AdAccountsService) {}

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
}
