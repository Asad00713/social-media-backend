import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { REQUIRE_CAPABILITY } from '../../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../../workspace-members/workspace-role.service';
import { InboxNotesController } from './inbox-notes.controller';
import { InboxNotesService } from './services/inbox-notes.service';

const WS = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const NOTE = '33333333-3333-4333-8333-333333333333';
const MENTIONED = '44444444-4444-4444-8444-444444444444';

describe('InboxNotesController over HTTP', () => {
  let app: INestApplication<App>;
  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  const svc = { create: jest.fn(), remove: jest.fn() };
  const base = `/inbox/workspaces/${WS}/conversations/${CONV}/notes`;
  const valid = { body: 'ping @Mia', mentionUserIds: [MENTIONED] };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InboxNotesController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: InboxNotesService, useValue: svc },
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
    svc.create.mockResolvedValue({ kind: 'note', id: NOTE });
    svc.remove.mockResolvedValue({ ok: true });
  });

  it('MEMBER create is 201 and records the caller', async () => {
    await request(app.getHttpServer())
      .post(base)
      .send(valid)
      .expect(201, { kind: 'note', id: NOTE });
    expect(svc.create).toHaveBeenCalledWith(WS, CONV, 'user-1', valid);
  });

  it('MEMBER delete is 200 with { ok: true }', async () => {
    await request(app.getHttpServer())
      .delete(`${base}/${NOTE}`)
      .expect(200, { ok: true });
    expect(svc.remove).toHaveBeenCalledWith(WS, CONV, NOTE, 'user-1');
  });

  it('a GUEST gets 403 on POST and DELETE', async () => {
    roles.getRole.mockResolvedValue('GUEST');
    const s = request(app.getHttpServer());
    await s.post(base).send(valid).expect(403);
    await s.delete(`${base}/${NOTE}`).expect(403);
    expect(svc.create).not.toHaveBeenCalled();
    expect(svc.remove).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...valid, body: '' }],
    [{ ...valid, body: 'b'.repeat(5001) }],
    [{ ...valid, mentionUserIds: ['not-a-uuid'] }],
    [{ ...valid, mentionUserIds: Array(21).fill(MENTIONED) }],
    [{ body: 'x' }],
    [{ ...valid, extra: 1 }],
  ])('create rejects %j with 400', async (body) => {
    await request(app.getHttpServer()).post(base).send(body).expect(400);
    expect(svc.create).not.toHaveBeenCalled();
  });

  it('accepts exactly 5000 characters', async () => {
    await request(app.getHttpServer())
      .post(base)
      .send({ body: 'b'.repeat(5000), mentionUserIds: [] })
      .expect(201);
  });

  it('rejects non-uuid path ids', async () => {
    await request(app.getHttpServer()).delete(`${base}/nope`).expect(400);
    await request(app.getHttpServer())
      .post(`/inbox/workspaces/${WS}/conversations/nope/notes`)
      .send(valid)
      .expect(400);
  });

  it('declares inbox:reply on both handlers', () => {
    const cap = (n: keyof InboxNotesController) =>
      Reflect.getMetadata(
        REQUIRE_CAPABILITY,
        InboxNotesController.prototype[n],
      ) as string | undefined;
    expect(cap('create')).toBe('inbox:reply');
    expect(cap('remove')).toBe('inbox:reply');
  });
});
