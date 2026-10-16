/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- test doubles are loosely typed */
import { ComposerSchedulingService } from './composer-scheduling.service';

/**
 * A composer-scheduled post must record the job that will publish it in
 * posts.job_id — PostService.updatePost/deletePost cancel by that column, so a
 * job nobody recorded is a job nobody can cancel and it publishes at its old
 * time after the post is moved.
 */
function make(existing: any[]) {
  const updates: any[] = [];
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => existing }) }),
    }),
    insert: () => ({ values: () => Promise.resolve() }),
    update: () => ({
      set: (v: any) => {
        updates.push(v);
        return { where: async () => undefined };
      },
    }),
  };
  const jobs = new Map<string, { remove: jest.Mock }>();
  const removed: string[] = [];
  const addJob = (id: string) =>
    jobs.set(id, {
      remove: jest.fn(async () => {
        removed.push(id);
      }),
    });
  const queue = {
    getJob: jest.fn(async (id: string) => jobs.get(id) ?? null),
    add: jest.fn(async (_n: string, _d: any, opts: any) => ({ id: opts.jobId })),
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
  return { svc, updates, queue, removed, addJob };
}

const dto = () => ({
  draftId: 'd1',
  scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
  base: { text: 'caption', mediaItems: [], hashtags: [], mentions: [] },
  channels: [{ channelId: '7', platform: 'facebook' }],
});

describe('ComposerSchedulingService job id bookkeeping', () => {
  it('schedule records the added job id on the post row', async () => {
    const { svc, updates } = make([{ id: 'd1', status: 'draft' }]);
    await svc.schedule('w1', 'u1', dto() as any);
    expect(updates.some((u) => u.jobId === 'composer-publish-d1')).toBe(true);
  });

  it('schedule records the job id for a brand-new row too', async () => {
    const { svc, updates } = make([]);
    await svc.schedule('w1', 'u1', dto() as any);
    expect(updates.some((u) => u.jobId === 'composer-publish-d1')).toBe(true);
  });

  it('schedule removes a differing pre-existing job named by job_id', async () => {
    const { svc, removed, addJob } = make([
      { id: 'd1', status: 'scheduled', jobId: 'post-d1-123' },
    ]);
    addJob('post-d1-123');
    await svc.schedule('w1', 'u1', dto() as any);
    expect(removed).toContain('post-d1-123');
  });

  it('schedule tolerates a job_id whose job no longer exists', async () => {
    const { svc } = make([
      { id: 'd1', status: 'scheduled', jobId: 'post-gone' },
    ]);
    await expect(svc.schedule('w1', 'u1', dto() as any)).resolves.toBeDefined();
  });

  it('cancel removes both the composer job and the job_id job, and nulls job_id', async () => {
    const { svc, removed, addJob, updates } = make([
      { id: 'd1', status: 'scheduled', jobId: 'post-d1-123' },
    ]);
    addJob('composer-publish-d1');
    addJob('post-d1-123');
    await svc.cancel('w1', 'd1');
    expect(removed.sort()).toEqual(['composer-publish-d1', 'post-d1-123']);
    expect(updates[0]).toMatchObject({ status: 'draft', jobId: null });
  });
});
