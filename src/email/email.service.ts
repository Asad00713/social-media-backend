import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend, type ErrorResponse } from 'resend';
import { toSubjectLine } from './render/subject-line';

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
  /** Set on a failure: true when a later attempt may succeed (429, 5xx, network). */
  retryable?: boolean;
  /** Resend's error name on a rejected send, e.g. `invalid_idempotent_request`. */
  errorCode?: string;
}

/** One message, fully rendered. */
export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
  attachments?: { filename: string; content: Buffer }[];
}

export interface DeliverOptions {
  /** Sent as Resend's Idempotency-Key: a retry within 24 h is not re-sent. */
  idempotencyKey: string;
  tags: { category: string; template: string };
}

/** Resend errors a later attempt can clear. Every other error is final. */
const RETRYABLE_ERRORS = new Set<string>([
  'rate_limit_exceeded',
  'concurrent_idempotent_requests',
  'application_error',
  'internal_server_error',
]);

/** A null status is the SDK's "the request could not be resolved" (network). */
function isRetryable(error: ErrorResponse): boolean {
  return (
    RETRYABLE_ERRORS.has(error.name) ||
    error.statusCode === null ||
    error.statusCode >= 500
  );
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private resend: Resend | null = null;
  private readonly fromEmail: string;
  private readonly replyTo: string | undefined;
  private readonly appUrl: string;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('RESEND_API_KEY');
    this.fromEmail = this.configService.get<string>(
      'RESEND_FROM_EMAIL',
      'Schedura <noreply@schedura.ai>',
    );
    this.replyTo =
      this.configService.get<string>('RESEND_REPLY_TO') || undefined;
    // APP_URL for backend links (drip notifications, etc.)
    this.appUrl = this.configService.get<string>(
      'APP_URL',
      'http://localhost:3000',
    );

    if (apiKey) {
      this.resend = new Resend(apiKey);
      this.logger.log('Resend email service initialized');
    } else {
      this.logger.warn(
        'RESEND_API_KEY not configured - emails will be logged only',
      );
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
        const hashtags = content.hashtags?.length
          ? ` (${content.hashtags.length} hashtags)`
          : '';
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
   * The one Resend call every email makes. Never throws: a failure comes back
   * as `{ success: false, retryable }`, and the caller (the email worker)
   * decides whether to retry. The same `idempotencyKey` on a retry means a
   * send whose response was lost is not delivered twice.
   */
  async deliver(
    msg: OutgoingEmail,
    opts: DeliverOptions,
  ): Promise<EmailResult> {
    const { to, html, text, attachments, headers } = msg;
    const subject = toSubjectLine(msg.subject);
    // Logs name the key and template only: never the address, subject or body
    // (bodies carry codes and reset links; error/warn persist to error_logs).
    const label = `${opts.idempotencyKey} (${opts.tags.template})`;

    if (!this.resend) {
      // Log the email instead of sending.
      //
      // This reports FAILURE, not success. It used to return success: true,
      // which made a missing API key indistinguishable from a delivered email
      // to every caller — so a production box with no RESEND_API_KEY told each
      // new user "check your email" for a message that was only ever written
      // to a log file. Nothing was ever sent; nothing ever said so.
      //
      // Callers that genuinely don't care whether the mail lands (background
      // notifications) can keep ignoring the result. The ones that gate a user
      // flow on it — email verification, password reset — must not.
      this.logger.error(`[EMAIL NOT SENT - No API Key] ${label}`);
      return {
        success: false,
        error: 'Email service is not configured (RESEND_API_KEY is unset)',
        retryable: false,
      };
    }

    const replyTo = msg.replyTo ?? this.replyTo;
    try {
      const result = await this.resend.emails.send(
        {
          from: this.fromEmail,
          to,
          subject,
          html,
          ...(text ? { text } : {}),
          ...(replyTo ? { replyTo } : {}),
          ...(attachments?.length ? { attachments } : {}),
          ...(headers && Object.keys(headers).length ? { headers } : {}),
          tags: [
            { name: 'category', value: opts.tags.category },
            { name: 'template', value: opts.tags.template },
          ],
        },
        { idempotencyKey: opts.idempotencyKey },
      );

      if (result.error) {
        const retryable = isRetryable(result.error);
        const line = `Failed to send email ${label}: ${result.error.name} ${result.error.message}`;
        // A retryable failure is one attempt of several: console only. The
        // worker's final-failure handler records the outcome once.
        if (retryable) this.logger.log(line);
        else this.logger.error(line);
        return {
          success: false,
          error: result.error.message,
          retryable,
          errorCode: result.error.name,
        };
      }

      this.logger.log(`Email sent ${label}, ID: ${result.data?.id}`);
      return {
        success: true,
        messageId: result.data?.id,
      };
    } catch (error) {
      // The SDK turns HTTP and network failures into `result.error`, so a throw
      // means no answer came back: retrying under the same key is safe.
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.log(`Email send failed ${label}: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
        retryable: true,
      };
    }
  }

  /**
   * Send a generic email. Legacy entry point: each call gets a fresh key, so
   * nothing is deduped. Deleted once every caller uses the outbox (T17).
   */
  async sendEmail(options: {
    to: string;
    subject: string;
    html: string;
    text?: string;
    /**
     * Where a reply should go, when that is not the from-address.
     *
     * Needed by mail we send *about* someone rather than *to* them — a contact
     * form enquiry arrives from our own Resend address, so without this a reply
     * goes to us instead of to the person who wrote in.
     */
    replyTo?: string;
    /** Files to attach (Resend sends them base64-encoded). */
    attachments?: { filename: string; content: Buffer }[];
    /** Extra message headers, e.g. `List-Unsubscribe`. */
    headers?: Record<string, string>;
  }): Promise<EmailResult> {
    return this.deliver(
      { ...options, text: options.text ?? '' },
      {
        idempotencyKey: `legacy.${randomUUID()}`,
        tags: { category: 'legacy', template: 'legacy' },
      },
    );
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
}
