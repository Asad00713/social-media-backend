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
      // Defaults describe an established user (well past the 30-day gate)
      // with no history, so `create()`'s reused `findMine` guard is
      // eligible by default — tests that need otherwise override these.
      users: {
        findFirst: jest.fn().mockResolvedValue({
          createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
        }),
      },
      feedbackDismissals: {
        findFirst: jest.fn().mockResolvedValue(undefined),
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
      {
        provide: NotificationEmitterService,
        useValue: { emitToAdmins: jest.fn() },
      },
    ],
  }).compile();
  return mod.get(FeedbackService);
}

describe('FeedbackService', () => {
  describe('create', () => {
    it('persists the submitted type when it matches the prompt', async () => {
      const db = makeDb();
      // Default makeDb() is an established user with no review history, so
      // the server prompts 'app'. Submit the type actually prompted for.
      const values = jest.fn(() => ({
        returning: jest.fn().mockResolvedValue([{ id: 'fb-1' }]),
      }));
      db.insert = jest.fn(() => ({ values })) as never;
      const service = await build(db);

      await service.create({ type: 'app', rating: 3 }, 'user-1');

      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'app', userId: 'user-1' }),
      );
    });

    it('rejects a submit for a type other than the one prompted', async () => {
      // Server prompts 'app' (established user, no history); caller submits
      // 'maestro' instead. Must be rejected, not silently inserted — this is
      // the only guard left now that the (user_id, type) unique index is gone.
      const db = makeDb();
      const service = await build(db);

      await expect(
        service.create({ type: 'maestro', rating: 4 }, 'user-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('accepts a submit for the type actually prompted', async () => {
      // Server prompts 'maestro': the user's only review is an 'app' review
      // from more than 90 days ago, so the cooldown has cleared and pickType
      // favors the type never rated most recently — 'maestro' here since
      // 'app' has history and 'maestro' does not.
      const db = makeDb();
      db.query.users = {
        findFirst: jest.fn().mockResolvedValue({
          createdAt: new Date('2024-01-01'),
        }),
      };
      db.query.feedback.findMany = jest.fn().mockResolvedValue([
        {
          id: 'old-app',
          type: 'app',
          rating: 5,
          createdAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
        },
      ]);
      db.query.feedbackDismissals = {
        findFirst: jest.fn().mockResolvedValue(undefined),
      };
      const values = jest.fn(() => ({
        returning: jest.fn().mockResolvedValue([{ id: 'fb-2' }]),
      }));
      db.insert = jest.fn(() => ({ values })) as never;
      const service = await build(db);

      await service.create({ type: 'maestro', rating: 5 }, 'user-1');

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
            .mockRejectedValue(
              Object.assign(new Error('dup'), { code: '23505' }),
            ),
        })),
      })) as never;
      const service = await build(db);

      await expect(
        service.create({ type: 'app', rating: 5 }, 'user-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('findMine', () => {
    it('returns no prompt for an account younger than 30 days', async () => {
      const db = makeDb();
      db.query.users = {
        findFirst: jest.fn().mockResolvedValue({
          createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
        }),
      };
      db.query.feedback.findMany = jest.fn().mockResolvedValue([]);
      db.query.feedbackDismissals = {
        findFirst: jest.fn().mockResolvedValue(undefined),
      };
      const service = await build(db);

      const result = await service.findMine('user-1');
      expect(result.prompt).toBeNull();
    });

    it('prompts app for an established user with no history', async () => {
      const db = makeDb();
      db.query.users = {
        findFirst: jest.fn().mockResolvedValue({
          createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
        }),
      };
      db.query.feedback.findMany = jest.fn().mockResolvedValue([]);
      db.query.feedbackDismissals = {
        findFirst: jest.fn().mockResolvedValue(undefined),
      };
      const service = await build(db);

      const result = await service.findMine('user-1');
      expect(result.prompt).toBe('app');
      expect(result.latest).toEqual({ app: null, maestro: null });
    });

    it('returns the NEWEST review per type when several exist', async () => {
      const older = {
        id: 'old',
        type: 'app',
        rating: 2,
        createdAt: new Date('2026-01-01'),
      };
      const newer = {
        id: 'new',
        type: 'app',
        rating: 5,
        createdAt: new Date('2026-05-01'),
      };
      const db = makeDb();
      db.query.users = {
        findFirst: jest.fn().mockResolvedValue({
          createdAt: new Date('2024-01-01'),
        }),
      };
      // Deliberately unordered — the unique index is gone, so the service
      // must not assume the driver returns these newest-first.
      db.query.feedback.findMany = jest.fn().mockResolvedValue([older, newer]);
      db.query.feedbackDismissals = {
        findFirst: jest.fn().mockResolvedValue(undefined),
      };
      const service = await build(db);

      const result = await service.findMine('user-1');
      expect(result.latest.app?.id).toBe('new');
    });
  });

  describe('create eligibility guard', () => {
    it('rejects a submit while the user is inside the cooldown', async () => {
      const db = makeDb();
      db.query.users = {
        findFirst: jest.fn().mockResolvedValue({
          createdAt: new Date('2024-01-01'),
        }),
      };
      db.query.feedback.findMany = jest.fn().mockResolvedValue([
        { id: 'r1', type: 'app', createdAt: new Date() },
      ]);
      db.query.feedbackDismissals = {
        findFirst: jest.fn().mockResolvedValue(undefined),
      };
      const service = await build(db);

      await expect(
        service.create({ type: 'app', rating: 5 }, 'user-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
