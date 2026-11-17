import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { isIanaTimeZone } from '../common/validators/is-iana-time-zone';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { users } from '../drizzle/schema/users.schema';
import { workspace } from '../drizzle/schema/workspace.schema';
import { workspaceInvitation } from '../drizzle/schema/workspace-invitation.schema';

export interface Recipient {
  id: string;
  email: string;
  name: string | null;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  timezone: string;
}

const DEFAULT_TIMEZONE = 'UTC';

/**
 * The one place that answers "who gets this?" for notifications. Workspace
 * roles come only from current members: the owner plus ACCEPTED invitations,
 * never a pending, rejected or expired one.
 */
@Injectable()
export class RecipientsService {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  async user(userId: string): Promise<Recipient | null> {
    const [row] = await this.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, userId));
    return row ?? null;
  }

  async owner(workspaceId: string): Promise<Recipient | null> {
    const [row] = await this.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(workspace)
      .innerJoin(users, eq(users.id, workspace.ownerId))
      .where(eq(workspace.id, workspaceId));
    return row ?? null;
  }

  /** The owner plus accepted ADMIN members, one entry per person, owner first. */
  async admins(workspaceId: string): Promise<Recipient[]> {
    const owner = await this.owner(workspaceId);
    const accepted = await this.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(workspaceInvitation)
      .innerJoin(users, eq(users.id, workspaceInvitation.userId))
      .where(
        and(
          eq(workspaceInvitation.workspaceId, workspaceId),
          eq(workspaceInvitation.status, 'ACCEPTED'),
          eq(workspaceInvitation.role, 'ADMIN'),
        ),
      );
    const byId = new Map<string, Recipient>();
    if (owner) byId.set(owner.id, owner);
    for (const r of accepted) if (!byId.has(r.id)) byId.set(r.id, r);
    return [...byId.values()];
  }

  async workspace(workspaceId: string): Promise<WorkspaceInfo | null> {
    const [row] = await this.db
      .select({
        id: workspace.id,
        name: workspace.name,
        timezone: workspace.timezone,
      })
      .from(workspace)
      .where(eq(workspace.id, workspaceId));
    return row ?? null;
  }

  /**
   * The zone times are shown in for this person: the one they chose on the
   * Preferences page, else the zone of the workspace they last opened, else
   * UTC. The workspace is LEFT-joined: a person with a saved zone but no
   * last-opened workspace must still get it.
   */
  async userTimezone(userId: string): Promise<string> {
    const [row] = await this.db
      .select({
        preference: sql<string | null>`${users.preferences}->>'timezone'`,
        timezone: workspace.timezone,
      })
      .from(users)
      .leftJoin(workspace, eq(workspace.id, users.lastAccessedWorkspaceId))
      .where(eq(users.id, userId));
    if (row?.preference && isIanaTimeZone(row.preference)) {
      return row.preference;
    }
    return row?.timezone || DEFAULT_TIMEZONE;
  }

  displayName(r: { name: string | null; email: string }): string {
    return r.name || r.email;
  }
}
