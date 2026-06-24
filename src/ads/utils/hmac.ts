import * as crypto from 'crypto';

/**
 * Sign a webhook payload with a shared secret using HMAC-SHA256.
 * Returns the signature in the format `sha256=<hex-digest>`,
 * matching GitHub-style webhook verification conventions.
 */
export function signWebhookPayload(secret: string, payload: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  return 'sha256=' + hmac.digest('hex');
}
