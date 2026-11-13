import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import { decrypt } from '../../common/utils/encryption.util';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import {
  channelConnectLinks,
  type ChannelConnectLink,
} from '../../drizzle/schema/channel-connect-links.schema';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';
import { users } from '../../drizzle/schema/users.schema';
import { workspace } from '../../drizzle/schema/workspace.schema';
import { EmailService } from '../../email/email.service';
import { displayNameOf } from '../lib/people';
import type {
  ConnectLinkConnectedDto,
  ConnectLinkDto,
  ConnectLinkResponse,
  ConnectLinkWithUrlResponse,
  CreateConnectLinkDto,
} from './dto/connect-link.dto';
import { connectLinkError } from './lib/connect-link-errors';
import {
  CONNECT_LINK_TTL_MS,
  RESEND_COOLDOWN_MS,
  createLinkToken,
  invalidNetworks,
  linkStatus,
  linkUrl,
} from './lib/connect-link-rules';

/**
 * The sender side of channel connect links: create, list, read, resend and
 * revoke. A link is a public URL (/c/<token>) a client opens to connect their
 * own accounts; only the token's hash is looked up, and the raw token is kept
 * encrypted so Copy link and Resend reuse the same URL for the link's life.
 */
@Injectable()
export class ConnectLinksService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly email: EmailService,
  ) {}

  async create(
    workspaceId: string,
    userId: string,
    dto: CreateConnectLinkDto,
  ): Promise<ConnectLinkWithUrlResponse> {
    const networks = [...new Set(dto.networks)];
    if (invalidNetworks(networks).length > 0) {
      throw connectLinkError(
        'NETWORK_NOT_OFFERED',
        'A connect link cannot offer one of those networks.',
      );
    }
    const email = dto.email?.trim() || null;
    if (dto.send && !email) {
      throw connectLinkError(
        'NO_EMAIL',
        'Add an email address to send a link.',
      );
    }

    const now = new Date();
    const token = createLinkToken();
    const url = linkUrl(token.raw);
    const expiresAt = new Date(now.getTime() + CONNECT_LINK_TTL_MS);

    // Email first: a send that fails leaves no link behind to clean up.
    if (dto.send && email) {
      const [ws, sender] = await Promise.all([
        this.workspaceName(workspaceId),
        this.userOf(userId),
      ]);
      await this.deliver(email, {
        workspaceName: ws,
        senderName: sender.name,
        networks,
        url,
        expiresAt,
      });
    }

    const [row] = await this.db
      .insert(channelConnectLinks)
      .values({
        workspaceId,
        createdByUserId: userId,
        email,
        networks,
        tokenHash: token.hash,
        tokenEncrypted: token.encrypted,
        expiresAt,
        lastSentAt: dto.send && email ? now : null,
      })
      .returning();

    return { link: (await this.toDtos([row]))[0], url };
  }

  /** Open links only (not revoked, not expired), newest first. */
  async list(workspaceId: string): Promise<ConnectLinkDto[]> {
    const now = new Date();
    const rows = await this.db
      .select()
      .from(channelConnectLinks)
      .where(
        and(
          eq(channelConnectLinks.workspaceId, workspaceId),
          isNull(channelConnectLinks.revokedAt),
          gt(channelConnectLinks.expiresAt, now),
        ),
      )
      .orderBy(desc(channelConnectLinks.createdAt));
    // The status rule lives in linkStatus alone; the query only narrows.
    return this.toDtos(rows.filter((l) => linkStatus(l, now) === 'open'));
  }

  /** One link of any status, with its URL (Copy link on an existing link). */
  async get(
    workspaceId: string,
    linkId: string,
  ): Promise<ConnectLinkWithUrlResponse> {
    const row = await this.findLink(workspaceId, linkId);
    return {
      link: (await this.toDtos([row]))[0],
      url: linkUrl(decrypt(row.tokenEncrypted)),
    };
  }

  /**
   * Email the same URL again. Does not extend the expiry. The send time is
   * claimed with a conditional update first, so two clicks at once cannot both
   * pass the cool-down; a failed send gives the claim back.
   */
  async resend(
    workspaceId: string,
    linkId: string,
  ): Promise<ConnectLinkResponse> {
    const link = await this.findLink(workspaceId, linkId);
    const now = new Date();
    const status = linkStatus(link, now);
    if (status === 'revoked') {
      throw connectLinkError('LINK_REVOKED', 'This link was cancelled.');
    }
    if (status === 'expired') {
      throw connectLinkError('LINK_EXPIRED', 'This link has expired.');
    }
    if (!link.email) {
      throw connectLinkError(
        'NO_EMAIL',
        'This link has no email address to send to. Copy the link instead.',
      );
    }

    const [claimed] = await this.db
      .update(channelConnectLinks)
      .set({ lastSentAt: now, updatedAt: now })
      .where(
        and(
          eq(channelConnectLinks.id, link.id),
          or(
            isNull(channelConnectLinks.lastSentAt),
            lte(
              channelConnectLinks.lastSentAt,
              new Date(now.getTime() - RESEND_COOLDOWN_MS),
            ),
          ),
        ),
      )
      .returning();
    if (!claimed) {
      throw connectLinkError(
        'RESEND_TOO_SOON',
        'This link was just sent. Wait a minute before sending it again.',
      );
    }

    try {
      const [ws, sender] = await Promise.all([
        this.workspaceName(workspaceId),
        this.userOf(link.createdByUserId),
      ]);
      await this.deliver(link.email, {
        workspaceName: ws,
        senderName: sender.name,
        networks: link.networks,
        url: linkUrl(decrypt(link.tokenEncrypted)),
        expiresAt: link.expiresAt,
      });
    } catch (err) {
      await this.db
        .update(channelConnectLinks)
        .set({ lastSentAt: link.lastSentAt })
        .where(eq(channelConnectLinks.id, link.id));
      throw err;
    }

    return { link: (await this.toDtos([claimed]))[0] };
  }

  /**
   * Cancel a link. Idempotent: a second revoke keeps the first revokedAt.
   * Accounts already connected through it stay.
   */
  async revoke(
    workspaceId: string,
    linkId: string,
  ): Promise<ConnectLinkResponse> {
    const link = await this.findLink(workspaceId, linkId);
    if (link.revokedAt) return { link: (await this.toDtos([link]))[0] };

    const now = new Date();
    const [revoked] = await this.db
      .update(channelConnectLinks)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(channelConnectLinks.id, link.id),
          isNull(channelConnectLinks.revokedAt),
        ),
      )
      .returning();
    // Lost a race with another revoke: theirs stands.
    const row = revoked ?? (await this.findLink(workspaceId, linkId));
    return { link: (await this.toDtos([row]))[0] };
  }

  // ---------------------------------------------------------------------------

  /** A link of THIS workspace; another workspace's link is a 404. */
  private async findLink(
    workspaceId: string,
    linkId: string,
  ): Promise<ChannelConnectLink> {
    const [row] = await this.db
      .select()
      .from(channelConnectLinks)
      .where(
        and(
          eq(channelConnectLinks.id, linkId),
          eq(channelConnectLinks.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('Connect link not found');
    return row;
  }

  private async deliver(
    to: string,
    data: Parameters<EmailService['sendChannelConnectLink']>[1],
  ): Promise<void> {
    const result = await this.email.sendChannelConnectLink(to, data);
    if (!result.success) {
      throw connectLinkError(
        'EMAIL_SEND_FAILED',
        'The email could not be sent. Try again, or copy the link.',
      );
    }
  }

  private async workspaceName(workspaceId: string): Promise<string> {
    const [row] = await this.db
      .select({ name: workspace.name })
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);
    return row?.name ?? 'a workspace';
  }

  private async userOf(
    userId: string,
  ): Promise<{ id: string; name: string; avatarUrl: string | null }> {
    const [row] = await this.db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row
      ? { id: row.id, name: displayNameOf(row), avatarUrl: row.avatarUrl }
      : { id: userId, name: 'A teammate', avatarUrl: null };
  }

  /** Links to DTOs: one users query and one channels query for the batch. */
  private async toDtos(links: ChannelConnectLink[]): Promise<ConnectLinkDto[]> {
    if (links.length === 0) return [];
    const ids = links.map((l) => l.id);
    const creatorIds = [...new Set(links.map((l) => l.createdByUserId))];

    const [creators, channels] = await Promise.all([
      this.db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          avatarUrl: users.avatarUrl,
        })
        .from(users)
        .where(inArray(users.id, creatorIds)),
      this.db
        .select({
          id: socialMediaChannels.id,
          platform: socialMediaChannels.platform,
          accountName: socialMediaChannels.accountName,
          profilePictureUrl: socialMediaChannels.profilePictureUrl,
          connectLinkId: socialMediaChannels.connectLinkId,
          addedViaLinkAt: socialMediaChannels.addedViaLinkAt,
        })
        .from(socialMediaChannels)
        .where(
          and(
            eq(socialMediaChannels.workspaceId, links[0].workspaceId),
            inArray(socialMediaChannels.connectLinkId, ids),
          ),
        )
        .orderBy(socialMediaChannels.addedViaLinkAt),
    ]);

    const creatorById = new Map(creators.map((u) => [u.id, u]));
    const connectedByLink = new Map<string, ConnectLinkConnectedDto[]>();
    for (const c of channels) {
      if (!c.connectLinkId) continue;
      const list = connectedByLink.get(c.connectLinkId) ?? [];
      list.push({
        platform: c.platform,
        channelId: c.id,
        accountName: c.accountName,
        avatarUrl: c.profilePictureUrl,
        connectedAt: c.addedViaLinkAt?.toISOString() ?? null,
      });
      connectedByLink.set(c.connectLinkId, list);
    }

    const now = new Date();
    return links.map((l) => {
      const u = creatorById.get(l.createdByUserId);
      return {
        id: l.id,
        email: l.email,
        networks: l.networks,
        status: linkStatus(l, now),
        expiresAt: l.expiresAt.toISOString(),
        createdAt: l.createdAt.toISOString(),
        lastSentAt: l.lastSentAt?.toISOString() ?? null,
        createdBy: u
          ? { id: u.id, name: displayNameOf(u), avatarUrl: u.avatarUrl }
          : { id: l.createdByUserId, name: 'A teammate', avatarUrl: null },
        connected: connectedByLink.get(l.id) ?? [],
      };
    });
  }
}
