import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isUUID } from 'class-validator';
import { SubscriptionLookupService } from '../services/subscription-lookup.service';
import { REQUIRES_FEATURE } from './requires-feature.decorator';
import {
  FEATURE_MIN_PLAN,
  planAllows,
  toPlanCode,
  type PlanFeature,
} from './plan-features';

/**
 * Enforces `@RequiresFeature(...)` — refuses a route whose plan feature the
 * workspace's plan does not include.
 *
 * Registered per controller, not globally: see the decorator for why.
 *
 * ## The 403 shape
 *
 * Mirrors `WorkspaceSuspendedGuard`'s structured refusal, because the frontend
 * already branches on `code`. `requiredPlan` is included so the UI can say
 * "Available on Pro" without keeping its own copy of the map — the same reason
 * the entitlements endpoint serves `featuresForPlan`.
 *
 * ## Errors fail OPEN, a resolved FREE plan fails CLOSED
 *
 * These are different cases and the guard treats them differently on purpose.
 *
 * A plan that resolves — including FREE, and including a workspace with no
 * subscription row at all — is an answer, and the answer is no. Failing open
 * there would make the whole map advisory.
 *
 * A lookup that *throws* is not an answer. A database blip must not take a
 * paying customer's Inbox away, and a plan gate is revenue protection, not a
 * security boundary: the worst case of waving one request through is that
 * someone briefly uses a feature they have not paid for. The worst case of
 * refusing is telling a Max customer their plan does not include what they
 * bought. Role and membership guards make the opposite trade, and should —
 * there the worst case is someone reading data that is not theirs.
 */
@Injectable()
export class PlanFeatureGuard implements CanActivate {
  private readonly logger = new Logger(PlanFeatureGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly lookup: SubscriptionLookupService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<PlanFeature>(
      REQUIRES_FEATURE,
      [context.getHandler(), context.getClass()],
    );
    // No decorator: this guard has nothing to say about the route.
    if (!feature) return true;

    const request = context.switchToHttp().getRequest<{
      params?: Record<string, string | undefined>;
      user?: { role?: string };
    }>();

    // A super admin is inspecting someone else's workspace, not using the
    // product on a plan of their own. Same exemption the suspend guard makes.
    if (request.user?.role === 'SUPER_ADMIN') return true;

    // `:workspaceId` everywhere except the analytics module, which uses
    // `:wsId` — the same two spellings the suspend guard resolves.
    const workspaceId =
      request.params?.workspaceId ?? request.params?.wsId ?? null;
    // A gated route with no workspace in its path cannot be answered. Rather
    // than guess, refuse: a route that needs a plan feature but is not
    // workspace-scoped is a wiring mistake, and failing open would hide it.
    if (!workspaceId || !isUUID(workspaceId)) {
      throw new ForbiddenException(this.payload(feature, 'FREE'));
    }

    let planCode: string;
    try {
      const subscription = await this.lookup.findByWorkspaceId(workspaceId);
      // No subscription row is a real answer, not a failure: the account is
      // free or never subscribed. `toPlanCode(null)` is FREE.
      planCode = subscription?.planCode ?? 'FREE';
    } catch (err) {
      // See the class comment: an unanswered lookup must not take a paid
      // feature away. Logged at error, because a plan gate quietly passing
      // everyone is exactly the kind of failure that hides for months.
      this.logger.error(
        `Plan lookup failed for workspace ${workspaceId}; allowing "${feature}" through: ${String(err)}`,
      );
      return true;
    }

    const plan = toPlanCode(planCode);
    if (planAllows(plan, feature)) return true;

    throw new ForbiddenException(this.payload(feature, plan));
  }

  private payload(feature: PlanFeature, plan: string) {
    return {
      statusCode: 403,
      error: 'Forbidden',
      code: 'PLAN_FEATURE_REQUIRED',
      feature,
      requiredPlan: FEATURE_MIN_PLAN[feature],
      currentPlan: plan,
      message: `This feature is not included in your plan. Upgrade to ${FEATURE_MIN_PLAN[feature]} to use it.`,
    };
  }
}
