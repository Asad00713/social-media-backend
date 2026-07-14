import { Injectable, Logger } from '@nestjs/common';

export const GRAPH_API_VERSION = 'v21.0';
export const WHATSAPP_GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/** The number already has two-step verification on, and our PIN is not its PIN. */
export const WA_ERROR_PIN_MISMATCH = 133005;

/**
 * A Graph error that carries Meta's numeric code. Callers branch on `code` rather
 * than pattern-matching `message`, which is prose Meta is free to reword or
 * localise.
 */
export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
    this.name = 'WhatsAppApiError';
  }
}

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
   * Exchange the short-lived Embedded Signup code (valid ~30s) for a
   * customer-scoped business access token. Tech Provider server-to-server call.
   */
  async exchangeCodeForBusinessToken(
    code: string,
  ): Promise<{ accessToken: string; expiresIn: number | null }> {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (!appId || !appSecret) {
      throw new Error('META_APP_ID / META_APP_SECRET are not configured');
    }
    const url =
      `${WHATSAPP_GRAPH_BASE}/oauth/access_token` +
      `?client_id=${encodeURIComponent(appId)}` +
      `&client_secret=${encodeURIComponent(appSecret)}` +
      `&code=${encodeURIComponent(code)}`;
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.access_token) {
      const msg = data?.error?.message || `Code exchange failed (${res.status})`;
      throw new Error(msg);
    }
    return {
      accessToken: data.access_token as string,
      expiresIn: typeof data.expires_in === 'number' ? data.expires_in : null,
    };
  }

  /**
   * WABA ids the customer actually granted us, read back off the business token
   * itself.
   *
   * Embedded Signup is supposed to hand the browser a `WA_EMBEDDED_SIGNUP`
   * message carrying `waba_id`, but that message is delivered by `postMessage`
   * and can simply never arrive (browser policy, extensions, Meta-side quirks) —
   * whereas the token is authoritative about what was granted. Meta lists the
   * most recently onboarded WABA first, so callers want `[0]`.
   */
  async getGrantedWabaIds(accessToken: string): Promise<string[]> {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (!appId || !appSecret) {
      throw new Error('META_APP_ID / META_APP_SECRET are not configured');
    }
    const url =
      `${WHATSAPP_GRAPH_BASE}/debug_token` +
      `?input_token=${encodeURIComponent(accessToken)}` +
      `&access_token=${encodeURIComponent(`${appId}|${appSecret}`)}`;
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        data?.error?.message || `Token inspection failed (${res.status})`;
      throw new Error(msg);
    }
    const scopes = (data?.data?.granular_scopes as any[]) ?? [];
    const managed = scopes.find(
      (s) => s?.scope === 'whatsapp_business_management',
    );
    return ((managed?.target_ids as any[]) ?? []).map((id) => String(id));
  }

  /**
   * Register the customer's business phone number for Cloud API use. `pin` is
   * the 6-digit two-step-verification PIN. If the number is already registered
   * (idempotent re-run) we treat it as success.
   */
  async registerPhoneNumber(
    accessToken: string,
    phoneNumberId: string,
    pin: string,
  ): Promise<void> {
    const res = await fetch(`${WHATSAPP_GRAPH_BASE}/${phoneNumberId}/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return;
    const msg = (data?.error?.message as string) || '';
    if (/already\s+registered/i.test(msg)) return; // idempotent
    const code = typeof data?.error?.code === 'number' ? data.error.code : null;
    throw new WhatsAppApiError(
      msg || `Phone number register failed (${res.status})`,
      code,
    );
  }

  /**
   * List the phone numbers on a WABA — fallback when the Embedded Signup
   * message event omits the phone_number_id, and to read verified_name.
   */
  async getWabaPhoneNumbers(
    accessToken: string,
    wabaId: string,
  ): Promise<
    Array<{ id: string; displayPhoneNumber: string | null; verifiedName: string | null }>
  > {
    const res = await fetch(
      `${WHATSAPP_GRAPH_BASE}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || `WABA phone lookup failed (${res.status})`;
      throw new Error(msg);
    }
    return ((data?.data as any[]) ?? []).map((p) => ({
      id: String(p.id),
      displayPhoneNumber: p.display_phone_number ?? null,
      verifiedName: p.verified_name ?? null,
    }));
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
