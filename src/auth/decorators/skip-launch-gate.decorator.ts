import { SetMetadata } from '@nestjs/common';

export const SKIP_LAUNCH_GATE = 'skipLaunchGate';

/**
 * Marks a route/controller as exempt from AllowlistGuard, so it stays reachable
 * even for a non-allowlisted user. Applied to `/auth/me` (the frontend must be
 * able to read `isAllowlisted` to render the Under-development page).
 */
export const SkipLaunchGate = () => SetMetadata(SKIP_LAUNCH_GATE, true);
