import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard';
import { ChatbotController } from '../chatbot/chatbot.controller';
import { SocialMediaController } from '../social-media/social-media.controller';
import { MediaController } from '../media/media.controller';
import { PostsController } from '../posts/posts.controller';
import { MaestroController } from '../maestro/maestro.controller';
import { CanvaController } from '../canva/canva.controller';

jest.mock('../drizzle/db', () => ({
  db: { insert: jest.fn(() => ({ values: jest.fn() })) },
}));

const user = { userId: 'u1', email: 'u@x.com' };

function guardsOf(proto: any, method: string): unknown[] {
  return Reflect.getMetadata(GUARDS_METADATA, proto[method]) ?? [];
}
function noAccess() {
  return { assertCan: jest.fn().mockRejectedValue(new NotFoundException()) };
}
function okAccess() {
  return { assertCan: jest.fn().mockResolvedValue('MEMBER') };
}
function make(Ctor: any, deps: Record<string, unknown>) {
  const c: any = Object.create(Ctor.prototype);
  Object.assign(c, deps);
  return c;
}

describe('routes that had no auth, or expose platform-wide data', () => {
  it.each([
    [ChatbotController, 'testClaude'],
    [SocialMediaController, 'postToFacebook'],
    [MediaController, 'deleteFromBunnyCDN'],
    [MediaController, 'listBunnyCDNFiles'],
    [MediaController, 'deleteMedia'],
    [PostsController, 'getQueueStatus'],
    [PostsController, 'getRateLimitStatus'],
    [PostsController, 'getPlatformRateLimitStatus'],
  ])('%p.%s requires SuperAdminGuard', (Ctor: any, method) => {
    expect(guardsOf(Ctor.prototype, method)).toContain(SuperAdminGuard);
  });

  it.each([
    [ChatbotController, 'testClaude'],
    [SocialMediaController, 'postToFacebook'],
    [MediaController, 'deleteFromBunnyCDN'],
    [MediaController, 'listBunnyCDNFiles'],
    [MediaController, 'deleteMedia'],
  ])('%p.%s also requires JwtAuthGuard', (Ctor: any, method) => {
    expect(guardsOf(Ctor.prototype, method)).toContain(JwtAuthGuard);
  });
});

describe('ChatbotController (workspace id in body/query)', () => {
  const svc = {
    createConversation: jest.fn().mockResolvedValue({ id: 'c' }),
    listSharedConversations: jest.fn().mockResolvedValue([]),
    getSharedConversation: jest.fn().mockResolvedValue({}),
    getProviderPreference: jest.fn().mockResolvedValue(null),
  };
  const tokens = { getUsageSummary: jest.fn().mockResolvedValue({}) };
  const router = { getAvailableProviders: jest.fn().mockReturnValue([]) };
  beforeEach(() => jest.clearAllMocks());

  const calls: Array<[string, (c: any) => Promise<unknown>, string]> = [
    [
      'createConversation',
      (c) => c.createConversation(user, { workspaceId: 'w' }),
      'posts:draft',
    ],
    [
      'getSharedConversations',
      (c) => c.getSharedConversations(user, 'w'),
      'posts:draft',
    ],
    [
      'getSharedConversation',
      (c) => c.getSharedConversation(user, 'id', 'w'),
      'posts:draft',
    ],
    ['getProviders', (c) => c.getProviders(user, 'w'), 'posts:draft'],
    [
      'getUsage',
      (c) => c.getUsage(user, { workspaceId: 'w' }),
      'analytics:view',
    ],
  ];

  it.each(calls)(
    '%s: non-member gets NotFound, no data touched',
    async (_n, run) => {
      const c = make(ChatbotController, {
        chatbotService: svc,
        tokenTracking: tokens,
        llmRouter: router,
        access: noAccess(),
      });
      await expect(run(c)).rejects.toBeInstanceOf(NotFoundException);
      expect(svc.createConversation).not.toHaveBeenCalled();
      expect(svc.listSharedConversations).not.toHaveBeenCalled();
      expect(svc.getSharedConversation).not.toHaveBeenCalled();
      expect(tokens.getUsageSummary).not.toHaveBeenCalled();
    },
  );

  it.each(calls)(
    '%s: member succeeds with the right capability',
    async (_n, run, cap) => {
      const access = okAccess();
      const c = make(ChatbotController, {
        chatbotService: svc,
        tokenTracking: tokens,
        llmRouter: router,
        access,
      });
      await expect(run(c)).resolves.toBeDefined();
      expect(access.assertCan).toHaveBeenCalledWith('w', 'u1', cap);
    },
  );
});

