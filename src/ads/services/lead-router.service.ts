import { Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { leads, leadForms } from '../../drizzle/schema';
import { EmailService } from '../../email/email.service';
import { signWebhookPayload } from '../utils/hmac';

type RouteType = 'inbox' | 'email' | 'webhook';

interface WebhookConfig {
  url: string;
  secret?: string;
}

interface EmailConfig {
  to: string;
}

type RouteConfig = WebhookConfig | EmailConfig | Record<string, unknown>;

interface LeadPayload {
  id: string;
  formId: string;
  formName: string;
  capturedAt: string;
  data: Record<string, string>;
}

type AttemptRecord = {
  type: string;
  status: 'success' | 'failed';
  at: string;
  error?: string;
};

@Injectable()
export class LeadRouterService {
  private readonly logger = new Logger(LeadRouterService.name);

  constructor(private readonly email: EmailService) {}

  async deliver(
    leadId: string,
    routeId: string,
    type: RouteType,
    config: RouteConfig,
  ): Promise<void> {
    // 1. Load lead + form
    const leadRows = await db
      .select()
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (leadRows.length === 0) {
      this.logger.error(
        `LeadRouterService: lead=${leadId} not found — skipping delivery`,
      );
      return;
    }
    const lead = leadRows[0];

    const formRows = await db
      .select()
      .from(leadForms)
      .where(eq(leadForms.id, lead.leadFormId))
      .limit(1);
    const form = formRows[0] ?? null;

    // 2. Build normalized payload
    const payloadData: Record<string, string> = {};
    for (const field of lead.fieldData) {
      payloadData[field.name] = field.values[0] ?? '';
    }

    const payload: LeadPayload = {
      id: lead.id,
      formId: lead.leadFormId,
      formName: form?.name ?? 'Unknown Form',
      capturedAt: lead.capturedAt.toISOString(),
      data: payloadData,
    };

    let attempt: AttemptRecord;

    try {
      switch (type) {
        case 'inbox':
          attempt = await this.deliverToInbox(payload);
          break;
        case 'email':
          attempt = await this.deliverToEmail(payload, config as EmailConfig);
          break;
        case 'webhook':
          attempt = await this.deliverToWebhook(
            payload,
            config as WebhookConfig,
          );
          break;
        default:
          this.logger.warn(
            `LeadRouterService: unknown route type "${type}" for route=${routeId}`,
          );
          return;
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      attempt = {
        type,
        status: 'failed',
        at: new Date().toISOString(),
        error,
      };

      // Persist the failed attempt then rethrow so BullMQ retries
      await this.appendAttemptAndUpdateStatus(lead, attempt);
      throw err;
    }

    await this.appendAttemptAndUpdateStatus(lead, attempt);
    this.logger.log(
      `LeadRouterService: lead=${leadId} route=${routeId} type=${type} status=${attempt.status}`,
    );
  }

  // --------------------------------------------------------------------------
  // Private delivery methods
  // --------------------------------------------------------------------------

  private async deliverToInbox(payload: LeadPayload): Promise<AttemptRecord> {
    // Lead is already visible in the leads table — inbox reads directly from there.
    // No extra action needed; just record success.
    this.logger.debug(
      `LeadRouterService: inbox delivery for lead=${payload.id} is a no-op (lead already in DB)`,
    );
    return {
      type: 'inbox',
      status: 'success',
      at: new Date().toISOString(),
    };
  }

  private async deliverToEmail(
    payload: LeadPayload,
    config: EmailConfig,
  ): Promise<AttemptRecord> {
    const to = config?.to;
    if (!to) {
      throw new Error('Email route config missing "to" address');
    }

    const subject = `New lead captured: ${payload.formName}`;
    const html = formatLeadEmail(payload);

    const result = await this.email.sendEmail({ to, subject, html });

    if (!result.success) {
      throw new Error(result.error ?? 'EmailService returned failure');
    }

    return {
      type: 'email',
      status: 'success',
      at: new Date().toISOString(),
    };
  }

  private async deliverToWebhook(
    payload: LeadPayload,
    config: WebhookConfig,
  ): Promise<AttemptRecord> {
    const { url, secret } = config ?? {};
    if (!url) {
      throw new Error('Webhook route config missing "url"');
    }

    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (secret) {
      headers['X-Schedura-Signature'] = signWebhookPayload(secret, body);
    }

    const res = await fetch(url, { method: 'POST', headers, body });

    if (!res.ok) {
      throw new Error(
        `Webhook POST failed: HTTP ${res.status} ${res.statusText}`,
      );
    }

    return {
      type: 'webhook',
      status: 'success',
      at: new Date().toISOString(),
    };
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private async appendAttemptAndUpdateStatus(
    lead: typeof leads.$inferSelect,
    attempt: AttemptRecord,
  ): Promise<void> {
    const existing: AttemptRecord[] = Array.isArray(lead.deliveryAttempts)
      ? (lead.deliveryAttempts as AttemptRecord[])
      : [];
    const updated = [...existing, attempt];

    // Determine new overall status:
    // - All success → 'delivered'
    // - All failed → 'failed'
    // - Mixed → 'partial'
    // - If there's at least one success and one failure → 'partial'
    const hasSuccess = updated.some((a) => a.status === 'success');
    const hasFailed = updated.some((a) => a.status === 'failed');
    const newStatus =
      hasSuccess && !hasFailed
        ? 'delivered'
        : !hasSuccess && hasFailed
          ? 'failed'
          : 'partial';

    await db
      .update(leads)
      .set({
        deliveryAttempts: updated,
        deliveryStatus: newStatus,
      })
      .where(eq(leads.id, lead.id));
  }
}

// ----------------------------------------------------------------------------
// Email formatting helper
// ----------------------------------------------------------------------------

function formatLeadEmail(payload: LeadPayload): string {
  const rows = Object.entries(payload.data)
    .map(
      ([key, value]) =>
        `<tr>
          <td style="padding: 8px 12px; font-weight: 600; color: #374151; background: #f3f4f6; border: 1px solid #e5e7eb;">${escapeHtml(key)}</td>
          <td style="padding: 8px 12px; color: #111827; border: 1px solid #e5e7eb;">${escapeHtml(value)}</td>
        </tr>`,
    )
    .join('\n');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Lead: ${escapeHtml(payload.formName)}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 24px 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 22px;">New Lead Captured</h1>
    <p style="color: rgba(255,255,255,0.85); margin: 6px 0 0; font-size: 14px;">Form: ${escapeHtml(payload.formName)}</p>
  </div>

  <div style="background: #f9fafb; padding: 24px 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p style="margin: 0 0 16px; color: #6b7280; font-size: 13px;">
      Captured at: <strong>${payload.capturedAt}</strong> &nbsp;|&nbsp; Lead ID: <code style="font-size: 12px;">${payload.id}</code>
    </p>

    <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
      <thead>
        <tr>
          <th style="padding: 8px 12px; text-align: left; background: #e5e7eb; border: 1px solid #d1d5db;">Field</th>
          <th style="padding: 8px 12px; text-align: left; background: #e5e7eb; border: 1px solid #d1d5db;">Value</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>

  <div style="text-align: center; padding: 16px; color: #9ca3af; font-size: 12px;">
    <p style="margin: 0;">This notification was sent by Schedura.</p>
  </div>
</body>
</html>
  `.trim();
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
