import { Injectable } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsGateway } from './notifications.gateway';
import type { Notification, NotificationPriority } from 'src/drizzle/schema';

/**
 * Helper service for emitting notifications from other services.
 * This provides a clean API for sending various types of notifications.
 */
@Injectable()
export class NotificationEmitterService {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly notificationsGateway: NotificationsGateway,
  ) {}

  /**
   * Create and emit a notification to a user
   */
  private async emitNotification(
    userId: string,
    type: Notification['type'],
    title: string,
    message: string,
    options?: {
      priority?: NotificationPriority;
      metadata?: Record<string, unknown>;
      actionUrl?: string;
    },
  ): Promise<Notification> {
    const notification = await this.notificationsService.create({
      userId,
      type,
      title,
      message,
      priority: options?.priority || 'medium',
      metadata: options?.metadata,
      actionUrl: options?.actionUrl,
    });

    // Send via WebSocket if user is connected
    this.notificationsGateway.sendNotificationToUser(userId, notification);

    // Update unread count
    const unreadCount = await this.notificationsService.getUnreadCount(userId);
    this.notificationsGateway.sendUnreadCountUpdate(userId, unreadCount);

    return notification;
  }

  // ==================== Auth & Account ====================

  async emailVerified(userId: string) {
    return this.emitNotification(
      userId,
      'email_verified',
      'Email Verified',
      'Your email has been successfully verified. Welcome to the platform!',
      { priority: 'medium' },
    );
  }

  async passwordChanged(userId: string) {
    return this.emitNotification(
      userId,
      'password_changed',
      'Password Changed',
      'Your password has been successfully changed. If you did not make this change, please contact support immediately.',
      { priority: 'high' },
    );
  }

  async newLogin(userId: string, device?: string, location?: string) {
    return this.emitNotification(
      userId,
      'new_login',
      'New Login Detected',
      `A new login was detected${device ? ` from ${device}` : ''}${location ? ` in ${location}` : ''}.`,
      { priority: 'high', metadata: { device, location } },
    );
  }

  // ==================== Workspace ====================

  async workspaceInvitation(
    userId: string,
    workspaceName: string,
    inviterName: string,
    workspaceId: string,
  ) {
    return this.emitNotification(
      userId,
      'workspace_invitation',
      'Workspace Invitation',
      `${inviterName} has invited you to join "${workspaceName}".`,
      {
        priority: 'high',
        metadata: { workspaceId, inviterName },
        actionUrl: `/workspaces/invitations`,
      },
    );
  }

  async invitationAccepted(
    userId: string,
    memberName: string,
    workspaceName: string,
  ) {
    return this.emitNotification(
      userId,
      'invitation_accepted',
      'Invitation Accepted',
      `${memberName} has accepted your invitation to join "${workspaceName}".`,
      { priority: 'medium', metadata: { memberName, workspaceName } },
    );
  }

  async invitationRejected(
    userId: string,
    memberEmail: string,
    workspaceName: string,
  ) {
    return this.emitNotification(
      userId,
      'invitation_rejected',
      'Invitation Declined',
      `The invitation to ${memberEmail} for "${workspaceName}" was declined.`,
      { priority: 'low', metadata: { memberEmail, workspaceName } },
    );
  }

  async memberRemoved(
    userId: string,
    workspaceName: string,
    removedBy: string,
  ) {
    return this.emitNotification(
      userId,
      'member_removed',
      'Removed from Workspace',
      `You have been removed from "${workspaceName}" by ${removedBy}.`,
      { priority: 'medium', metadata: { workspaceName, removedBy } },
    );
  }

  // ==================== Billing ====================

  async paymentSuccessful(
    userId: string,
    amount: number,
    planName: string,
  ) {
    return this.emitNotification(
      userId,
      'payment_successful',
      'Payment Successful',
      `Your payment of $${amount.toFixed(2)} for ${planName} was successful.`,
      { priority: 'medium', metadata: { amount, planName } },
    );
  }

  async paymentFailed(
    userId: string,
    amount: number,
    reason?: string,
  ) {
    return this.emitNotification(
      userId,
      'payment_failed',
      'Payment Failed',
      `Your payment of $${amount.toFixed(2)} failed${reason ? `: ${reason}` : '. Please update your payment method.'}.`,
      { priority: 'high', metadata: { amount, reason }, actionUrl: '/billing' },
    );
  }

  async subscriptionExpiring(
    userId: string,
    daysRemaining: number,
    planName: string,
  ) {
    return this.emitNotification(
      userId,
      'subscription_expiring',
      'Subscription Expiring Soon',
      `Your ${planName} subscription will expire in ${daysRemaining} day${daysRemaining > 1 ? 's' : ''}. Renew now to avoid interruption.`,
      { priority: 'high', metadata: { daysRemaining, planName }, actionUrl: '/billing' },
    );
  }

  async planChanged(
    userId: string,
    oldPlan: string,
    newPlan: string,
  ) {
    return this.emitNotification(
      userId,
      'plan_changed',
      'Plan Updated',
      `Your subscription has been changed from ${oldPlan} to ${newPlan}.`,
      { priority: 'medium', metadata: { oldPlan, newPlan } },
    );
  }

  // ==================== Social Media Channels ====================

  async channelConnected(
    userId: string,
    platform: string,
    accountName: string,
    workspaceId?: string,
  ) {
    return this.emitNotification(
      userId,
      'channel_connected',
      'Channel Connected',
      `${platform} account "${accountName}" has been successfully connected.`,
      { priority: 'medium', metadata: { platform, accountName, workspaceId } },
    );
  }

  async channelDisconnected(
    userId: string,
    platform: string,
    accountName: string,
    reason?: string,
  ) {
    return this.emitNotification(
      userId,
      'channel_disconnected',
      'Channel Disconnected',
      `${platform} account "${accountName}" has been disconnected${reason ? `: ${reason}` : '.'}`,
      { priority: 'high', metadata: { platform, accountName, reason } },
    );
  }

  async tokenExpired(
    userId: string,
    platform: string,
    accountName: string,
  ) {
    return this.emitNotification(
      userId,
      'token_expired',
      'Reconnection Required',
      `Your ${platform} account "${accountName}" needs to be reconnected. The authorization has expired.`,
      { priority: 'high', metadata: { platform, accountName }, actionUrl: '/channels' },
    );
  }

  // ==================== Posts ====================

  async postPublished(
    userId: string,
    platform: string,
    postTitle?: string,
  ) {
    return this.emitNotification(
      userId,
      'post_published',
      'Post Published',
      `Your post${postTitle ? ` "${postTitle}"` : ''} has been published to ${platform}.`,
      { priority: 'low', metadata: { platform, postTitle } },
    );
  }

  async postFailed(
    userId: string,
    platform: string,
    postTitle: string,
    error?: string,
  ) {
    return this.emitNotification(
      userId,
      'post_failed',
      'Post Failed',
      `Failed to publish "${postTitle}" to ${platform}${error ? `: ${error}` : '.'}`,
      { priority: 'high', metadata: { platform, postTitle, error } },
    );
  }

  async postScheduledReminder(
    userId: string,
    postTitle: string,
    scheduledTime: Date,
  ) {
    return this.emitNotification(
      userId,
      'post_scheduled_reminder',
      'Scheduled Post Reminder',
      `Your post "${postTitle}" is scheduled to be published soon.`,
      { priority: 'medium', metadata: { postTitle, scheduledTime } },
    );
  }

  // ==================== Drip Campaigns ====================

  async campaignStarted(
    userId: string,
    campaignName: string,
    campaignId: string,
  ) {
    return this.emitNotification(
      userId,
      'campaign_started',
      'Campaign Started',
      `Your drip campaign "${campaignName}" has started.`,
      { priority: 'medium', metadata: { campaignName, campaignId } },
    );
  }

  async campaignCompleted(
    userId: string,
    campaignName: string,
    postsPublished: number,
  ) {
    return this.emitNotification(
      userId,
      'campaign_completed',
      'Campaign Completed',
      `Your drip campaign "${campaignName}" has completed. ${postsPublished} posts were published.`,
      { priority: 'medium', metadata: { campaignName, postsPublished } },
    );
  }

  async campaignPostFailed(
    userId: string,
    campaignName: string,
    postTitle: string,
    error?: string,
  ) {
    return this.emitNotification(
      userId,
      'campaign_post_failed',
      'Campaign Post Failed',
      `A post in campaign "${campaignName}" failed to publish${error ? `: ${error}` : '.'}`,
      { priority: 'high', metadata: { campaignName, postTitle, error } },
    );
  }

  // ==================== Admin Notifications (for Super Admins) ====================

  async newUserRegistered(
    adminUserId: string,
    newUserEmail: string,
    newUserName?: string,
  ) {
    return this.emitNotification(
      adminUserId,
      'new_user_registered',
      'New User Registered',
      `A new user has registered: ${newUserName || newUserEmail}`,
      { priority: 'low', metadata: { newUserEmail, newUserName } },
    );
  }

  async newFeedbackSubmitted(
    adminUserId: string,
    rating: number,
    userName: string,
  ) {
    return this.emitNotification(
      adminUserId,
      'new_feedback_submitted',
      'New Feedback Received',
      `${userName} submitted ${rating}-star feedback.`,
      { priority: 'medium', metadata: { rating, userName }, actionUrl: '/admin/feedback' },
    );
  }

  // ==================== System ====================

  async systemAnnouncement(
    userIds: string[],
    title: string,
    message: string,
    actionUrl?: string,
  ) {
    const notifications = await Promise.all(
      userIds.map((userId) =>
        this.emitNotification(userId, 'system_announcement', title, message, {
          priority: 'medium',
          actionUrl,
        }),
      ),
    );
    return notifications;
  }
}
