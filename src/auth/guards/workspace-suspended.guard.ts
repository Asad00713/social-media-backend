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
import { subscriptions, workspace } from '../../drizzle/schema';
import { SKIP_SUSPEND_CHECK } from '../decorators/skip-suspend-check.decorator';

/**
 * Stripe statuses that HARD-suspend a workspace: billing has failed terminally
 * — dunning exhausted (`unpaid`) or the very first payment never completed
 * (`incomplete_expired`). Deliberately excluded:
 *   • `past_due` / `incomplete` — soft grace states; the app warns but stays
 *     usable, matching the frontend's two-tier gate.
 *   • `canceled` — a cancellation (voluntary or dunning-driven) is reset to the
 *     FREE plan by the subscription-deleted webhook, so the workspace becomes a
 *     free user, not a locked one.
 */
export const SUSPENDED_STATUSES = ['unpaid', 'incomplete_expired'] as const;

/**
 * Global guard (registered as an APP_GUARD) that blocks every workspace-scoped
 * request whose workspace is suspended — either manually (admin-driven
 * `workspace.isActive = false`) or via billing — returning a structured 403
 * the frontend recognises (`code: 'WORKSPACE_SUSPENDED'`, machine-readable
 * `reason`).
 *
 * It is deliberately a broad no-op:
 *   • routes carrying `@SkipSuspendCheck()` (billing) always pass;
 *   • routes with no `:workspaceId` / `:wsId` param (auth, plan list, webhooks,
 *     health) are not workspace-scoped and always pass;
 *   • a workspace with no row at all passes (nothing to enforce);
 *   • a workspace with no subscription row is FREE / never-subscribed and passes.
 * The manual check (`workspace.isActive === false`) runs first and
 * short-circuits before the subscription query. Only an active subscription
 * row in one of {@link SUSPENDED_STATUSES} is blocked on the billing path, so
 * the blast radius is limited to genuinely-suspended workspaces. `reason` is
 * `'billing'` for the billing path, else `workspace.suspendedReason` (falling
 * back to `'manual'`).
 *
 * This is the app's first global guard — auth elsewhere is opt-in per route —
 * because suspension enforcement is inherently cross-cutting: a suspended
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

    const request = context.switchToHttp().getRequest<{
      params?: Record<string, string | undefined>;
      user?: { role?: string };
    }>();

    // A super admin is never locked out of a suspended workspace — reaching one
    // to inspect and reactivate it is the whole point. This is a best-effort
    // second line behind @SkipSuspendCheck() on the admin controller: as a
    // global guard this can run before the route's auth guard populates
    // `request.user`, so when the role is present we honour it, and when it is
    // not the decorator has already exempted the admin routes.
    if (request.user?.role === 'SUPER_ADMIN') return true;
    // `:workspaceId` everywhere except the analytics module, which uses `:wsId`.
    const workspaceId =
      request.params?.workspaceId ?? request.params?.wsId ?? null;
    if (!workspaceId) return true;

    const wsRows = await this.db
      .select({ isActive: workspace.isActive, reason: workspace.suspendedReason })
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);

    const ws = wsRows[0];
    if (ws && ws.isActive === false) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'WORKSPACE_SUSPENDED',
        reason: ws.reason ?? 'manual',
        message: 'This workspace has been suspended. Contact support for details.',
      });
    }

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
        reason: 'billing',
        status,
        message:
          'This workspace is suspended because of a billing problem. Update your payment method to restore access.',
      });
    }

    return true;
  }
}
