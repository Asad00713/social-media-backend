import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { DbType } from '../../drizzle/db';
import { PlannerNotesService } from './planner-notes.service';

const WS = 'ws-1';
const ME = 'user-1';
const ROW = {
  id: 'n1',
  date: '2026-03-05',
  body: 'Sale',
  color: 'amber',
  updatedAt: new Date('2026-03-01T10:00:00Z'),
  authorId: 'user-9',
  authorName: 'Sana',
};

type Builder = Record<string, jest.Mock> & PromiseLike<unknown>;

/** A drizzle-like builder: every method returns itself; awaiting settles. */
function chain(result: unknown, error?: unknown): Builder {
  const c: Record<string, unknown> = {};
  for (const m of [
    'select',
    'from',
    'leftJoin',
    'where',
    'orderBy',
    'limit',
    'insert',
    'values',
    'update',
    'set',
    'delete',
    'returning',
  ]) {
    c[m] = jest.fn(() => c);
  }
  c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    (error ? Promise.reject(error as Error) : Promise.resolve(result)).then(
      res,
      rej,
    );
  return c as Builder;
}

/** Queue one builder per db call, in call order. */
function fakeDb(...builders: Builder[]) {
  const queue = [...builders];
  const next = () => {
    const b = queue.shift();
    if (!b) throw new Error('unexpected db call');
    return b;
  };
  return {
    select: jest.fn(next),
    insert: jest.fn(next),
    update: jest.fn(next),
    delete: jest.fn(next),
  } as unknown as DbType;
}

const dto = (over: Partial<{ date: string; body: string }> = {}) => ({
  date: '2026-03-05',
  body: 'Sale',
  color: 'amber' as const,
  ...over,
});

const UNIQUE = 'calendar_notes_workspace_date_uq';

describe('PlannerNotesService', () => {
  describe('create', () => {
    it.each(['2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31'])(
      'rejects the impossible date %s before touching the db',
      async (date) => {
        const svc = new PlannerNotesService(fakeDb());
        await expect(
          svc.create(WS, ME, 'MEMBER', dto({ date })),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );

    it('accepts 29 February in a leap year', async () => {
      const db = fakeDb(chain([{ id: 'n1' }]), chain([ROW]));
      const svc = new PlannerNotesService(db);
      await expect(
        svc.create(WS, ME, 'MEMBER', dto({ date: '2028-02-29' })),
      ).resolves.toMatchObject({ id: 'n1' });
    });

    it('returns the note with its author and an ISO updatedAt', async () => {
      const svc = new PlannerNotesService(
        fakeDb(chain([{ id: 'n1' }]), chain([ROW])),
      );
      await expect(svc.create(WS, ME, 'MEMBER', dto())).resolves.toEqual({
        id: 'n1',
        date: '2026-03-05',
        body: 'Sale',
        color: 'amber',
        author: { id: 'user-9', name: 'Sana' },
        updatedAt: '2026-03-01T10:00:00.000Z',
      });
    });

    it('maps a unique violation on the day index to 409', async () => {
      const err = Object.assign(new Error('dup'), {
        code: '23505',
        constraint: UNIQUE,
      });
      const svc = new PlannerNotesService(fakeDb(chain(null, err)));
      const p = svc.create(WS, ME, 'MEMBER', dto());
      await expect(p).rejects.toBeInstanceOf(ConflictException);
      await expect(p).rejects.toThrow('A note for this day already exists');
    });

    it('maps the same violation when the driver wraps it in cause', async () => {
      const cause = { code: '23505', constraint: UNIQUE };
      const err = Object.assign(new Error('Failed query'), { cause });
      const svc = new PlannerNotesService(fakeDb(chain(null, err)));
      await expect(svc.create(WS, ME, 'MEMBER', dto())).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('re-throws a 23505 on any other constraint, and other errors', async () => {
      const other = Object.assign(new Error('pk'), {
        code: '23505',
        constraint: 'calendar_notes_pkey',
      });
      await expect(
        new PlannerNotesService(fakeDb(chain(null, other))).create(
          WS,
          ME,
          'MEMBER',
          dto(),
        ),
      ).rejects.toBe(other);
      const boom = new Error('boom');
      await expect(
        new PlannerNotesService(fakeDb(chain(null, boom))).create(
          WS,
          ME,
          'MEMBER',
          dto(),
        ),
      ).rejects.toBe(boom);
    });
  });

  describe('update and remove', () => {
    it('lets a MEMBER edit a note another member wrote', async () => {
      const svc = new PlannerNotesService(
        fakeDb(chain([{ id: 'n1' }]), chain([ROW])),
      );
      await expect(
        svc.update(WS, 'n1', ME, 'MEMBER', { body: 'Edited' }),
      ).resolves.toMatchObject({ id: 'n1', author: { id: 'user-9' } });
    });

    it.each([
      [{}],
      [{ body: null }],
      [{ color: null }],
      [{ body: null, color: null }],
    ])('answers 400 to the empty patch %j without writing', async (patch) => {
      const db = fakeDb();
      const svc = new PlannerNotesService(db);
      const p = svc.update(WS, 'n1', ME, 'MEMBER', patch as never);
      await expect(p).rejects.toBeInstanceOf(BadRequestException);
      await expect(p).rejects.toThrow('Nothing to update');
      expect(db.update).not.toHaveBeenCalled();
    });

    it('lets a MEMBER delete a note another member wrote', async () => {
      const svc = new PlannerNotesService(fakeDb(chain([{ id: 'n1' }])));
      await expect(svc.remove(WS, 'n1', ME, 'MEMBER')).resolves.toBeUndefined();
    });

    it('answers 404 when the id is not in this workspace', async () => {
      await expect(
        new PlannerNotesService(fakeDb(chain([]))).update(
          WS,
          'n1',
          ME,
          'MEMBER',
          { color: 'red' },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        new PlannerNotesService(fakeDb(chain([]))).remove(
          WS,
          'n1',
          ME,
          'MEMBER',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('list range', () => {
    const list = (from: string, to: string) =>
      new PlannerNotesService(fakeDb(chain([ROW]))).list(WS, from, to);

    it('rejects from after to', async () => {
      await expect(list('2026-03-10', '2026-03-09')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it.each([
      ['2026-02-30', '2026-03-05'],
      ['2026-03-01', '2026-13-01'],
    ])('rejects the impossible date in %s..%s', async (from, to) => {
      await expect(list(from, to)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('allows to = from + 100 days and rejects from + 101', async () => {
      await expect(list('2026-01-01', '2026-04-11')).resolves.toHaveLength(1);
      await expect(list('2026-01-01', '2026-04-12')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('allows a single day', async () => {
      await expect(list('2026-03-05', '2026-03-05')).resolves.toHaveLength(1);
    });

    it('maps a deleted creator to author null', async () => {
      const db = fakeDb(chain([{ ...ROW, authorId: null, authorName: null }]));
      const [n] = await new PlannerNotesService(db).list(
        WS,
        '2026-03-01',
        '2026-03-31',
      );
      expect(n.author).toBeNull();
    });
  });
});
