import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { socialMediaChannels } from '../drizzle/schema/channels.schema';
import { posts } from '../drizzle/schema/posts.schema';
import { users } from '../drizzle/schema/users.schema';
import { workspaceInvitation } from '../drizzle/schema/workspace-invitation.schema';
import { workspace } from '../drizzle/schema/workspace.schema';
import type { WorkspaceHubDto } from './dto/workspace-hub.dto';
import {
  SCHEDULE_WINDOW_DAYS,
  buildHubSummaries,
  type HubChannelRow,
  type HubMemberRow,
  type HubScheduledRow,
} from './lib/hub-summary';

const DAY_MS = 24 * 60 * 60 * 1000;

const memberColumns = {
  userId: users.id,
  name: users.name,
  email: users.email,
  avatarUrl: users.avatarUrl,
  avatarColor: users.avatarColor,
};

@Injectable()
export class WorkspaceHubService {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /**
   * A card for every workspace the user owns or joined, the same set
   * `/auth/me` lists. The ids come from the user's own rows, never from the
   * request, so no other workspace can be read through this.
   */
  async listSummaries(
    userId: string,
    now: Date = new Date(),
  ): Promise<WorkspaceHubDto> {
    const [owned, joined] = await Promise.all([
      this.db
        .select({ id: workspace.id })
        .from(workspace)
        .where(eq(workspace.ownerId, userId)),
      this.db
        .select({ id: workspaceInvitation.workspaceId })
        .from(workspaceInvitation)
        .where(
          and(
            eq(workspaceInvitation.userId, userId),
            eq(workspaceInvitation.status, 'ACCEPTED'),
          ),
        ),
    ]);
    const ids = [...new Set([...owned, ...joined].map((r) => r.id))];
    if (ids.length === 0) return { workspaces: [] };

    const windowEnd = new Date(now.getTime() + SCHEDULE_WINDOW_DAYS * DAY_MS);
    const [channels, owners, accepted, scheduled] = await Promise.all([
      this.db
        .select({
          id: socialMediaChannels.id,
          workspaceId: socialMediaChannels.workspaceId,
          platform: socialMediaChannels.platform,
          accountName: socialMediaChannels.accountName,
          profilePictureUrl: socialMediaChannels.profilePictureUrl,
          connectionStatus: socialMediaChannels.connectionStatus,
          tokenExpiresAt: socialMediaChannels.tokenExpiresAt,
          // Whether one exists, never the token itself.
          hasRefreshToken: sql<boolean>`${socialMediaChannels.refreshToken} is not null`,
          createdAt: socialMediaChannels.createdAt,
        })
        .from(socialMediaChannels)
        .where(
          and(
            inArray(socialMediaChannels.workspaceId, ids),
            eq(socialMediaChannels.isActive, true),
          ),
        ) as Promise<HubChannelRow[]>,
      this.db
        .select({ workspaceId: workspace.id, ...memberColumns })
        .from(workspace)
        .innerJoin(users, eq(users.id, workspace.ownerId))
        .where(inArray(workspace.id, ids)),
      this.db
        .select({
          workspaceId: workspaceInvitation.workspaceId,
          ...memberColumns,
          joinedAt: workspaceInvitation.acceptedAt,
        })
        .from(workspaceInvitation)
        .innerJoin(users, eq(users.id, workspaceInvitation.userId))
        .where(
          and(
            inArray(workspaceInvitation.workspaceId, ids),
            eq(workspaceInvitation.status, 'ACCEPTED'),
          ),
        ),
      this.db
        .select({
          workspaceId: posts.workspaceId,
          count: sql<number>`count(*)::int`,
        })
        .from(posts)
        .where(
          and(
            inArray(posts.workspaceId, ids),
            eq(posts.status, 'scheduled'),
            gte(posts.scheduledAt, now),
            lt(posts.scheduledAt, windowEnd),
          ),
        )
        .groupBy(posts.workspaceId) as Promise<HubScheduledRow[]>,
    ]);

    const members: HubMemberRow[] = [
      ...owners.map((o) => ({ ...o, isOwner: true, joinedAt: null })),
      ...accepted.map((a) => ({ ...a, isOwner: false })),
    ];

    return {
      workspaces: buildHubSummaries(ids, channels, members, scheduled, now),
    };
  }
}
