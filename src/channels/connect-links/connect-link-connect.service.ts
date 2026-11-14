import { ConflictException, Injectable, Logger } from '@nestjs/common';
import {
  PLATFORM_CONFIG,
  type SupportedPlatform,
} from '../../drizzle/schema/channels.schema';
import { NotificationEmitterService } from '../../notifications/notification-emitter.service';
import type { ChannelResponseDto } from '../dto/channel.dto';
import {
  CHANNEL_LIMIT_REACHED,
  errorCodeOf,
} from '../../billing/services/channel-limit.error';
import {
  ChannelConnectService,
  type ConnectTokens,
  type SettledFacebookPage,
} from '../services/channel-connect.service';
import type { CreateChannelOptions } from '../services/channel.service';
import {
  ConnectLinkAccessService,
  type ResolvedConnectLink,
} from './connect-link-access.service';
import type {
  ConnectLinkConnectedChannelDto,
  ConnectLinkFacebookConnectBody,
  ConnectLinkFacebookConnectResponse,
  ConnectLinkSkipCode,
  ConnectLinkSkippedDto,
} from './dto/connect-link.dto';
import { FacebookSelectionStore } from './facebook-selection.store';
import { connectLinkError } from './lib/connect-link-errors';

/** What the callback does next for a link connect on a token platform. */
export type LinkTokenConnectResult =
  | { kind: 'channel'; channel: ChannelResponseDto }
  | { kind: 'selection'; id: string };

/**
 * Creating channels for a client who connects through a link. The link has
 * already been resolved (open, sender still allowed); everything here runs as
 * the sender and marks each new channel with the link.
 */
@Injectable()
export class ConnectLinkConnectService {
  private readonly logger = new Logger(ConnectLinkConnectService.name);

  constructor(
    private readonly channelConnect: ChannelConnectService,
    private readonly selections: FacebookSelectionStore,
    private readonly notifications: NotificationEmitterService,
    private readonly access: ConnectLinkAccessService,
  ) {}

  // ==========================================================================
  // Public Facebook Pages (the link page, after `?selection=`)
  // ==========================================================================

  /**
   * The Pages the client's Facebook user manages - same shape as the team's
   * `POST /channels/facebook/pages`. Leaves the selection in place: the page
   * may reload or retry.
   */
  async facebookPages(rawToken: string, selectionId: string) {
    const resolved = await this.resolveForFacebook(rawToken);
    const userAccessToken = await this.selections.read(
      resolved.link.id,
      selectionId,
    );
    const pages = await this.channelConnect.listFacebookPages(userAccessToken);
    // Instagram via a Page is only connected when the link offers Instagram,
    // so the picker is not shown an Instagram account it cannot add.
    if (resolved.link.networks.includes('instagram')) return pages;
    return pages.map((page) => ({
      ...page,
      hasInstagram: false,
      instagramAccount: null,
    }));
  }

  /**
   * Connect the chosen Pages (and their Instagram accounts when asked and the
   * link offers Instagram). Uses the selection up first, so it works once,
   * and from then on never loses what was connected:
   *
   * - every channel created is returned and announced to the sender, even
   *   when the Instagram step of its Page then fails;
   * - a Page or Instagram account the workspace already has is skipped as
   *   ALREADY_CONNECTED, any other failure of one Page as CONNECT_FAILED,
   *   and the rest go on;
   * - the channel limit stops the run: the account it hit and every Page not
   *   tried yet are skipped as CHANNEL_LIMIT_REACHED.
   *
   * With nothing connected the answer is the refusal itself: the 403 limit,
   * 409 ALREADY_CONNECTED when every skip was a duplicate, else 502
   * CONNECT_FAILED.
   */
  async connectFacebook(
    rawToken: string,
    body: ConnectLinkFacebookConnectBody,
  ): Promise<ConnectLinkFacebookConnectResponse> {
    const resolved = await this.resolveForFacebook(rawToken);
    const userAccessToken = await this.selections.take(
      resolved.link.id,
      body.selection,
    );
    const includeInstagram =
      body.includeInstagram && resolved.link.networks.includes('instagram');
    const mark = this.markOf(resolved);

    const channels: ConnectLinkConnectedChannelDto[] = [];
    const skipped: ConnectLinkSkippedDto[] = [];
    const limitReachedFrom = (index: number) => {
      for (const pageId of body.pageIds.slice(index)) {
        skipped.push({
          pageId,
          platform: 'facebook',
          code: CHANNEL_LIMIT_REACHED,
        });
      }
    };

    for (const [index, pageId] of body.pageIds.entries()) {
      let settled: SettledFacebookPage;
      try {
        settled = await this.channelConnect.connectFacebookPageSettled(
          resolved.link.workspaceId,
          resolved.link.createdByUserId,
          { userAccessToken, pageId, includeInstagram, intent: 'connect' },
          mark,
        );
      } catch (err) {
        // Nothing was created for this Page.
        const code = this.skipCodeOf(err, resolved, pageId, 'facebook');
        if (code === CHANNEL_LIMIT_REACHED) {
          if (channels.length === 0) throw err;
          limitReachedFrom(index);
          break;
        }
        skipped.push({ pageId, platform: 'facebook', code });
        continue;
      }

      for (const channel of [
        settled.facebookChannel,
        settled.instagramChannel,
      ]) {
        if (!channel) continue;
        channels.push({
          platform: channel.platform,
          channelId: channel.id,
          accountName: channel.accountName,
        });
        await this.notifyConnected(resolved, channel);
      }

      if (settled.instagramError !== null) {
        const code = this.skipCodeOf(
          settled.instagramError,
          resolved,
          pageId,
          'instagram',
        );
        skipped.push({ pageId, platform: 'instagram', code });
        if (code === CHANNEL_LIMIT_REACHED) {
          limitReachedFrom(index + 1);
          break;
        }
      }
    }

    if (channels.length === 0 && skipped.length > 0) {
      if (skipped.every((s) => s.code === 'ALREADY_CONNECTED')) {
        throw connectLinkError(
          'ALREADY_CONNECTED',
          'These Pages are already connected to this workspace.',
        );
      }
      throw connectLinkError(
        'CONNECT_FAILED',
        'Facebook did not let these Pages be connected. Try again.',
      );
    }
    return { channels, skipped };
  }

