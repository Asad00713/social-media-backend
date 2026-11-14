import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue, UnrecoverableError } from 'bullmq';
import type { PreferenceEventKey } from '../../notification-preferences/notification-events';
import { NotificationPreferencesService } from '../../notification-preferences/notification-preferences.service';
import { QUEUES } from '../../queue/queue.module';
import { EmailService, type EmailResult } from '../email.service';
import { AppLinks } from '../links/app-links';
import { renderEmail } from '../render/render-email';
import { EmailSuppressionRepository } from '../suppression/email-suppression.repository';
import { getTemplate } from '../templates/registry';
import type { AnyTemplateDef } from '../templates/types';
import { EmailFooterService } from './email-footer.service';
import {
  EMAIL_JOB_SEND,
  IDEMPOTENCY_KEY_RE,
  RetryableEmailError,
  type EmailJobData,
  type EnqueueEmail,
} from './email-job';

type SendOutcome =
  | { status: 'sent'; messageId?: string }
  | { status: 'skipped:pref' | 'skipped:suppressed' };

function assertKey(key: string): void {
  if (!IDEMPOTENCY_KEY_RE.test(key)) {
    throw new Error(
      `Invalid email idempotency key "${key}": it must match ${String(IDEMPOTENCY_KEY_RE)}`,
    );
  }
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
  constructor(
    @InjectQueue(QUEUES.EMAIL) private readonly queue: Queue,
    private readonly email: EmailService,
    private readonly prefs: NotificationPreferencesService,
    private readonly suppressions: EmailSuppressionRepository,
    private readonly footer: EmailFooterService,
    private readonly links: AppLinks,
  ) {}

  /** Throws on a bad key, so a caller bug surfaces before anything is queued. */
  async enqueue<P>(input: EnqueueEmail<P>): Promise<void> {
    assertKey(input.idempotencyKey);
    await this.queue.add(EMAIL_JOB_SEND, toJobData(input), {
      jobId: input.idempotencyKey,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
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
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        retryable: err instanceof RetryableEmailError,
      };
    }
  }

  /** Shared by sendNow and the worker. */
  async process(
    data: EmailJobData,
  ): Promise<'sent' | 'skipped:pref' | 'skipped:suppressed'> {
    return (await this.send(data)).status;
  }

  /**
   * Guard, footer, render, deliver. Throws RetryableEmailError for a
   * transient failure and UnrecoverableError for one no retry can fix.
   */
  private async send(data: EmailJobData): Promise<SendOutcome> {
    const { to, workspaceId, props } = data;
    const def = this.templateOf(data.template);

    if (def.event && to.userId) {
      const allowed = await this.prefs.shouldSend(
        to.userId,
        workspaceId,
        def.event as PreferenceEventKey,
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
      },
      {
        idempotencyKey: data.idempotencyKey,
        tags: { category: def.category, template: def.id },
      },
    );
    if (!result.success) {
      const reason = `Email ${data.idempotencyKey} (${def.id}) failed: ${result.error ?? 'unknown error'}`;
      throw result.retryable
        ? new RetryableEmailError(reason)
        : new UnrecoverableError(reason);
    }
    return { status: 'sent', messageId: result.messageId };
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
