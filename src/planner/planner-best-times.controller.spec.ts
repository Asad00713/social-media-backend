import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { REQUIRE_CAPABILITY } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../workspace-members/workspace-role.service';
import { PlannerBestTimesController } from './planner-best-times.controller';
import { BestTimesService } from './services/best-times.service';

const WS = '11111111-1111-4111-8111-111111111111';

describe('PlannerBestTimesController over HTTP', () => {
  let app: INestApplication<App>;
  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  const service = { getForWorkspace: jest.fn() };
  const url = (ws = WS) => `/planner/workspaces/${ws}/best-times`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PlannerBestTimesController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: BestTimesService, useValue: service },
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
    service.getForWorkspace.mockResolvedValue({
      timezone: 'UTC',
      channels: [],
    });
  });

  it('returns the best times for the caller', async () => {
    await request(app.getHttpServer())
      .get(url())
      .expect(200, { timezone: 'UTC', channels: [] });
    expect(service.getForWorkspace).toHaveBeenCalledWith(WS, 'user-1');
  });

  it('lets a GUEST read', async () => {
    roles.getRole.mockResolvedValue('GUEST');
    await request(app.getHttpServer()).get(url()).expect(200);
  });

  it('answers 403 to a non-member', async () => {
    roles.getRole.mockResolvedValue(null);
    await request(app.getHttpServer()).get(url()).expect(403);
    expect(service.getForWorkspace).not.toHaveBeenCalled();
  });

  it('answers 400 to a non-UUID workspace id', async () => {
    await request(app.getHttpServer()).get(url('abc')).expect(400);
  });

  it('capability metadata: posts:draft', () => {
    const handler = Object.getOwnPropertyDescriptor(
      PlannerBestTimesController.prototype,
      'get',
    )?.value as object;
    expect(Reflect.getMetadata(REQUIRE_CAPABILITY, handler)).toBe(
      'posts:draft',
    );
  });
});
