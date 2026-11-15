import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailOutboxService } from '../email/queue/email-outbox.service';
import { AppLinks } from '../email/links/app-links';
import { formatWhen } from '../email/links/format-when';
import { clipMessage } from '../email/templates/support/message-text';
import { contactEnquiryTemplate } from '../email/templates/support/contact-enquiry';
import {
  contactReceivedTemplate,
  MESSAGE_PREVIEW_CHARS,
} from '../email/templates/support/contact-received';
import { newContactReference } from './contact-reference';
import type { ContactTopic, CreateContactDto } from './dto';

/** Where each subject should land. */
const TOPIC_LABELS: Record<ContactTopic, string> = {
  general: 'General enquiry',
  support: 'Support',
  billing: 'Billing & refunds',
  sales: 'Sales',
  privacy: 'Privacy & data',
  legal: 'Legal',
};

/**
 * A Reply-To is the sender's address, typed into a public form. The DTO has
 * validated it as an email; this refuses anything that could still break out
 * of a header (whitespace, CR/LF, a display name, a second address).
 */
const SAFE_REPLY_TO_RE = /^[^\s<>",;]+@[^\s<>",;]+$/;
const MAX_ADDRESS_CHARS = 254;

function safeReplyTo(email: string): string | undefined {
  return email.length <= MAX_ADDRESS_CHARS && SAFE_REPLY_TO_RE.test(email)
    ? email
    : undefined;
}

export interface ContactResult {
  /** True when the message reached us. The acknowledgement is best-effort. */
  delivered: boolean;
}

@Injectable()
export class ContactService {
  private readonly logger = new Logger(ContactService.name);
  /** Where enquiries land: CONTACT_INBOX_EMAIL, else SUPPORT_EMAIL. */
  private readonly inbox: string;

  constructor(
    private readonly outbox: EmailOutboxService,
    private readonly links: AppLinks,
    config: ConfigService,
  ) {
    this.inbox =
      config.get<string>('CONTACT_INBOX_EMAIL') || this.links.supportEmail();
  }

  /**
   * Handle one submission from the marketing site's contact form.
   *
   * Two messages go out, and they are deliberately not treated the same way:
   *
   * - **To us**, carrying the enquiry. Sent inline: if this fails the
   *   submission has effectively been lost, so the failure is surfaced to the
   *   caller and the form can tell the sender to email us directly instead of
   *   showing a success screen for a message nobody received.
   * - **To the sender**, acknowledging it. Queued and best-effort: if it
   *   cannot be queued or their mail server rejects it, we still have the
   *   enquiry, and failing the request would invite a resend that duplicates
   *   something we already hold.
   *
   * Both quote the same reference, so a reply threads to the enquiry. The
   * `Reply-To` on our copy is the sender's address, and on theirs the inbox.
   * Logs carry the reference, never an address or the message.
   */
  async submit(dto: CreateContactDto): Promise<ContactResult> {
    // Honeypot. Accepted and dropped rather than rejected — a 400 would tell
    // the sender which field tripped it.
    if (dto.website) {
      this.logger.warn('Contact form honeypot tripped');
      return { delivered: true };
    }

    const reference = newContactReference();
    const topic = TOPIC_LABELS[dto.topic];

    if (!this.inbox) {
      this.logger.error(
        `Contact form: no inbox configured, enquiry #${reference} was not sent`,
      );
      return { delivered: false };
    }

    const toUs = await this.outbox.sendNow({
      template: contactEnquiryTemplate,
      props: {
        reference,
        topic,
        name: dto.name,
        email: dto.email,
        company: dto.company || null,
        message: dto.message,
      },
      to: { email: this.inbox, userId: null },
      workspaceId: null,
      idempotencyKey: `contact.${reference}`,
      replyTo: safeReplyTo(dto.email),
    });

    if (!toUs.success) {
      this.logger.error(
        `Contact form: failed to deliver enquiry #${reference}: ${toUs.error ?? 'unknown error'}`,
      );
      return { delivered: false };
    }

    // Best-effort. A failed acknowledgement must not lose us the enquiry we
    // have already accepted, so its failure is logged and not returned.
    try {
      await this.outbox.enqueue({
        template: contactReceivedTemplate,
        props: {
          reference,
          topic,
          sentAt: formatWhen(new Date(), 'UTC'),
          // The job payload sits in Redis: keep what the quote shows, not 5 000 characters.
          message: clipMessage(dto.message, MESSAGE_PREVIEW_CHARS),
          maestroUrl: this.links.frontend('/'),
        },
        to: { email: dto.email, userId: null },
        workspaceId: null,
        idempotencyKey: `contact-ack.${reference}`,
        replyTo: this.inbox,
      });
    } catch (err) {
      this.logger.warn(
        `Contact form: enquiry #${reference} was received but the acknowledgement could not be queued: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return { delivered: true };
  }
}
