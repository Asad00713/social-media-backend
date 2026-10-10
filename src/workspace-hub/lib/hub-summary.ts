import {
  CHANNEL_CATEGORY,
  type SupportedPlatform,
} from '../../drizzle/schema/channels.schema';
import type {
  HubChannelDto,
  HubMemberDto,
  WorkspaceHubSummaryDto,
} from '../dto/workspace-hub.dto';

/** How many channel logos and member avatars a card shows before "+N". */
export const PREVIEW_LIMIT = 3;

/** "Scheduled this week" means the next 7 days from now, not the calendar week. */
export const SCHEDULE_WINDOW_DAYS = 7;

const RECONNECT_STATUSES = new Set(['expired', 'revoked', 'error']);

export interface HubChannelRow {
  id: number;
  workspaceId: string;
  platform: string;
  accountName: string;
  profilePictureUrl: string | null;
  connectionStatus: string | null;
  tokenExpiresAt: Date | null;
  hasRefreshToken: boolean;
  createdAt: Date;
}

export interface HubMemberRow {
  workspaceId: string;
  userId: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
  avatarColor: string | null;
  isOwner: boolean;
  /** When the invitation was accepted; null for the owner. */
  joinedAt: Date | null;
}

export interface HubScheduledRow {
  workspaceId: string;
  count: number;
}

/**
 * Decided by platform, not by the stored `category` column, which defaults to
 * 'social' and was only backfilled where that migration ran.
 */
function isSocial(platform: string): boolean {
  return CHANNEL_CATEGORY[platform as SupportedPlatform] === 'social';
}

/**
 * The connection is broken and only the user can fix it. An expired access
 * token alone does not count when a refresh token can renew it: Google's
 * lapse every hour and are renewed on use.
 */
export function needsReconnect(row: HubChannelRow, now: Date): boolean {
  if (row.connectionStatus && RECONNECT_STATUSES.has(row.connectionStatus)) {
    return true;
  }
  return (
    !!row.tokenExpiresAt &&
    row.tokenExpiresAt.getTime() < now.getTime() &&
    !row.hasRefreshToken
  );
}

/** Email-code sign-ups have no name until onboarding asks for one. */
export function displayNameOf(name: string | null, email: string): string {
  return name?.trim() || email.split('@')[0];
}

function toChannel(row: HubChannelRow): HubChannelDto {
  return {
    id: row.id,
    platform: row.platform,
    accountName: row.accountName,
    avatarUrl: row.profilePictureUrl,
  };
}

function toMember(row: HubMemberRow): HubMemberDto {
  return {
    id: row.userId,
    name: displayNameOf(row.name, row.email),
    avatarUrl: row.avatarUrl,
    avatarColor: row.avatarColor,
  };
}

const byOldest = (a: HubChannelRow, b: HubChannelRow) =>
  a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id;

/** Owner first, then by join date; a missing date sorts last. */
const byJoinOrder = (a: HubMemberRow, b: HubMemberRow) => {
  if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
  const at = a.joinedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bt = b.joinedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return at - bt;
};

/** One person per workspace; the owner row wins over an invitation row. */
function uniqueMembers(rows: HubMemberRow[]): HubMemberRow[] {
  const byUser = new Map<string, HubMemberRow>();
  for (const row of rows) {
    const seen = byUser.get(row.userId);
    if (!seen || (row.isOwner && !seen.isOwner)) byUser.set(row.userId, row);
  }
  return [...byUser.values()];
}

/**
 * The Workspaces hub card for each workspace id, in the order given. A
 * workspace with no channels, members or posts still gets a card of zeros.
 */
export function buildHubSummaries(
  workspaceIds: string[],
  channels: HubChannelRow[],
  members: HubMemberRow[],
  scheduled: HubScheduledRow[],
  now: Date,
): WorkspaceHubSummaryDto[] {
  return workspaceIds.map((workspaceId) => {
    const social = channels
      .filter((c) => c.workspaceId === workspaceId && isSocial(c.platform))
      .sort(byOldest);
    const people = uniqueMembers(
      members.filter((m) => m.workspaceId === workspaceId),
    ).sort(byJoinOrder);
    const posts = scheduled.find((s) => s.workspaceId === workspaceId);

    return {
      workspaceId,
      channelCount: social.length,
      channels: social.slice(0, PREVIEW_LIMIT).map(toChannel),
      reconnect: social.filter((c) => needsReconnect(c, now)).map(toChannel),
      memberCount: people.length,
      members: people.slice(0, PREVIEW_LIMIT).map(toMember),
      scheduledNext7Days: posts?.count ?? 0,
    };
  });
}
