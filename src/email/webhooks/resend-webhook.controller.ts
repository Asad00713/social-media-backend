import {
  BadRequestException,
  Controller,
  HttpCode,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
  type RawBodyRequest,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { Webhook } from 'svix';
import { SkipLaunchGate } from '../../auth/decorators/skip-launch-gate.decorator';
import {
  EmailSuppressionRepository,
  type SuppressionReason,
} from '../suppression/email-suppression.repository';

/** The part of a Resend event this controller reads. */
interface ResendEvent {
  type?: unknown;
  data?: {
    email_id?: unknown;
    to?: unknown;
    bounce?: { type?: unknown };
  };
}

/**
 * Resend's delivery webhook. A hard bounce or a spam complaint puts the
 * address on the suppression list, which the outbox checks before every
 * notification and lifecycle send. The call carries no login: the svix
 * signature over the exact bytes Resend sent is the credential, so the event
 * is parsed only after it verified.
 */
@Controller('email/webhooks')
@SkipLaunchGate()
export class ResendWebhookController {
  private readonly logger = new Logger(ResendWebhookController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly suppressions: EmailSuppressionRepository,
  ) {}

  @Post('resend')
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ received: true } | { ignored: true }> {
    const secret = this.config.get<string>('RESEND_WEBHOOK_SECRET');
    if (!secret) {
      throw new ServiceUnavailableException('Resend webhook is not configured');
    }
    const event = this.verified(req, this.webhook(secret));

    const reason = this.reasonOf(event);
    if (!reason) return { ignored: true };

    const emailId =
      typeof event.data?.email_id === 'string' ? event.data.email_id : null;
    const recipients = Array.isArray(event.data?.to) ? event.data.to : [];
    for (const to of recipients) {
      if (typeof to === 'string' && to.trim()) {
        await this.suppressions.suppress(to, reason, emailId);
        this.logger.log(`Suppressed a recipient (${reason}) for ${emailId}`);
      }
    }
    return { received: true };
  }

  /**
   * A malformed secret makes the svix constructor throw. That is a bad
   * configuration, not a bad signature: log it once without the secret and
   * answer 503, so it is never mistaken for a rejected delivery.
   */
  private webhook(secret: string): Webhook {
    try {
      return new Webhook(secret);
    } catch {
      this.logger.error('RESEND_WEBHOOK_SECRET is malformed: svix rejected it');
      throw new ServiceUnavailableException('Resend webhook is not configured');
    }
  }

  /** 400 on a missing body, a missing header or a bad signature. */
  private verified(req: RawBodyRequest<Request>, hook: Webhook): ResendEvent {
    const header = (name: string) => {
      const v = req.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    const id = header('svix-id');
    const timestamp = header('svix-timestamp');
    const signature = header('svix-signature');
    if (!req.rawBody || !id || !timestamp || !signature) {
      throw new BadRequestException('Invalid webhook');
    }
    try {
      return hook.verify(req.rawBody.toString('utf8'), {
        'svix-id': id,
        'svix-timestamp': timestamp,
        'svix-signature': signature,
      }) as ResendEvent;
    } catch {
      throw new BadRequestException('Invalid webhook signature');
    }
  }

  /** A permanent (or unclassified) bounce and a complaint; a transient bounce is not one. */
  private reasonOf(event: ResendEvent): SuppressionReason | null {
    if (event.type === 'email.bounced') {
      return event.data?.bounce?.type === 'Transient' ? null : 'bounced';
    }
    return event.type === 'email.complained' ? 'complained' : null;
  }
}
