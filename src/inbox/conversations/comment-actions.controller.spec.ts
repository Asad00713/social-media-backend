import { INestApplication, Type, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

jest.mock('../../drizzle/db', () => ({ db: {} }));

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CloudflareR2Service } from '../../media/cloudflare-r2.service';
import { REQUIRE_CAPABILITY } from '../../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../../workspace-members/workspace-role.service';
import { InboxController } from '../inbox.controller';
import { InboxService } from '../inbox.service';
import { ScheduledMessagesService } from '../services/scheduled-messages.service';
import { CommentActionsController } from './comment-actions.controller';
import { CommentActionsService } from './services/comment-actions.service';
import { ReplyResponseBuilder } from './services/reply-response.builder';

const WS = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';
const base = `/inbox/workspaces/${WS}/comments`;

const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
const actions = {
  like: jest.fn(),
  hide: jest.fn(),
  delete: jest.fn(),
  privateReply: jest.fn(),
};
const inbox = { archiveCommentThread: jest.fn() };

async function build(
  controllers: Array<Type<unknown>>,
): Promise<INestApplication<App>> {
  const moduleRef = await Test.createTestingModule({
    controllers,
    providers: [
      WorkspaceRoleGuard,
      { provide: WorkspaceRoleService, useValue: roles },
      { provide: CommentActionsService, useValue: actions },
      { provide: ReplyResponseBuilder, useValue: {} },
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
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.init();
  return app;
}

describe('CommentActionsController over HTTP', () => {
  let app: INestApplication<App>;
  beforeAll(async () => {
    app = await build([CommentActionsController]);
  });
  afterAll(() => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    roles.getRole.mockResolvedValue('MEMBER');
    roles.isPlatformSuperAdmin.mockResolvedValue(false);
    actions.like.mockResolvedValue({ node: { id: ITEM } });
    actions.hide.mockResolvedValue({ node: { id: ITEM } });
    actions.delete.mockResolvedValue({ ok: true });
    actions.privateReply.mockResolvedValue({ conversationId: 'c-1' });
  });

  const http = () => request(app.getHttpServer());

  it('rejects a GUEST on all four routes and never reaches the service', async () => {
    roles.getRole.mockResolvedValue('GUEST');
    await http().post(`${base}/${ITEM}/like`).send({ liked: true }).expect(403);
    await http()
      .post(`${base}/${ITEM}/hide`)
      .send({ hidden: true })
      .expect(403);
    await http().delete(`${base}/${ITEM}`).expect(403);
    await http()
      .post(`${base}/${ITEM}/private-reply`)
      .send({ text: 'hi' })
      .expect(403);
    for (const fn of Object.values(actions)) expect(fn).not.toHaveBeenCalled();
  });

  it('declares inbox:reply on every handler', () => {
    for (const name of ['like', 'hide', 'remove', 'privateReply'] as const) {
      expect(
        Reflect.getMetadata(
          REQUIRE_CAPABILITY,
          CommentActionsController.prototype[name],
        ),
      ).toBe('inbox:reply');
    }
  });

  it('answers 200 and passes the workspace, item, user and body through', async () => {
    await http()
      .post(`${base}/${ITEM}/like`)
      .send({ liked: true })
      .expect(200, { node: { id: ITEM } });
    expect(actions.like).toHaveBeenCalledWith(WS, ITEM, 'user-1', true);

    await http()
      .post(`${base}/${ITEM}/hide`)
      .send({ hidden: false })
      .expect(200);
    expect(actions.hide).toHaveBeenCalledWith(WS, ITEM, 'user-1', false);

    await http().delete(`${base}/${ITEM}`).expect(200, { ok: true });
    expect(actions.delete).toHaveBeenCalledWith(WS, ITEM, 'user-1');

    await http()
      .post(`${base}/${ITEM}/private-reply`)
      .send({ text: 'hello' })
      .expect(200, { conversationId: 'c-1' });
    expect(actions.privateReply).toHaveBeenCalledWith(
      WS,
      ITEM,
      'user-1',
      'hello',
    );
  });

  it('rejects a malformed body', async () => {
    await http()
      .post(`${base}/${ITEM}/like`)
      .send({ liked: 'yes' })
      .expect(400);
    await http().post(`${base}/${ITEM}/hide`).send({ hidden: 1 }).expect(400);
    await http()
      .post(`${base}/${ITEM}/private-reply`)
      .send({ text: '' })
      .expect(400);
    await http()
      .post(`${base}/${ITEM}/private-reply`)
      .send({ text: 'x'.repeat(1001) })
      .expect(400);
    await http()
      .post(`${base}/${ITEM}/like`)
      .send({ liked: true, extra: 1 })
      .expect(400);
    expect(actions.like).not.toHaveBeenCalled();
    expect(actions.privateReply).not.toHaveBeenCalled();
  });

  it('the legacy PATCH hide delegates with (workspace, item, user, hidden) in that order', async () => {
    const legacyApp = await build([InboxController]);
    try {
      actions.hide.mockResolvedValue({ success: true, isHidden: true });
      await request(legacyApp.getHttpServer())
        .patch(`${base}/${ITEM}/hide`)
        .send({ hidden: true })
        .expect(200, { success: true, isHidden: true });
      expect(actions.hide).toHaveBeenCalledWith(WS, ITEM, 'user-1', true);
    } finally {
      await legacyApp.close();
    }
  });

  it('rejects an item id that is not a uuid', async () => {
    await http().post(`${base}/nope/like`).send({ liked: true }).expect(400);
    await http().delete(`${base}/nope`).expect(400);
    expect(actions.like).not.toHaveBeenCalled();
    expect(actions.delete).not.toHaveBeenCalled();
  });
});

describe('DELETE comments/thread/:threadKey route order', () => {
  const threadUrl = `${base}/thread/${encodeURIComponent('5:post-1')}`;

  // Both registration orders: the thread route must win regardless of which
  // controller Nest registers first.
  it.each([
    ['InboxController first', [InboxController, CommentActionsController]],
    [
      'CommentActionsController first',
      [CommentActionsController, InboxController],
    ],
  ] as Array<[string, Array<Type<unknown>>]>)(
    'reaches archiveCommentThread, not the item delete (%s)',
    async (_name, controllers) => {
      jest.clearAllMocks();
      roles.getRole.mockResolvedValue('MEMBER');
      roles.isPlatformSuperAdmin.mockResolvedValue(false);
      inbox.archiveCommentThread.mockResolvedValue({
        success: true,
        archivedCount: 2,
      });
      actions.delete.mockResolvedValue({ ok: true });

      const app = await build(controllers);
      try {
        await request(app.getHttpServer())
          .delete(threadUrl)
          .expect(200, { success: true, archivedCount: 2 });
        expect(inbox.archiveCommentThread).toHaveBeenCalledWith(
          WS,
          'user-1',
          '5:post-1',
        );
        expect(actions.delete).not.toHaveBeenCalled();

        // and a uuid still deletes the item, not the thread
        await request(app.getHttpServer())
          .delete(`${base}/${ITEM}`)
          .expect(200);
        expect(actions.delete).toHaveBeenCalledWith(WS, ITEM, 'user-1');
        expect(inbox.archiveCommentThread).toHaveBeenCalledTimes(1);
      } finally {
        await app.close();
      }
    },
  );

  it('InboxController no longer owns DELETE comments/:itemId', () => {
    expect(
      (InboxController.prototype as unknown as Record<string, unknown>)
        .deleteComment,
    ).toBeUndefined();
  });
});
