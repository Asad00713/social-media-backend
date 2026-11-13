import {
  CHANNEL_CATEGORY,
  getRefreshTokenTtlDays,
  type socialMediaChannels,
  type SupportedPlatform,
} from '../../drizzle/schema/channels.schema';
import type { ChannelResponseDto } from '../dto/channel.dto';
import type { PersonRef } from './channel-health';
import { personOf } from './people';

const DAY_MS = 24 * 60 * 60 * 1000;

export type ChannelRow = typeof socialMediaChannels.$inferSelect;

/**
 * The name a channel goes by in the app: the team's nickname when it has
 * one, else the platform's account name. A blank nickname (only possible on a
 * hand-written row; the CHECK and the DTO refuse one) falls back too.
 */
export function channelDisplayName(
  c: Pick<ChannelRow, 'nickname' | 'accountName'>,
): string {
  const nick = c.nickname?.trim();
  return nick ? nick : c.accountName;
}

/**
 * A channel row as the API returns it: no tokens, plus the derived fields.
 * `people` holds connectedBy / pausedBy (see `loadPeople`).
 */
export function toChannelResponse(
  channel: ChannelRow,
  people: Map<string, PersonRef>,
  now: Date = new Date(),
): ChannelResponseDto {
  const isTokenExpired = channel.tokenExpiresAt
    ? channel.tokenExpiresAt < now
    : false;

  const refreshTokenExpiresInDays = (() => {
    if (!channel.refreshToken || !channel.refreshTokenIssuedAt) return null;
    const ttlDays = getRefreshTokenTtlDays(
      channel.platform as SupportedPlatform,
    );
    if (ttlDays === null) return null;
    const issuedAt = new Date(channel.refreshTokenIssuedAt).getTime();
    const expiresAt = issuedAt + ttlDays * DAY_MS;
    return Math.floor((expiresAt - now.getTime()) / DAY_MS);
  })();

  return {
    id: channel.id,
    workspaceId: channel.workspaceId,
    platform: channel.platform,
    accountType: channel.accountType,
    platformAccountId: channel.platformAccountId,
    accountName: channel.accountName,
    nickname: channel.nickname ?? null,
    displayName: channelDisplayName(channel),
    showInSidebar: channel.showInSidebar ?? false,
    username: channel.username,
    profilePictureUrl: channel.profilePictureUrl,
    permissions: (channel.permissions as string[]) || [],
    capabilities: channel.capabilities as Record<string, any> | null,
    isActive: channel.isActive,
    connectionStatus: channel.connectionStatus,
    lastError: channel.lastError,
    lastSyncedAt: channel.lastSyncedAt,
    lastPostedAt: channel.lastPostedAt,
    metadata: (channel.metadata as Record<string, any>) || {},
    displayOrder: channel.displayOrder,
    timezone: channel.timezone,
    color: channel.color,
    tokenExpiresAt: channel.tokenExpiresAt,
    isTokenExpired,
    hasRefreshToken: !!channel.refreshToken,
    refreshTokenExpiresInDays,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
    category:
      CHANNEL_CATEGORY[channel.platform as SupportedPlatform] ??
      channel.category,
    pausedAt: channel.pausedAt ?? null,
    pausedBy: channel.pausedAt
      ? personOf(people, channel.pausedByUserId)
      : null,
    connectedBy: personOf(people, channel.connectedByUserId),
    // "Added through a link" is addedViaLinkAt; a connectLinkId alone (a stray
    // write, or a link row since gone) does not make it one.
    connectedVia: channel.addedViaLinkAt
      ? { kind: 'link', email: channel.addedViaLinkEmail ?? null }
      : null,
  };
}
