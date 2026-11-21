import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AllowlistGuard } from './allowlist.guard';

function ctx(headers: Record<string, string | undefined>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}
const reflector = (skip: boolean) =>
  ({
    getAllAndOverride: jest.fn().mockReturnValue(skip),
  }) as unknown as Reflector;

function make(opts: {
  skip?: boolean;
  verify?: (t: string) => { sub: string; email: string; sid?: string };
  /** What SessionCheck answers for a sid (default: live). */
  live?: boolean;
  role?: string;
  /** The address on the users row; the claim's email is never read. */
  email?: string;
  // Onboarding state of the looked-up user. Default: a real timestamp, i.e.
  // ONBOARDED — so the "block unlisted" tests exercise the post-onboarding
  // lock. Pass `null` to simulate a user still in onboarding; pass a custom
  // resolver via `user` to simulate a failed lookup.
  onboardingCompletedAt?: Date | string | null;
  user?: unknown;
}) {
  const jwtService = {
    verify: jest.fn((t: string) =>
      opts.verify ? opts.verify(t) : { sub: 'u1', email: 'x@x.com' },
    ),
  };
  const config = { get: jest.fn().mockReturnValue('secret') };
  const resolvedUser =
    'user' in opts
      ? opts.user
      : {
          role: opts.role ?? 'USER',
          email: opts.email ?? 'x@x.com',
          onboardingCompletedAt:
            opts.onboardingCompletedAt === undefined
              ? new Date('2026-01-01T00:00:00Z')
              : opts.onboardingCompletedAt,
        };
  const usersService = {
    findOneWithSuspension: jest.fn().mockResolvedValue(resolvedUser),
  };
  return new AllowlistGuard(
    reflector(!!opts.skip),
    jwtService as never,
    config as never,
    usersService as never,
    { isLive: jest.fn().mockResolvedValue(opts.live ?? true) } as never,
  );
}

describe('AllowlistGuard', () => {
  const OLD = process.env.ALLOWLIST_EMAILS;
  afterEach(() => {
    process.env.ALLOWLIST_EMAILS = OLD;
  });

  it('passes when gate is off (no env)', async () => {
    delete process.env.ALLOWLIST_EMAILS;
    const g = make({});
    await expect(
      g.canActivate(ctx({ authorization: 'Bearer t' })),
    ).resolves.toBe(true);
  });

  it('passes @SkipLaunchGate routes without checking', async () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    const g = make({ skip: true });
    await expect(
      g.canActivate(ctx({ authorization: 'Bearer t' })),
    ).resolves.toBe(true);
  });

  it('passes when there is no/invalid token (let JwtAuthGuard handle auth)', async () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    const g = make({
      verify: () => {
        throw new Error('bad');
      },
    });
    await expect(g.canActivate(ctx({}))).resolves.toBe(true);
  });

  it('blocks an unlisted user with 403 NOT_LAUNCHED', async () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    const g = make({
      verify: () => ({ sub: 'u1', email: 'c@z.com' }),
      role: 'USER',
    });
    await expect(
      g.canActivate(ctx({ authorization: 'Bearer t' })),
    ).rejects.toMatchObject({
      response: { code: 'NOT_LAUNCHED' },
    });
  });

  it('blocks an unlisted user still in onboarding (no onboarding pass-through)', async () => {
    // Pre-fix hole: a non-allowlisted user with onboardingCompletedAt === null
    // passed through and could connect channels + post. The gate now blocks
    // regardless of onboarding state; the genuine setup routes are opened via
    // @SkipLaunchGate instead.
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    const g = make({
      verify: () => ({ sub: 'u1', email: 'c@z.com' }),
      role: 'USER',
      onboardingCompletedAt: null,
    });
    await expect(
      g.canActivate(ctx({ authorization: 'Bearer t' })),
    ).rejects.toMatchObject({ response: { code: 'NOT_LAUNCHED' } });
  });

  it('blocks an unlisted user once onboarding is complete', async () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    const g = make({
      verify: () => ({ sub: 'u1', email: 'c@z.com' }),
      role: 'USER',
      onboardingCompletedAt: new Date('2026-02-01T00:00:00Z'),
    });
    await expect(
      g.canActivate(ctx({ authorization: 'Bearer t' })),
    ).rejects.toMatchObject({ response: { code: 'NOT_LAUNCHED' } });
  });

  it('blocks (fail-safe) an unlisted user when the user lookup fails', async () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    // Lookup returns nothing → onboardingCompletedAt undefined → must NOT open.
    const g = make({
      verify: () => ({ sub: 'u1', email: 'c@z.com' }),
      user: undefined,
    });
    await expect(
      g.canActivate(ctx({ authorization: 'Bearer t' })),
    ).rejects.toMatchObject({ response: { code: 'NOT_LAUNCHED' } });
  });

  it('passes a listed user', async () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    const g = make({
      verify: () => ({ sub: 'u1', email: 'a@x.com' }),
      role: 'USER',
      email: 'a@x.com',
    });
    await expect(
      g.canActivate(ctx({ authorization: 'Bearer t' })),
    ).resolves.toBe(true);
  });

  it('passes a super admin even if unlisted', async () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    const g = make({
      verify: () => ({ sub: 'u1', email: 'c@z.com' }),
      role: 'SUPER_ADMIN',
    });
    await expect(
      g.canActivate(ctx({ authorization: 'Bearer t' })),
    ).resolves.toBe(true);
  });

  it('decides on the address in the database, not a stale claim from before an email change', async () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    // The token still says a@x.com; the account moved to c@z.com since.
    const moved = make({
      verify: () => ({ sub: 'u1', email: 'a@x.com' }),
      role: 'USER',
      email: 'c@z.com',
    });
    await expect(
      moved.canActivate(ctx({ authorization: 'Bearer t' })),
    ).rejects.toMatchObject({ response: { code: 'NOT_LAUNCHED' } });

    // And the other way round: a listed address on the row is enough.
    const listed = make({
      verify: () => ({ sub: 'u1', email: 'c@z.com' }),
      role: 'USER',
      email: 'a@x.com',
    });
    await expect(
      listed.canActivate(ctx({ authorization: 'Bearer t' })),
    ).resolves.toBe(true);
  });

  it('a revoked sid → 401 Session ended (never the 403 NOT_LAUNCHED or a pass)', async () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    for (const email of ['a@x.com', 'c@z.com']) {
      const g = make({
        verify: () => ({
          sub: 'u1',
          email,
          sid: '11111111-1111-4111-8111-111111111111',
        }),
        email,
        live: false,
      });
      await expect(
        g.canActivate(ctx({ authorization: 'Bearer t' })),
      ).rejects.toMatchObject({ status: 401, message: 'Session ended' });
    }
  });

  it('a live sid on an allowlisted user passes', async () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    const g = make({
      verify: () => ({
        sub: 'u1',
        email: 'a@x.com',
        sid: '11111111-1111-4111-8111-111111111111',
      }),
      email: 'a@x.com',
    });
    await expect(
      g.canActivate(ctx({ authorization: 'Bearer t' })),
    ).resolves.toBe(true);
  });
});
