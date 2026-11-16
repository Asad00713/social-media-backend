/* eslint-disable @typescript-eslint/require-await -- loosely typed test doubles */
import { BadRequestException } from '@nestjs/common';
import {
  HELD_REASON,
  HELD_REASON_DISCONNECTED,
  enqueueHeldPost,
  holdTarget,
  holdingReasonOf,
  isMissedRelease,
  publishRefusalFor,
  type HoldingChannel,
} from './held-targets';
import type { PostTarget } from '../../drizzle/schema/posts.schema';

const NOW = new Date('2026-11-15T12:00:00Z');
const MIN = 60_000;

const target = (over: Partial<PostTarget> = {}): PostTarget =>
  ({
    channelId: '7',
    platform: 'bluesky',
    status: 'draft',
    ...over,
  }) as PostTarget;

describe('holds for a disconnected channel', () => {
  it('holdTarget writes the reason and keeps the first hold time', () => {
    const first = holdTarget(target(), NOW, HELD_REASON);
    const later = holdTarget(
      first,
      new Date(NOW.getTime() + MIN),
      HELD_REASON_DISCONNECTED,
    );
    expect(later.heldAt).toBe(NOW.toISOString());
    expect(later.heldReason).toBe('channel_disconnected');
    expect(holdTarget(target(), NOW).heldReason).toBe('channel_paused');
  });

  it('holdingReasonOf: disconnected wins over a pause; neither holds nothing', () => {
    expect(
      holdingReasonOf({ pausedAt: NOW, connectionStatus: 'disconnected' }),
    ).toBe(HELD_REASON_DISCONNECTED);
    expect(holdingReasonOf({ pausedAt: NOW, connectionStatus: 'connected' })).toBe(
      HELD_REASON,
    );
    expect(
      holdingReasonOf({ pausedAt: null, connectionStatus: 'expired' }),
    ).toBeNull();
  });

  it('publishRefusalFor names the disconnected channels first', () => {
    const holding = new Map<string, HoldingChannel>([
      ['7', { name: 'Bluesky', reason: HELD_REASON }],
      ['9', { name: 'Mastodon', reason: HELD_REASON_DISCONNECTED }],
    ]);
    const err = publishRefusalFor(holding);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({
      code: 'CHANNEL_DISCONNECTED',
      message:
        'Disconnected: Mastodon. Reconnect it to publish - scheduled posts wait until you do.',
    });
    const paused = publishRefusalFor(
      new Map([['7', { name: 'Bluesky', reason: HELD_REASON }]]),
    );
    expect(paused.getResponse()).toMatchObject({ code: 'CHANNEL_PAUSED' });
  });

  it('isMissedRelease: only past the grace, never a post with no time', () => {
    const grace = 10 * MIN;
    expect(isMissedRelease(new Date(NOW.getTime() - 11 * MIN), grace, NOW)).toBe(
      true,
    );
    expect(isMissedRelease(new Date(NOW.getTime() - 10 * MIN), grace, NOW)).toBe(
      false,
    );
    expect(isMissedRelease(new Date(NOW.getTime() + MIN), grace, NOW)).toBe(false);
    expect(isMissedRelease(null, grace, NOW)).toBe(false);
  });

  it('enqueueHeldPost with missed: job flagged, no delay, job_id recorded', async () => {
    const add = jest.fn(async (_n: string, _d: unknown, o: { jobId: string }) => ({
      id: o.jobId,
    }));
    const where = jest.fn(async () => undefined);
    const db = { update: () => ({ set: () => ({ where }) }) };
    const id = await enqueueHeldPost(
      { add } as never,
      db as never,
      { id: 'p1', scheduledAt: new Date(NOW.getTime() - 60 * MIN) },
      NOW,
      { missed: true },
    );
    expect(id).toBe(`post-p1-resume-${NOW.getTime()}`);
    expect(add).toHaveBeenCalledWith(
      'publish-post',
      { postId: 'p1', heldOnly: true, missedHeld: true },
      expect.objectContaining({ delay: 0 }),
    );
    expect(where).toHaveBeenCalled();
  });
});
