import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

function serverSecret(): string {
  const s = process.env.TELEGRAM_WEBHOOK_HMAC_SECRET;
  if (!s) {
    throw new Error('TELEGRAM_WEBHOOK_HMAC_SECRET is not configured');
  }
  return s;
}

/** Random opaque id embedded in the per-bot webhook URL path. */
export function generateTelegramRouteId(): string {
  return randomBytes(16).toString('hex'); // 32 hex chars
}

/** Per-bot webhook secret, derived (not stored) from the routeId. */
export function deriveTelegramWebhookSecret(routeId: string): string {
  return createHmac('sha256', serverSecret()).update(routeId).digest('hex');
}

/** Constant-time comparison of the X-Telegram-Bot-Api-Secret-Token header. */
export function verifyTelegramWebhookSecret(
  routeId: string,
  headerSecret: string | undefined,
): boolean {
  if (!headerSecret) return false;
  const expected = Buffer.from(deriveTelegramWebhookSecret(routeId), 'utf8');
  const got = Buffer.from(headerSecret, 'utf8');
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}
