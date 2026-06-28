import { Logger } from '@nestjs/common';

const logger = new Logger('MaestroAgentAuth');

export interface ResolvedAgentAuth {
  /** 'subscription' = Claude Code OAuth (Max plan); 'apiKey' = ANTHROPIC_API_KEY. */
  mode: 'apiKey' | 'subscription';
  /** Env to hand the Agent SDK subprocess (it REPLACES the subprocess env). */
  env: Record<string, string | undefined>;
}

/**
 * Resolve which auth the Agent SDK subprocess should use.
 *
 * DEFAULT = Claude Code subscription (Max plan): the subprocess authenticates
 * via the logged-in Claude Code OAuth. We strip `ANTHROPIC_API_KEY` from the
 * subprocess env so it does NOT silently fall back to the API-console key — that
 * key is the legacy chatbot's (Messages API) and may carry zero credits.
 *
 * Set `MAESTRO_AUTH_MODE=apikey` to bill via the Anthropic API instead
 * (production / scale); that keeps `ANTHROPIC_API_KEY` in the subprocess env.
 *
 * `Options.env` REPLACES the subprocess environment, so we spread `process.env`.
 */
export function resolveAgentAuth(): ResolvedAgentAuth {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'schedura-maestro/0.1',
  };

  const mode = (process.env.MAESTRO_AUTH_MODE || '').toLowerCase();

  // Explicit API-key billing (production / scale). Keep ANTHROPIC_API_KEY.
  if (mode === 'apikey' || mode === 'api' || mode === 'key') {
    if (!env.ANTHROPIC_API_KEY) {
      logger.warn('MAESTRO_AUTH_MODE=apikey but ANTHROPIC_API_KEY is not set');
    }
    logger.debug('Auth mode: apiKey');
    return { mode: 'apiKey', env };
  }

  // DEFAULT: Claude Code subscription (Max plan). Strip the API-console key so
  // the subprocess uses the logged-in Claude Code OAuth instead.
  delete env.ANTHROPIC_API_KEY;
  logger.debug('Auth mode: subscription (Max plan)');
  return { mode: 'subscription', env };
}
