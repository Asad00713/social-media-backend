import { Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { leads, leadForms } from '../../drizzle/schema';
import { EmailService } from '../../email/email.service';
import { AppLinks } from '../../email/links/app-links';
import { formatWhen } from '../../email/links/format-when';
import { renderEmail } from '../../email/render/render-email';
import {
  leadDelivered,
  leadFooterReason,
  type LeadDeliveredProps,
} from '../../email/templates/reports/lead-delivered';
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

  constructor(
    private readonly email: EmailService,
    private readonly links: AppLinks,
  ) {}

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
          attempt = await this.deliverToEmail(
            payload,
            config as EmailConfig,
            routeId,
          );
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
    routeId: string,
  ): Promise<AttemptRecord> {
    const to = config?.to;
    if (!to) {
      throw new Error('Email route config missing "to" address');
    }

    const props: LeadDeliveredProps = {
      formName: payload.formName,
      capturedAt: formatWhen(new Date(payload.capturedAt), 'UTC'),
      leadId: payload.id,
      fields: Object.entries(payload.data).map(([name, value]) => ({
        name,
        value,
      })),
    };
    const { subject, html, text } = await renderEmail(leadDelivered, props, {
      assetBaseUrl: this.links.assetBase(),
      footer: {
        reason: leadFooterReason(payload.formName),
        links: [
          { label: 'Help center', href: this.links.help() },
          { label: 'Privacy', href: this.links.privacy() },
        ],
      },
    });

    // The key names this lead and route, so a BullMQ retry after a lost
    // response is not sent twice (Resend dedupes the key for 24 h).
    const result = await this.email.deliver(
      { to, subject, html, text },
      {
        idempotencyKey: `lead.${payload.id}.${routeId}`,
        tags: { category: 'leads', template: 'lead-delivered' },
      },
    );

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
