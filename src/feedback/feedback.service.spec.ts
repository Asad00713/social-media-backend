import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FeedbackService } from './feedback.service';
import { DRIZZLE } from 'src/drizzle/drizzle.module';
import { NotificationEmitterService } from 'src/notifications/notification-emitter.service';

/** Minimal chainable stub standing in for the Drizzle query builder. */
function makeDb(overrides: Record<string, unknown> = {}) {
  const insertReturning = jest.fn().mockResolvedValue([{ id: 'fb-1' }]);
  return {
    query: {
      feedback: {
        findFirst: jest.fn().mockResolvedValue(undefined),
        findMany: jest.fn().mockResolvedValue([]),
      },
    },
    insert: jest.fn(() => ({
      values: jest.fn(() => ({ returning: insertReturning })),
    })),
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn().mockResolvedValue([{ count: 0, avg: 0 }]),
        then: (r: (v: unknown) => unknown) => r([{ count: 0, avg: 0 }]),
      })),
    })),
    __insertReturning: insertReturning,
    ...overrides,
  };
}

async function build(db: ReturnType<typeof makeDb>) {
  const mod = await Test.createTestingModule({
    providers: [
      FeedbackService,
      { provide: DRIZZLE, useValue: db },
      { provide: NotificationEmitterService, useValue: { emitToAdmins: jest.fn() } },
    ],
  }).compile();
  return mod.get(FeedbackService);
}

describe('FeedbackService', () => {
  describe('create', () => {
    it('rejects a second review of the same type', async () => {
      const db = makeDb();
      db.query.feedback.findFirst = jest
        .fn()
        .mockResolvedValue({ id: 'existing', type: 'app' });
      const service = await build(db);

      await expect(
        service.create({ type: 'app', rating: 5 }, 'user-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('allows a different type for the same user', async () => {
      const db = makeDb();
      // No existing row for the (user, maestro) pair.
      db.query.feedback.findFirst = jest.fn().mockResolvedValue(undefined);
      const service = await build(db);

      await expect(
        service.create({ type: 'maestro', rating: 4 }, 'user-1'),
      ).resolves.toBeDefined();
    });

    it('persists the submitted type', async () => {
      const db = makeDb();
      const values = jest.fn(() => ({
        returning: jest.fn().mockResolvedValue([{ id: 'fb-1' }]),
      }));
      db.insert = jest.fn(() => ({ values })) as never;
      const service = await build(db);

      await service.create({ type: 'maestro', rating: 3 }, 'user-1');

      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'maestro', userId: 'user-1' }),
      );
    });

    it('maps a unique-violation race to ConflictException, not a 500', async () => {
      const db = makeDb();
      db.insert = jest.fn(() => ({
        values: jest.fn(() => ({
          returning: jest
            .fn()
            .mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' })),
        })),
      })) as never;
      const service = await build(db);

      await expect(
        service.create({ type: 'app', rating: 5 }, 'user-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('findMine', () => {
    it('returns null for both types when the user has submitted nothing', async () => {
      const db = makeDb();
      db.query.feedback.findMany = jest.fn().mockResolvedValue([]);
      const service = await build(db);

      await expect(service.findMine('user-1')).resolves.toEqual({
        app: null,
        maestro: null,
      });
    });

    it('keys each submitted review by its type', async () => {
      const db = makeDb();
      const row = { id: 'fb-1', type: 'maestro', rating: 4 };
      db.query.feedback.findMany = jest.fn().mockResolvedValue([row]);
      const service = await build(db);

      await expect(service.findMine('user-1')).resolves.toEqual({
        app: null,
        maestro: row,
      });
    });
  });
});
