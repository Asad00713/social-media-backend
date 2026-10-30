import {
  ConflictException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

jest.mock('../drizzle/db', () => ({ db: {} }));

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CloudflareR2Service } from '../media/cloudflare-r2.service';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../workspace-members/workspace-role.service';
import { CommentActionsService } from './conversations/services/comment-actions.service';
import { ReplyResponseBuilder } from './conversations/services/reply-response.builder';
import { REQUIRE_CAPABILITY } from '../workspace-members/require-capability.decorator';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { ScheduledMessagesService } from './services/scheduled-messages.service';

const WS = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';
const base = `/inbox/workspaces/${WS}`;

const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
const inbox = {
  reply: jest.fn(),
  commentOnPost: jest.fn(),
  sendDm: jest.fn(),
  sendDmTemplate: jest.fn(),
};
const built = {
  forComment: jest.fn(),
  forDm: jest.fn(),
};

const LEGACY_COMMENT = { id: ITEM, platformItemId: 'p-1', text: 'hi' };
const LEGACY_DM = { id: ITEM, platformItemId: 'm-1', text: 'hi' };
const NODE = { id: ITEM, replies: [] };
const ENTRY = { kind: 'message', id: ITEM };
const ROW = { id: 'conv-1' };

/** Nth argument of a mock's first call. */
const arg = (fn: jest.Mock, n: number): unknown =>
  (fn.mock.calls[0] as unknown[])[n];

const SENT_AT = '2026-10-26T10:00:00.000Z';

jest.setTimeout(30000);

