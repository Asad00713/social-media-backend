import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue, UnrecoverableError } from 'bullmq';
import {
  NOTIFICATION_EVENTS,
  type PreferenceEventKey,
} from '../../notification-preferences/notification-events';
import { NotificationPreferencesService } from '../../notification-preferences/notification-preferences.service';
import { QUEUES } from '../../queue/queue.module';
import { EmailService, type EmailResult } from '../email.service';
import { AppLinks } from '../links/app-links';
import { renderEmail } from '../render/render-email';
import { EmailSuppressionRepository } from '../suppression/email-suppression.repository';
import { EmailTokensService } from '../tokens/email-tokens.service';
import { eventOf } from '../templates/define-template';
import { getTemplate } from '../templates/registry';
import type { AnyTemplateDef } from '../templates/types';
import { EmailFooterService } from './email-footer.service';
import {
  EMAIL_JOB_ATTEMPTS,
  EMAIL_JOB_BACKOFF_MS,
  EMAIL_JOB_SEND,
  IDEMPOTENCY_KEY_RE,
  RetryableEmailError,
  type EmailJobData,
  type EmailRecipient,
  type EnqueueEmail,
} from './email-job';

type SendOutcome =
  | { status: 'sent'; messageId?: string }
  | { status: 'skipped:pref' | 'skipped:suppressed' };

/** All digits: BullMQ refuses integer-like custom job ids. */
const ALL_DIGITS_RE = /^\d+$/;

function assertKey(key: string): void {
  if (!IDEMPOTENCY_KEY_RE.test(key) || ALL_DIGITS_RE.test(key)) {
    throw new Error(
      `Invalid email idempotency key "${key}": it must match ${String(IDEMPOTENCY_KEY_RE)} and not be all digits`,
    );
  }
}

function isEventKey(key: string): key is PreferenceEventKey {
  return Object.keys(NOTIFICATION_EVENTS).includes(key);
}

function toJobData<P>(input: Omit<EnqueueEmail<P>, 'delayMs'>): EmailJobData {
  return {
    template: input.template.id,
    props: input.props,
    to: input.to,
    workspaceId: input.workspaceId,
    idempotencyKey: input.idempotencyKey,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
  };
}

/**
 * The only way template mail is sent. `enqueue` puts a job on the `email`
 * queue (job id = idempotency key, so a repeat enqueue is a no-op); `sendNow`
 * runs the same pipeline inline where a person is waiting on the result.
 * Both re-check preferences and suppression at send time, so an unsubscribe
 * or a removal after enqueue is honoured.
 */
@Injectable()
export class EmailOutboxService {
  private readonly logger = new Logger(EmailOutboxService.name);

  constructor(
    @InjectQueue(QUEUES.EMAIL) private readonly queue: Queue,
    private readonly email: EmailService,
    private readonly prefs: NotificationPreferencesService,
    private readonly suppressions: EmailSuppressionRepository,
    private readonly footer: EmailFooterService,
    private readonly links: AppLinks,
    private readonly tokens: EmailTokensService,
  ) {}

  /** Throws on a bad key, so a caller bug surfaces before anything is queued. */
  async enqueue<P>(input: EnqueueEmail<P>): Promise<void> {
    assertKey(input.idempotencyKey);
    await this.queue.add(EMAIL_JOB_SEND, toJobData(input), {
      jobId: input.idempotencyKey,
      attempts: EMAIL_JOB_ATTEMPTS,
      backoff: { type: 'exponential', delay: EMAIL_JOB_BACKOFF_MS },
      ...(input.delayMs !== undefined ? { delay: input.delayMs } : {}),
    });
  }

