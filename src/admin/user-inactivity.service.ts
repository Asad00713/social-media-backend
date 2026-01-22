import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { users } from '../drizzle/schema';
import { eq, and, isNull, lte, sql } from 'drizzle-orm';
import { EmailService } from '../email/email.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../drizzle/schema';

@Injectable()
export class UserInactivityService {
  private readonly logger = new Logger(UserInactivityService.name);

  constructor(
    @Inject(DRIZZLE) private db: DbType,
    private emailService: EmailService,
    private notificationsService: NotificationsService,
  ) {}

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

      this.logger.log(`Sent ${type} notification to ${adminIds.length} super admin(s)`);
    } catch (error) {
      this.logger.error(`Failed to send notification to super admins: ${error.message}`);
    }
  }

  /**
   * Run daily at 2 AM to check for inactive users
   * - 15 days inactive: Send first reminder
   * - 25 days inactive: Send second reminder
   * - 30 days inactive: Send final notice + deactivate account
   * - 365 days inactive: Permanently delete account
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async handleUserInactivity() {
    this.logger.log('Starting user inactivity check...');

    try {
      await this.process15DayInactiveUsers();
      await this.process25DayInactiveUsers();
      await this.process30DayInactiveUsers();
      await this.process365DayInactiveUsers();

      this.logger.log('User inactivity check completed');
    } catch (error) {
      this.logger.error(`User inactivity check failed: ${error.message}`, error.stack);
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

    this.logger.log(`Found ${inactiveUsers.length} users inactive for 15+ days`);

    const processedUsers: string[] = [];
    for (const user of inactiveUsers) {
      try {
        // Send email
        const result = await this.emailService.sendInactivityReminder15Days(
          user.email,
          user.name || undefined,
        );

        if (result.success) {
          // Mark email as sent
          await this.db
            .update(users)
            .set({
              inactivityEmail15DaysSentAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(users.id, user.id));

          processedUsers.push(user.email);
          this.logger.log(`Sent 15-day inactivity email to ${user.email}`);
        } else {
          this.logger.error(`Failed to send 15-day email to ${user.email}: ${result.error}`);
        }
      } catch (error) {
        this.logger.error(`Error processing 15-day inactive user ${user.email}: ${error.message}`);
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

    this.logger.log(`Found ${inactiveUsers.length} users inactive for 25+ days`);

    const processedUsers: string[] = [];
    for (const user of inactiveUsers) {
      try {
        const result = await this.emailService.sendInactivityReminder25Days(
          user.email,
          user.name || undefined,
        );

        if (result.success) {
          await this.db
            .update(users)
            .set({
              inactivityEmail25DaysSentAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(users.id, user.id));

          processedUsers.push(user.email);
          this.logger.log(`Sent 25-day inactivity email to ${user.email}`);
        } else {
          this.logger.error(`Failed to send 25-day email to ${user.email}: ${result.error}`);
        }
      } catch (error) {
        this.logger.error(`Error processing 25-day inactive user ${user.email}: ${error.message}`);
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

    this.logger.log(`Found ${inactiveUsers.length} users inactive for 30+ days (will be deactivated)`);

    const deactivatedUsers: string[] = [];
    for (const user of inactiveUsers) {
      try {
        // Send deactivation notice email
        const result = await this.emailService.sendInactivityDeactivationNotice(
          user.email,
          user.name || undefined,
        );

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
        if (result.success) {
          this.logger.log(`Deactivated user ${user.email} due to 30 days inactivity (email sent)`);
        } else {
          this.logger.warn(`Deactivated user ${user.email} but email failed: ${result.error}`);
        }
      } catch (error) {
        this.logger.error(`Error processing 30-day inactive user ${user.email}: ${error.message}`);
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

    this.logger.log(`Found ${usersToDelete.length} users inactive for 365+ days (will be deleted)`);

    const deletedUsers: string[] = [];
    for (const user of usersToDelete) {
      try {
        // Delete the user
        await this.db.delete(users).where(eq(users.id, user.id));
        deletedUsers.push(user.email);
        this.logger.log(`Permanently deleted user ${user.email} due to 1 year inactivity`);
      } catch (error) {
        this.logger.error(`Error deleting inactive user ${user.email}: ${error.message}`);
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
   * Manual trigger for testing (can be called via admin endpoint)
   */
  async runManualCheck() {
    this.logger.log('Manual inactivity check triggered');
    await this.handleUserInactivity();
    return { success: true, message: 'Inactivity check completed' };
  }

  /**
   * Get inactivity statistics for admin dashboard
   */
  async getInactivityStats() {
    const now = new Date();
    const fifteenDaysAgo = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000);
    const twentyFiveDaysAgo = new Date(now.getTime() - 25 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      inactive15Days,
      inactive25Days,
      deactivatedUsers,
    ] = await Promise.all([
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
}
