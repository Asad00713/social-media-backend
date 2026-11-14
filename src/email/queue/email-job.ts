import type { TemplateId } from '../templates/template-ids';
import type { EmailTemplateDef } from '../templates/types';

/** Who a message goes to. `userId` is null for a non-user (a guest, an enquiry). */
export interface EmailRecipient {
  email: string;
  userId: string | null;
}

/** What a caller hands the outbox: the def keeps `props` typed. */
export interface EnqueueEmail<P> {
  template: EmailTemplateDef<P>;
  props: P;
  to: EmailRecipient;
  workspaceId: string | null;
  /** The job id and Resend's Idempotency-Key, built from the logical entity. */
  idempotencyKey: string;
  replyTo?: string;
  delayMs?: number;
}

/** The serialisable job payload: the template travels by id. */
export interface EmailJobData {
  template: TemplateId;
  props: unknown;
  to: EmailRecipient;
  workspaceId: string | null;
  idempotencyKey: string;
  replyTo?: string;
}

export const EMAIL_JOB_SEND = 'send';

/** BullMQ job ids may not contain `:`, and Resend caps keys at 256 chars. */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._-]{1,200}$/;

/** A transient send failure (rate limit, 5xx, network): BullMQ retries it. */
export class RetryableEmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableEmailError';
  }
}
