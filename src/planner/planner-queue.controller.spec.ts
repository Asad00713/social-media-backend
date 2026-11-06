import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../workspace-members/workspace-role.service';
import { PlannerQueueController } from './planner-queue.controller';
import { QueueSlotsService } from './services/queue-slots.service';

const WS = '11111111-1111-4111-8111-111111111111';
const POST = '22222222-2222-4222-8222-222222222222';
const BODY = {
  timezone: 'UTC',
  slots: [],
  nextFree: null,
  top: null,
};

describe('PlannerQueueController over HTTP', () => {
  let app: INestApplication<App>;
  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  const queue = { get: jest.fn() };
  const get = (qs = '', ws = WS) =>
    request(app.getHttpServer()).get(`/planner/workspaces/${ws}/queue${qs}`);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PlannerQueueController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: QueueSlotsService, useValue: queue },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: {
          switchToHttp: () => { getRequest: () => { user?: unknown } };
        }) => {
          ctx.switchToHttp().getRequest().user = { userId: 'user-1' };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });
  afterAll(() => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    roles.getRole.mockResolvedValue('MEMBER');
    roles.isPlatformSuperAdmin.mockResolvedValue(false);
    queue.get.mockResolvedValue(BODY);
  });

  it('passes the caller, the channels and the draft id', async () => {
    await get(`?channelIds=7,%2012&excludePostId=${POST}`).expect(200, BODY);
    expect(queue.get).toHaveBeenCalledWith(WS, 'user-1', {
      channelIds: ['7', '12'],
      excludePostId: POST,
    });
  });

  it('works with no query at all', async () => {
    await get().expect(200);
    expect(queue.get).toHaveBeenCalledWith(WS, 'user-1', {
      channelIds: [],
      excludePostId: undefined,
    });
  });

  it.each([
    ['?channelIds=abc'],
    ['?channelIds=7,x'],
    ['?excludePostId=nope'],
    [`?channelIds=${Array.from({ length: 51 }, (_, i) => i).join(',')}`],
  ])('answers 400 to %s', async (qs) => {
    await get(qs).expect(400);
    expect(queue.get).not.toHaveBeenCalled();
  });

  it('lets a GUEST read it (posts:draft) and refuses a non-member', async () => {
    roles.getRole.mockResolvedValue('GUEST');
    await get().expect(200);
    roles.getRole.mockResolvedValue(null);
    await get().expect(403);
  });

  it('answers 400 to a non-UUID workspace id', async () => {
    await get('', 'abc').expect(400);
  });
});
