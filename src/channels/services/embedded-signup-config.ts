export interface EmbeddedSignupConfig {
  appId: string | null;
  configId: string | null;
  configured: boolean;
}

/**
 * Public (non-secret) client config the browser needs to launch WhatsApp Embedded
 * Signup. `app_id` and `config_id` are visible in Meta's consent-dialog URL, so
 * exposing them to an authenticated user is safe — the app SECRET never leaves the
 * server. Returns nulls + `configured:false` when unset so the UI can render a
 * "not set up" state instead of erroring.
 */
export function readEmbeddedSignupConfig(
  env: NodeJS.ProcessEnv,
): EmbeddedSignupConfig {
  const appId = env.META_APP_ID || null;
  const configId = env.WHATSAPP_ES_CONFIG_ID || null;
  return { appId, configId, configured: Boolean(appId && configId) };
}
