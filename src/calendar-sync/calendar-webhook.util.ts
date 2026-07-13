import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Per-channel webhook secret for the calendar push subscriptions.
 *
 * Mirrors `channels/utils/telegram-webhook-secret.util.ts`: the secret is
 * DERIVED (HMAC of the channel id under a server secret), never stored — so no
 * extra column on `calendar_sync_state` is needed. Google echoes it back in
 * `X-Goog-Channel-Token`; Microsoft Graph echoes it back as `clientState` on
 * every change notification.
 *
 * Server secret: `CALENDAR_WEBHOOK_HMAC_SECRET` if set, else `ENCRYPTION_KEY`
 * (always configured — see `common/utils/encryption.util.ts`). Rotating either
 * invalidates existing watches; the renewal job re-arms them within the hour.
 */
function serverSecret(): string {
  const secret =
    process.env.CALENDAR_WEBHOOK_HMAC_SECRET || process.env.ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      'Neither CALENDAR_WEBHOOK_HMAC_SECRET nor ENCRYPTION_KEY is configured',
    );
  }
  return secret;
}

/** Deterministic per-channel secret sent to (and echoed back by) the provider. */
export function deriveCalendarWebhookSecret(channelId: number): string {
  return createHmac('sha256', serverSecret())
    .update(`calendar-sync:${channelId}`)
    .digest('hex');
}

/**
 * Constant-time verification of the secret a provider echoed back
 * (Google `X-Goog-Channel-Token` / Graph `clientState`).
 */
export function verifyCalendarWebhookSecret(
  channelId: number,
  received: string | undefined | null,
): boolean {
  if (!received) return false;
  const expected = Buffer.from(deriveCalendarWebhookSecret(channelId), 'utf8');
  const got = Buffer.from(received, 'utf8');
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}

/**
 * Public HTTPS base the providers will call back on, e.g.
 * `https://api.schedura.com`. Reuses the same env chain as the Telegram webhook
 * (`API_PUBLIC_URL`, then `APP_URL`). Returns `null` when it is missing or not
 * HTTPS — both Google push channels and Graph subscriptions REQUIRE a public
 * HTTPS endpoint, so in that case we simply do not subscribe and let the 15-min
 * reconcile poll carry the sync (localhost dev).
 */
export function calendarWebhookBaseUrl(): string | null {
  const base = (process.env.API_PUBLIC_URL || process.env.APP_URL || '')
    .trim()
    .replace(/\/+$/, '');
  if (!base) return null;
  if (!base.startsWith('https://')) return null;
  return base;
}
