import { Injectable, Logger, Inject } from '@nestjs/common';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import {
  INTEGRATION_PLATFORMS,
  posts,
  socialMediaChannels,
  users,
  workspace,
  workspaceInvitation,
} from '../drizzle/schema';
import {
  eq,
  and,
  gt,
  inArray,
  isNull,
  isNotNull,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { AppLinks } from '../email/links/app-links';
import { formatDay, formatMonthDay } from '../email/links/format-when';
import { EmailOutboxService } from '../email/queue/email-outbox.service';
import { accountPaused } from '../email/templates/lifecycle/account-paused';
import { inactiveReminder } from '../email/templates/lifecycle/inactive-reminder';
import { pausingSoon } from '../email/templates/lifecycle/pausing-soon';
import { NotificationsService } from '../notifications/notifications.service';
import { RecipientsService } from '../notifications/recipients.service';
import { NotificationType } from '../drizzle/schema';
import { liveWorkspaces } from '../posts/soft-delete/soft-delete';

const DAY_MS = 86_400_000;

@Injectable()
export class UserInactivityService {
  private readonly logger = new Logger(UserInactivityService.name);

  constructor(
    @Inject(DRIZZLE) private db: DbType,
    private notificationsService: NotificationsService,
    private emailOutbox: EmailOutboxService,
    private recipients: RecipientsService,
    private links: AppLinks,
  ) {}

  /**
   * The moment the inactivity clock started: the last login, else signup. The
   * same expression the sweeps select on, and part of each email's
   * idempotency key so a person who comes back and lapses again is mailed
   * again.
   */
  private lastActive(user: { lastLoginAt: Date | null; createdAt: Date }) {
    return user.lastLoginAt ?? user.createdAt;
  }

  /** F2's numbers: what is waiting in the workspace the person last opened. */
  private async workspaceSnapshot(workspaceId: string) {
    const now = new Date();
    const [channels, drafts, scheduled] = await Promise.all([
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(socialMediaChannels)
        .where(
          and(
            eq(socialMediaChannels.workspaceId, workspaceId),
            eq(socialMediaChannels.connectionStatus, 'connected'),
            notInArray(socialMediaChannels.platform, INTEGRATION_PLATFORMS),
          ),
        ),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(posts)
        .where(
          and(eq(posts.workspaceId, workspaceId), eq(posts.status, 'draft')),
        ),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(posts)
        .where(
          and(
            eq(posts.workspaceId, workspaceId),
            eq(posts.status, 'scheduled'),
            gt(posts.scheduledAt, now),
            lte(posts.scheduledAt, new Date(now.getTime() + 7 * DAY_MS)),
          ),
        ),
    ]);
    return {
      channels: Number(channels[0]?.count) || 0,
      drafts: Number(drafts[0]?.count) || 0,
      scheduledThisWeek: Number(scheduled[0]?.count) || 0,
    };
  }

  /**
   * Get all super admin user IDs for notifications
   */
  private async getSuperAdminIds(): Promise<string[]> {
    const admins = await this.db
      .select({ id: users.id })
      .from(users)
      .where(sql`${users.role} = 'SUPER_ADMIN'`);

    return admins.map((admin) => admin.id);
  }

  /**
   * Send notification to all super admins
   */
  private async notifySuperAdmins(
    type: NotificationType,
    title: string,
    message: string,
    metadata?: Record<string, unknown>,
  ) {
    try {
      const adminIds = await this.getSuperAdminIds();
      if (adminIds.length === 0) {
        this.logger.warn('No super admins found to notify');
        return;
      }

      await this.notificationsService.notifyUsers(adminIds, {
        type,
        title,
        message,
        priority: 'high',
        metadata,
        actionUrl: '/admin/users',
      });

      this.logger.log(
        `Sent ${type} notification to ${adminIds.length} super admin(s)`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send notification to super admins: ${error.message}`,
      );
    }
  }

  /**
   * DISABLED — the @Cron decorator is deliberately removed, not commented out
   * with the schedule left in place, so nothing re-enables it by accident.
   *
   * It was suspending accounts that had no business being suspended. Two
   * things made that worse than a bad flag:
   *
   *  - `lastLoginAt` is the only signal it reads. Someone using the product
   *    through a live session, a scheduled post or a connected channel counts
   *    as absent, because none of those touch that column.
   *  - The 365-day step *deletes* the user row, and `users` cascaded — so the
   *    workspaces, channels and posts went with it (since 0093 owners are
   *    skipped instead: owner_id is RESTRICT). It selects on
   *    `isActive = false`, which is precisely the state the 30-day step puts
   *    people in. A wrong suspension today is a permanent deletion in a year.
   *
   * The 15 and 25 day reminder emails were harmless on their own, but they are
   * the countdown that leads to the other two; sending them while the ending
   * is switched off would promise consequences that no longer follow.
   *
   * Everything below still works and `runManualCheck()` still calls it, so
   * this can be re-enabled once the activity signal is real (sessions, posts,
   * channel use — not just logins) and deletion is separated from suspension.
   */
  async handleUserInactivity() {
    this.logger.log('Starting user inactivity check...');

    try {
      await this.process15DayInactiveUsers();
      await this.process25DayInactiveUsers();
      await this.process30DayInactiveUsers();
      await this.process365DayInactiveUsers();

      this.logger.log('User inactivity check completed');
    } catch (error) {
      this.logger.error(
        `User inactivity check failed: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Send first reminder to users inactive for 15+ days
   */
  private async process15DayInactiveUsers() {
    const fifteenDaysAgo = new Date();
    fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);

    // Find users who:
    // - Last login was 15+ days ago (or never logged in and created 15+ days ago)
    // - Haven't received the 15-day email yet
    // - Are still active
    // - Are not SUPER_ADMIN
    const inactiveUsers = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
        lastAccessedWorkspaceId: users.lastAccessedWorkspaceId,
      })
      .from(users)
      .where(
        and(
          eq(users.isActive, true),
          sql`${users.role} != 'SUPER_ADMIN'`,
          isNull(users.inactivityEmail15DaysSentAt),
          sql`COALESCE(${users.lastLoginAt}, ${users.createdAt}) <= ${fifteenDaysAgo}`,
        ),
      );

    this.logger.log(
      `Found ${inactiveUsers.length} users inactive for 15+ days`,
    );

    const processedUsers: string[] = [];
    for (const user of inactiveUsers) {
      try {
        // F2 says what is waiting in the workspace the person last opened.
        // Nothing to say without one, so skip (and leave them unmarked).
        const ws = user.lastAccessedWorkspaceId
          ? await this.recipients.workspace(user.lastAccessedWorkspaceId)
          : null;
        if (!ws) {
          this.logger.log(
            `Skipped 15-day inactivity email for user ${user.id}: no workspace`,
          );
          continue;
        }

        const queued = await this.emailOutbox.enqueue({
          template: inactiveReminder,
          props: {
            workspaceName: ws.name,
            ...(await this.workspaceSnapshot(ws.id)),
            openUrl: this.links.frontend('/'),
          },
          to: { email: user.email, userId: user.id },
          workspaceId: null,
          idempotencyKey: `inactive-reminder.${user.id}.${this.lastActive(user).getTime()}`,
        });
        // Redis did not answer in time: leave the user unmarked, so the next
        // run tries again (the same key keeps a late add from doubling it).
        if (!queued) {
          this.logger.warn(
            `15-day inactivity email for user ${user.id} not queued; left for the next run`,
          );
          continue;
        }

        // Mark email as queued
        await this.db
          .update(users)
          .set({
            inactivityEmail15DaysSentAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(users.id, user.id));

        processedUsers.push(user.email);
        this.logger.log(`Queued 15-day inactivity email for user ${user.id}`);
      } catch (error) {
        this.logger.error(
          `Error processing 15-day inactive user ${user.id}: ${error.message}`,
        );
      }
    }

    // Notify super admins if any users were processed
    if (processedUsers.length > 0) {
      await this.notifySuperAdmins(
        'user_inactive_15_days',
        '15-Day Inactivity Alert',
        `${processedUsers.length} user(s) have been inactive for 15 days and received reminder emails: ${processedUsers.join(', ')}`,
        { userCount: processedUsers.length, users: processedUsers },
      );
    }
  }

  /**
   * Send second reminder to users inactive for 25+ days
   */
  private async process25DayInactiveUsers() {
    const twentyFiveDaysAgo = new Date();
    twentyFiveDaysAgo.setDate(twentyFiveDaysAgo.getDate() - 25);

    const inactiveUsers = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(
        and(
          eq(users.isActive, true),
          sql`${users.role} != 'SUPER_ADMIN'`,
          isNull(users.inactivityEmail25DaysSentAt),
          sql`COALESCE(${users.lastLoginAt}, ${users.createdAt}) <= ${twentyFiveDaysAgo}`,
        ),
      );

    this.logger.log(
      `Found ${inactiveUsers.length} users inactive for 25+ days`,
    );

    const processedUsers: string[] = [];
    for (const user of inactiveUsers) {
      try {
        // The pause lands 30 days after the last activity, as the 30-day
        // sweep counts it.
        const lastActive = this.lastActive(user);
        const pauseOn = new Date(lastActive.getTime() + 30 * DAY_MS);
        const queued = await this.emailOutbox.enqueue({
          template: pausingSoon,
          props: {
            pauseDate: formatMonthDay(
              pauseOn,
              await this.recipients.userTimezone(user.id),
            ),
            signInUrl: this.links.frontend('/login'),
          },
          to: { email: user.email, userId: user.id },
          workspaceId: null,
          idempotencyKey: `pausing-soon.${user.id}.${lastActive.getTime()}`,
        });
        if (!queued) {
          this.logger.warn(
            `25-day inactivity email for user ${user.id} not queued; left for the next run`,
          );
          continue;
        }

        await this.db
          .update(users)
          .set({
            inactivityEmail25DaysSentAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(users.id, user.id));

        processedUsers.push(user.email);
        this.logger.log(`Queued 25-day inactivity email for user ${user.id}`);
      } catch (error) {
        this.logger.error(
          `Error processing 25-day inactive user ${user.id}: ${error.message}`,
        );
      }
    }

    // Notify super admins if any users were processed
    if (processedUsers.length > 0) {
      await this.notifySuperAdmins(
        'user_inactive_25_days',
        '25-Day Inactivity Warning',
        `${processedUsers.length} user(s) have been inactive for 25 days and received warning emails: ${processedUsers.join(', ')}`,
        { userCount: processedUsers.length, users: processedUsers },
      );
    }
  }

  /**
   * Send final notice and deactivate users inactive for 30+ days
   */
  private async process30DayInactiveUsers() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const inactiveUsers = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(
        and(
          eq(users.isActive, true),
          sql`${users.role} != 'SUPER_ADMIN'`,
          isNull(users.inactivityEmail30DaysSentAt),
          sql`COALESCE(${users.lastLoginAt}, ${users.createdAt}) <= ${thirtyDaysAgo}`,
        ),
      );

    this.logger.log(
      `Found ${inactiveUsers.length} users inactive for 30+ days (will be deactivated)`,
    );

    const deactivatedUsers: string[] = [];
    for (const user of inactiveUsers) {
      try {
        // Queue the pause notice (F4). Suspend regardless of whether it could
        // be queued, as before.
        let noticeQueued = true;
        try {
          const now = new Date();
          const timeZone = await this.recipients.userTimezone(user.id);
          noticeQueued = await this.emailOutbox.enqueue({
            template: accountPaused,
            props: {
              pausedSince: formatDay(now, timeZone),
              // The 365-day step deletes a year after the suspension.
              deleteOn: formatDay(
                new Date(now.getTime() + 365 * DAY_MS),
                timeZone,
              ),
              signInUrl: this.links.frontend('/login'),
              supportEmail: this.links.supportEmail(),
            },
            to: { email: user.email, userId: user.id },
            workspaceId: null,
            idempotencyKey: `account-paused.${user.id}.${this.lastActive(user).getTime()}`,
          });
        } catch (error) {
          noticeQueued = false;
          this.logger.warn(
            `Could not queue the pause notice for user ${user.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        // Deactivate the user regardless of email success
        await this.db
          .update(users)
          .set({
            isActive: false,
            suspendedAt: new Date(),
            suspendedReason: 'inactivity',
            suspensionNote: 'Auto-deactivated due to 30 days of inactivity',
            inactivityEmail30DaysSentAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(users.id, user.id));

        deactivatedUsers.push(user.email);
        this.logger.log(
          `Deactivated user ${user.id} due to 30 days inactivity (${noticeQueued ? 'notice queued' : 'notice not queued'})`,
        );
      } catch (error) {
        this.logger.error(
          `Error processing 30-day inactive user ${user.id}: ${error.message}`,
        );
      }
    }

    // Notify super admins if any users were deactivated
    if (deactivatedUsers.length > 0) {
      await this.notifySuperAdmins(
        'user_deactivated_30_days',
        'Users Deactivated - 30 Days Inactive',
        `${deactivatedUsers.length} user(s) have been automatically deactivated due to 30 days of inactivity: ${deactivatedUsers.join(', ')}`,
        { userCount: deactivatedUsers.length, users: deactivatedUsers },
      );
    }
  }

  /**
   * Permanently delete users inactive for 365+ days
   */
  private async process365DayInactiveUsers() {
    const oneYearAgo = new Date();
    oneYearAgo.setDate(oneYearAgo.getDate() - 365);

    // Warning: 30 days before deletion (335 days inactive)
    const warningDate = new Date();
    warningDate.setDate(warningDate.getDate() - 335);

    // First, send warning emails to users approaching 1 year
    const usersApproachingDeletion = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        suspendedAt: users.suspendedAt,
      })
      .from(users)
      .where(
        and(
          eq(users.isActive, false),
          eq(users.suspendedReason, 'inactivity'),
          sql`${users.role} != 'SUPER_ADMIN'`,
          sql`${users.suspendedAt} <= ${warningDate}`,
          sql`${users.suspendedAt} > ${oneYearAgo}`,
        ),
      );

    // Note: We're not tracking deletion warning emails separately
    // In production, you might want to add another field for this

    // Now delete users who have been inactive for 1 year
    const usersToDelete = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
      })
      .from(users)
      .where(
        and(
          eq(users.isActive, false),
          eq(users.suspendedReason, 'inactivity'),
          sql`${users.role} != 'SUPER_ADMIN'`,
          sql`${users.suspendedAt} <= ${oneYearAgo}`,
        ),
      );

    this.logger.log(
      `Found ${usersToDelete.length} users inactive for 365+ days (will be deleted)`,
    );

    // workspace.owner_id is ON DELETE RESTRICT since 0093, so deleting an
    // owner fails with 23001 and would fail again on every run. Owners are
    // skipped, once, by id.
    // TODO(settings Part A, Task 21): route this purge through
    // AccountDeletionService.deleteAccount (soft delete + anonymise) instead
    // of a hard DELETE, and decide what happens to an inactive owner's
    // workspaces there.
    const owners = await this.workspaceOwnersAmong(
      usersToDelete.map((u) => u.id),
    );
    if (owners.size > 0) {
      this.logger.warn(
        `Skipped ${owners.size} inactive workspace owner(s), not deleted: ${[...owners].join(', ')}`,
      );
    }

    const deletedUsers: string[] = [];
    for (const user of usersToDelete) {
      if (owners.has(user.id)) continue;
      try {
        // Delete the user
        await this.db.delete(users).where(eq(users.id, user.id));
        deletedUsers.push(user.email);
        this.logger.log(
          `Permanently deleted user ${user.email} due to 1 year inactivity`,
        );
      } catch (error) {
        this.logger.error(
          `Error deleting inactive user ${user.email}: ${error.message}`,
        );
      }
    }

    // Notify super admins if any users were deleted
    if (deletedUsers.length > 0) {
      await this.notifySuperAdmins(
        'user_deleted_365_days',
        'Users Permanently Deleted - 1 Year Inactive',
        `${deletedUsers.length} user(s) have been permanently deleted due to 1 year of inactivity: ${deletedUsers.join(', ')}`,
        { userCount: deletedUsers.length, users: deletedUsers },
      );
    }
  }

  /**
   * Which of these users own at least one workspace row.
   *
   * Deliberately NOT filtered by liveWorkspaces(): this guards a HARD user
   * delete, and workspace.owner_id is ON DELETE RESTRICT (0093). A
   * soft-deleted workspace is still a row until the purge removes it, so its
   * owner would fail the delete with 23503 all the same.
   */
  private async workspaceOwnersAmong(userIds: string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await this.db
      .select({ ownerId: workspace.ownerId })
      .from(workspace)
      .where(inArray(workspace.ownerId, userIds));
    return new Set(rows.map((r) => r.ownerId));
  }

  /**
   * Manual trigger, reachable at POST /admin/inactivity/run-check.
   *
   * Refuses for the same reason the schedule is off. Turning off the cron
   * while leaving this callable would only mean the suspensions and deletions
   * arrive when somebody presses a button instead of at 2 AM — the same
   * damage, harder to explain afterwards.
   */
  async runManualCheck() {
    this.logger.warn(
      'Manual inactivity check refused: the inactivity sweep is disabled.',
    );

    return {
      success: false,
      message:
        'The inactivity sweep is disabled. It suspends accounts on last-login alone, and its 365-day step deletes them along with their workspaces. Re-enable it once activity means more than a login and deletion is separated from suspension.',
    };
  }

  /**
   * Get inactivity statistics for admin dashboard
   */
  async getInactivityStats() {
    const now = new Date();
    const fifteenDaysAgo = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000);
    const twentyFiveDaysAgo = new Date(
      now.getTime() - 25 * 24 * 60 * 60 * 1000,
    );
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [inactive15Days, inactive25Days, deactivatedUsers] =
      await Promise.all([
        // Users inactive 15-24 days
        this.db
          .select({ count: sql<number>`count(*)` })
          .from(users)
          .where(
            and(
              eq(users.isActive, true),
              sql`COALESCE(${users.lastLoginAt}, ${users.createdAt}) <= ${fifteenDaysAgo}`,
              sql`COALESCE(${users.lastLoginAt}, ${users.createdAt}) > ${twentyFiveDaysAgo}`,
            ),
          ),
        // Users inactive 25-29 days
        this.db
          .select({ count: sql<number>`count(*)` })
          .from(users)
          .where(
            and(
              eq(users.isActive, true),
              sql`COALESCE(${users.lastLoginAt}, ${users.createdAt}) <= ${twentyFiveDaysAgo}`,
              sql`COALESCE(${users.lastLoginAt}, ${users.createdAt}) > ${thirtyDaysAgo}`,
            ),
          ),
        // Users deactivated due to inactivity
        this.db
          .select({ count: sql<number>`count(*)` })
          .from(users)
          .where(
            and(
              eq(users.isActive, false),
              eq(users.suspendedReason, 'inactivity'),
            ),
          ),
      ]);

    return {
      inactive15to24Days: Number(inactive15Days[0]?.count) || 0,
      inactive25to29Days: Number(inactive25Days[0]?.count) || 0,
      deactivatedDueToInactivity: Number(deactivatedUsers[0]?.count) || 0,
    };
  }

  /**
   * Get inactivity email statistics - total counts and per workspace breakdown
   */
  async getInactivityEmailStats() {
    // Get total email counts
    const [totalEmails] = await this.db
      .select({
        emails15Days: sql<number>`count(*) FILTER (WHERE ${users.inactivityEmail15DaysSentAt} IS NOT NULL)`,
        emails25Days: sql<number>`count(*) FILTER (WHERE ${users.inactivityEmail25DaysSentAt} IS NOT NULL)`,
        emails30Days: sql<number>`count(*) FILTER (WHERE ${users.inactivityEmail30DaysSentAt} IS NOT NULL)`,
      })
      .from(users)
      .where(sql`${users.role} != 'SUPER_ADMIN'`);

    // Get users who received any inactivity email with their workspace info
    // A user can be: workspace owner OR workspace member (accepted invitation)
    const usersWithEmails = await this.db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        email15DaysSentAt: users.inactivityEmail15DaysSentAt,
        email25DaysSentAt: users.inactivityEmail25DaysSentAt,
        email30DaysSentAt: users.inactivityEmail30DaysSentAt,
        isActive: users.isActive,
      })
      .from(users)
      .where(
        and(
          sql`${users.role} != 'SUPER_ADMIN'`,
          or(
            isNotNull(users.inactivityEmail15DaysSentAt),
            isNotNull(users.inactivityEmail25DaysSentAt),
            isNotNull(users.inactivityEmail30DaysSentAt),
          ),
        ),
      );

    // Get workspace stats per user (as owner)
    const workspacesByOwner = await this.db
      .select({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        ownerId: workspace.ownerId,
      })
      .from(workspace)
      .where(liveWorkspaces());

    // Get workspace memberships
    const memberships = await this.db
      .select({
        workspaceId: workspaceInvitation.workspaceId,
        userId: workspaceInvitation.userId,
      })
      .from(workspaceInvitation)
      .where(eq(workspaceInvitation.status, 'ACCEPTED'));

    // Build workspace stats map
    const workspaceStatsMap = new Map<
      string,
      {
        workspaceId: string;
        workspaceName: string;
        emails15Days: number;
        emails25Days: number;
        emails30Days: number;
        totalEmails: number;
        affectedUsers: { email: string; name: string | null; status: string }[];
      }
    >();

    // Initialize workspaces
    for (const ws of workspacesByOwner) {
      workspaceStatsMap.set(ws.workspaceId, {
        workspaceId: ws.workspaceId,
        workspaceName: ws.workspaceName,
        emails15Days: 0,
        emails25Days: 0,
        emails30Days: 0,
        totalEmails: 0,
        affectedUsers: [],
      });
    }

    // Process each user with emails
    for (const user of usersWithEmails) {
      // Find workspaces this user belongs to (as owner or member)
      const userWorkspaces = new Set<string>();

      // As owner
      for (const ws of workspacesByOwner) {
        if (ws.ownerId === user.userId) {
          userWorkspaces.add(ws.workspaceId);
        }
      }

      // As member
      for (const membership of memberships) {
        if (membership.userId === user.userId) {
          userWorkspaces.add(membership.workspaceId);
        }
      }

      // Count emails for each workspace
      for (const wsId of userWorkspaces) {
        const stats = workspaceStatsMap.get(wsId);
        if (stats) {
          if (user.email15DaysSentAt) stats.emails15Days++;
          if (user.email25DaysSentAt) stats.emails25Days++;
          if (user.email30DaysSentAt) stats.emails30Days++;

          const userEmailCount =
            (user.email15DaysSentAt ? 1 : 0) +
            (user.email25DaysSentAt ? 1 : 0) +
            (user.email30DaysSentAt ? 1 : 0);
          stats.totalEmails += userEmailCount;

          // Add user to affected users list if not already there
          const existingUser = stats.affectedUsers.find(
            (u) => u.email === user.email,
          );
          if (!existingUser) {
            stats.affectedUsers.push({
              email: user.email,
              name: user.name,
              status: user.isActive ? 'active' : 'deactivated',
            });
          }
        }
      }
    }

    // Convert map to array and sort by total emails
    const workspaceStats = Array.from(workspaceStatsMap.values())
      .filter((ws) => ws.totalEmails > 0)
      .sort((a, b) => b.totalEmails - a.totalEmails);

    return {
      totals: {
        emails15Days: Number(totalEmails?.emails15Days) || 0,
        emails25Days: Number(totalEmails?.emails25Days) || 0,
        emails30Days: Number(totalEmails?.emails30Days) || 0,
        totalEmails:
          (Number(totalEmails?.emails15Days) || 0) +
          (Number(totalEmails?.emails25Days) || 0) +
          (Number(totalEmails?.emails30Days) || 0),
      },
      byWorkspace: workspaceStats,
      usersWithNoWorkspace: usersWithEmails
        .filter((user) => {
          // Check if user has any workspace
          const hasWorkspace =
            workspacesByOwner.some((ws) => ws.ownerId === user.userId) ||
            memberships.some((m) => m.userId === user.userId);
          return !hasWorkspace;
        })
        .map((user) => ({
          email: user.email,
          name: user.name,
          emails15Days: user.email15DaysSentAt ? 1 : 0,
          emails25Days: user.email25DaysSentAt ? 1 : 0,
          emails30Days: user.email30DaysSentAt ? 1 : 0,
          status: user.isActive ? 'active' : 'deactivated',
        })),
    };
  }
}
