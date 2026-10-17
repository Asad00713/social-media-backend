import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { REQUIRE_CAPABILITY } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../workspace-members/workspace-role.service';
import { PlannerNotesController } from './planner-notes.controller';
import { PlannerNotesService } from './services/planner-notes.service';

const WS = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const NOTE = {
  id: ID,
  date: '2026-03-05',
  body: 'Sale',
  color: 'amber',
  author: null,
  updatedAt: '2026-03-01T10:00:00.000Z',
};

describe('PlannerNotesController over HTTP', () => {
  let app: INestApplication<App>;
  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  const notes = {
    list: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };
  const base = (ws = WS) => `/planner/workspaces/${ws}/notes`;
  const valid = { date: '2026-03-05', body: 'Sale', color: 'amber' };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PlannerNotesController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: PlannerNotesService, useValue: notes },
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
    notes.list.mockResolvedValue([NOTE]);
    notes.create.mockResolvedValue(NOTE);
    notes.update.mockResolvedValue(NOTE);
    notes.remove.mockResolvedValue(undefined);
  });

  const expectNoWrites = () =>
    [notes.create, notes.update, notes.remove].forEach((w) =>
      expect(w).not.toHaveBeenCalled(),
    );

  describe('POST', () => {
    it('lets a MEMBER create, passing user id and role to the service', async () => {
      await request(app.getHttpServer())
        .post(base())
        .send(valid)
        .expect(201, NOTE);
      expect(notes.create).toHaveBeenCalledWith(
        WS,
        'user-1',
        'MEMBER',
        expect.objectContaining(valid),
      );
    });

    it.each([
      [{ ...valid, color: 'pink' }, 'colour not in the list'],
      [{ ...valid, colour: 'pink' }, 'misspelt key'],
      [{ ...valid, extra: 1 }, 'extra key'],
      [{ ...valid, body: '' }, 'empty body'],
      [{ ...valid, body: 'x'.repeat(501) }, 'body of 501'],
      [{ ...valid, date: '2026-02-30' }, 'impossible date'],
      [{ ...valid, date: '2026-13-01' }, 'month 13'],
      [{ ...valid, date: '5 March' }, 'not yyyy-MM-dd'],
      [{ date: valid.date, body: 'x' }, 'missing color'],
    ])('answers 400 to %j (%s)', async (body, why) => {
      expect(why).toBeTruthy();
      await request(app.getHttpServer()).post(base()).send(body).expect(400);
      expectNoWrites();
    });

    it('accepts a body of exactly 500', async () => {
      await request(app.getHttpServer())
        .post(base())
        .send({ ...valid, body: 'x'.repeat(500) })
        .expect(201);
    });

    it('answers 403 to a GUEST', async () => {
      roles.getRole.mockResolvedValue('GUEST');
      await request(app.getHttpServer()).post(base()).send(valid).expect(403);
      expectNoWrites();
    });

    it('answers 403 to a non-member', async () => {
      roles.getRole.mockResolvedValue(null);
      await request(app.getHttpServer()).post(base()).send(valid).expect(403);
      expectNoWrites();
    });

    it('answers 400 to a non-UUID workspace id', async () => {
      await request(app.getHttpServer())
        .post(base('abc'))
        .send(valid)
        .expect(400);
      expectNoWrites();
    });
  });

  describe('PATCH and DELETE', () => {
    it('lets a MEMBER patch', async () => {
      await request(app.getHttpServer())
        .patch(`${base()}/${ID}`)
        .send({ body: 'New' })
        .expect(200, NOTE);
      expect(notes.update).toHaveBeenCalledWith(WS, ID, 'user-1', 'MEMBER', {
        body: 'New',
      });
    });

    it('lets a MEMBER delete, answering a message', async () => {
      await request(app.getHttpServer())
        .delete(`${base()}/${ID}`)
        .expect(200, { message: 'Note deleted' });
      expect(notes.remove).toHaveBeenCalledWith(WS, ID, 'user-1', 'MEMBER');
    });

    it.each([
      [{ color: 'pink' }],
      [{ body: '' }],
      [{ body: 'x'.repeat(501) }],
      [{ date: '2026-03-06' }],
      [{ extra: 1 }],
    ])('answers 400 to patch %j', async (body) => {
      await request(app.getHttpServer())
        .patch(`${base()}/${ID}`)
        .send(body)
        .expect(400);
      expect(notes.update).not.toHaveBeenCalled();
    });

    it('answers 400 to a non-UUID note id', async () => {
      await request(app.getHttpServer())
        .patch(`${base()}/nope`)
        .send({ body: 'x' })
        .expect(400);
      await request(app.getHttpServer()).delete(`${base()}/nope`).expect(400);
      expectNoWrites();
    });

    it('answers 403 to a GUEST on both', async () => {
      roles.getRole.mockResolvedValue('GUEST');
      await request(app.getHttpServer())
        .patch(`${base()}/${ID}`)
        .send({ body: 'x' })
        .expect(403);
      await request(app.getHttpServer()).delete(`${base()}/${ID}`).expect(403);
      expectNoWrites();
    });
  });

  describe('GET', () => {
    const get = (qs: string) => request(app.getHttpServer()).get(base() + qs);

    it('lets a GUEST read', async () => {
      roles.getRole.mockResolvedValue('GUEST');
      await get('?from=2026-03-01&to=2026-03-31').expect(200, [NOTE]);
      expect(notes.list).toHaveBeenCalledWith(WS, '2026-03-01', '2026-03-31');
    });

    it.each([
      [''],
      ['?to=2026-03-31'],
      ['?from=2026-03-01'],
      ['?from=2026-02-30&to=2026-03-31'],
      ['?from=2026-03-01&to=2026-13-01'],
      ['?from=banana&to=2026-03-31'],
      ['?from=2026-03-01&to=2026-03-31&x=1'],
    ])('answers 400 to %s', async (qs) => {
      await get(qs).expect(400);
      expect(notes.list).not.toHaveBeenCalled();
    });

    it('answers 403 to a non-member', async () => {
      roles.getRole.mockResolvedValue(null);
      await get('?from=2026-03-01&to=2026-03-31').expect(403);
      expect(notes.list).not.toHaveBeenCalled();
    });
  });

  describe('capability metadata', () => {
    const cap = (name: keyof PlannerNotesController) =>
      Reflect.getMetadata(
        REQUIRE_CAPABILITY,
        PlannerNotesController.prototype[name],
      ) as string | undefined;

    it('reads need posts:draft; writes need posts:publish', () => {
      expect(cap('list')).toBe('posts:draft');
      expect(cap('create')).toBe('posts:publish');
      expect(cap('update')).toBe('posts:publish');
      expect(cap('remove')).toBe('posts:publish');
    });
  });
});
