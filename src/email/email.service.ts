import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

export interface DripNotificationData {
  userEmail: string;
  userName?: string;
  campaignName: string;
  dripPostId: string;
  scheduledAt: Date;
  generatedContent: string;
  platformContent: Record<string, { text: string; hashtags?: string[] }>;
  reviewUrl?: string;
}

export interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private resend: Resend | null = null;
  private readonly fromEmail: string;
  private readonly frontendUrl: string;
  private readonly appUrl: string;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('RESEND_API_KEY');
    this.fromEmail = this.configService.get<string>('RESEND_FROM_EMAIL', 'noreply@yourdomain.com');
    // FRONTEND_URL for auth links (verification, password reset)
    this.frontendUrl = this.configService.get<string>('FRONTEND_URL', 'http://localhost:3000');
    // APP_URL for backend links (drip notifications, etc.)
    this.appUrl = this.configService.get<string>('APP_URL', 'http://localhost:3000');

    if (apiKey) {
      this.resend = new Resend(apiKey);
      this.logger.log('Resend email service initialized');
    } else {
      this.logger.warn('RESEND_API_KEY not configured - emails will be logged only');
    }
  }

  /**
   * Check if email service is configured
   */
  isConfigured(): boolean {
    return this.resend !== null;
  }

  /**
   * Send drip post review notification
   */
  async sendDripNotification(data: DripNotificationData): Promise<EmailResult> {
    const {
      userEmail,
      userName,
      campaignName,
      dripPostId,
      scheduledAt,
      generatedContent,
      platformContent,
      reviewUrl,
    } = data;

    const subject = `[Action Required] Review your scheduled post for "${campaignName}"`;
    const timeUntilPublish = this.formatTimeUntilPublish(scheduledAt);

    // Build platform content summary
    const platformSummary = Object.entries(platformContent)
      .map(([platform, content]) => {
        const hashtags = content.hashtags?.length ? ` (${content.hashtags.length} hashtags)` : '';
        return `• ${platform.charAt(0).toUpperCase() + platform.slice(1)}: ${content.text.substring(0, 100)}...${hashtags}`;
      })
      .join('\n');

    const htmlContent = this.buildDripNotificationHtml({
      userName,
      campaignName,
      dripPostId,
      scheduledAt,
      timeUntilPublish,
      generatedContent,
      platformSummary,
      reviewUrl: reviewUrl || `${this.appUrl}/drips/posts/${dripPostId}`,
    });

    const textContent = this.buildDripNotificationText({
      userName,
      campaignName,
      scheduledAt,
      timeUntilPublish,
      generatedContent,
      platformSummary,
      reviewUrl: reviewUrl || `${this.appUrl}/drips/posts/${dripPostId}`,
    });

    return this.sendEmail({
      to: userEmail,
      subject,
      html: htmlContent,
      text: textContent,
    });
  }

  /**
   * Send a generic email
   */
  async sendEmail(options: {
    to: string;
    subject: string;
    html: string;
    text?: string;
  }): Promise<EmailResult> {
    const { to, subject, html, text } = options;

    if (!this.resend) {
      // Log the email instead of sending
      this.logger.log(`[EMAIL NOT SENT - No API Key] To: ${to}, Subject: ${subject}`);
      this.logger.debug(`Email content: ${text || html.substring(0, 200)}`);
      return {
        success: true,
        messageId: `log-${Date.now()}`,
      };
    }

    try {
      const result = await this.resend.emails.send({
        from: this.fromEmail,
        to,
        subject,
        html,
        text,
      });

      if (result.error) {
        this.logger.error(`Failed to send email: ${result.error.message}`);
        return {
          success: false,
          error: result.error.message,
        };
      }

      this.logger.log(`Email sent to ${to}, ID: ${result.data?.id}`);
      return {
        success: true,
        messageId: result.data?.id,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Email send failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Format time until publish
   */
  private formatTimeUntilPublish(scheduledAt: Date): string {
    const now = new Date();
    const diff = scheduledAt.getTime() - now.getTime();
    const minutes = Math.round(diff / (1000 * 60));

    if (minutes < 60) {
      return `${minutes} minutes`;
    }

    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;

    if (remainingMinutes === 0) {
      return `${hours} hour${hours > 1 ? 's' : ''}`;
    }

    return `${hours} hour${hours > 1 ? 's' : ''} and ${remainingMinutes} minutes`;
  }

  /**
   * Build HTML email content for drip notification
   */
  private buildDripNotificationHtml(data: {
    userName?: string;
    campaignName: string;
    dripPostId: string;
    scheduledAt: Date;
    timeUntilPublish: string;
    generatedContent: string;
    platformSummary: string;
    reviewUrl: string;
  }): string {
    const greeting = data.userName ? `Hi ${data.userName}` : 'Hi there';
    const publishTime = data.scheduledAt.toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Review Your Scheduled Post</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Review Your Scheduled Post</h1>
  </div>

  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p style="font-size: 16px; margin-top: 0;">${greeting},</p>

    <p>Your AI-generated content for <strong>"${data.campaignName}"</strong> is ready for review!</p>

    <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0;">
      <strong>Publishes in ${data.timeUntilPublish}</strong><br>
      <span style="color: #92400e;">${publishTime}</span>
    </div>

    <div style="background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 20px 0;">
      <h3 style="margin-top: 0; color: #374151;">Generated Content</h3>
      <p style="color: #6b7280; white-space: pre-wrap;">${data.generatedContent}</p>
    </div>

    <div style="background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 20px 0;">
      <h3 style="margin-top: 0; color: #374151;">Platform Versions</h3>
      <pre style="color: #6b7280; white-space: pre-wrap; font-size: 14px;">${data.platformSummary}</pre>
    </div>

    <div style="text-align: center; margin: 30px 0;">
      <a href="${data.reviewUrl}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 15px 30px; border-radius: 8px; font-weight: bold; font-size: 16px;">Review & Edit Post</a>
    </div>

    <p style="color: #6b7280; font-size: 14px;">
      If you don't make any changes, the post will be published automatically at the scheduled time.
    </p>
  </div>

  <div style="text-align: center; padding: 20px; color: #9ca3af; font-size: 12px;">
    <p>This email was sent by your Social Media Automation tool.</p>
  </div>
</body>
</html>
    `.trim();
  }

  /**
   * Build plain text email content for drip notification
   */
  private buildDripNotificationText(data: {
    userName?: string;
    campaignName: string;
    scheduledAt: Date;
    timeUntilPublish: string;
    generatedContent: string;
    platformSummary: string;
    reviewUrl: string;
  }): string {
    const greeting = data.userName ? `Hi ${data.userName}` : 'Hi there';
    const publishTime = data.scheduledAt.toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });

    return `
${greeting},

Your AI-generated content for "${data.campaignName}" is ready for review!

⏰ PUBLISHES IN ${data.timeUntilPublish.toUpperCase()}
${publishTime}

---

GENERATED CONTENT:
${data.generatedContent}

---

PLATFORM VERSIONS:
${data.platformSummary}

---

Review and edit your post here:
${data.reviewUrl}

If you don't make any changes, the post will be published automatically at the scheduled time.

---
This email was sent by your Social Media Automation tool.
    `.trim();
  }

  /**
   * Send email verification email
   */
  async sendVerificationEmail(
    email: string,
    token: string,
    name?: string,
  ): Promise<EmailResult> {
    const verifyUrl = `${this.frontendUrl}/auth/verify?token=${token}`;
    const greeting = name ? `Hi ${name}` : 'Hi there';

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify Your Email</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Welcome! Verify Your Email</h1>
  </div>

  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p style="font-size: 16px; margin-top: 0;">${greeting},</p>

    <p>Thank you for signing up! Please verify your email address to get started.</p>

    <div style="text-align: center; margin: 30px 0;">
      <a href="${verifyUrl}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 15px 30px; border-radius: 8px; font-weight: bold; font-size: 16px;">Verify Email Address</a>
    </div>

    <p style="color: #6b7280; font-size: 14px;">
      This link will expire in 24 hours. If you didn't create an account, you can safely ignore this email.
    </p>

    <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
      <p style="color: #9ca3af; font-size: 12px; margin: 0;">
        If the button doesn't work, copy and paste this link into your browser:<br>
        <a href="${verifyUrl}" style="color: #667eea; word-break: break-all;">${verifyUrl}</a>
      </p>
    </div>
  </div>

  <div style="text-align: center; padding: 20px; color: #9ca3af; font-size: 12px;">
    <p>This email was sent by your Social Media Automation tool.</p>
  </div>
</body>
</html>
    `.trim();

    const text = `
${greeting},

Thank you for signing up! Please verify your email address to get started.

Click the link below to verify your email:
${verifyUrl}

This link will expire in 24 hours. If you didn't create an account, you can safely ignore this email.

---
This email was sent by your Social Media Automation tool.
    `.trim();

    return this.sendEmail({
      to: email,
      subject: 'Verify Your Email Address',
      html,
      text,
    });
  }

  /**
   * Send inactivity reminder email (15 days)
   */
  async sendInactivityReminder15Days(
    email: string,
    name?: string,
  ): Promise<EmailResult> {
    const greeting = name ? `Hi ${name}` : 'Hi there';
    const loginUrl = `${this.frontendUrl}/auth/login`;

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>We Miss You!</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">We Miss You! 👋</h1>
  </div>

  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p style="font-size: 16px; margin-top: 0;">${greeting},</p>

    <p>We noticed you haven't logged in for about <strong>15 days</strong>. Your scheduled posts and social media channels are waiting for you!</p>

    <p>Here's what you might be missing:</p>
    <ul style="color: #6b7280;">
      <li>New AI content generation features</li>
      <li>Your scheduled posts need attention</li>
      <li>Analytics and insights from your channels</li>
    </ul>

    <div style="text-align: center; margin: 30px 0;">
      <a href="${loginUrl}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 15px 30px; border-radius: 8px; font-weight: bold; font-size: 16px;">Log In Now</a>
    </div>

    <p style="color: #6b7280; font-size: 14px;">
      If you need any help getting started again, our support team is here for you!
    </p>
  </div>

  <div style="text-align: center; padding: 20px; color: #9ca3af; font-size: 12px;">
    <p>This email was sent by your Social Media Automation tool.</p>
  </div>
</body>
</html>
    `.trim();

    const text = `
${greeting},

We noticed you haven't logged in for about 15 days. Your scheduled posts and social media channels are waiting for you!

Here's what you might be missing:
- New AI content generation features
- Your scheduled posts need attention
- Analytics and insights from your channels

Log in now: ${loginUrl}

If you need any help getting started again, our support team is here for you!

---
This email was sent by your Social Media Automation tool.
    `.trim();

    return this.sendEmail({
      to: email,
      subject: 'We Miss You! Your Social Media Awaits 👋',
      html,
      text,
    });
  }

  /**
   * Send inactivity reminder email (25 days)
   */
  async sendInactivityReminder25Days(
    email: string,
    name?: string,
  ): Promise<EmailResult> {
    const greeting = name ? `Hi ${name}` : 'Hi there';
    const loginUrl = `${this.frontendUrl}/auth/login`;

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Account Needs Attention</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Your Account Needs Attention ⚠️</h1>
  </div>

  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p style="font-size: 16px; margin-top: 0;">${greeting},</p>

    <p>It's been <strong>25 days</strong> since we last saw you. We wanted to remind you that your account is still here, but it needs some attention.</p>

    <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0;">
      <strong style="color: #92400e;">Important Notice</strong><br>
      <span style="color: #92400e; font-size: 14px;">If you don't log in within the next 5 days, your account will be temporarily deactivated to protect your data.</span>
    </div>

    <p>Don't worry - you won't lose anything! Simply log in to keep your account active.</p>

    <div style="text-align: center; margin: 30px 0;">
      <a href="${loginUrl}" style="display: inline-block; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: white; text-decoration: none; padding: 15px 30px; border-radius: 8px; font-weight: bold; font-size: 16px;">Keep My Account Active</a>
    </div>

    <p style="color: #6b7280; font-size: 14px;">
      If you're having trouble logging in or have questions, please contact our support team.
    </p>
  </div>

  <div style="text-align: center; padding: 20px; color: #9ca3af; font-size: 12px;">
    <p>This email was sent by your Social Media Automation tool.</p>
  </div>
</body>
</html>
    `.trim();

    const text = `
${greeting},

It's been 25 days since we last saw you. We wanted to remind you that your account is still here, but it needs some attention.

IMPORTANT NOTICE:
If you don't log in within the next 5 days, your account will be temporarily deactivated to protect your data.

Don't worry - you won't lose anything! Simply log in to keep your account active.

Log in now: ${loginUrl}

If you're having trouble logging in or have questions, please contact our support team.

---
This email was sent by your Social Media Automation tool.
    `.trim();

    return this.sendEmail({
      to: email,
      subject: '⚠️ Your Account Will Be Deactivated Soon',
      html,
      text,
    });
  }

  /**
   * Send final inactivity notice email (30 days - account deactivated)
   */
  async sendInactivityDeactivationNotice(
    email: string,
    name?: string,
  ): Promise<EmailResult> {
    const greeting = name ? `Hi ${name}` : 'Hi there';
    const loginUrl = `${this.frontendUrl}/auth/login`;

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Account Deactivated</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Account Deactivated 🔒</h1>
  </div>

  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p style="font-size: 16px; margin-top: 0;">${greeting},</p>

    <p>Due to <strong>30 days of inactivity</strong>, your account has been temporarily deactivated.</p>

    <div style="background: #fee2e2; border-left: 4px solid #ef4444; padding: 15px; margin: 20px 0;">
      <strong style="color: #991b1b;">What This Means</strong><br>
      <ul style="color: #991b1b; font-size: 14px; margin: 10px 0; padding-left: 20px;">
        <li>You cannot log in until your account is reactivated</li>
        <li>Scheduled posts have been paused</li>
        <li>Your data is safe and preserved</li>
      </ul>
    </div>

    <p><strong>Want to reactivate your account?</strong></p>
    <p>Simply contact our support team and we'll help you get back up and running in no time.</p>

    <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0;">
      <strong style="color: #92400e;">Important</strong><br>
      <span style="color: #92400e; font-size: 14px;">If your account remains inactive for 1 year, it will be permanently deleted along with all associated data.</span>
    </div>

    <div style="text-align: center; margin: 30px 0;">
      <a href="mailto:support@yourdomain.com?subject=Reactivate My Account" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 15px 30px; border-radius: 8px; font-weight: bold; font-size: 16px;">Contact Support</a>
    </div>
  </div>

  <div style="text-align: center; padding: 20px; color: #9ca3af; font-size: 12px;">
    <p>This email was sent by your Social Media Automation tool.</p>
  </div>
</body>
</html>
    `.trim();

    const text = `
${greeting},

Due to 30 days of inactivity, your account has been temporarily deactivated.

WHAT THIS MEANS:
- You cannot log in until your account is reactivated
- Scheduled posts have been paused
- Your data is safe and preserved

WANT TO REACTIVATE YOUR ACCOUNT?
Simply contact our support team and we'll help you get back up and running in no time.

IMPORTANT:
If your account remains inactive for 1 year, it will be permanently deleted along with all associated data.

Contact support to reactivate: support@yourdomain.com

---
This email was sent by your Social Media Automation tool.
    `.trim();

    return this.sendEmail({
      to: email,
      subject: '🔒 Your Account Has Been Deactivated',
      html,
      text,
    });
  }

  /**
   * Send account deletion warning email (before 1 year deletion)
   */
  async sendAccountDeletionWarning(
    email: string,
    name?: string,
    daysUntilDeletion: number = 30,
  ): Promise<EmailResult> {
    const greeting = name ? `Hi ${name}` : 'Hi there';

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Account Scheduled for Deletion</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #ef4444 0%, #991b1b 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">⚠️ Account Scheduled for Deletion</h1>
  </div>

  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p style="font-size: 16px; margin-top: 0;">${greeting},</p>

    <p>Your account has been inactive for almost <strong>1 year</strong> and is scheduled for permanent deletion.</p>

    <div style="background: #fee2e2; border-left: 4px solid #ef4444; padding: 15px; margin: 20px 0;">
      <strong style="color: #991b1b;">⏰ ${daysUntilDeletion} Days Until Permanent Deletion</strong><br>
      <span style="color: #991b1b; font-size: 14px;">After this date, your account and ALL associated data (posts, media, settings) will be permanently deleted and cannot be recovered.</span>
    </div>

    <p><strong>Don't want to lose your account?</strong></p>
    <p>Contact our support team immediately to reactivate your account before it's too late.</p>

    <div style="text-align: center; margin: 30px 0;">
      <a href="mailto:support@yourdomain.com?subject=URGENT: Prevent Account Deletion" style="display: inline-block; background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); color: white; text-decoration: none; padding: 15px 30px; border-radius: 8px; font-weight: bold; font-size: 16px;">Contact Support Now</a>
    </div>
  </div>

  <div style="text-align: center; padding: 20px; color: #9ca3af; font-size: 12px;">
    <p>This email was sent by your Social Media Automation tool.</p>
  </div>
</body>
</html>
    `.trim();

    const text = `
${greeting},

Your account has been inactive for almost 1 year and is scheduled for permanent deletion.

⏰ ${daysUntilDeletion} DAYS UNTIL PERMANENT DELETION
After this date, your account and ALL associated data (posts, media, settings) will be permanently deleted and cannot be recovered.

DON'T WANT TO LOSE YOUR ACCOUNT?
Contact our support team immediately to reactivate your account before it's too late.

Contact support NOW: support@yourdomain.com
Subject: URGENT: Prevent Account Deletion

---
This email was sent by your Social Media Automation tool.
    `.trim();

    return this.sendEmail({
      to: email,
      subject: '⚠️ URGENT: Your Account Will Be Deleted in ' + daysUntilDeletion + ' Days',
      html,
      text,
    });
  }

  /**
   * Send password reset email
   */
  async sendPasswordResetEmail(
    email: string,
    token: string,
    name?: string,
  ): Promise<EmailResult> {
    const resetUrl = `${this.frontendUrl}/auth/reset?token=${token}`;
    const greeting = name ? `Hi ${name}` : 'Hi there';

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your Password</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Reset Your Password</h1>
  </div>

  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p style="font-size: 16px; margin-top: 0;">${greeting},</p>

    <p>We received a request to reset your password. Click the button below to choose a new password.</p>

    <div style="text-align: center; margin: 30px 0;">
      <a href="${resetUrl}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 15px 30px; border-radius: 8px; font-weight: bold; font-size: 16px;">Reset Password</a>
    </div>

    <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0;">
      <strong style="color: #92400e;">Security Notice</strong><br>
      <span style="color: #92400e; font-size: 14px;">This link will expire in 1 hour. If you didn't request a password reset, please ignore this email or contact support if you have concerns.</span>
    </div>

    <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
      <p style="color: #9ca3af; font-size: 12px; margin: 0;">
        If the button doesn't work, copy and paste this link into your browser:<br>
        <a href="${resetUrl}" style="color: #667eea; word-break: break-all;">${resetUrl}</a>
      </p>
    </div>
  </div>

  <div style="text-align: center; padding: 20px; color: #9ca3af; font-size: 12px;">
    <p>This email was sent by your Social Media Automation tool.</p>
  </div>
</body>
</html>
    `.trim();

    const text = `
${greeting},

We received a request to reset your password. Click the link below to choose a new password:

${resetUrl}

SECURITY NOTICE:
This link will expire in 1 hour. If you didn't request a password reset, please ignore this email or contact support if you have concerns.

---
This email was sent by your Social Media Automation tool.
    `.trim();

    return this.sendEmail({
      to: email,
      subject: 'Reset Your Password',
      html,
      text,
    });
  }
}
