import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { REQUIRE_CAPABILITY } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { FirstWeekController } from './first-week.controller';

const WS = '11111111-1111-4111-8111-111111111111';
const USER = { userId: 'user-1' };

describe('FirstWeekController access', () => {
  const reflector = new Reflector();
  const guards =
    (Reflect.getMetadata(GUARDS_METADATA, FirstWeekController) as unknown[]) ??
    [];

  it('runs WorkspaceRoleGuard after the JWT guard has set req.user', () => {
    const jwt = guards.indexOf(JwtAuthGuard);
    const role = guards.indexOf(WorkspaceRoleGuard);
    expect(jwt).toBeGreaterThanOrEqual(0);
    expect(role).toBeGreaterThan(jwt);
  });

  const capabilityOf = (method: keyof FirstWeekController) =>
    reflector.getAllAndOverride<string | undefined>(REQUIRE_CAPABILITY, [
      (
        FirstWeekController.prototype as unknown as Record<
          string,
          () => unknown
        >
      )[method],
      FirstWeekController as unknown as () => unknown,
    ]);

  it('lets any member read the state (it renders on Home)', () => {
    expect(capabilityOf('getState')).toBe('analytics:view');
  });

  it.each(['saveBrand', 'retry', 'schedule', 'unschedule'] as const)(
    'makes %s need editor rights (posts:publish)',
    (method) => {
      expect(capabilityOf(method)).toBe('posts:publish');
    },
  );
});

describe('FirstWeekController delegation', () => {
  const service = {
    getState: jest.fn(() => Promise.resolve('state')),
    saveBrand: jest.fn(() => Promise.resolve('profile')),
    retry: jest.fn(() => Promise.resolve('profile')),
    schedule: jest.fn(() => Promise.resolve({ scheduled: [], skipped: [] })),
    unschedule: jest.fn(() => Promise.resolve({ unscheduled: [] })),
  };
  const controller = new FirstWeekController(service as any);
  beforeEach(() => jest.clearAllMocks());

  it('GET /', async () => {
    expect(await controller.getState(WS)).toBe('state');
    expect(service.getState).toHaveBeenCalledWith(WS);
  });

  it('PUT /brand passes the caller and the body', async () => {
    const body = { sells: 's', voice: ['v'], audience: 'a' };
    await controller.saveBrand(WS, USER, body);
    expect(service.saveBrand).toHaveBeenCalledWith(WS, 'user-1', body);
  });

  it('POST /retry', async () => {
    await controller.retry(WS, USER);
    expect(service.retry).toHaveBeenCalledWith(WS, 'user-1');
  });

  it('POST /schedule', async () => {
    await controller.schedule(WS, USER, { postIds: ['p1'] });
    expect(service.schedule).toHaveBeenCalledWith(WS, 'user-1', ['p1']);
  });

  it('POST /unschedule', async () => {
    await controller.unschedule(WS, { postIds: ['p1'] });
    expect(service.unschedule).toHaveBeenCalledWith(WS, ['p1']);
  });
});
