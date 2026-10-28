import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { REQUIRE_CAPABILITY } from '../../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../../workspace-members/workspace-role.service';
import { SavedRepliesController } from './saved-replies.controller';
import { SavedRepliesService } from './services/saved-replies.service';

const WS = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';

describe('SavedRepliesController over HTTP', () => {
  let app: INestApplication<App>;
  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  const svc = {
    list: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    restore: jest.fn(),
    use: jest.fn(),
  };
  const base = `/inbox/workspaces/${WS}/saved-replies`;
  const valid = { name: 'Thanks', shortcut: 'thanks', body: 'Thank you!' };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SavedRepliesController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: SavedRepliesService, useValue: svc },
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
    svc.list.mockResolvedValue([]);
    svc.create.mockResolvedValue({ id: ID });
    svc.update.mockResolvedValue({ id: ID });
    svc.remove.mockResolvedValue(undefined);
    svc.restore.mockResolvedValue({ id: ID });
    svc.use.mockResolvedValue({ usageCount: 3 });
  });

  it('lets a GUEST list, passing q through', async () => {
    roles.getRole.mockResolvedValue('GUEST');
    await request(app.getHttpServer()).get(`${base}?q=/than`).expect(200, []);
    expect(svc.list).toHaveBeenCalledWith(WS, '/than');
  });

  it('MEMBER create is 201 and records the caller', async () => {
    await request(app.getHttpServer()).post(base).send(valid).expect(201);
    expect(svc.create).toHaveBeenCalledWith(WS, 'user-1', valid);
  });

  it('MEMBER update, remove, restore, use are 200 with the right args', async () => {
    await request(app.getHttpServer())
      .patch(`${base}/${ID}`)
      .send({ name: 'New' })
      .expect(200);
    expect(svc.update).toHaveBeenCalledWith(WS, ID, { name: 'New' });
    await request(app.getHttpServer()).delete(`${base}/${ID}`).expect(200);
    expect(svc.remove).toHaveBeenCalledWith(WS, ID);
    await request(app.getHttpServer())
      .post(`${base}/${ID}/restore`)
      .expect(200);
    expect(svc.restore).toHaveBeenCalledWith(WS, ID);
    await request(app.getHttpServer())
      .post(`${base}/${ID}/use`)
      .expect(200, { usageCount: 3 });
    expect(svc.use).toHaveBeenCalledWith(WS, ID);
  });

  it('a GUEST gets 403 on every write route', async () => {
    roles.getRole.mockResolvedValue('GUEST');
    const s = request(app.getHttpServer());
    await s.post(base).send(valid).expect(403);
    await s.patch(`${base}/${ID}`).send({ name: 'x' }).expect(403);
    await s.delete(`${base}/${ID}`).expect(403);
    await s.post(`${base}/${ID}/restore`).expect(403);
    await s.post(`${base}/${ID}/use`).expect(403);
    for (const fn of Object.values(svc)) expect(fn).not.toHaveBeenCalled();
  });

  it('a non-member gets 403 on list', async () => {
    roles.getRole.mockResolvedValue(null);
    await request(app.getHttpServer()).get(base).expect(403);
  });

  it.each([
    [{ ...valid, shortcut: 'Hi there' }],
    [{ ...valid, shortcut: 'UPPER' }],
    [{ ...valid, shortcut: 'a'.repeat(33) }],
    [{ ...valid, shortcut: '' }],
    [{ ...valid, name: '' }],
    [{ ...valid, name: 'n'.repeat(61) }],
    [{ ...valid, body: '' }],
    [{ ...valid, body: 'b'.repeat(5001) }],
    [{ ...valid, extra: 1 }],
    [{ name: 'x', shortcut: 'x' }],
  ])('create rejects %j with 400', async (body) => {
    await request(app.getHttpServer()).post(base).send(body).expect(400);
    expect(svc.create).not.toHaveBeenCalled();
  });

  it.each([
    [{ shortcut: 'Hi there' }],
    [{ body: '' }],
    [{ name: 'n'.repeat(61) }],
    [{ extra: 1 }],
  ])('update rejects %j with 400', async (body) => {
    await request(app.getHttpServer())
      .patch(`${base}/${ID}`)
      .send(body)
      .expect(400);
    expect(svc.update).not.toHaveBeenCalled();
  });

  it('rejects a q over 60 characters and non-uuid ids', async () => {
    await request(app.getHttpServer())
      .get(`${base}?q=${'a'.repeat(61)}`)
      .expect(400);
    await request(app.getHttpServer())
      .patch(`${base}/nope`)
      .send({})
      .expect(400);
    await request(app.getHttpServer()).post(`${base}/nope/use`).expect(400);
    await request(app.getHttpServer())
      .get('/inbox/workspaces/nope/saved-replies')
      .expect(400);
  });

  it('declares the capability on every handler', () => {
    const cap = (n: keyof SavedRepliesController) =>
      Reflect.getMetadata(
        REQUIRE_CAPABILITY,
        SavedRepliesController.prototype[n],
      ) as string | undefined;
    expect(cap('list')).toBe('inbox:view');
    for (const n of ['create', 'update', 'remove', 'restore', 'use'] as const) {
      expect(cap(n)).toBe('inbox:reply');
    }
  });
});
