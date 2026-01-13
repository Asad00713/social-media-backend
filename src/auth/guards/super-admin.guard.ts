import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { JwtUser } from '../strategies/jwt.strategy';

@Injectable()
export class SuperAdminGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest();
        const user = request.user as JwtUser;

        if (!user) {
            throw new ForbiddenException('Authentication required');
        }

        if (user.role !== 'SUPER_ADMIN') {
            throw new ForbiddenException('Super admin access required');
        }

        return true;
    }
}
