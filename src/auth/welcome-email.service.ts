import { Injectable, Logger } from '@nestjs/common';
import { EmailOnceService } from '../email/email-once.service';
import { AppLinks } from '../email/links/app-links';
import { EmailOutboxService } from '../email/queue/email-outbox.service';
import { welcome } from '../email/templates/lifecycle/welcome';

/** How long a claimed welcome stays claimed: far past any repeat verify. */
const CLAIM_TTL_SECONDS = 30 * 86400;

export interface WelcomeRecipient {
  id: string;
  email: string;
  name: string | null;
}

/**
 * F1: the welcome email, sent once per person after the address is proven
 * (the OTP or link verify, or a new Google account). `send` never rejects and
 * callers do not await it: a mail problem must never fail or slow a signup.
 * Logs carry the user id only, never the address or name.
 */
@Injectable()
export class WelcomeEmailService {
  private readonly logger = new Logger(WelcomeEmailService.name);

  constructor(
    private readonly outbox: EmailOutboxService,
    private readonly once: EmailOnceService,
    private readonly links: AppLinks,
  ) {}

  async send(user: WelcomeRecipient): Promise<void> {
    try {
      // The claim covers days (Resend's own key only 24 h); the idempotency
      // key below is what makes a concurrent double call a single job.
      const key = `welcome.${user.id}`;
      if (!(await this.once.claim(key, CLAIM_TTL_SECONDS))) return;
      await this.outbox.enqueue({
        template: welcome,
        props: {
          firstName: user.name?.trim().split(/\s+/)[0] || 'there',
          openUrl: this.links.frontend('/'),
        },
        to: { email: user.email, userId: user.id },
        workspaceId: null,
        idempotencyKey: key,
      });
    } catch (err) {
      this.logger.warn(
        `welcome email for user ${user.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
