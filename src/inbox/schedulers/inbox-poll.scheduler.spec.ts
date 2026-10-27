const whereMock = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../../drizzle/db', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => whereMock() }),
    }),
  },
}));

import type { Queue } from 'bullmq';
import { InboxPollScheduler } from './inbox-poll.scheduler';
import { pollDedupId } from './poll-dedup';

describe('pollDedupId', () => {
  it('has no colon', () => {
    expect(pollDedupId(12)).toBe('inbox-poll-12');
    expect(pollDedupId(12)).not.toContain(':');
  });
});

describe('InboxPollScheduler.enqueueInboxPolling', () => {
  it('adds each poll with a per-channel deduplication id', async () => {
    whereMock.mockResolvedValue([{ id: 7 }, { id: 9 }]);
    const add = jest.fn<Promise<void>, [string, unknown, unknown]>();
    add.mockResolvedValue(undefined);
    const queue = { add };
    const scheduler = new InboxPollScheduler(queue as unknown as Queue);

    await scheduler.enqueueInboxPolling();

    expect(add).toHaveBeenCalledTimes(2);
    expect(add.mock.calls[0][2]).toEqual(
      expect.objectContaining({ deduplication: { id: 'inbox-poll-7' } }),
    );
    expect(add.mock.calls[1][2]).toEqual(
      expect.objectContaining({ deduplication: { id: 'inbox-poll-9' } }),
    );
  });
});
