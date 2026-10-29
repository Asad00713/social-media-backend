import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

jest.mock('../drizzle/db', () => ({ db: {} }));

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CloudflareR2Service } from '../media/cloudflare-r2.service';
import { REQUIRE_CAPABILITY } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../workspace-members/workspace-role.service';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { CommentActionsService } from './conversations/services/comment-actions.service';
import { ScheduledMessagesService } from './services/scheduled-messages.service';

const WS = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const CONV = '33333333-3333-4333-8333-333333333333';
const base = `/inbox/workspaces/${WS}/scheduled`;
const SOON = new Date(Date.now() + 3_600_000).toISOString();

describe('scheduled routes over HTTP', () => {
  let app: INestApplication<App>;
  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  const scheduled = {
    create: jest.fn(),
    update: jest.fn(),
    cancel: jest.fn(),
    sendNow: jest.fn(),
    restore: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InboxController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: InboxService, useValue: {} },
        { provide: CommentActionsService, useValue: {} },
        { provide: ScheduledMessagesService, useValue: scheduled },
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
    for (const fn of Object.values(scheduled)) fn.mockResolvedValue({ id: ID });
  });

  const http = () => request(app.getHttpServer());
  const goodCreate = { inboxConversationId: CONV, text: 'hi', sendAt: SOON };

  it('rejects a GUEST on every write route and never reaches the service', async () => {
    roles.getRole.mockResolvedValue('GUEST');
    await http().post(base).send(goodCreate).expect(403);
    await http().patch(`${base}/${ID}`).send({ text: 'x' }).expect(403);
    await http().delete(`${base}/${ID}`).expect(403);
    await http().post(`${base}/${ID}/send-now`).expect(403);
    await http().post(`${base}/${ID}/restore`).expect(403);
    for (const fn of Object.values(scheduled))
      expect(fn).not.toHaveBeenCalled();
  });

  it('declares inbox:reply on the two new handlers', () => {
    for (const name of ['sendNow', 'restoreScheduled'] as const) {
      expect(
        Reflect.getMetadata(
          REQUIRE_CAPABILITY,

          InboxController.prototype[name],
        ),
      ).toBe('inbox:reply');
    }
  });

  it('answers 200 for send-now and restore', async () => {
    await http().post(`${base}/${ID}/send-now`).expect(200);
    await http().post(`${base}/${ID}/restore`).expect(200);
    expect(scheduled.sendNow).toHaveBeenCalledWith(WS, 'user-1', ID);
    expect(scheduled.restore).toHaveBeenCalledWith(WS, 'user-1', ID);
  });

  it('accepts the new create shape and the legacy one', async () => {
    await http().post(base).send(goodCreate).expect(201);
    await http()
      .post(base)
      .send({
        type: 'dm',
        threadKey: '4:pg:9',
        text: 'hi',
        scheduledAt: SOON,
      })
      .expect(201);
    expect(scheduled.create).toHaveBeenCalledTimes(2);
  });

  it('rejects a body that mixes both shapes, or neither, or both times', async () => {
    await http()
      .post(base)
      .send({ ...goodCreate, threadKey: '4:pg:9' })
      .expect(400);
    await http().post(base).send({ text: 'hi', sendAt: SOON }).expect(400);
    await http()
      .post(base)
      .send({ ...goodCreate, scheduledAt: SOON })
      .expect(400);
    await http()
      .post(base)
      .send({ inboxConversationId: CONV, text: 'hi' })
      .expect(400);
    expect(scheduled.create).not.toHaveBeenCalled();
  });

  it('rejects more than 10 attachments', async () => {
    const a = {
      kind: 'image',
      url: 'https://cdn.example.test/a.png',
      contentType: 'image/png',
    };
    await http()
      .post(base)
      .send({ ...goodCreate, attachments: Array(11).fill(a) })
      .expect(400);
  });

  it('still accepts the Planner PATCH { scheduledAt }', async () => {
    await http().patch(`${base}/${ID}`).send({ scheduledAt: SOON }).expect(200);
    expect(scheduled.update).toHaveBeenCalledWith(
      WS,
      'user-1',
      ID,
      expect.objectContaining({ scheduledAt: SOON }),
    );
  });
});
