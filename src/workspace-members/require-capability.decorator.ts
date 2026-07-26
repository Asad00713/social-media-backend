import { SetMetadata } from '@nestjs/common';
import type { Capability } from './role-capabilities';

export const REQUIRE_CAPABILITY = 'require_capability';
export const RequireCapability = (cap: Capability) =>
  SetMetadata(REQUIRE_CAPABILITY, cap);
