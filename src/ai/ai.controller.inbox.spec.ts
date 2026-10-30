import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { REQUIRE_CAPABILITY } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../workspace-members/workspace-role.service';
import { AiController } from './ai.controller';
import { GroqService } from './groq.service';
import { AiTokenService } from './services/ai-token.service';
import { ElevenLabsSttService } from './services/elevenlabs-stt.service';
import { ComposerAiService } from './composer-ai.service';
import { InboxAiService } from './inbox-ai.service';

const WS = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const COMMENT = '33333333-3333-4333-8333-333333333333';

describe('AiController inbox routes over HTTP', () => {
  let app: INestApplication<App>;
  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  const inboxAi = { suggestReply: jest.fn(), quickReplies: jest.fn() };
  const suggestUrl = `/ai/workspaces/${WS}/inbox/suggest-reply`;
  const quickUrl = `/ai/workspaces/${WS}/inbox/quick-replies`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AiController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: GroqService, useValue: {} },
        { provide: AiTokenService, useValue: {} },
        { provide: ElevenLabsSttService, useValue: {} },
        { provide: ComposerAiService, useValue: {} },
        { provide: InboxAiService, useValue: inboxAi },
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
    inboxAi.suggestReply.mockResolvedValue({ reply: 'ok', usage: {} });
    inboxAi.quickReplies.mockResolvedValue({ replies: ['a', 'b', 'c'] });
  });

  it.each(['suggestReply', 'quickReplies'] as const)(
    '%s requires inbox:reply',
    (handler) => {
      expect(
        Reflect.getMetadata(
          REQUIRE_CAPABILITY,
          AiController.prototype[handler],
        ),
      ).toBe('inbox:reply');
    },
  );

  it.each([
    [suggestUrl, { conversationId: CONV }],
    [quickUrl, { conversationId: CONV, commentId: COMMENT }],
  ])('a GUEST gets 403 on %s', async (url, body) => {
    roles.getRole.mockResolvedValue('GUEST');
    await request(app.getHttpServer()).post(url).send(body).expect(403);
    expect(inboxAi.suggestReply).not.toHaveBeenCalled();
    expect(inboxAi.quickReplies).not.toHaveBeenCalled();
  });

  it('suggest-reply: a conversationId body reaches the service', async () => {
    await request(app.getHttpServer())
      .post(suggestUrl)
      .send({
        conversationId: CONV,
        commentId: COMMENT,
        instruction: 'translate_en',
        draft: 'hola',
      })
      .expect(200);
    expect(inboxAi.suggestReply).toHaveBeenCalledWith(
      WS,
      'user-1',
      expect.objectContaining({
        conversationId: CONV,
        commentId: COMMENT,
        instruction: 'translate_en',
        draft: 'hola',
      }),
    );
  });

  it('suggest-reply: the legacy platform + messages body still works', async () => {
    await request(app.getHttpServer())
      .post(suggestUrl)
      .send({ platform: 'x', messages: [{ author: 'customer', text: 'hi' }] })
      .expect(200);
  });

  it('suggest-reply: both conversationId and messages is a 400', async () => {
    await request(app.getHttpServer())
      .post(suggestUrl)
      .send({
        conversationId: CONV,
        platform: 'x',
        messages: [{ author: 'customer', text: 'hi' }],
      })
      .expect(400);
    expect(inboxAi.suggestReply).not.toHaveBeenCalled();
  });

  it('suggest-reply: neither is a 400; translate_en without a draft is a 400', async () => {
    await request(app.getHttpServer()).post(suggestUrl).send({}).expect(400);
    await request(app.getHttpServer())
      .post(suggestUrl)
      .send({ conversationId: CONV, instruction: 'translate_en' })
      .expect(400);
    expect(inboxAi.suggestReply).not.toHaveBeenCalled();
  });

  it('quick-replies: validates the body and returns the replies', async () => {
    await request(app.getHttpServer())
      .post(quickUrl)
      .send({ conversationId: CONV })
      .expect(400);
    await request(app.getHttpServer())
      .post(quickUrl)
      .send({ conversationId: 'nope', commentId: COMMENT })
      .expect(400);
    await request(app.getHttpServer())
      .post(quickUrl)
      .send({ conversationId: CONV, commentId: COMMENT })
      .expect(200, { replies: ['a', 'b', 'c'] });
    expect(inboxAi.quickReplies).toHaveBeenCalledWith(WS, 'user-1', {
      conversationId: CONV,
      commentId: COMMENT,
    });
  });

  it('quick-replies: a non-uuid workspace is a 400', async () => {
    await request(app.getHttpServer())
      .post('/ai/workspaces/not-a-uuid/inbox/quick-replies')
      .send({ conversationId: CONV, commentId: COMMENT })
      .expect(400);
  });
});
