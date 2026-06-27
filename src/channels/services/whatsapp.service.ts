import { Injectable, Logger } from '@nestjs/common';

export const WHATSAPP_GRAPH_BASE = 'https://graph.facebook.com/v21.0';

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  /** Send a plain text message. Only valid inside the 24h customer window. */
  async sendText(
    accessToken: string,
    phoneNumberId: string,
    toWaId: string,
    text: string,
  ): Promise<{ messageId: string }> {
    const res = await fetch(`${WHATSAPP_GRAPH_BASE}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toWaId,
        type: 'text',
        text: { body: text, preview_url: false },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || `WhatsApp send failed (${res.status})`;
      throw new Error(msg);
    }
    return { messageId: data?.messages?.[0]?.id ?? '' };
  }

  /** Mark an inbound message read (blue ticks). Best-effort. */
  async markRead(
    accessToken: string,
    phoneNumberId: string,
    messageId: string,
  ): Promise<void> {
    try {
      await fetch(`${WHATSAPP_GRAPH_BASE}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
        }),
      });
    } catch (err) {
      this.logger.warn(`markRead failed: ${(err as Error).message}`);
    }
  }
}
