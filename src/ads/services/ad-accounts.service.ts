import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { db } from '../../drizzle/db';
import { adAccounts, socialMediaChannels } from '../../drizzle/schema';
import { and, eq } from 'drizzle-orm';
import { MetaAdsClient } from './meta-ads.client';
import { ChannelService } from '../../channels/services/channel.service';
import { FacebookService } from '../../channels/services/facebook.service';

@Injectable()
export class AdAccountsService {
  private readonly logger = new Logger(AdAccountsService.name);

  constructor(
    private readonly metaClient: MetaAdsClient,
    private readonly channelService: ChannelService,
    private readonly facebookService: FacebookService,
  ) {}

  /**
   * Sync the user's connected Meta ad accounts.
   *
   * Meta's `/me/adaccounts` endpoint requires a USER access token (with
   * ads_management / ads_read scopes). The channel row stores the Page
   * access token, which can't read ad accounts. So we either:
   *   1. Receive the fresh user token via the `userAccessToken` parameter
   *      (called from `connectFacebookPage` right after OAuth completes), or
   *   2. Pull a previously-cached user token from `channel.metadata.fbUserAccessToken`
   *      (stashed at connect-time so manual refreshes work)
   *
   * If neither is available the user must reconnect via the
   * Continue-with-Meta flow.
   */
  async syncForChannel(
    workspaceId: string,
    channelId: number,
    userAccessToken?: string,
  ): Promise<void> {
    const channel = await this.channelService.getChannelForPosting(channelId);

    if (!channel || channel.platform !== 'facebook') {
      throw new NotFoundException('Facebook channel not found');
    }

    if (channel.workspaceId !== workspaceId) {
      throw new ForbiddenException('Channel does not belong to this workspace');
    }

    // Prefer the freshly-passed user token. Otherwise look for one stashed
    // at connect-time in the channel metadata.
    const cachedUserToken = (
      channel.metadata as Record<string, unknown> | null
    )?.['fbUserAccessToken'];
    const tokenToUse =
      userAccessToken ??
      (typeof cachedUserToken === 'string' ? cachedUserToken : undefined);

    if (!tokenToUse) {
      throw new BadRequestException(
        'Cannot read ad accounts with a Page-scoped token. Please reconnect this Facebook page using the "Continue with Meta" flow to grant ads permissions.',
      );
    }

    const remote = await this.metaClient.listAdAccounts(tokenToUse);

    // If we got a fresh user token, cache it so manual refreshes work later.
    if (userAccessToken) {
      const nextMetadata = {
        ...((channel.metadata as Record<string, unknown> | null) ?? {}),
        fbUserAccessToken: userAccessToken,
      };
      await db
        .update(socialMediaChannels)
        .set({ metadata: nextMetadata, updatedAt: new Date() })
        .where(eq(socialMediaChannels.id, channelId));
    }

    this.logger.log(
      `Syncing ${remote.length} ad account(s) for channel ${channelId}`,
    );

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
        });
    }

    this.logger.log(
      `Ad account sync complete for workspace ${workspaceId}, channel ${channelId}`,
    );
  }

  async list(workspaceId: string): Promise<(typeof adAccounts.$inferSelect)[]> {
    return db
      .select()
      .from(adAccounts)
      .where(eq(adAccounts.workspaceId, workspaceId));
  }

  async getById(
    workspaceId: string,
    id: string,
  ): Promise<typeof adAccounts.$inferSelect> {
    const [row] = await db
      .select()
      .from(adAccounts)
      .where(
        and(eq(adAccounts.id, id), eq(adAccounts.workspaceId, workspaceId)),
      );

    if (!row) throw new NotFoundException('Ad account not found');
    return row;
  }

  /**
   * List recent FB Page posts available for boosting.
   * Used by the boost-wizard UI picker.
   */
  async listPagePostsForBoost(
    workspaceId: string,
    channelId: number,
  ): Promise<
    {
      id: string;
      message?: string;
      createdTime: string;
      fullPicture?: string;
      permalinkUrl?: string;
      attachmentsType?: string;
    }[]
  > {
    const channel = await this.channelService.getChannelForPosting(channelId);

    if (!channel || channel.platform !== 'facebook') {
      throw new NotFoundException('Facebook channel not found');
    }

    if (channel.workspaceId !== workspaceId) {
      throw new ForbiddenException('Channel does not belong to this workspace');
    }

    if (!channel.accessToken) {
      throw new ForbiddenException('Channel access token unavailable');
    }

    return this.facebookService.listPagePostsForBoost(
      channel.platformAccountId,
      channel.accessToken,
    );
  }
}