describe('InboxController reply routes', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InboxController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: InboxService, useValue: inbox },
        { provide: ReplyResponseBuilder, useValue: built },
        { provide: CommentActionsService, useValue: {} },
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
    app = moduleRef.createNestApplication<INestApplication<App>>();
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
    jest.resetAllMocks();
    roles.getRole.mockResolvedValue('MEMBER');
    roles.isPlatformSuperAdmin.mockResolvedValue(false);
    inbox.reply.mockResolvedValue(LEGACY_COMMENT);
    inbox.commentOnPost.mockResolvedValue(LEGACY_COMMENT);
    inbox.sendDm.mockResolvedValue(LEGACY_DM);
    inbox.sendDmTemplate.mockResolvedValue(LEGACY_DM);
    built.forComment.mockResolvedValue({ node: NODE, row: ROW });
    built.forDm.mockResolvedValue({ entry: ENTRY, row: ROW });
  });

  const http = () => request(app.getHttpServer());

  it('comment reply returns the legacy fields AND node AND row', async () => {
    const res = await http()
      .post(`${base}/comments/${ITEM}/reply`)
      .send({ text: 'hi' })
      .expect(201);
    expect(res.body).toEqual({ ...LEGACY_COMMENT, node: NODE, row: ROW });
    expect(built.forComment).toHaveBeenCalledWith(WS, 'user-1', LEGACY_COMMENT);
  });

  it('comment on a post returns legacy + node + row, and never applies markDone', async () => {
    const res = await http()
      .post(`${base}/threads/7:p1/comments`)
      .send({ text: 'hi' })
      .expect(201);
    expect(res.body).toEqual({ ...LEGACY_COMMENT, node: NODE, row: ROW });
    expect(inbox.commentOnPost).toHaveBeenCalledWith(
      WS,
      'user-1',
      '7:p1',
      'hi',
    );
  });

  it('sending a DM returns legacy + entry + row', async () => {
    const res = await http()
      .post(`${base}/dms/7:conv/messages`)
      .send({ text: 'hi' })
      .expect(201);
    expect(res.body).toEqual({ ...LEGACY_DM, entry: ENTRY, row: ROW });
    expect(built.forDm).toHaveBeenCalledWith(WS, 'user-1', LEGACY_DM);
  });

  it('a template send returns legacy + entry + row', async () => {
    const res = await http()
      .post(`${base}/dms/7:conv/template`)
      .send({ name: 'tpl', language: 'en', markDone: true })
      .expect(201);
    expect(res.body).toEqual({ ...LEGACY_DM, entry: ENTRY, row: ROW });
    expect(inbox.sendDmTemplate).toHaveBeenCalledWith(
      WS,
      'user-1',
      '7:conv',
      'tpl',
      'en',
      { markDone: true },
    );
  });

  it('forwards { markDone, typingStartedAt: Date, force } to the service', async () => {
    await http()
      .post(`${base}/comments/${ITEM}/reply`)
      .send({
        text: 'hi',
        markDone: false,
        typingStartedAt: SENT_AT,
        force: true,
      })
      .expect(201);
    const opts = arg(inbox.reply, 4) as {
      markDone: boolean;
      typingStartedAt: Date;
      force: boolean;
    };
    expect(opts).toEqual({
      markDone: false,
      typingStartedAt: new Date(SENT_AT),
      force: true,
    });
    expect(opts.typingStartedAt).toBeInstanceOf(Date);

    await http()
      .post(`${base}/dms/7:conv/messages`)
      .send({
        text: 'hi',
        markDone: false,
        typingStartedAt: SENT_AT,
        force: true,
      })
      .expect(201);
    expect(arg(inbox.sendDm, 5)).toEqual({
      markDone: false,
      typingStartedAt: new Date(SENT_AT),
      force: true,
    });
  });

  it('sends no opts keys the client did not send (the sender setting decides markDone)', async () => {
    await http()
      .post(`${base}/comments/${ITEM}/reply`)
      .send({ text: 'hi' })
      .expect(201);
    expect(arg(inbox.reply, 4)).toEqual({});
  });

  it.each([
    [`comments/${ITEM}/reply`, { text: 'hi', markDone: 'yes' }],
    [`comments/${ITEM}/reply`, { text: 'hi', typingStartedAt: 'soon' }],
    [`comments/${ITEM}/reply`, { text: 'hi', force: 'yes' }],
    ['dms/7:conv/messages', { text: 'hi', markDone: 'yes' }],
    ['dms/7:conv/messages', { text: 'hi', typingStartedAt: 'soon' }],
    ['dms/7:conv/template', { name: 'a', language: 'en', markDone: 'yes' }],
  ])('POST %s %j is a 400', async (path, body) => {
    await http().post(`${base}/${path}`).send(body).expect(400);
    expect(inbox.reply).not.toHaveBeenCalled();
    expect(inbox.sendDm).not.toHaveBeenCalled();
    expect(inbox.sendDmTemplate).not.toHaveBeenCalled();
  });

  it('rejects a GUEST on all four routes before the service', async () => {
    roles.getRole.mockResolvedValue('GUEST');
    await http()
      .post(`${base}/comments/${ITEM}/reply`)
      .send({ text: 'hi' })
      .expect(403);
    await http()
      .post(`${base}/threads/7:p1/comments`)
      .send({ text: 'hi' })
      .expect(403);
    await http()
      .post(`${base}/dms/7:conv/messages`)
      .send({ text: 'hi' })
      .expect(403);
    await http()
      .post(`${base}/dms/7:conv/template`)
      .send({ name: 'a', language: 'en' })
      .expect(403);
    expect(inbox.reply).not.toHaveBeenCalled();
    expect(inbox.commentOnPost).not.toHaveBeenCalled();
    expect(inbox.sendDm).not.toHaveBeenCalled();
    expect(inbox.sendDmTemplate).not.toHaveBeenCalled();
  });

  it('a REPLIED_FIRST ConflictException arrives as 409 with that body', async () => {
    const body = {
      code: 'REPLIED_FIRST',
      reply: { by: null, text: 'on it', at: SENT_AT },
    };
    inbox.sendDm.mockRejectedValue(new ConflictException(body));
    const res = await http()
      .post(`${base}/dms/7:conv/messages`)
      .send({ text: 'hi', typingStartedAt: SENT_AT })
      .expect(409);
    expect(res.body).toMatchObject(body);
    expect(built.forDm).not.toHaveBeenCalled();
  });

  it.each(['reply', 'commentOnPost', 'sendDm', 'sendDmTemplate'] as const)(
    '%s requires inbox:reply',
    (name) => {
      expect(
        Reflect.getMetadata(
          REQUIRE_CAPABILITY,
          InboxController.prototype[name],
        ),
      ).toBe('inbox:reply');
    },
  );

  it('POST threads/:threadKey/comments is { text } only: markDone is a 400', async () => {
    await http()
      .post(`${base}/threads/7:p1/comments`)
      .send({ text: 'hi', markDone: true })
      .expect(400);
    expect(inbox.commentOnPost).not.toHaveBeenCalled();
  });

  it('an explicit null typingStartedAt / markDone / force means "not sent", not 1970', async () => {
    await http()
      .post(`${base}/comments/${ITEM}/reply`)
      .send({ text: 'hi', typingStartedAt: null, markDone: null, force: null })
      .expect(201);
    expect(arg(inbox.reply, 4)).toEqual({});
  });

  it.each([
    ['comments/' + ITEM + '/reply', 'forComment', LEGACY_COMMENT],
    ['threads/7:p1/comments', 'forComment', LEGACY_COMMENT],
    ['dms/7:conv/messages', 'forDm', LEGACY_DM],
    ['dms/7:conv/template', 'forDm', LEGACY_DM],
  ] as const)(
    'POST %s: a builder failure after the send still answers 201 with the legacy body and row null',
    async (path, builderFn, legacy) => {
      built[builderFn].mockRejectedValue(new Error('pool timeout'));
      const body = path.endsWith('template')
        ? { name: 'a', language: 'en' }
        : { text: 'hi' };
      const res = await http().post(`${base}/${path}`).send(body).expect(201);
      expect(res.body).toEqual({ ...legacy, row: null });
    },
  );
});
