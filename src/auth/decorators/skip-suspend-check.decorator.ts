import { SetMetadata } from '@nestjs/common';

export const SKIP_SUSPEND_CHECK = 'skipSuspendCheck';

/**
 * Marks a controller or route as exempt from {@link WorkspaceSuspendedGuard},
 * so it stays reachable even while the workspace is billing-suspended.
 *
 * Applied to the billing controller so a suspended user can still read their
 * subscription status and pay to recover — without it the lock would be a
 * dead end (you'd need to pay, but the pay route would itself be blocked).
 */
export const SkipSuspendCheck = () => SetMetadata(SKIP_SUSPEND_CHECK, true);
