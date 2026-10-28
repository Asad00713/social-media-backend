import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

// InboxService reads `db` as a module singleton; the service-level block below
// only needs the channel select to return no rows.
jest.mock('../drizzle/db', () => ({
  db: {
    select: jest.fn(() => ({
      from: () => ({ where: () => Promise.resolve([]) }),
    })),
    update: jest.fn(),
    execute: jest.fn(),
  },
}));

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CloudflareR2Service } from '../media/cloudflare-r2.service';
import { REQUIRE_CAPABILITY } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../workspace-members/workspace-role.service';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { ScheduledMessagesService } from './services/scheduled-messages.service';

const WS = '11111111-1111-4111-8111-111111111111';

describe('POST /inbox/workspaces/:id/sync over HTTP', () => {
  let app: INestApplication<App>;
  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  const inbox = { syncNow: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InboxController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: InboxService, useValue: inbox },
        { provide: ScheduledMessagesService, useValue: {} },
        { provide: CloudflareR2Service, useValue: {} },
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
    inbox.syncNow.mockResolvedValue({ queued: 0 });
  });

  const post = () =>
    request(app.getHttpServer()).post(`/inbox/workspaces/${WS}/sync`);

  it('requires inbox:reply', () => {
    expect(
      Reflect.getMetadata(
        REQUIRE_CAPABILITY,
        // eslint-disable-next-line @typescript-eslint/unbound-method -- metadata read only
        InboxController.prototype.syncNow,
      ),
    ).toBe('inbox:reply');
  });

  it('rejects a GUEST and never syncs', async () => {
    roles.getRole.mockResolvedValue('GUEST');
    await post().expect(403);
    expect(inbox.syncNow).not.toHaveBeenCalled();
  });

  it('rejects a non-member', async () => {
    roles.getRole.mockResolvedValue(null);
    await post().expect(403);
    expect(inbox.syncNow).not.toHaveBeenCalled();
  });

  it('lets a MEMBER sync', async () => {
    await post().expect(202);
    expect(inbox.syncNow).toHaveBeenCalledWith(WS, 'user-1');
  });
});

describe('InboxService.syncNow', () => {
  it('does not delete inbox rows and returns no cleanedUp field', async () => {
    const service = new InboxService(
      {} as never,
      { supportedPlatforms: () => [] } as never,
      {} as never,
      {} as never,
      {} as never,
      { add: jest.fn() } as never,
    );
    jest
      .spyOn(service as any, 'assertWorkspaceAccess')
      .mockResolvedValue(undefined);
    const cleanup = jest.spyOn(
      service as any,
      'cleanupOrphanedThreadKeysForWorkspace',
    );

    const result = await service.syncNow(WS, 'user-1');

    expect(cleanup).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('cleanedUp');
    expect(result).toEqual({
      queued: 0,
      channels: [],
      webhookActivated: 0,
      webhookErrors: [],
    });
  });

  it('enqueues each poll with the per-channel dedup id and reports queued', async () => {
    const { db } = jest.requireMock('../drizzle/db') as {
      db: { select: jest.Mock; update: jest.Mock };
    };
    db.select.mockReturnValueOnce({
      from: () => ({
        where: () =>
          Promise.resolve([
            { id: 7, platform: 'twitter', platformAccountId: 'a' },
            { id: 9, platform: 'twitter', platformAccountId: 'b' },
          ]),
      }),
    });
    db.update.mockReturnValueOnce({
      set: () => ({ where: () => Promise.resolve() }),
    });
    const add = jest.fn();
    const service = new InboxService(
      {} as never,
      { supportedPlatforms: () => ['twitter'] } as never,
      {} as never,
      {} as never,
      {} as never,
      { add } as never,
    );
    jest
      .spyOn(service as any, 'assertWorkspaceAccess')
      .mockResolvedValue(undefined);

    const result = await service.syncNow(WS, 'user-1');

    expect(result.queued).toBe(2);
    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledWith(
      'poll',
      { channelId: 7 },
      expect.objectContaining({ deduplication: { id: 'inbox-poll-7' } }),
    );
    expect(add).toHaveBeenCalledWith(
      'poll',
      { channelId: 9 },
      expect.objectContaining({ deduplication: { id: 'inbox-poll-9' } }),
    );
  });
});
