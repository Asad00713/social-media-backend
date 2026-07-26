import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { subscriptions } from '../../drizzle/schema';
import { SKIP_SUSPEND_CHECK } from '../decorators/skip-suspend-check.decorator';

/**
 * Stripe statuses that HARD-suspend a workspace: billing has failed terminally
 * — dunning exhausted (`unpaid`), a cancellation took effect (`canceled`), or
 * the very first payment never completed (`incomplete_expired`). The soft grace
 * states (`past_due`, `incomplete`) are intentionally NOT here: the app warns
 * about them but stays usable, matching the frontend's two-tier gate.
 */
export const SUSPENDED_STATUSES = [
  'unpaid',
  'canceled',
  'incomplete_expired',
] as const;

/**
 * Global guard (registered as an APP_GUARD) that blocks every workspace-scoped
 * request whose workspace is billing-suspended, returning a structured 403 the
 * frontend recognises (`code: 'WORKSPACE_SUSPENDED'`).
 *
 * It is deliberately a broad no-op:
 *   • routes carrying `@SkipSuspendCheck()` (billing) always pass;
 *   • routes with no `:workspaceId` / `:wsId` param (auth, plan list, webhooks,
 *     health) are not workspace-scoped and always pass;
 *   • a workspace with no subscription row is FREE / never-subscribed and passes.
 * Only an active row in one of {@link SUSPENDED_STATUSES} is blocked, so the
 * blast radius is limited to genuinely-suspended workspaces.
 *
 * This is the app's first global guard — auth elsewhere is opt-in per route —
 * because billing enforcement is inherently cross-cutting: a suspended
 * workspace must be locked everywhere, not one controller at a time.
 */
@Injectable()
export class WorkspaceSuspendedGuard implements CanActivate {
  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_SUSPEND_CHECK, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const request = context
      .switchToHttp()
      .getRequest<{ params?: Record<string, string | undefined> }>();
    // `:workspaceId` everywhere except the analytics module, which uses `:wsId`.
    const workspaceId =
      request.params?.workspaceId ?? request.params?.wsId ?? null;
    if (!workspaceId) return true;

    const rows = await this.db
      .select({ status: subscriptions.status })
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, workspaceId))
      .limit(1);

    const status = rows[0]?.status;
    if (!status) return true;

    if ((SUSPENDED_STATUSES as readonly string[]).includes(status)) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'WORKSPACE_SUSPENDED',
        status,
        message:
          'This workspace is suspended because of a billing problem. Update your payment method to restore access.',
      });
    }

    return true;
  }
}