  /** Never throws: every failure, a bad key included, is `{ success: false }`. */
  async sendNow<P>(
    input: Omit<EnqueueEmail<P>, 'delayMs'>,
  ): Promise<EmailResult> {
    try {
      assertKey(input.idempotencyKey);
      const outcome = await this.send(toJobData(input));
      if (outcome.status !== 'sent') {
        return { success: false, error: `Not sent: ${outcome.status}` };
      }
      return { success: true, messageId: outcome.messageId };
    } catch (err) {
      const errorCode = (err as { errorCode?: unknown } | null)?.errorCode;
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        retryable: err instanceof RetryableEmailError,
        ...(typeof errorCode === 'string' ? { errorCode } : {}),
      };
    }
  }

  /**
   * Shared by sendNow and the worker. `attemptsMade` is the job's count of
   * earlier failed attempts (0 on the first run and for sendNow).
   */
  async process(
    data: EmailJobData,
    attemptsMade = 0,
  ): Promise<'sent' | 'skipped:pref' | 'skipped:suppressed'> {
    return (await this.send(data, attemptsMade)).status;
  }

  /**
   * Guard, footer, render, deliver. Throws RetryableEmailError for a
   * transient failure and UnrecoverableError for one no retry can fix.
   */
  private async send(
    data: EmailJobData,
    attemptsMade = 0,
  ): Promise<SendOutcome> {
    const { to, workspaceId, props } = data;
    const def = this.templateOf(data.template);

    const event = eventOf(def, props);
    if (event && to.userId) {
      const allowed = await this.prefs.shouldSend(
        to.userId,
        workspaceId,
        event as PreferenceEventKey,
        'email',
      );
      if (!allowed) return { status: 'skipped:pref' };
    }

    const toggleable =
      def.footer === 'notification' || def.category === 'lifecycle';
    if (toggleable && (await this.suppressions.isSuppressed(to.email))) {
      return { status: 'skipped:suppressed' };
    }

    const footer = await this.footer.build(def, props, to, workspaceId);
    const rendered = await renderEmail(def, props, {
      assetBaseUrl: this.links.assetBase(),
      footer,
    });
    const result = await this.email.deliver(
      {
        to: to.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        ...(data.replyTo ? { replyTo: data.replyTo } : {}),
        ...this.unsubscribeHeaders(def, props, to, workspaceId),
      },
      {
        idempotencyKey: data.idempotencyKey,
        tags: { category: def.category, template: def.id },
      },
    );
    if (
      !result.success &&
      result.errorCode === 'invalid_idempotent_request' &&
      attemptsMade > 0
    ) {
      // On a retry this means an earlier attempt already used the key with a
      // slightly different payload (the footer re-reads the workspace name):
      // that attempt reached Resend, so the email went out.
      this.logger.log(
        `Email ${data.idempotencyKey} (${def.id}) was already sent by an earlier attempt`,
      );
      return { status: 'sent' };
    }
    if (!result.success) {
      // The code only: the worker logs this at error level (error_logs), and
      // a provider message can quote the recipient address.
      const reason = `Email ${data.idempotencyKey} (${def.id}) failed: ${result.errorCode ?? (result.retryable ? 'retryable' : 'failed')}`;
      // The code rides along, so sendNow callers can log it.
      throw Object.assign(
        result.retryable
          ? new RetryableEmailError(reason)
          : new UnrecoverableError(reason),
        { errorCode: result.errorCode },
      );
    }
    return { status: 'sent', messageId: result.messageId };
  }

  /**
   * RFC 8058 one-click unsubscribe for the mail a person can switch off: a
   * notification, and the account-level inactivity reminder. Mandatory mail
   * has no event to switch off, so it carries neither header.
   */
  private unsubscribeHeaders(
    def: AnyTemplateDef,
    props: unknown,
    to: EmailRecipient,
    workspaceId: string | null,
  ): { headers?: Record<string, string> } {
    const key = eventOf(def, props);
    const unsubscribable =
      def.footer === 'notification' || key === 'inactivity_reminder';
    if (!unsubscribable || !key || !to.userId) return {};
    // Only an event whose email can be switched off: the link would otherwise
    // lead to a page that does nothing.
    const event = isEventKey(key) ? NOTIFICATION_EVENTS[key] : undefined;
    if (!event?.email || event.email.locked) return {};
    const token = this.tokens.unsubscribeToken({
      uid: to.userId,
      ws: workspaceId,
      ev: event.key,
    });
    return {
      headers: {
        'List-Unsubscribe': `<${this.links.api('/email/unsubscribe/' + token)}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    };
  }

  private templateOf(id: string): AnyTemplateDef {
    try {
      return getTemplate(id);
    } catch (err) {
      throw new UnrecoverableError(
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
