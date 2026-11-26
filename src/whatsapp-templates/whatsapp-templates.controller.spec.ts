import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { REQUIRE_CAPABILITY } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../workspace-members/workspace-role.service';
import { WhatsAppTemplatesController } from './whatsapp-templates.controller';
import { WhatsAppTemplatesService } from './whatsapp-templates.service';

const WS = '11111111-1111-4111-8111-111111111111';

describe('WhatsAppTemplatesController', () => {
  let app: INestApplication<App>;
  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  const service = {
    listForWorkspace: jest.fn(),
    syncWorkspace: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [WhatsAppTemplatesController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: WhatsAppTemplatesService, useValue: service },
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
    await app.init();
  });
  afterAll(() => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    roles.getRole.mockResolvedValue('GUEST');
    roles.isPlatformSuperAdmin.mockResolvedValue(false);
    service.listForWorkspace.mockResolvedValue([]);
    service.syncWorkspace.mockResolvedValue({ synced: 1 });
  });

  const capabilityOf = (name: 'list' | 'sync' | 'remove') =>
    Reflect.getMetadata(
      REQUIRE_CAPABILITY,
      WhatsAppTemplatesController.prototype[name],
    ) as string | undefined;

  it('keeps the list readable at inbox:view and the delete at channels:manage', () => {
    expect(capabilityOf('list')).toBe('inbox:view');
    expect(capabilityOf('remove')).toBe('channels:manage');
  });

  it('syncing from Meta needs inbox:reply', () => {
    expect(capabilityOf('sync')).toBe('inbox:reply');
  });

  const sync = () =>
    request(app.getHttpServer()).post(
      `/workspaces/${WS}/whatsapp-templates/sync`,
    );

  it('refuses a GUEST a forced sync and never calls Meta', async () => {
    await sync().expect(403);
    expect(service.syncWorkspace).not.toHaveBeenCalled();
  });

  it('lets a MEMBER force a sync', async () => {
    roles.getRole.mockResolvedValue('MEMBER');
    await sync().expect(200, { synced: 1 });
    expect(service.syncWorkspace).toHaveBeenCalledWith(WS, { force: true });
  });

  it('still lets a GUEST read the template list', async () => {
    await request(app.getHttpServer())
      .get(`/workspaces/${WS}/whatsapp-templates`)
      .expect(200, []);
  });
});
