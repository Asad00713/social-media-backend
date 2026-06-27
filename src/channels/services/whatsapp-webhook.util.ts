export interface ParsedWhatsAppMedia {
  mediaId: string;
  kind: 'image' | 'video' | 'audio' | 'voice' | 'file';
  mimeType?: string;
  caption?: string;
  filename?: string;
}

export interface ParsedWhatsAppMessage {
  phoneNumberId: string;
  fromWaId: string;
  messageId: string;
  text: string;
  timestamp: Date;
  authorName?: string;
  isText: boolean;
  /** Present for image/video/audio/voice/document/sticker messages. */
  media?: ParsedWhatsAppMedia;
  /** Placeholder text for non-media, non-text messages (location/contacts). */
  note?: string;
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
        const base = {
          phoneNumberId: String(phoneNumberId),
          fromWaId: String(msg?.from ?? ''),
          messageId: String(msg?.id ?? ''),
          timestamp: msg?.timestamp
            ? new Date(Number(msg.timestamp) * 1000)
            : new Date(),
          authorName: nameByWaId.get(String(msg?.from ?? '')),
          referral: msg?.referral,
        };
        const type = msg?.type as string | undefined;

        if (type === 'text' && typeof msg?.text?.body === 'string') {
          out.push({ ...base, text: String(msg.text.body), isText: true });
        } else if (
          type === 'image' ||
          type === 'video' ||
          type === 'audio' ||
          type === 'document' ||
          type === 'sticker'
        ) {
          const node = msg[type] ?? {};
          const kind: ParsedWhatsAppMedia['kind'] =
            type === 'image' || type === 'sticker'
              ? 'image'
              : type === 'video'
                ? 'video'
                : type === 'document'
                  ? 'file'
                  : node?.voice === true
                    ? 'voice'
                    : 'audio';
          const caption =
            typeof node?.caption === 'string' ? node.caption : undefined;
          out.push({
            ...base,
            text: caption ?? '',
            isText: false,
            media: {
              mediaId: String(node?.id ?? ''),
              kind,
              mimeType: node?.mime_type ? String(node.mime_type) : undefined,
              caption,
              filename:
                type === 'document' && node?.filename
                  ? String(node.filename)
                  : undefined,
            },
          });
        } else if (type === 'location') {
          out.push({ ...base, text: '', isText: false, note: '📍 Location' });
        } else if (type === 'contacts') {
          out.push({ ...base, text: '', isText: false, note: '👤 Contact' });
        }
        // else: unsupported (reaction/button/system/...) — skip
      }
    }
  }
  return out;
}
