import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRE_CAPABILITY } from './require-capability.decorator';
import {
  roleCan,
  type Capability,
  type WorkspaceRole,
} from './role-capabilities';
import { WorkspaceRoleService } from './workspace-role.service';

interface RoleRequest {
  user?: { userId?: string };
  params?: Record<string, string | undefined>;
  /** Set here so handlers can read it via @CurrentWorkspaceRole(). */
  workspaceRole?: WorkspaceRole | 'SUPER_ADMIN';
}

/** The denial every capability check on a workspace route answers with. */
function capabilityDenied(): ForbiddenException {
  return new ForbiddenException(
    'You do not have permission to perform this action in this workspace',
  );
}

/**
 * For a handler whose capability depends on its input (a bulk route that
 * needs more for one action): checks the role the guard already resolved,
 * and denies exactly as the guard does.
 */
export function assertRoleCan(
  role: WorkspaceRole | 'SUPER_ADMIN' | undefined,
  cap: Capability,
): void {
  if (role === 'SUPER_ADMIN') return;
  if (role && roleCan(role, cap)) return;
  throw capabilityDenied();
}

@Injectable()
export class WorkspaceRoleGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private roleService: WorkspaceRoleService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const cap = this.reflector.getAllAndOverride<Capability | undefined>(
      REQUIRE_CAPABILITY,
      [context.getHandler(), context.getClass()],
    );
    if (!cap) return true;

    const req = context.switchToHttp().getRequest<RoleRequest>();
    const userId = req.user?.userId;
    const workspaceId =
      req.params?.workspaceId ?? req.params?.wsId ?? req.params?.wid;

    if (!userId || !workspaceId) {
      throw new ForbiddenException('Cannot resolve workspace role');
    }

    const role = await this.roleService.getRole(workspaceId, userId);
    if (role && roleCan(role, cap)) {
      req.workspaceRole = role;
      return true;
    }
    // Platform super admins are not workspace members, so getRole returns null
    // for them. Let them through anyway (support/admin tooling), mirroring the
    // service-layer isPlatformSuperAdmin allowance. This lookup runs only on the
    // failure path, keeping it off the hot path for normal members.
    if (await this.roleService.isPlatformSuperAdmin(userId)) {
      req.workspaceRole = 'SUPER_ADMIN';
      return true;
    }
    throw capabilityDenied();
  }
}
