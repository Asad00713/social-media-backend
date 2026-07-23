import { Test } from '@nestjs/testing';
import { PgDialect } from 'drizzle-orm/pg-core';
import { YoutubeRetentionScheduler } from './youtube-retention.scheduler';
import {
  YoutubeRetentionService,
  YOUTUBE_RETENTION_DAYS,
} from '../services/youtube-retention.service';
import { DRIZZLE } from '../../drizzle/drizzle.module';

const DAY = 24 * 60 * 60 * 1000;

const retention = { wipeExpiredContent: jest.fn() };

async function build() {
  const mod = await Test.createTestingModule({
    providers: [
      YoutubeRetentionScheduler,
      { provide: YoutubeRetentionService, useValue: retention },
    ],
  }).compile();
  return mod.get(YoutubeRetentionScheduler);
}

describe('YoutubeRetentionScheduler', () => {
  beforeEach(() => {
    retention.wipeExpiredContent.mockReset();
    retention.wipeExpiredContent.mockResolvedValue({ wiped: 0 });
  });

  it('runs the retention wipe', async () => {
    const scheduler = await build();
    await scheduler.wipeExpiredYoutubeContent();
    expect(retention.wipeExpiredContent).toHaveBeenCalledTimes(1);
  });

  // An unhandled rejection inside a cron handler kills the scheduler for every
  // later tick — one bad night must not stop retention running forever after.
  it('swallows and logs a failure rather than throwing', async () => {
    retention.wipeExpiredContent.mockRejectedValue(new Error('db is down'));
    const scheduler = await build();
    await expect(scheduler.wipeExpiredYoutubeContent()).resolves.toBeUndefined();
  });

  // `(err as Error).message` throws a TypeError when the rejection value is
  // not an Error (e.g. a bare `null`/`undefined` rejection, or a thrown
  // string). That throw would happen INSIDE the catch block, escaping the
  // try/catch entirely and rejecting the handler's own promise — exactly the
  // unhandled-rejection failure this handler exists to prevent.
  it('swallows a non-Error rejection (e.g. reject(null)) rather than throwing', async () => {
    retention.wipeExpiredContent.mockRejectedValue(null);
    const scheduler = await build();
    await expect(scheduler.wipeExpiredYoutubeContent()).resolves.toBeUndefined();
  });
});

// The spec calls the retention window its top risk: getting the boundary
// wrong destroys user data irreversibly. These tests exercise the REAL
// YoutubeRetentionService.wipeExpiredContent() rather than re-deriving the
// comparison locally, so an off-by-one introduced in the service (< -> <=,
// or a change to the cutoff arithmetic) fails these tests instead of being
// silently mirrored by them.
describe('retention boundary (real service)', () => {
  const now = new Date('2026-07-18T12:00:00Z');
  const dialect = new PgDialect();

  let db: { execute: jest.Mock };
  let capturedQuery: { sql: string; params: unknown[] };

  beforeEach(async () => {
    db = { execute: jest.fn().mockResolvedValue({ rowCount: 0 }) };
    const mod = await Test.createTestingModule({
      providers: [
        YoutubeRetentionService,
        { provide: DRIZZLE, useValue: db },
      ],
    }).compile();
    const service = mod.get(YoutubeRetentionService);

    const result = await service.wipeExpiredContent(now);

    expect(db.execute).toHaveBeenCalledTimes(1);
    const [query] = db.execute.mock.calls[0];
    capturedQuery = dialect.sqlToQuery(query);

    // The cutoff the service returns to callers must be the same value it
    // actually sent to Postgres as the comparison bound.
    expect(capturedQuery.params[0]).toBe(result.cutoff.toISOString());
  });

  /**
   * Reads the real operator and cutoff out of the SQL the service generated
   * for this run and applies them to a candidate timestamp. This is the
   * service's own decision, not a re-implementation of it: if the service
   * starts emitting `<=` instead of `<`, or shifts the cutoff, this helper's
   * verdict changes accordingly — which is what makes the assertions below
   * able to fail on those mutations.
   */
  function expiredByRealQuery(commentPostedAt: Date): boolean {
    const match = capturedQuery.sql.match(
      /platform_created_at\s*(<=?)\s*\$1/,
    );
    if (!match) {
      throw new Error(
        'could not find a platform_created_at comparison against $1 in the generated SQL',
      );
    }
    const operator = match[1];
    const cutoffMs = new Date(capturedQuery.params[0] as string).getTime();
    if (operator === '<') return commentPostedAt.getTime() < cutoffMs;
    if (operator === '<=') return commentPostedAt.getTime() <= cutoffMs;
    throw new Error(`unexpected comparison operator: ${operator}`);
  }

  it('does not expire a comment posted 29 days before now', () => {
    expect(expiredByRealQuery(new Date(now.getTime() - 29 * DAY))).toBe(false);
  });

  it('expires a comment posted 31 days before now', () => {
    expect(expiredByRealQuery(new Date(now.getTime() - 31 * DAY))).toBe(true);
  });

  it('keeps a comment posted exactly 30 days before now (strictly-less-than boundary)', () => {
    // A comment on its 30th day has not yet exceeded 30 calendar days, so it
    // must survive one more run. This fails if the operator flips to <=.
    expect(expiredByRealQuery(new Date(now.getTime() - 30 * DAY))).toBe(false);
  });

  it('derives the cutoff from the documented 30-day retention window', () => {
    // Direct assertion on the arithmetic itself: fails if YOUTUBE_RETENTION_DAYS
    // stops being honored, or the ms-per-day math is changed.
    const expectedCutoff = new Date(now.getTime() - YOUTUBE_RETENTION_DAYS * DAY);
    expect(capturedQuery.params[0]).toBe(expectedCutoff.toISOString());
  });

  it('uses a strict less-than comparison against the cutoff', () => {
    const match = capturedQuery.sql.match(
      /platform_created_at\s*(<=?)\s*\$1/,
    );
    expect(match?.[1]).toBe('<');
  });
});
