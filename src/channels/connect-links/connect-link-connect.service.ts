import { Injectable, Logger } from '@nestjs/common';
import {
  PLATFORM_CONFIG,
  type SupportedPlatform,
} from '../../drizzle/schema/channels.schema';
import { NotificationEmitterService } from '../../notifications/notification-emitter.service';
import type { ChannelResponseDto } from '../dto/channel.dto';
import {
  ChannelConnectService,
  type ConnectTokens,
} from '../services/channel-connect.service';
import type { CreateChannelOptions } from '../services/channel.service';
import type { ResolvedConnectLink } from './connect-link-access.service';
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
  ) {}

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