describe('MaestroController', () => {
  const maestro = {
    createConversation: jest.fn().mockResolvedValue({ id: 'c' }),
    presignAttachment: jest.fn().mockResolvedValue({ url: 'x' }),
    getUsage: jest.fn().mockResolvedValue({}),
  };
  const mentions = { search: jest.fn().mockResolvedValue([]) };
  beforeEach(() => jest.clearAllMocks());

  const calls: Array<[string, (c: any) => Promise<unknown>, string]> = [
    [
      'createConversation',
      (c) => c.createConversation(user, { workspaceId: 'w' }),
      'posts:draft',
    ],
    [
      'presignAttachment',
      (c) => c.presignAttachment(user, { workspaceId: 'w' }),
      'posts:draft',
    ],
    ['searchMentions', (c) => c.searchMentions(user, 'w', 'q'), 'posts:draft'],
    ['getUsage', (c) => c.getUsage(user, 'w'), 'analytics:view'],
  ];

  it.each(calls)('%s: non-member gets NotFound', async (_n, run) => {
    const c = make(MaestroController, {
      maestro,
      mentions,
      access: noAccess(),
    });
    await expect(run(c)).rejects.toBeInstanceOf(NotFoundException);
    expect(maestro.createConversation).not.toHaveBeenCalled();
    expect(maestro.presignAttachment).not.toHaveBeenCalled();
    expect(maestro.getUsage).not.toHaveBeenCalled();
    expect(mentions.search).not.toHaveBeenCalled();
  });

  it.each(calls)('%s: member succeeds', async (_n, run, cap) => {
    const access = okAccess();
    const c = make(MaestroController, { maestro, mentions, access });
    await expect(run(c)).resolves.toBeDefined();
    expect(access.assertCan).toHaveBeenCalledWith('w', 'u1', cap);
  });
});

describe('MediaController.presignComposerVideo', () => {
  const r2 = { createPresignedUpload: jest.fn().mockResolvedValue({ ok: 1 }) };
  const dto = {
    workspaceId: 'w',
    contentType: 'video/mp4',
    sizeBytes: 1,
    filename: 'a.mp4',
  };
  beforeEach(() => jest.clearAllMocks());

  it('non-member gets NotFound and nothing is presigned', async () => {
    const c = make(MediaController, { r2Service: r2, access: noAccess() });
    await expect(c.presignComposerVideo(dto, user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(r2.createPresignedUpload).not.toHaveBeenCalled();
  });

  it('member can presign (posts:draft)', async () => {
    const access = okAccess();
    const c = make(MediaController, { r2Service: r2, access });
    await expect(c.presignComposerVideo(dto, user)).resolves.toEqual({ ok: 1 });
    expect(access.assertCan).toHaveBeenCalledWith('w', 'u1', 'posts:draft');
  });
});

describe('CanvaController.initiateOAuth', () => {
  const canva = {
    generateAuthUrl: jest
      .fn()
      .mockReturnValue({ authUrl: 'u', codeVerifier: 'v' }),
  };
  beforeEach(() => jest.clearAllMocks());

  it('non-member cannot store an OAuth state for a foreign workspace', async () => {
    const { db } = jest.requireMock('../drizzle/db');
    const c = make(CanvaController, {
      canvaService: canva,
      access: noAccess(),
      logger: { log: jest.fn() },
    });
    await expect(
      c.initiateOAuth(user, { workspaceId: 'w' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('member (channels:manage) proceeds', async () => {
    const access = okAccess();
    const c = make(CanvaController, {
      canvaService: canva,
      access,
      logger: { log: jest.fn() },
    });
    await c.initiateOAuth(user, { workspaceId: 'w' });
    expect(access.assertCan).toHaveBeenCalledWith('w', 'u1', 'channels:manage');
  });
});
