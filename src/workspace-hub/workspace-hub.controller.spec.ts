import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceHubController } from './workspace-hub.controller';
import { WorkspaceHubService } from './workspace-hub.service';

describe('WorkspaceHubController over HTTP', () => {
  let app: INestApplication<App>;
  let signedIn = true;
  const hub = { listSummaries: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [WorkspaceHubController],
      providers: [{ provide: WorkspaceHubService, useValue: hub }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: {
          switchToHttp: () => { getRequest: () => { user?: unknown } };
        }) => {
          if (!signedIn) return false;
          ctx.switchToHttp().getRequest().user = { userId: 'user-1' };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(() => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    signedIn = true;
    hub.listSummaries.mockResolvedValue({ workspaces: [] });
  });

  it('lists the signed-in user’s own workspaces, by their id from the token', async () => {
    await request(app.getHttpServer())
      .get('/workspace-hub')
      .expect(200, { workspaces: [] });
    expect(hub.listSummaries).toHaveBeenCalledWith('user-1');
  });

  it('refuses a request with no signed-in user', async () => {
    signedIn = false;
    await request(app.getHttpServer()).get('/workspace-hub').expect(403);
    expect(hub.listSummaries).not.toHaveBeenCalled();
  });
});
