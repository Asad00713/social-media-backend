import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common'
import { db } from '../../drizzle/db'
import { adAccounts } from '../../drizzle/schema'
import { and, eq } from 'drizzle-orm'
import { MetaAdsClient } from './meta-ads.client'
import { ChannelService } from '../../channels/services/channel.service'

@Injectable()
export class AdAccountsService {
  private readonly logger = new Logger(AdAccountsService.name)

  constructor(
    private readonly metaClient: MetaAdsClient,
    private readonly channelService: ChannelService,
  ) {}

  /**
   * Sync the user's connected Meta ad accounts.
   * Called fire-and-forget after intent=ads OAuth completes.
   */
  async syncForChannel(workspaceId: string, channelId: number): Promise<void> {
    // getChannelForPosting returns the channel with decrypted accessToken
    const channel = await this.channelService.getChannelForPosting(channelId)

    if (!channel || channel.platform !== 'facebook') {
      throw new NotFoundException('Facebook channel not found')
    }

    if (channel.workspaceId !== workspaceId) {
      throw new ForbiddenException('Channel does not belong to this workspace')
    }

    if (!channel.accessToken) {
      throw new ForbiddenException('Channel access token unavailable')
    }

    const remote = await this.metaClient.listAdAccounts(channel.accessToken)
    this.logger.log(`Syncing ${remote.length} ad account(s) for channel ${channelId}`)

    for (const acct of remote) {
      await db
        .insert(adAccounts)
        .values({
          workspaceId,
          channelId,
          metaAdAccountId: acct.id,
          name: acct.name,
          currency: acct.currency,
          timezoneName: acct.timezone_name,
          accountStatus: acct.account_status,
          businessId: acct.business?.id ?? null,
          disableReason: acct.disable_reason ?? null,
          capabilities: acct.capabilities ?? [],
          fundingSource: acct.funding_source_details ?? null,
          lastSyncedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [adAccounts.workspaceId, adAccounts.metaAdAccountId],
          set: {
            name: acct.name,
            currency: acct.currency,
            timezoneName: acct.timezone_name,
            accountStatus: acct.account_status,
            disableReason: acct.disable_reason ?? null,
            capabilities: acct.capabilities ?? [],
            fundingSource: acct.funding_source_details ?? null,
            updatedAt: new Date(),
            lastSyncedAt: new Date(),
          },
        })
    }

    this.logger.log(`Ad account sync complete for workspace ${workspaceId}, channel ${channelId}`)
  }

  async list(workspaceId: string): Promise<(typeof adAccounts.$inferSelect)[]> {
    return db
      .select()
      .from(adAccounts)
      .where(eq(adAccounts.workspaceId, workspaceId))
  }

  async getById(
    workspaceId: string,
    id: string,
  ): Promise<typeof adAccounts.$inferSelect> {
    const [row] = await db
      .select()
      .from(adAccounts)
      .where(and(eq(adAccounts.id, id), eq(adAccounts.workspaceId, workspaceId)))

    if (!row) throw new NotFoundException('Ad account not found')
    return row
  }
}
