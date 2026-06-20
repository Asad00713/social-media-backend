process.env.TELEGRAM_WEBHOOK_HMAC_SECRET = 'test-server-secret';
import {
  deriveTelegramWebhookSecret,
  verifyTelegramWebhookSecret,
  generateTelegramRouteId,
} from './telegram-webhook-secret.util';

describe('telegram-webhook-secret.util', () => {
  it('derives a stable hex secret for a routeId', () => {
    const a = deriveTelegramWebhookSecret('route-abc');
    const b = deriveTelegramWebhookSecret('route-abc');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('derives different secrets for different routeIds', () => {
    expect(deriveTelegramWebhookSecret('r1')).not.toBe(
      deriveTelegramWebhookSecret('r2'),
    );
  });

  it('verifies a matching header secret', () => {
    const secret = deriveTelegramWebhookSecret('route-xyz');
    expect(verifyTelegramWebhookSecret('route-xyz', secret)).toBe(true);
  });

  it('rejects a wrong or missing header secret', () => {
    expect(verifyTelegramWebhookSecret('route-xyz', 'nope')).toBe(false);
    expect(verifyTelegramWebhookSecret('route-xyz', undefined)).toBe(false);
  });

  it('generates a 32-hex routeId', () => {
    expect(generateTelegramRouteId()).toMatch(/^[0-9a-f]{32}$/);
  });
});
