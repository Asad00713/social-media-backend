import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { SUSPENDED_STATUSES } from '../../auth/guards/workspace-suspended.guard';
import { decrypt } from '../../common/utils/encryption.util';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { subscriptions } from '../../drizzle/schema/billing.schema';
import {
  channelConnectLinks,
  type ChannelConnectLink,
} from '../../drizzle/schema/channel-connect-links.schema';
import {
  socialMediaChannels,
  type SupportedPlatform,
} from '../../drizzle/schema/channels.schema';
import { users } from '../../drizzle/schema/users.schema';
import { workspace } from '../../drizzle/schema/workspace.schema';
import { roleCan } from '../../workspace-members/role-capabilities';
import { WorkspaceRoleService } from '../../workspace-members/workspace-role.service';
import { displayNameOf } from '../lib/people';
import { OAuthService } from '../services/oauth.service';
import type {
  ConnectLinkPreviewDto,
  ConnectLinkStartDto,
} from './dto/connect-link.dto';
import { connectLinkError } from './lib/connect-link-errors';
import {
  hashLinkToken,
  isStateOfLink,
  linkStatus,
  type StateOwner,
} from './lib/connect-link-rules';

export interface ResolvedConnectLink {
  link: ChannelConnectLink;
  workspace: { id: string; name: string };
  sender: { id: string; name: string; email: string };
}

/** See ConnectLinkAccessService.linkOfState. */
export type StateLink =
  | { status: 'missing' }
  | { status: 'foreign' }
  | { status: 'own'; rawToken: string | null };

/**
 * The recipient side of a connect link: what a client's browser (no login)
 * may do with a token. Every entry goes through resolve()/resolveById(), which
 * re-check the link each time, so a cancelled, expired or orphaned link stops
 * working at the next request, not at the next login.
 */
