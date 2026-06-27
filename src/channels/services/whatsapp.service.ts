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

  /**
   * Download a media object by id. Two-step: resolve the (token-gated) URL,
   * then fetch the binary. Used by the inbox ingest to rehost to R2.
   */
  async downloadMedia(
    accessToken: string,
    mediaId: string,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const metaRes = await fetch(`${WHATSAPP_GRAPH_BASE}/${mediaId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const meta = await metaRes.json().catch(() => ({}));
    if (!metaRes.ok || !meta?.url) {
      const msg =
        meta?.error?.message || `WhatsApp media lookup failed (${metaRes.status})`;
      throw new Error(msg);
    }
    const binRes = await fetch(meta.url as string, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!binRes.ok) {
      throw new Error(`WhatsApp media download failed (${binRes.status})`);
    }
    const buffer = Buffer.from(await binRes.arrayBuffer());
    const contentType =
      (meta.mime_type as string) ||
      binRes.headers.get('content-type') ||
      'application/octet-stream';
    return { buffer, contentType };
  }

  /**
   * Subscribe this app to the WABA so inbound message webhooks are delivered.
   * Manual webhook config alone does NOT route a specific WABA's events — the
   * WABA must list the app under subscribed_apps. Throws so the caller can log.
   */
  async subscribeWaba(accessToken: string, wabaId: string): Promise<void> {
    const res = await fetch(
      `${WHATSAPP_GRAPH_BASE}/${wabaId}/subscribed_apps`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.success === false) {
      const msg =
        data?.error?.message || `WABA subscribe failed (${res.status})`;
      throw new Error(msg);
    }
  }

  /**
   * Send a media message by public link (R2 URL). Captions are valid only on
   * image/video/document; `filename` only on document. 24h window applies.
   */
  async sendMedia(
    accessToken: string,
    phoneNumberId: string,
    toWaId: string,
    media: {
      type: 'image' | 'audio' | 'video' | 'document';
      link: string;
      caption?: string;
      filename?: string;
    },
  ): Promise<{ messageId: string }> {
    const mediaObj: Record<string, unknown> = { link: media.link };
    if (media.caption && media.type !== 'audio') mediaObj.caption = media.caption;
    if (media.filename && media.type === 'document') mediaObj.filename = media.filename;

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
        type: media.type,
        [media.type]: mediaObj,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        data?.error?.message || `WhatsApp media send failed (${res.status})`;
      throw new Error(msg);
    }
    return { messageId: data?.messages?.[0]?.id ?? '' };
  }
}
