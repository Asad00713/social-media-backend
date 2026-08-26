import { Logger } from '@nestjs/common';

const logger = new Logger('MaestroAgentAuth');

export type AgentAuthMode = 'apiKey' | 'subscription';

/** Where the resolved API key came from — drives billing downstream. */
export type AgentKeySource = 'platform' | 'byok';

export interface ResolvedAgentAuth {
  /** 'apiKey' = ANTHROPIC_API_KEY; 'subscription' = Claude Code OAuth (dev only). */
  mode: AgentAuthMode;
  /** Which key is paying for this run. 'byok' = the workspace's own key, so the
   *  turn must NOT be billed against plan credits. Always 'platform' under
   *  subscription mode. */
  keySource: AgentKeySource;
  /** Env to hand the Agent SDK subprocess (it REPLACES the subprocess env). */
  env: Record<string, string | undefined>;
}

/** Optional per-workspace overrides. Phase 2 (BYOK) passes the decrypted key. */
export interface AgentAuthOptions {
  /**
   * The workspace's own Anthropic API key (already decrypted), when it has one.
   * Takes priority over the platform key — the whole point of BYOK is that the
   * user's own Anthropic account is billed instead of ours.
   */
  workspaceApiKey?: string | null;
}

/**
 * Thrown when no usable credential exists. Surfaced to the user as a clean
 * error rather than letting the Agent SDK subprocess fail cryptically.
 */
export class MaestroAuthUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaestroAuthUnavailableError';
  }
}

/**
 * Resolve which credential the Agent SDK subprocess should use for one run.
 *
 * DEFAULT = API key. Maestro is a paid, multi-tenant product: every run must be
 * billable to an Anthropic API account, so the API key is the only mode that
 * works in production.
 *
 * `MAESTRO_AUTH_MODE=subscription` opts INTO Claude Code OAuth (a logged-in Max
 * plan) for LOCAL DEVELOPMENT ONLY. It is refused when NODE_ENV=production: a
 * container has no interactive OAuth session, and billing many tenants to one
 * personal subscription is not a commercial billing path.
 *
 * Key priority under apiKey mode:
 *   1. the workspace's own key (BYOK)   → keySource 'byok', not billed
 *   2. ANTHROPIC_API_KEY (platform)     → keySource 'platform', billed
 *
 * `Options.env` REPLACES the subprocess environment, so we spread `process.env`.
 *
 * @throws MaestroAuthUnavailableError when no usable credential is configured.
 */
export function resolveAgentAuth(
  options: AgentAuthOptions = {},
): ResolvedAgentAuth {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'schedura-maestro/0.1',
  };

  const isProduction = process.env.NODE_ENV === 'production';
  const rawMode = (process.env.MAESTRO_AUTH_MODE || '').toLowerCase();
  const wantsSubscription =
    rawMode === 'subscription' || rawMode === 'sub' || rawMode === 'oauth';

  // Subscription mode: local-dev convenience only, never in production.
  if (wantsSubscription) {
    if (isProduction) {
      throw new MaestroAuthUnavailableError(
        'MAESTRO_AUTH_MODE=subscription is not usable in production (no interactive Claude Code session). Set MAESTRO_AUTH_MODE=apikey and provide ANTHROPIC_API_KEY.',
      );
    }
    // Strip the API key so the subprocess genuinely uses the Claude Code OAuth
    // rather than silently falling back to the console key.
    delete env.ANTHROPIC_API_KEY;
    logger.debug('Auth mode: subscription (local dev, Claude Code OAuth)');
    return { mode: 'subscription', keySource: 'platform', env };
  }

  // BYOK — the workspace pays its own Anthropic bill.
  const byok = options.workspaceApiKey?.trim();
  if (byok) {
    env.ANTHROPIC_API_KEY = byok;
    logger.debug('Auth mode: apiKey (workspace BYOK)');
    return { mode: 'apiKey', keySource: 'byok', env };
  }

  // Platform key — the default paid path.
  const platformKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!platformKey) {
    throw new MaestroAuthUnavailableError(
      'Maestro is not configured: ANTHROPIC_API_KEY is missing. Set it in the environment, or set MAESTRO_AUTH_MODE=subscription for local development.',
    );
  }
  env.ANTHROPIC_API_KEY = platformKey;
  logger.debug('Auth mode: apiKey (platform key)');
  return { mode: 'apiKey', keySource: 'platform', env };
}
