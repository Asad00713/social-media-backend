import { Injectable, Logger } from '@nestjs/common';
import type { PreferenceEventKey } from '../notification-preferences/notification-events';
import { NotificationPreferencesService } from '../notification-preferences/notification-preferences.service';
import type { EnqueueEmail } from '../email/queue/email-job';
import { EmailOutboxService } from '../email/queue/email-outbox.service';
import { RecipientsService } from './recipients.service';

export interface NotifyInput<P> {
  userId: string;
  workspaceId: string | null;
  /** The preference event; null for mandatory mail and bells. */
  event: PreferenceEventKey | null;
  /** The in-app notification, run only when the app preference allows it. */
  bell?: () => Promise<unknown>;
  /** `to` defaults to the user's own address. */
  email?: Omit<EnqueueEmail<P>, 'to' | 'workspaceId'> & { to?: string };
}

/**
 * One call that tells a person about something: the bell and the email, each
 * honouring that person's preferences. It never throws, so a failed
 * notification can never break the action that caused it. The email's own
 * preference and suppression checks run again at send time in the worker.
 */
@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);

  constructor(
    private readonly prefs: NotificationPreferencesService,
    private readonly outbox: EmailOutboxService,
    private readonly recipients: RecipientsService,
  ) {}

  async notify<P>(input: NotifyInput<P>): Promise<void> {
    const { userId, workspaceId, event, bell, email } = input;
    if (bell) {
      try {
        if (
          event === null ||
          (await this.prefs.shouldSend(userId, workspaceId, event, 'app'))
        ) {
          await bell();
        }
      } catch (err) {
        this.warn('bell', input, err);
      }
    }
    if (email) {
      try {
        const address = email.to ?? (await this.recipients.user(userId))?.email;
        if (!address) {
          this.logger.warn(
            `notify email skipped: user ${userId} has no address`,
          );
          return;
        }
        await this.outbox.enqueue({
          ...email,
          to: { email: address, userId },
          workspaceId,
        });
      } catch (err) {
        this.warn('email', input, err);
      }
    }
  }

  private warn(part: string, input: NotifyInput<unknown>, err: unknown): void {
    this.logger.warn(
      `notify ${part} failed (event ${input.event ?? 'mandatory'}, user ${input.userId}): ${(err as Error)?.message ?? String(err)}`,
    );
  }
}
