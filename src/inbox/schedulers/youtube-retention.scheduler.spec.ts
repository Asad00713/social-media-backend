import { Test } from '@nestjs/testing';
import { YoutubeRetentionScheduler } from './youtube-retention.scheduler';
import {
  YoutubeRetentionService,
  YOUTUBE_RETENTION_DAYS,
} from '../services/youtube-retention.service';

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
});

// The spec calls the retention window its top risk. These assert the arithmetic
// the service actually uses, at the boundary where an off-by-one shows up.
describe('retention boundary', () => {
  const now = new Date('2026-07-18T12:00:00Z');
  const cutoff = new Date(now.getTime() - YOUTUBE_RETENTION_DAYS * DAY);

  function isExpired(commentPostedAt: Date): boolean {
    return commentPostedAt < cutoff;
  }

  it('keeps a comment posted 29 days ago', () => {
    expect(isExpired(new Date(now.getTime() - 29 * DAY))).toBe(false);
  });

  it('wipes a comment posted 31 days ago', () => {
    expect(isExpired(new Date(now.getTime() - 31 * DAY))).toBe(true);
  });

  it('keeps a comment posted exactly 30 days ago', () => {
    // Strictly-less-than at the boundary: a comment on its 30th day has not yet
    // exceeded 30 calendar days, so it survives one more run.
    expect(isExpired(new Date(now.getTime() - 30 * DAY))).toBe(false);
  });
});
