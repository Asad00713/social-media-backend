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
 *
 * Facebook and Instagram deliveries also accept FACEBOOK_CLIENT_SECRET: OAuth
 * signs with the Facebook app secret taken from `platform_credentials` or,
 * failing that, FACEBOOK_CLIENT_SECRET, so a deployment that only sets the
 * latter would otherwise reject every genuine delivery. (The DB value is not
 * read here; webhook verification stays env-only.)
 */
export function metaSigningSecrets(
  source: MetaWebhookSource,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidates =
    source === 'instagram'
      ? [
          env.INSTAGRAM_CLIENT_SECRET,
          env.META_APP_SECRET,
          env.FACEBOOK_CLIENT_SECRET,
        ]
      : source === 'threads'
        ? [env.THREADS_CLIENT_SECRET, env.META_APP_SECRET]
        : [env.META_APP_SECRET, env.FACEBOOK_CLIENT_SECRET];
  const secrets = candidates
    .map((s) => s?.trim())
    .filter((s): s is string => !!s);
  return [...new Set(secrets)];
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
