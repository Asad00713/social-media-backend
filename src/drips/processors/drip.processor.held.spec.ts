/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment -- db double */
import { dripCampaigns, dripPosts } from '../../drizzle/schema/drips.schema';
import { socialMediaChannels } from '../../drizzle/schema/channels.schema';

let updates: Array<{ table: unknown; set: Record<string, unknown> }>;
let historyRows: Record<string, unknown>[];

const rowsFor = (table: unknown): unknown[] => {
  if (table === dripPosts) {
    return [
      {
        id: 'dp1',
        status: 'approved',
        occurrenceNumber: 3,
        generatedContent: 'Hello',
        platformContent: { bluesky: { text: 'Hello' } },
      },
    ];
  }
  if (table === dripCampaigns) {
    return [
      {
        id: 'c1',
        status: 'active',
        workspaceId: 'w1',
        createdById: 'u1',
        targetChannelIds: ['7'],
        completedOccurrences: 4,
        consecutiveErrors: 0,
      },
    ];
  }
  if (table === socialMediaChannels) {
    return [{ id: 7, platform: 'bluesky' }];
  }
  return [];
};

const mockDb = {
  select: jest.fn(() => ({
    from: (table: unknown) => ({
      where: async () => rowsFor(table),
    }),
  })),
  insert: jest.fn(() => ({
    values: (v: Record<string, unknown>) => {
      if ('action' in v) historyRows.push(v);
      const p = Promise.resolve(undefined) as Promise<unknown> & {
        returning: () => Promise<unknown[]>;
      };
      p.returning = async () => [{ id: 'post-1' }];
      return p;
    },
  })),
  update: jest.fn((table: unknown) => ({
    set: (set: Record<string, unknown>) => {
      updates.push({ table, set });
      return { where: async () => undefined };
    },
  })),
};

jest.mock('../../drizzle/db', () => ({ db: mockDb }));
jest.mock('../../drizzle/db-utils', () => ({
  withRetry: (fn: () => unknown) => fn(),
}));

import { DripProcessor } from './drip.processor';

function make(status: string) {
  const postService = {
    publishPost: jest.fn(async () => ({ status, targets: [] })),
  };
  const processor = new DripProcessor(
    {} as never,
    postService as never,
    {} as never,
  );
  return { processor, postService };
}

const job = {
  name: 'drip-publish-post',
  data: { dripPostId: 'dp1', campaignId: 'c1' },
} as never;

beforeEach(() => {
  updates = [];
  historyRows = [];
});

describe('DripProcessor on a paused channel', () => {
  it('publishes with onPaused: hold', async () => {
    const { processor, postService } = make('scheduled');
    await processor.process(job);
    expect(postService.publishPost).toHaveBeenCalledWith('post-1', 'w1', 'u1', {
      onPaused: 'hold',
    });
  });

  it('a held occurrence is scheduled, not failed, and moves no counter', async () => {
    const { processor } = make('scheduled');
    const result = await processor.process(job);

    expect(result).toMatchObject({ success: true, held: true });
    const dripWrites = updates
      .filter((u) => u.table === dripPosts)
      .map((u) => u.set.status)
      .filter(Boolean);
    expect(dripWrites.at(-1)).toBe('scheduled');
    expect(dripWrites).not.toContain('failed');
    expect(updates.filter((u) => u.table === dripCampaigns)).toEqual([]);
    expect(historyRows.map((h) => h.action)).toContain('held');
  });

  it('a published occurrence still counts as before', async () => {
    const { processor } = make('published');
    await processor.process(job);
    expect(
      updates.filter((u) => u.table === dripPosts).map((u) => u.set.status),
    ).toContain('published');
    expect(
      updates.find((u) => u.table === dripCampaigns)?.set.completedOccurrences,
    ).toBe(5);
  });
});
