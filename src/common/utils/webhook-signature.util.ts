import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Slack v0 signature verification.
 * See https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * Slack signs `v0:<timestamp>:<raw_body>` with HMAC-SHA256 keyed by the
 * Signing Secret, and sends the result as `X-Slack-Signature: v0=<hex>`.
 *
 * Rejects requests where the timestamp is more than 5 minutes off (replay
 * protection) and uses timing-safe comparison.
 */
export function verifySlackSignature(opts: {
  signingSecret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  toleranceSeconds?: number;
}): boolean {
  const { signingSecret, timestamp, signature, rawBody } = opts;
  const tolerance = opts.toleranceSeconds ?? 300;

  if (!timestamp || !signature || !signature.startsWith('v0=')) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > tolerance) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac('sha256', signingSecret).update(base).digest('hex')}`;

  // timingSafeEqual requires equal-length buffers; bail early on mismatched
  // lengths to avoid the throw.
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
