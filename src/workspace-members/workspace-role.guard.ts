import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRE_CAPABILITY } from './require-capability.decorator';
import { roleCan, type Capability } from './role-capabilities';
import { WorkspaceRoleService } from './workspace-role.service';

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

    const req = context.switchToHttp().getRequest();
    const userId = req.user?.userId;
    const workspaceId =
      req.params?.workspaceId ?? req.params?.wsId ?? req.params?.wid;

    if (!userId || !workspaceId) {
      throw new ForbiddenException('Cannot resolve workspace role');
    }

    const role = await this.roleService.getRole(workspaceId, userId);
    if (!role || !roleCan(role, cap)) {
      throw new ForbiddenException(
        'You do not have permission to perform this action in this workspace',
      );
    }
    return true;
  }
}