@Injectable()
export class ConnectLinkAccessService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly roles: WorkspaceRoleService,
    private readonly oauth: OAuthService,
  ) {}

  /**
   * Find a link by its raw token and check it is usable. Order: not found,
   * revoked, expired, then unavailable (workspace suspended, the sender can
   * no longer manage channels, or the sender's account is suspended).
   */
  async resolve(rawToken: string): Promise<ResolvedConnectLink> {
    const [link] = await this.db
      .select()
      .from(channelConnectLinks)
      .where(eq(channelConnectLinks.tokenHash, hashLinkToken(rawToken)))
      .limit(1);
    return this.check(link);
  }

  /** The same checks by link id (the OAuth callback only has the state). */
  async resolveById(linkId: string): Promise<ResolvedConnectLink> {
    const [link] = await this.db
      .select()
      .from(channelConnectLinks)
      .where(eq(channelConnectLinks.id, linkId))
      .limit(1);
    return this.check(link);
  }

  /**
   * The link a stored OAuth state names, as the callback may use it:
   * - `missing`: there is no such link;
   * - `foreign`: the link is not the state's (another workspace or another
   *   sender). Only the public start writes a link state, so this one is
   *   forged: the callback refuses it as an invalid state and never answers
   *   it with the link's URL;
   * - `own`: the state's own link, with its raw token whatever its status
   *   (null when the stored token cannot be read). The callback must send the
   *   visitor back to `/c/<token>` even when the link died mid-flow (the page
   *   then shows why). Grants nothing by itself: every action still resolves.
   */
  async linkOfState(linkId: string, owner: StateOwner): Promise<StateLink> {
    const [row] = await this.db
      .select({
        workspaceId: channelConnectLinks.workspaceId,
        createdByUserId: channelConnectLinks.createdByUserId,
        tokenEncrypted: channelConnectLinks.tokenEncrypted,
      })
      .from(channelConnectLinks)
      .where(eq(channelConnectLinks.id, linkId))
      .limit(1);
    if (!row) return { status: 'missing' };
    if (!isStateOfLink(row, owner)) return { status: 'foreign' };
    try {
      return { status: 'own', rawToken: decrypt(row.tokenEncrypted) };
    } catch {
      return { status: 'own', rawToken: null };
    }
  }

  /**
   * What the page shows: the workspace name, who asked, when the link ends,
   * and per offered network the accounts already connected through THIS link.
   * No workspace id, channel ids or any email but the sender's.
   */
  async preview(rawToken: string): Promise<ConnectLinkPreviewDto> {
    const { link, workspace: ws, sender } = await this.resolve(rawToken);

    const channels = await this.db
      .select({
        platform: socialMediaChannels.platform,
        accountName: socialMediaChannels.accountName,
        profilePictureUrl: socialMediaChannels.profilePictureUrl,
      })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.workspaceId, link.workspaceId),
          eq(socialMediaChannels.connectLinkId, link.id),
        ),
      )
      .orderBy(socialMediaChannels.addedViaLinkAt);

    return {
      workspaceName: ws.name,
      sender: { name: sender.name, email: sender.email },
      expiresAt: link.expiresAt.toISOString(),
      networks: link.networks.map((platform) => ({
        platform,
        connected: channels
          .filter((c) => c.platform === platform)
          .map((c) => ({
            accountName: c.accountName,
            avatarUrl: c.profilePictureUrl,
          })),
      })),
    };
  }

  /**
   * Begin an OAuth connect on the sender's behalf. The state carries the link
   * id, so the callback can create the channels without a session.
   */
  async start(
    rawToken: string,
    platform: string,
  ): Promise<ConnectLinkStartDto> {
    const { link } = await this.resolve(rawToken);
    const offered = link.networks.find((n) => n === platform);
    if (!offered) {
      throw connectLinkError(
        'NETWORK_NOT_OFFERED',
        'This link does not offer that network.',
      );
    }
    const { authorizationUrl } = await this.oauth.initiateOAuth(
      link.workspaceId,
      link.createdByUserId,
      {
        // links only ever store CONNECT_LINK_NETWORKS (checked at create)
        platform: offered as SupportedPlatform,
        additionalData: { connectLinkId: link.id, intent: 'connect' },
      },
    );
    return { authorizationUrl };
  }

  // ---------------------------------------------------------------------------

  private async check(
    link: ChannelConnectLink | undefined,
  ): Promise<ResolvedConnectLink> {
    if (!link) {
      throw connectLinkError('LINK_NOT_FOUND', 'This link does not exist.');
    }
    const status = linkStatus(link, new Date());
    if (status === 'revoked') {
      throw connectLinkError('LINK_REVOKED', 'This link was cancelled.');
    }
    if (status === 'expired') {
      throw connectLinkError('LINK_EXPIRED', 'This link has expired.');
    }

    const unavailable = () =>
      connectLinkError('LINK_UNAVAILABLE', 'This link is no longer available.');

    const [ws] = await this.db
      .select({
        id: workspace.id,
        name: workspace.name,
        ownerId: workspace.ownerId,
        isActive: workspace.isActive,
      })
      .from(workspace)
      .where(eq(workspace.id, link.workspaceId))
      .limit(1);
    if (!ws || ws.isActive === false) throw unavailable();
    if (await this.billingSuspended(ws.ownerId)) throw unavailable();

    // The sender must still be allowed to add channels: a removed or
    // downgraded member's link must not keep connecting accounts in their name.
    const role = await this.roles.getRole(
      link.workspaceId,
      link.createdByUserId,
    );
    if (!role || !roleCan(role, 'channels:manage')) throw unavailable();

    // A suspended sender (admin suspension sets is_active = false, and the
    // JWT strategy then refuses them everywhere) stops acting through their
    // links too.
    const [sender] = await this.db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        isActive: users.isActive,
      })
      .from(users)
      .where(eq(users.id, link.createdByUserId))
      .limit(1);
    if (!sender || sender.isActive === false) throw unavailable();

    return {
      link,
      workspace: { id: ws.id, name: ws.name },
      sender: {
        id: sender.id,
        name: displayNameOf(sender),
        email: sender.email,
      },
    };
  }

  /** Same rule as WorkspaceSuspendedGuard: the owner's terminal billing states. */
  private async billingSuspended(ownerId: string | null): Promise<boolean> {
    if (!ownerId) return false;
    const [sub] = await this.db
      .select({ status: subscriptions.status })
      .from(subscriptions)
      .where(eq(subscriptions.userId, ownerId))
      .limit(1);
    return (
      !!sub?.status &&
      (SUSPENDED_STATUSES as readonly string[]).includes(sub.status)
    );
  }
}
