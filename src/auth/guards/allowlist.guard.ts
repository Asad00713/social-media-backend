import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../../users/users.service';
import { isEmailAllowlisted, parseAllowlist } from '../allowlist';
import { SKIP_LAUNCH_GATE } from '../decorators/skip-launch-gate.decorator';

/**
 * Global launch gate. Before public launch, only allowlisted emails (and super
 * admins) may reach the app; everyone else gets 403 NOT_LAUNCHED. The gate is
 * OFF (pass-through) when ALLOWLIST_EMAILS is empty/unset.
 *
 * A non-allowlisted user is blocked from the whole app regardless of onboarding
 * state. The few pre-launch routes a signed-up user still needs — auth,
 * profile, create-workspace, complete-onboarding — opt out via @SkipLaunchGate,
 * so a non-allowlisted user can sign up and set up an account but cannot connect
 * channels or publish. (An earlier version instead passed through any user with
 * onboardingCompletedAt === null, which let random sign-ups connect channels and
 * post during onboarding — a live bypass this closes.)
 *
 * JwtAuthGuard is per-controller, not global, so this global guard cannot rely
 * on req.user. It verifies the bearer token itself (best-effort): no/invalid
 * token → pass (the route's own auth guard, if any, will reject). It is an
 * access gate only and never grants a role.
 */
@Injectable()
export class AllowlistGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Gate off → nothing to do, cheapest path first.
    if (parseAllowlist(process.env.ALLOWLIST_EMAILS).length === 0) return true;

    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_LAUNCH_GATE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const req = context
      .switchToHttp()
      .getRequest<{ headers?: Record<string, string | undefined> }>();
    const auth = req.headers?.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return true; // unauthenticated → not our job

    let payload: { sub?: string };
    try {
      payload = this.jwtService.verify(auth.slice(7), {
        secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      });
    } catch {
      return true; // invalid/expired token → let JwtAuthGuard 401 it
    }

    // The role ("super admin always passes") and the CURRENT address come from
    // the row, never from the token: the token's email claim is frozen at
    // sign-in, so after an email change it would still name an address the
    // account gave up, one someone else may since have registered. A failed
    // lookup fails SAFE (no role, no email → blocked below).
    let role: string | undefined;
    let email: string | undefined;
    try {
      const user = await this.usersService.findOneWithSuspension(
        payload.sub as string,
      );
      role = user?.role;
      email = user?.email;
    } catch {
      role = undefined;
      email = undefined;
    }

    if (isEmailAllowlisted(email, role)) return true;

    // Not allowlisted → blocked from the whole app, regardless of onboarding
    // state. The genuine pre-launch setup routes a signed-up user still needs
    // (auth, profile, create-workspace, complete-onboarding) are opened
    // individually via @SkipLaunchGate — see those handlers. This deliberately
    // does NOT wait for onboarding to complete: an earlier version passed
    // through any user with onboardingCompletedAt === null, which let random
    // sign-ups connect channels and publish during onboarding (a live bypass).
    throw new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      code: 'NOT_LAUNCHED',
      message:
        'Schedura is not yet publicly available. You will get access at launch.',
    });
  }
}
