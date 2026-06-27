export interface ParsedWhatsAppMessage {
  phoneNumberId: string;
  fromWaId: string;
  messageId: string;
  text: string;
  timestamp: Date;
  authorName?: string;
  isText: boolean;
  referral?: Record<string, any>;
}

/** Flatten a WhatsApp Cloud API webhook into inbound message rows. Ignores
 *  status callbacks (delivery/read) and keeps non-text as isText=false. */
export function parseWhatsAppMessages(payload: any): ParsedWhatsAppMessage[] {
  const out: ParsedWhatsAppMessage[] = [];
  if (payload?.object !== 'whatsapp_business_account') return out;
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== 'messages') continue;
      const value = change.value ?? {};
      const phoneNumberId = value?.metadata?.phone_number_id;
      const messages = value?.messages ?? [];
      if (!phoneNumberId || messages.length === 0) continue; // status-only → skip
      const nameByWaId = new Map<string, string>();
      for (const c of value?.contacts ?? []) {
        if (c?.wa_id && c?.profile?.name) nameByWaId.set(c.wa_id, c.profile.name);
      }
      for (const msg of messages) {
        const isText = msg?.type === 'text' && typeof msg?.text?.body === 'string';
        out.push({
          phoneNumberId: String(phoneNumberId),
          fromWaId: String(msg?.from ?? ''),
          messageId: String(msg?.id ?? ''),
          text: isText ? String(msg.text.body) : '',
          timestamp: msg?.timestamp
            ? new Date(Number(msg.timestamp) * 1000)
            : new Date(),
          authorName: nameByWaId.get(String(msg?.from ?? '')),
          isText,
          referral: msg?.referral,
        });
      }
    }
  }
  return out;
}