  /** The per-account code of a failed Page or Instagram step. */
  private skipCodeOf(
    err: unknown,
    resolved: ResolvedConnectLink,
    pageId: string,
    platform: 'facebook' | 'instagram',
  ): ConnectLinkSkipCode {
    if (err instanceof ConflictException) return 'ALREADY_CONNECTED';
    if (errorCodeOf(err) === CHANNEL_LIMIT_REACHED) {
      return CHANNEL_LIMIT_REACHED;
    }
    this.logger.warn(
      `Connect-link ${platform} connect failed for link ${resolved.link.id}, page ${pageId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 'CONNECT_FAILED';
  }

  private async resolveForFacebook(
    rawToken: string,
  ): Promise<ResolvedConnectLink> {
    const resolved = await this.access.resolve(rawToken);
    if (!resolved.link.networks.includes('facebook')) {
      throw connectLinkError(
        'NETWORK_NOT_OFFERED',
        'This link does not offer that network.',
      );
    }
    return resolved;
  }

  /** The `createChannel` options that mark a channel as added via the link. */
  markOf(resolved: ResolvedConnectLink): CreateChannelOptions {
    return {
      connectLink: { linkId: resolved.link.id, email: resolved.link.email },
    };
  }

  /**
   * The callback's default flow for a link: no tokens go to the browser.
   * LinkedIn, YouTube and Pinterest are connected here; Facebook's user token
   * is parked as a selection for the link page's Pages picker. Any other
   * platform never reaches the default flow on a link.
   */
  async connectFromTokens(
    resolved: ResolvedConnectLink,
    platform: string,
    tokens: ConnectTokens,
  ): Promise<LinkTokenConnectResult> {
    const ws = resolved.link.workspaceId;
    const sender = resolved.link.createdByUserId;
    const mark = this.markOf(resolved);

    let channel: ChannelResponseDto;
    switch (platform) {
      case 'linkedin':
        channel = await this.channelConnect.connectLinkedIn(
          ws,
          sender,
          tokens,
          mark,
        );
        break;
      case 'youtube':
        channel = await this.channelConnect.connectYouTube(
          ws,
          sender,
          tokens,
          mark,
        );
        break;
      case 'pinterest':
        channel = await this.channelConnect.connectPinterest(
          ws,
          sender,
          tokens,
          mark,
        );
        break;
      case 'facebook':
        return {
          kind: 'selection',
          id: await this.selections.create(
            resolved.link.id,
            tokens.accessToken,
          ),
        };
      default:
        throw connectLinkError(
          'NETWORK_NOT_OFFERED',
          'This link does not offer that network.',
        );
    }

    await this.notifyConnected(resolved, channel);
    return { kind: 'channel', channel };
  }

  /**
   * Tell the sender (in-app) that the client connected an account. Never
   * fails the connect: the channel exists either way.
   */
  async notifyConnected(
    resolved: ResolvedConnectLink,
    channel: Pick<ChannelResponseDto, 'platform' | 'accountName'>,
  ): Promise<void> {
    const label =
      PLATFORM_CONFIG[channel.platform as SupportedPlatform]?.name ??
      channel.platform;
    try {
      await this.notifications.channelConnected(
        resolved.sender.id,
        label,
        channel.accountName,
        resolved.workspace.id,
      );
    } catch (err) {
      this.logger.warn(
        `Connect-link notification failed for link ${resolved.link.id}: ${(err as Error).message}`,
      );
    }
  }
}
