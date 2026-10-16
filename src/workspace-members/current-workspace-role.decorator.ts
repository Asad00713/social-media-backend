import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { WorkspaceRole } from './role-capabilities';

interface RoleRequest {
  workspaceRole?: WorkspaceRole | 'SUPER_ADMIN';
}

/**
 * The caller's role in the path workspace, as resolved by WorkspaceRoleGuard
 * (`'SUPER_ADMIN'` for a platform super admin). Only populated on routes that
 * carry a `@RequireCapability`.
 */
export const CurrentWorkspaceRole = createParamDecorator(
  (
    _data: unknown,
    ctx: ExecutionContext,
  ): WorkspaceRole | 'SUPER_ADMIN' | undefined =>
    ctx.switchToHttp().getRequest<RoleRequest>().workspaceRole,
);
