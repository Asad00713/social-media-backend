import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../workspace-members/workspace-role.service';
import { BrandVoiceController } from './brand-voice.controller';
import { versionConflict } from './brand-voice.errors';
import { BrandVoiceService } from './brand-voice.service';

const WS = '11111111-1111-4111-8111-111111111111';
const URL = `/workspaces/${WS}/brand-voice`;
const VOICE = {
  tone: ['Warm'],
  description: null,
  wordsUse: [],
  wordsAvoid: [],
  emojiLevel: 'few',
  hashtagsMode: 'few',
  channelTweaks: {},
  version: 1,
  hasVoice: true,
};

describe('BrandVoiceController over HTTP', () => {
  let app: INestApplication<App>;
  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  const service = { get: jest.fn(), update: jest.fn(), revert: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BrandVoiceController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: BrandVoiceService, useValue: service },
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
    service.get.mockResolvedValue(VOICE);
    service.update.mockResolvedValue({ ...VOICE, version: 2 });
    service.revert.mockResolvedValue({ ...VOICE, version: 3 });
  });

  it('a GUEST gets 403 on GET; a MEMBER reads it', async () => {
    roles.getRole.mockResolvedValue('GUEST');
    await request(app.getHttpServer()).get(URL).expect(403);
    expect(service.get).not.toHaveBeenCalled();

    roles.getRole.mockResolvedValue('MEMBER');
    const res = await request(app.getHttpServer()).get(URL).expect(200);
    expect(res.body).toEqual(VOICE);
    expect(service.get).toHaveBeenCalledWith(WS);
  });

  it('a MEMBER gets 403 on PATCH and revert; an ADMIN saves', async () => {
    await request(app.getHttpServer())
      .patch(URL)
      .send({ version: 1, tone: ['Warm'] })
      .expect(403);
    await request(app.getHttpServer())
      .post(`${URL}/revert`)
      .send({ version: 2 })
      .expect(403);
    expect(service.update).not.toHaveBeenCalled();
    expect(service.revert).not.toHaveBeenCalled();

    roles.getRole.mockResolvedValue('ADMIN');
    await request(app.getHttpServer())
      .patch(URL)
      .send({ version: 1, tone: ['Warm'] })
      .expect(200);
    const res = await request(app.getHttpServer())
      .post(`${URL}/revert`)
      .send({ version: 2 })
      .expect(200);
    expect((res.body as { version: number }).version).toBe(3);
    expect(service.revert).toHaveBeenCalledWith(WS, 2);
  });

  it('PATCH with an unknown field is 400 and never reaches the service', async () => {
    roles.getRole.mockResolvedValue('ADMIN');
    await request(app.getHttpServer())
      .patch(URL)
      .send({ version: 1, hasVoice: true })
      .expect(400);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('revert with a bad body is 400 and never reaches the service', async () => {
    roles.getRole.mockResolvedValue('ADMIN');
    await request(app.getHttpServer())
      .post(`${URL}/revert`)
      .send({ version: 0 })
      .expect(400);
    expect(service.revert).not.toHaveBeenCalled();
  });

  it('a workspace id that is not a UUID is 400', async () => {
    roles.getRole.mockResolvedValue('ADMIN');
    await request(app.getHttpServer())
      .get('/workspaces/not-a-uuid/brand-voice')
      .expect(400);
    expect(service.get).not.toHaveBeenCalled();
  });

  it('PATCH passes the workspace and the validated body to the service', async () => {
    roles.getRole.mockResolvedValue('ADMIN');
    const body = {
      version: 4,
      tone: ['Warm', 'Bold'],
      description: null,
      channelTweaks: { linkedin: 'More formal' },
    };
    const res = await request(app.getHttpServer())
      .patch(URL)
      .send(body)
      .expect(200);
    expect((res.body as { version: number }).version).toBe(2);
    expect(service.update).toHaveBeenCalledTimes(1);
    expect(service.update).toHaveBeenCalledWith(
      WS,
      expect.objectContaining(body),
    );
  });

  it("the service's VERSION_CONFLICT reaches the client as 409 with its code", async () => {
    roles.getRole.mockResolvedValue('ADMIN');
    service.update.mockRejectedValue(versionConflict());
    const res = await request(app.getHttpServer())
      .patch(URL)
      .send({ version: 1, tone: ['Warm'] })
      .expect(409);
    expect((res.body as { code: string }).code).toBe('VERSION_CONFLICT');
  });
});
