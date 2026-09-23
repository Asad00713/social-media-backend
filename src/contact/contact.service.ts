import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailService } from '../email/email.service';
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

/** Escape anything a sender typed before it goes into an HTML email body. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface ContactResult {
  /** True when the message reached us. The acknowledgement is best-effort. */
  delivered: boolean;
}

@Injectable()
export class ContactService {
  private readonly logger = new Logger(ContactService.name);
  private readonly inbox: string;

  constructor(
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {
    this.inbox = this.config.get<string>(
      'CONTACT_INBOX_EMAIL',
      'info@schedura.ai',
    );
  }

  /**
   * Handle one submission from the marketing site's contact form.
   *
   * Two messages go out, and they are deliberately not treated the same way:
   *
   * - **To us**, carrying the enquiry. If this fails the submission has
   *   effectively been lost, so the failure is surfaced to the caller and the
   *   form can tell the sender to email us directly instead of showing a
   *   success screen for a message nobody received.
   * - **To the sender**, acknowledging it. Best-effort: if their mail server
   *   rejects it, we still have the enquiry, and failing the request would
   *   invite a resend that duplicates something we already hold.
   *
   * The `Reply-To` on our copy is the sender's address, so a reply goes back
   * to them rather than to the Resend from-address.
   */
  async submit(dto: CreateContactDto): Promise<ContactResult> {
    // Honeypot. Accepted and dropped rather than rejected — a 400 would tell
    // the sender which field tripped it.
    if (dto.website) {
      this.logger.warn(`Contact form honeypot tripped by ${dto.email}`);
      return { delivered: true };
    }

    const label = TOPIC_LABELS[dto.topic];

    const toUs = await this.email.sendEmail({
      to: this.inbox,
      replyTo: dto.email,
      subject: `[${label}] ${dto.name}`,
      html: this.enquiryHtml(dto, label),
      text: this.enquiryText(dto, label),
    });

    if (!toUs.success) {
      this.logger.error(
        `Contact form: failed to deliver enquiry from ${dto.email}: ${toUs.error}`,
      );
      return { delivered: false };
    }

    // Best-effort. A bounced acknowledgement must not lose us the enquiry we
    // have already accepted, so its result is logged and not returned.
    const ack = await this.email.sendEmail({
      to: dto.email,
      subject: 'We got your message — Schedura',
      html: this.acknowledgementHtml(dto, label),
      text: this.acknowledgementText(dto, label),
    });

    if (!ack.success) {
      this.logger.warn(
        `Contact form: enquiry from ${dto.email} was received but the acknowledgement failed: ${ack.error}`,
      );
    }

    return { delivered: true };
  }

  private enquiryHtml(dto: CreateContactDto, label: string): string {
    const rows: Array<[string, string]> = [
      ['Name', dto.name],
      ['Email', dto.email],
      ...(dto.company ? ([['Company', dto.company]] as Array<[string, string]>) : []),
      ['Topic', label],
    ];

    return `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;color:#16181d">
        <h2 style="margin:0 0 4px;font-size:17px">${esc(label)}</h2>
        <p style="margin:0 0 20px;color:#5b6270;font-size:13px">
          Sent from the contact form on schedura.ai
        </p>
        <table style="border-collapse:collapse;width:100%;font-size:14px">
          ${rows
            .map(
              ([k, v]) => `
            <tr>
              <td style="padding:6px 12px 6px 0;color:#5b6270;white-space:nowrap;vertical-align:top">${esc(k)}</td>
              <td style="padding:6px 0"><strong>${esc(v)}</strong></td>
            </tr>`,
            )
            .join('')}
        </table>
        <div style="margin-top:20px;padding:16px;background:#f6f6f7;border-radius:10px;font-size:14px;line-height:1.6;white-space:pre-wrap">${esc(
          dto.message,
        )}</div>
        <p style="margin-top:20px;font-size:13px;color:#5b6270">
          Reply to this email and it goes straight back to ${esc(dto.email)}.
        </p>
      </div>`;
  }

  private enquiryText(dto: CreateContactDto, label: string): string {
    return [
      `${label} — via schedura.ai contact form`,
      '',
      `Name:    ${dto.name}`,
      `Email:   ${dto.email}`,
      ...(dto.company ? [`Company: ${dto.company}`] : []),
      '',
      dto.message,
      '',
      `Reply to this email to answer ${dto.email} directly.`,
    ].join('\n');
  }

  private acknowledgementHtml(dto: CreateContactDto, label: string): string {
    const firstName = dto.name.split(' ')[0];
    return `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;color:#16181d">
        <p style="font-size:15px;line-height:1.6">Hi ${esc(firstName)},</p>
        <p style="font-size:15px;line-height:1.6">
          Thanks for writing — your message reached us and a person will read it.
          We reply to most enquiries within one business day.
        </p>
        <p style="font-size:15px;line-height:1.6">
          There's nothing you need to do in the meantime. If something changes or
          you want to add to it, just reply to this email.
        </p>
        <div style="margin:22px 0;padding:16px;background:#f6f6f7;border-radius:10px">
          <p style="margin:0 0 6px;font-size:12px;color:#5b6270;text-transform:uppercase;letter-spacing:.04em">
            ${esc(label)} — what you sent
          </p>
          <div style="font-size:14px;line-height:1.6;white-space:pre-wrap">${esc(dto.message)}</div>
        </div>
        <p style="font-size:15px;line-height:1.6">— The Schedura team</p>
        <p style="margin-top:26px;font-size:12px;color:#8a909b">
          Schedura LLC · 1309 Coffeen Avenue STE 1200, Sheridan, WY 82801, USA
        </p>
      </div>`;
  }

  private acknowledgementText(dto: CreateContactDto, label: string): string {
    const firstName = dto.name.split(' ')[0];
    return [
      `Hi ${firstName},`,
      '',
      'Thanks for writing — your message reached us and a person will read it.',
      'We reply to most enquiries within one business day.',
      '',
      `${label} — what you sent:`,
      dto.message,
      '',
      '— The Schedura team',
      'Schedura LLC · 1309 Coffeen Avenue STE 1200, Sheridan, WY 82801, USA',
    ].join('\n');
  }
}
