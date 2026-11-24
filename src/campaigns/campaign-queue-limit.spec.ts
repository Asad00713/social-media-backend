import { ForbiddenException } from '@nestjs/common';
import {
  CampaignPublishingService,
  QueueLimitReachedError,
} from './campaign-publishing.service';

/**
 * `PostQueueService.enforceQueueLimit` guarded createPost, updatePost and the
 * two composer paths — but not campaigns. So a workspace on a 10-post queue
 * cap could schedule without limit through a campaign, which made the cap
 * cosmetic for anyone who found the feature.
 *
 * Every campaign post (simple, drip and evergreen) goes through
 * `materializeAndEnqueue`, so that is where the check belongs. These tests pin
 * both halves of the fix: the check runs, and its refusal arrives as a type
 * the slot loops can handle rather than an exception that aborts a launch
 * half-done.
 */

const INPUT = {
  workspaceId: 'ws-1',
  createdById: 'user-1',
  campaignId: 'camp-1',
  date: '2026-12-01',
  channelId: '42',
  time: '09:00',
  content: { caption: 'hello' } as never,
  platform: 'twitter',
  scheduledAt: new Date('2026-12-01T09:00:00Z'),
};

function make(enforceQueueLimit: jest.Mock) {
  const queue = {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    getJob: jest.fn(),
  } as never;
  return new CampaignPublishingService(queue, {
    enforceQueueLimit,
  } as never);
}

describe('campaign slots respect the plan queue cap', () => {
  it('checks the cap for the slot’s own channel before inserting', async () => {
    const enforce = jest.fn().mockResolvedValue(undefined);
    const service = make(enforce);

    // The insert itself needs a live DB, so this test asserts only what
    // happens before it — which is the part the fix added.
    await service.materializeAndEnqueue(INPUT).catch(() => undefined);

    expect(enforce).toHaveBeenCalledWith('ws-1', ['42']);
  });

  it('translates the refusal into QueueLimitReachedError', async () => {
    // A bare ForbiddenException would travel up through four callers that do
    // not catch, aborting a launch loop part-way: some slots scheduled, the
    // rest untouched, the campaign never marked active.
    const enforce = jest
      .fn()
      .mockRejectedValue(
        new ForbiddenException('Scheduling queue full for channel 42.'),
      );
    const service = make(enforce);

    await expect(service.materializeAndEnqueue(INPUT)).rejects.toThrow(
      QueueLimitReachedError,
    );
  });

  it('carries the channel id and the reason on the error', async () => {
    const enforce = jest
      .fn()
      .mockRejectedValue(
        new ForbiddenException('This channel has 10 of 10 scheduled posts.'),
      );
    const service = make(enforce);

    const err = await service
      .materializeAndEnqueue(INPUT)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(QueueLimitReachedError);
    const queueErr = err as QueueLimitReachedError;
    expect(queueErr.channelId).toBe('42');
    // The caller writes this into the slot's `lastError`, so it has to be the
    // provider's message and not a generic one.
    expect(queueErr.message).toContain('10 of 10');
  });

  it('does not swallow an unrelated failure', async () => {
    // Only the cap refusal becomes QueueLimitReachedError. A database or
    // lookup failure must stay what it is, or a real fault would be recorded
    // as "at your plan limit".
    const boom = new Error('connection terminated');
    const service = make(jest.fn().mockRejectedValue(boom));

    await expect(service.materializeAndEnqueue(INPUT)).rejects.toThrow(boom);
    await expect(service.materializeAndEnqueue(INPUT)).rejects.not.toBeInstanceOf(
      QueueLimitReachedError,
    );
  });

  it('QueueLimitReachedError is distinguishable from ForbiddenException', () => {
    // The campaign loops branch on `instanceof QueueLimitReachedError`. If it
    // extended ForbiddenException, an unrelated 403 would be mistaken for a
    // plan limit and silently skip a slot.
    const err = new QueueLimitReachedError('42', 'full');
    expect(err).not.toBeInstanceOf(ForbiddenException);
    expect(err.name).toBe('QueueLimitReachedError');
  });
});
