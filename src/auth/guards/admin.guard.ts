import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { JwtUser } from '../strategies/jwt.strategy';

@Injectable()
export class AdminGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest();
        const user = request.user as JwtUser;

        if (!user) {
            throw new ForbiddenException('Authentication required');
        }

        // Allow both ADMIN and SUPER_ADMIN roles
        if (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
            throw new ForbiddenException('Admin access required');
        }

        return true;
    }
}
