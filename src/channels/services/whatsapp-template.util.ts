import type { WhatsAppTemplateComponent } from '../../drizzle/schema/whatsapp-templates.schema';

export interface ParsedTemplateEvent {
  wabaId: string;
  metaTemplateId: string;
  name: string;
  language: string;
  status: string;
  category?: string;
  reason?: string | null;
}

/**
 * Flatten `message_template_status_update` webhooks into status rows.
 *
 * Deliberately separate from `parseWhatsAppMessages`: that parser feeds inbox
 * ingest and the Maestro bridge, and both filter on `field === 'messages'`.
 * Widening it would put template payloads through message code paths.
 */
export function parseWhatsAppTemplateEvents(
  payload: any,
): ParsedTemplateEvent[] {
  const out: ParsedTemplateEvent[] = [];
  if (payload?.object !== 'whatsapp_business_account') return out;
  for (const entry of payload?.entry ?? []) {
    const wabaId = entry?.id;
    if (!wabaId) continue;
    for (const change of entry?.changes ?? []) {
      if (change?.field !== 'message_template_status_update') continue;
      const v = change.value ?? {};
      if (!v?.message_template_id || !v?.event) continue;
      out.push({
        wabaId: String(wabaId),
        metaTemplateId: String(v.message_template_id),
        name: String(v.message_template_name ?? ''),
        language: String(v.message_template_language ?? ''),
        status: String(v.event),
        category: v.message_template_category
          ? String(v.message_template_category)
          : undefined,
        reason: v.reason === undefined ? undefined : v.reason,
      });
    }
  }
  return out;
}

export interface MappedMetaTemplate {
  metaTemplateId: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components: WhatsAppTemplateComponent[];
}

/** Normalize one row of `GET /<waba>/message_templates` into our column shape. */
export function mapMetaTemplateRow(row: any): MappedMetaTemplate {
  return {
    metaTemplateId: String(row?.id ?? ''),
    name: String(row?.name ?? ''),
    language: String(row?.language ?? ''),
    category: String(row?.category ?? ''),
    status: String(row?.status ?? ''),
    components: Array.isArray(row?.components) ? row.components : [],
  };
}
