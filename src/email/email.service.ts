import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend, type ErrorResponse } from 'resend';
import { toSubjectLine } from './render/subject-line';

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

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('RESEND_API_KEY');
    this.fromEmail = this.configService.get<string>(
      'RESEND_FROM_EMAIL',
      'Schedura <noreply@schedura.ai>',
    );
    this.replyTo =
      this.configService.get<string>('RESEND_REPLY_TO') || undefined;

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
}
