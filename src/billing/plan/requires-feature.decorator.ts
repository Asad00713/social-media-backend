import { SetMetadata } from '@nestjs/common';
import type { PlanFeature } from './plan-features';

export const REQUIRES_FEATURE = 'requiresPlanFeature';

/**
 * Marks a controller or route as needing a plan feature, enforced by
 * `PlanFeatureGuard`.
 *
 * ```ts
 * @RequiresFeature('inbox:use')
 * @Controller('workspaces/:workspaceId/inbox')
 * export class InboxController {}
 * ```
 *
 * Opt-in per route, unlike `WorkspaceSuspendedGuard` which is global.
 * Suspension is cross-cutting — a suspended workspace is locked everywhere —
 * but plan features are the opposite: most routes are the product everyone
 * pays nothing for, and only named ones are gated. A global plan guard would
 * have to carry a route-to-feature table, which is the same map in a worse
 * place: far from the controller it describes, and silently wrong whenever a
 * route is renamed.
 *
 * Applied to a class it covers every route in it; a route's own decorator
 * overrides the class's, so one endpoint can need a higher tier than its
 * siblings.
 */
export const RequiresFeature = (feature: PlanFeature) =>
  SetMetadata(REQUIRES_FEATURE, feature);
