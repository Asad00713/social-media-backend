import {
  ForbiddenException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { SKIP_SUSPEND_CHECK } from '../auth/decorators/skip-suspend-check.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard';
import { InboxAdminController } from './inbox-admin.controller';
import { InboxService } from './inbox.service';

const WS = '11111111-1111-4111-8111-111111111111';

describe('InboxAdminController over HTTP', () => {
  let app: INestApplication<App>;
  let allow = true;
  const inbox = { cleanupOrphanedThreadKeysForWorkspace: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InboxAdminController],
      providers: [{ provide: InboxService, useValue: inbox }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(SuperAdminGuard)
      .useValue({
        canActivate: () => {
          if (!allow) throw new ForbiddenException();
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });
  afterAll(() => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    allow = true;
    inbox.cleanupOrphanedThreadKeysForWorkspace.mockResolvedValue({
      deleted: 2,
      channels: [7],
    });
  });

  const url = (id: string) =>
    `/admin/inbox/workspaces/${id}/cleanup-orphaned-thread-keys`;

  it('runs the cleanup for a super admin and returns 200', async () => {
    await request(app.getHttpServer())
      .post(url(WS))
      .expect(200, { deleted: 2, channels: [7] });
    expect(inbox.cleanupOrphanedThreadKeysForWorkspace).toHaveBeenCalledWith(
      WS,
    );
  });

  it('rejects anyone else with 403', async () => {
    allow = false;
    await request(app.getHttpServer()).post(url(WS)).expect(403);
    expect(inbox.cleanupOrphanedThreadKeysForWorkspace).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid workspace id with 400', async () => {
    await request(app.getHttpServer()).post(url('nope')).expect(400);
    expect(inbox.cleanupOrphanedThreadKeysForWorkspace).not.toHaveBeenCalled();
  });

  it('stays reachable while a workspace is suspended', () => {
    expect(Reflect.getMetadata(SKIP_SUSPEND_CHECK, InboxAdminController)).toBe(
      true,
    );
  });
});
