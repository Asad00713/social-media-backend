import { IsIn } from 'class-validator';
import type { PortalIntent } from '../providers/payment-provider.interface';

export const PORTAL_INTENTS = [
  'portal',
  'update_payment_method',
] as const satisfies readonly PortalIntent[];

/** Body of `POST billing/workspaces/:workspaceId/portal-link`. */
export class PortalLinkDto {
  @IsIn(PORTAL_INTENTS)
  intent: PortalIntent;
}
