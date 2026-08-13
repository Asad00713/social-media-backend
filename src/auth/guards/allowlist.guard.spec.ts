import { ExecutionContext, ForbiddenException } from '@nestjs/common';
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
  ({ getAllAndOverride: jest.fn().mockReturnValue(skip) }) as unknown as Reflector;

function make(opts: {
  skip?: boolean;
  verify?: (t: string) => { sub: string; email: string };
  role?: string;
}) {
  const jwtService = {
    verify: jest.fn((t: string) =>
      opts.verify ? opts.verify(t) : { sub: 'u1', email: 'x@x.com' },
    ),
  };
  const config = { get: jest.fn().mockReturnValue('secret') };
  const usersService = {
    findOneWithSuspension: jest.fn().mockResolvedValue({ role: opts.role ?? 'USER' }),
  };
  return new AllowlistGuard(
    reflector(!!opts.skip),
    jwtService as never,
    config as never,
    usersService as never,
  );
}

describe('AllowlistGuard', () => {
  const OLD = process.env.ALLOWLIST_EMAILS;
  afterEach(() => { process.env.ALLOWLIST_EMAILS = OLD; });

  it('passes when gate is off (no env)', async () => {
    delete process.env.ALLOWLIST_EMAILS;
    const g = make({});
    await expect(g.canActivate(ctx({ authorization: 'Bearer t' }))).resolves.toBe(true);
  });

  it('passes @SkipLaunchGate routes without checking', async () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    const g = make({ skip: true });
    await expect(g.canActivate(ctx({ authorization: 'Bearer t' }))).resolves.toBe(true);
  });

  it('passes when there is no/invalid token (let JwtAuthGuard handle auth)', async () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    const g = make({ verify: () => { throw new Error('bad'); } });
    await expect(g.canActivate(ctx({}))).resolves.toBe(true);
  });

  it('blocks an unlisted user with 403 NOT_LAUNCHED', async () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    const g = make({ verify: () => ({ sub: 'u1', email: 'c@z.com' }), role: 'USER' });
    await expect(g.canActivate(ctx({ authorization: 'Bearer t' }))).rejects.toMatchObject({
      response: { code: 'NOT_LAUNCHED' },
    });
  });

  it('passes a listed user', async () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    const g = make({ verify: () => ({ sub: 'u1', email: 'a@x.com' }), role: 'USER' });
    await expect(g.canActivate(ctx({ authorization: 'Bearer t' }))).resolves.toBe(true);
  });

  it('passes a super admin even if unlisted', async () => {
    process.env.ALLOWLIST_EMAILS = 'a@x.com';
    const g = make({ verify: () => ({ sub: 'u1', email: 'c@z.com' }), role: 'SUPER_ADMIN' });
    await expect(g.canActivate(ctx({ authorization: 'Bearer t' }))).resolves.toBe(true);
  });
});
