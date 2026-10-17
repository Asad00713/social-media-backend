/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- test doubles are loosely typed */
import { ComposerSchedulingService } from './composer-scheduling.service';

function make(existing: any[]) {
  const captured: { inserted?: any; updated?: any } = {};
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => existing }) }),
    }),
    insert: () => ({
      values: (v: any) => {
        captured.inserted = v;
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (v: any) => {
        captured.updated ??= v; // first write = the row content; later ones are bookkeeping
        return { where: async () => undefined };
      },
    }),
  };
  const queue = {
    getJob: jest.fn(async () => null),
    add: jest.fn(async () => undefined),
  };
  const calendar = {
    syncPost: jest.fn(async () => undefined),
    removePostEvent: jest.fn(async () => undefined),
  };
  const postQueue = { enforceQueueLimit: jest.fn(async () => undefined) };
  const svc = new ComposerSchedulingService(
    db as any,
    queue as any,
    calendar as any,
    postQueue as any,
  );
  return { svc, captured, queue, postQueue };
}

const dto = () => ({
  draftId: 'd1',
  scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
  base: { text: 'caption', mediaItems: [], hashtags: [], mentions: [] },
  channels: [
    {
      channelId: '7',
      platform: 'facebook',
      publishStatus: 'queued',
      retryCount: 0,
    },
  ],
});

describe('ComposerSchedulingService.schedule keeps the first-week tag', () => {
  it('re-applies source=first_week over the composer default', async () => {
    const { svc, captured } = make([
      {
        id: 'd1',
        status: 'draft',
        metadata: {
          source: 'first_week',
          firstWeekSlot: 3,
          suggestedAt: '2026-10-18T13:00:00.000Z',
        },
      },
    ]);
    await svc.schedule('w1', 'u1', dto() as any);
    expect(captured.updated.status).toBe('scheduled');
    expect(captured.updated.metadata).toMatchObject({
      source: 'first_week',
      firstWeekSlot: 3,
      suggestedAt: '2026-10-18T13:00:00.000Z',
    });
  });

  it('still tags an ordinary scheduled draft as composer', async () => {
    const { svc, captured } = make([
      { id: 'd1', status: 'draft', metadata: { source: 'composer' } },
    ]);
    await svc.schedule('w1', 'u1', dto() as any);
    expect(captured.updated.metadata.source).toBe('composer');
    expect(captured.updated.metadata.firstWeekSlot).toBeUndefined();
  });

  it('tags a brand-new scheduled post as composer', async () => {
    const { svc, captured } = make([]);
    await svc.schedule('w1', 'u1', dto() as any);
    expect(captured.inserted.metadata.source).toBe('composer');
  });

  it('still enforces the queue ceiling for a first-week draft that is not yet scheduled', async () => {
    const { svc, postQueue } = make([
      { id: 'd1', status: 'draft', metadata: { source: 'first_week' } },
    ]);
    await svc.schedule('w1', 'u1', dto() as any);
    expect(postQueue.enforceQueueLimit).toHaveBeenCalledWith('w1', ['7']);
  });
});
