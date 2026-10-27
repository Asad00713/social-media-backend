import { verifyMetaSignature } from '../../common/utils/webhook-signature.util';

export type MetaWebhookSource = 'facebook' | 'instagram' | 'threads';

/**
 * Candidate signing secrets for a Meta webhook endpoint, in priority order.
 *
 * Meta signs every webhook POST with the app secret of the app that owns the
 * subscription
 * (https://developers.facebook.com/docs/graph-api/webhooks/getting-started#validate-payloads).
 * Instagram API with Instagram Login and the Threads API run under their own
 * app ids with their own secrets, so those endpoints accept either secret.
 */
export function metaSigningSecrets(
  source: MetaWebhookSource,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const own =
    source === 'instagram'
      ? env.INSTAGRAM_CLIENT_SECRET
      : source === 'threads'
        ? env.THREADS_CLIENT_SECRET
        : undefined;
  return [own, env.META_APP_SECRET]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s);
}

/** True when ANY candidate secret verifies the raw body's signature. */
export function isValidMetaDelivery(
  source: MetaWebhookSource,
  signatureHeader: string | undefined,
  rawBody: Buffer | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!rawBody) return false;
  return metaSigningSecrets(source, env).some((appSecret) =>
    verifyMetaSignature({ appSecret, signatureHeader, rawBody }),
  );
}
