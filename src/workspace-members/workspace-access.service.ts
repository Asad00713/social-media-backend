import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  roleCan,
  type Capability,
  type WorkspaceRole,
} from './role-capabilities';
import { WorkspaceRoleService } from './workspace-role.service';

/** What someone who is no longer in the workspace is told. */
export const NO_LONGER_MEMBER_MESSAGE =
  "You're no longer a member of this workspace.";

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

  /**
   * `assertCan` for a route whose caller is a person looking at a screen, not
   * a probe: it tells the two refusals apart. A member whose role is too low
   * has not left, so they get `roleMessage` (403); someone with no seat at
   * all still gets a 404, saying they are no longer a member. A platform
   * super admin passes, as in `assertCan`.
   */
  async assertCanOrExplain(
    workspaceId: string,
    userId: string,
    cap: Capability,
    roleMessage: string,
  ): Promise<WorkspaceRole | 'SUPER_ADMIN'> {
    try {
      return await this.assertCan(workspaceId, userId, cap);
    } catch (err) {
      if (!(err instanceof NotFoundException)) throw err;
      const role = await this.roles.getRole(workspaceId, userId);
      if (role) throw new ForbiddenException(roleMessage);
      throw new NotFoundException(NO_LONGER_MEMBER_MESSAGE);
    }
  }
}
