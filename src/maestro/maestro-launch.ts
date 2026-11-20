import { CanActivate, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * The one switch that decides whether Maestro (the agent) may run.
 *
 * Maestro ships as "Coming soon". The frontend hides it, but that is not a
 * gate: the bridge reaches this backend straight from Telegram/WhatsApp, and
 * any API route can be called directly. So the backend keeps its own switch,
 * and every Maestro entry point asks THIS class -- never the env itself -- so
 * there is one spelling of "is Maestro on" to audit.
 *
 * ON only when `MAESTRO_ENABLED` is exactly `'true'`. Absent, empty, `'1'`,
 * `'TRUE'`, `'yes'` -- all OFF. Failing closed is the point: a typo in the
 * deploy config must not quietly launch an agent that spends tokens and
 * publishes on people's behalf.
 *
 * Read on every call rather than cached at boot, so a test (or an operator
 * restarting with a new value) never sees a stale answer.
 */

export const MAESTRO_COMING_SOON_CODE = 'MAESTRO_COMING_SOON';
export const MAESTRO_COMING_SOON_MESSAGE = 'Maestro is coming soon.';

/** The single fixed reply the bridge sends while Maestro is OFF. */
export const MAESTRO_BRIDGE_COMING_SOON_TEXT =
  "Maestro is coming soon. We'll let you know when it's ready.";

@Injectable()
export class MaestroLaunch {
  constructor(private readonly config: ConfigService) {}

  isEnabled(): boolean {
    return this.config.get<string>('MAESTRO_ENABLED') === 'true';
  }
}

/** The 403 every gated Maestro route answers with while Maestro is OFF. */
export function maestroComingSoon(): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    code: MAESTRO_COMING_SOON_CODE,
    message: MAESTRO_COMING_SOON_MESSAGE,
  });
}

/**
 * Applied to the WHOLE `MaestroController`, so every `/maestro/*` route --
 * including ones added later -- is closed while Maestro is OFF. Class-level
 * rather than per-route on purpose: a per-route list is the one somebody
 * forgets to extend.
 */
@Injectable()
export class MaestroLaunchGuard implements CanActivate {
  constructor(private readonly launch: MaestroLaunch) {}

  canActivate(): boolean {
    if (!this.launch.isEnabled()) throw maestroComingSoon();
    return true;
  }
}
