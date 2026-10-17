import { Injectable, NotFoundException } from '@nestjs/common';
import {
  roleCan,
  type Capability,
  type WorkspaceRole,
} from './role-capabilities';
import { WorkspaceRoleService } from './workspace-role.service';

/**
 * Service-level counterpart of WorkspaceRoleGuard, for routes whose workspace
 * id is NOT a path param (it comes from a body, a query, or is derived from a
 * resource such as a channel) and so cannot use the guard.
 *
 * Throws NotFound rather than Forbidden so a non-member cannot probe which
 * workspace / resource ids exist.
 */
@Injectable()
export class WorkspaceAccessService {
  constructor(private readonly roles: WorkspaceRoleService) {}

  async assertCan(
    workspaceId: string,
    userId: string,
    cap: Capability,
  ): Promise<WorkspaceRole | 'SUPER_ADMIN'> {
    const role = await this.roles.getRole(workspaceId, userId);
    if (role && roleCan(role, cap)) return role;
    // Failure path only: platform super admins are not workspace members.
    if (await this.roles.isPlatformSuperAdmin(userId)) return 'SUPER_ADMIN';
    throw new NotFoundException('Not found');
  }
}
