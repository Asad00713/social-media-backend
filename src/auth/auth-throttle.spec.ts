import 'reflect-metadata';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AuthController } from './auth.controller';
import {
  FORGOT_PASSWORD_THROTTLE,
  LOGIN_THROTTLE,
  REGISTER_THROTTLE,
  RESEND_CODE_THROTTLE,
} from './auth-throttle';
import { ClientIpThrottlerGuard } from '../common/guards/client-ip-throttler.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { JwtRefreshGuard } from './guards/jwt-refresh.guard';

/**
 * The unauthenticated auth routes are the one surface where a stranger can
 * spend our resources before proving anything, so every one of them must be
 * bounded by SOMETHING. Which "something" differs per route, and the point of
 * this file is that the choice is deliberate and recorded, rather than a
 * throttle sprayed over routes that did not need one.
 *
 * Written fail-closed: the list below is derived from the controller's own
 * route metadata, not hand-written, because the gap that BE #251 and BE #252
 * both found was a MISSING line that no hand-written list would have noticed.
 */

/** Metadata keys `@Throttle` writes — measured, not assumed: the name is */
/** appended with no separator (`THROTTLER:LIMITdefault`). */
const LIMIT_KEY = 'THROTTLER:LIMITdefault';
const TTL_KEY = 'THROTTLER:TTLdefault';

const proto = AuthController.prototype as unknown as Record<string, object>;

/** Every handler on the controller, with its route path. */
function handlers(): Array<{ name: string; path: string; handler: object }> {
  return Object.getOwnPropertyNames(AuthController.prototype)
    .filter((name) => name !== 'constructor')
    .map((name) => ({
      name,
      path: Reflect.getMetadata(PATH_METADATA, proto[name]) as string,
      handler: proto[name],
    }))
    .filter((h) => typeof h.path === 'string');
}

function guardsOf(handler: object): unknown[] {
  return (Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[]) ?? [];
}

function throttleOf(handler: object): { limit: number; ttl: number } | null {
  const limit = Reflect.getMetadata(LIMIT_KEY, handler) as number | undefined;
  const ttl = Reflect.getMetadata(TTL_KEY, handler) as number | undefined;
  return limit === undefined || ttl === undefined ? null : { limit, ttl };
}

describe('the limits are the ones that were reasoned about', () => {
  it.each([
    ['register', REGISTER_THROTTLE],
    ['login', LOGIN_THROTTLE],
    ['forgotPassword', FORGOT_PASSWORD_THROTTLE],
    ['resendVerification', RESEND_CODE_THROTTLE],
  ])('%s carries its named limit', (name, expected) => {
    expect(throttleOf(proto[name])).toEqual(expected.default);
  });

  it.each([
    ['login', LOGIN_THROTTLE, 10, 15 * 60 * 1000],
    ['register', REGISTER_THROTTLE, 5, 60 * 60 * 1000],
    ['forgot-password', FORGOT_PASSWORD_THROTTLE, 5, 60 * 60 * 1000],
    ['resend-code', RESEND_CODE_THROTTLE, 15, 15 * 60 * 1000],
  ])('%s is %p', (_label, bag, limit, ttl) => {
    // Pinned: a number nudged without a reason should fail here, so the
    // reasoning in auth-throttle.ts and the running limit cannot drift apart.
    expect(bag.default).toEqual({ limit, ttl });
  });
});

describe('resend is deliberately looser than forgot-password', () => {
  it('allows more resends per hour than reset mails', () => {
    const perHour = (bag: { default: { limit: number; ttl: number } }) =>
      (bag.default.limit * 60 * 60 * 1000) / bag.default.ttl;
    expect(perHour(RESEND_CODE_THROTTLE)).toBeGreaterThan(
      perHour(FORGOT_PASSWORD_THROTTLE),
    );
  });

  it('never locks a half-finished signup out for more than 15 minutes', () => {
    // Resend is the only button that screen has. An hour-long window on it
    // strands the person mid-signup with nowhere to go, which is the failure
    // the admin/challenge limit already had once.
    expect(RESEND_CODE_THROTTLE.default.ttl).toBeLessThanOrEqual(
      15 * 60 * 1000,
    );
  });

  it('still caps resend fan-out well below a mail flood', () => {
    const perHour =
      (RESEND_CODE_THROTTLE.default.limit * 60 * 60 * 1000) /
      RESEND_CODE_THROTTLE.default.ttl;
    expect(perHour).toBeLessThanOrEqual(60);
  });
});

describe('the four open routes bucket by the VISITOR, not the proxy', () => {
  it.each(['register', 'login', 'forgotPassword', 'resendVerification'])(
    '%s uses ClientIpThrottlerGuard',
    (name) => {
      expect(guardsOf(proto[name])).toContain(ClientIpThrottlerGuard);
    },
  );

  it.each(['register', 'login', 'forgotPassword', 'resendVerification'])(
    '%s does NOT use the plain ThrottlerGuard',
    (name) => {
      // The plain guard tracks `req.ip`, which behind Railway's edge is the
      // edge for every visitor: one shared bucket that 429s real customers
      // once any single caller exhausts it. That is strictly worse than no
      // limit, so it must never appear on a route meant to be per-visitor.
      expect(guardsOf(proto[name])).not.toContain(ThrottlerGuard);
    },
  );
});

/**
 * The fail-closed part. Every route a stranger can reach has to be bounded,
 * and this derives the list from the controller rather than restating it — so
 * a route added later shows up here instead of slipping through.
 */
describe('every unauthenticated route is bounded by something', () => {
  /**
   * Routes bounded by something the code does, not by a throttle. Each entry
   * names the mechanism, so this is a record of a decision rather than a
   * suppression list.
   */
  const BOUNDED_IN_CODE: Record<string, string> = {
    verifyOtp:
      'MAX_CODE_ATTEMPTS (5) claimed atomically before the comparison: a parallel burst cannot test a sixth code',
    verifyEmail: 'a crypto.randomBytes(32) token — 256 bits, not guessable',
    resetPassword: 'the same 256-bit token',
  };

  const JWT_GUARDS = [JwtAuthGuard, JwtRefreshGuard];

  const found = handlers();

  it('finds every route it is meant to police', () => {
    // Pinned so a renamed or dropped handler surfaces here rather than
    // quietly shrinking the net.
    expect(found.length).toBeGreaterThanOrEqual(13);
  });

  it.each(handlers().map((h) => [h.name, h.path] as [string, string]))(
    '%s (%s) is bounded',
    (name) => {
      const handler = proto[name];
      const guards = guardsOf(handler);
      const how = {
        throttled: throttleOf(handler) !== null,
        authenticated: JWT_GUARDS.some((g) => guards.includes(g)),
        boundedInCode: name in BOUNDED_IN_CODE,
      };
      expect({
        name,
        bounded: how.throttled || how.authenticated || how.boundedInCode,
      }).toEqual({ name, bounded: true });
    },
  );

  it('each code-bounded route still says HOW it is bounded', () => {
    for (const [name, why] of Object.entries(BOUNDED_IN_CODE)) {
      expect(typeof proto[name]).toBe('function');
      expect(why.length).toBeGreaterThan(20);
    }
  });
});
