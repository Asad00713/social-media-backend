import { INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceAccessService } from '../workspace-members/workspace-access.service';
import { MaestroController } from './maestro.controller';
import {
  MAESTRO_COMING_SOON_CODE,
  MAESTRO_COMING_SOON_MESSAGE,
  MaestroLaunch,
  MaestroLaunchGuard,
} from './maestro-launch';
import { MaestroService } from './services/maestro.service';
import { MentionSearchService } from './services/mention-search.service';
import { BridgeService } from './bridge/services/bridge.service';

const WS = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';

function launchWith(value: string | undefined) {
  return new MaestroLaunch({
    get: (key: string) => (key === 'MAESTRO_ENABLED' ? value : undefined),
  } as unknown as ConfigService);
}

describe('MaestroLaunch.isEnabled', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['1', false],
    ['TRUE', false],
    ['yes', false],
    [' true', false],
    ['true', true],
  ])('MAESTRO_ENABLED=%p -> %p', (value, expected) => {
    expect(launchWith(value).isEnabled()).toBe(expected);
  });
});

/**
 * Every route the controller declares, read from Nest's own metadata, so a
 * route added later is checked without anyone extending a list here.
 */
function controllerRoutes(): Array<{ method: RequestMethod; path: string }> {
  const proto = MaestroController.prototype as unknown as Record<
    string,
    unknown
  >;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .map((name) => proto[name])
    .filter(
      (fn): fn is object =>
        typeof fn === 'function' &&
        Reflect.getMetadata(PATH_METADATA, fn) !== undefined,
    )
    .map((fn) => ({
      method: Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod,
      path: String(Reflect.getMetadata(PATH_METADATA, fn)),
    }));
}

function concrete(path: string): string {
  return `/maestro/${path.replace(':id', CONV)}?workspaceId=${WS}`;
}

describe('MaestroController behind the launch gate (HTTP)', () => {
  let app: INestApplication<App>;
  let enabled: string | undefined;

  // Every service method the controller can reach. Each one is a spy, so the
  // OFF case can assert that NOTHING behind the gate ran -- not the model,
  // not a DB write, not a link token.
  const maestro = {
    streamMessage: jest.fn(),
    createConversation: jest.fn(),
    listConversations: jest.fn(),
    presignAttachment: jest.fn(),
    getTone: jest.fn(),
    setTone: jest.fn(),
    getKeyStatus: jest.fn(),
    setOwnKey: jest.fn(),
    removeOwnKey: jest.fn(),
    completeOnboarding: jest.fn(),
    getUsage: jest.fn(),
    getConversationMessages: jest.fn(),
    setFeedback: jest.fn(),
  };
  const bridge = {
    listLinks: jest.fn(),
    telegramDeepLink: jest.fn(),
    whatsappDeepLink: jest.fn(),
  };
  const mentions = { search: jest.fn() };
  const access = { assertCan: jest.fn() };
  const all = [maestro, bridge, mentions, access];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MaestroController],
      providers: [
        MaestroLaunch,
        MaestroLaunchGuard,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'MAESTRO_ENABLED' ? enabled : undefined,
          },
        },
        { provide: MaestroService, useValue: maestro },
        { provide: BridgeService, useValue: bridge },
        { provide: MentionSearchService, useValue: mentions },
        { provide: WorkspaceAccessService, useValue: access },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: {
          switchToHttp: () => { getRequest: () => { user?: unknown } };
        }) => {
          ctx.switchToHttp().getRequest().user = {
            userId: 'user-1',
            email: 'u@example.test',
          };
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
    enabled = undefined;
  });

  const routes = controllerRoutes();

  it('found the controller routes (guards the metadata walk itself)', () => {
    // 17 today. A floor, not an exact count, so adding a route does not
    // break this -- but an empty walk (metadata keys renamed) would.
    expect(routes.length).toBeGreaterThanOrEqual(17);
    expect(routes).toContainEqual({
      method: RequestMethod.POST,
      path: 'conversations/:id/messages',
    });
  });

  function send(method: RequestMethod, path: string) {
    const server = request(app.getHttpServer());
    const url = concrete(path);
    const body = { workspaceId: WS, message: 'hi' };
    switch (method) {
      case RequestMethod.GET:
        return server.get(url);
      case RequestMethod.POST:
        return server.post(url).send(body);
      case RequestMethod.PATCH:
        return server.patch(url).send(body);
      default:
        throw new Error(`unhandled method ${method}`);
    }
  }

  describe.each([
    ['unset', undefined],
    ['"false"', 'false'],
    ['"1"', '1'],
  ])('MAESTRO_ENABLED %s', (_label, value) => {
    it.each(routes.map((r) => [RequestMethod[r.method], r.path, r.method]))(
      '%s /maestro/%s answers 403 MAESTRO_COMING_SOON and runs nothing',
      async (_m, path, method) => {
        enabled = value;
        const res = await send(method, path);
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({
          code: MAESTRO_COMING_SOON_CODE,
          message: MAESTRO_COMING_SOON_MESSAGE,
        });
        for (const svc of all) {
          for (const fn of Object.values(svc)) {
            expect(fn).not.toHaveBeenCalled();
          }
        }
      },
    );
  });

  describe('MAESTRO_ENABLED "true"', () => {
    beforeEach(() => {
      enabled = 'true';
    });

    it('reads still answer as before', async () => {
      maestro.getTone.mockResolvedValue('plain');
      const res = await request(app.getHttpServer()).get('/maestro/tone');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ tone: 'plain' });
    });

    it('a chat turn reaches the agent and streams', async () => {
      maestro.streamMessage.mockImplementation(function* () {
        yield { event: 'text', data: { delta: 'hello' } };
      });
      const res = await request(app.getHttpServer())
        .post(`/maestro/conversations/${CONV}/messages`)
        .send({ message: 'hi' });
      expect(res.status).toBe(201);
      expect(maestro.streamMessage).toHaveBeenCalledTimes(1);
      expect(res.text).toContain('event: text');
    });
  });
});
