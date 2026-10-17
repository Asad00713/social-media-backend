/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await -- test doubles are loosely typed */

let rows: any[];

const mockDb = {
  select: jest.fn(() => ({
    from: () => ({ where: () => ({ limit: async () => rows }) }),
  })),
  update: jest.fn(() => ({
    set: () => ({ where: async () => undefined }),
  })),
};

jest.mock('../../drizzle/db', () => ({ db: mockDb }));
jest.mock('../../drizzle/db-utils', () => ({
  withRetry: (fn: () => unknown) => fn(),
}));

import { PostPublishProcessor } from './post-publish.processor';

function make(existingJobs: string[] = []) {
  const postService = {
    publishPost: jest.fn(async () => ({ status: 'published', targets: [] })),
  };
  const queue = {
    getJob: jest.fn(async (id: string) =>
      existingJobs.includes(id) ? { id } : null,
    ),
  };
  const processor = new PostPublishProcessor(postService as any, queue as any);
  return { processor, postService, queue };
}

const job = (id: string) => ({ id, data: { postId: 'p1' } }) as any;
const row = (over: any = {}) => ({
  id: 'p1',
  workspaceId: 'w1',
  createdById: 'u1',
  status: 'scheduled',
  jobId: null,
  ...over,
});

describe('PostPublishProcessor', () => {
  it('returns skipped (does not throw) when the post no longer exists', async () => {
    rows = [];
    const { processor, postService } = make();
    await expect(processor.process(job('j1'))).resolves.toEqual({
      skipped: true,
      reason: 'Post not found',
    });
    expect(postService.publishPost).not.toHaveBeenCalled();
  });

  it('skips a superseded job when the job the row names still exists', async () => {
    rows = [row({ jobId: 'post-p1-2' })];
    const { processor, postService } = make(['post-p1-2']);
    await expect(
      processor.process(job('composer-publish-p1')),
    ).resolves.toEqual({
      skipped: true,
      reason: 'Superseded by job post-p1-2',
    });
    expect(postService.publishPost).not.toHaveBeenCalled();
  });

  it('publishes when the job the row names no longer exists', async () => {
    rows = [row({ jobId: 'post-p1-old' })];
    const { processor, postService } = make([]);
    await processor.process(job('j-new'));
    expect(postService.publishPost).toHaveBeenCalledTimes(1);
  });

  it('publishes when the row names this very job', async () => {
    rows = [row({ jobId: 'j1' })];
    const { processor, postService, queue } = make(['j1']);
    await processor.process(job('j1'));
    expect(queue.getJob).not.toHaveBeenCalled();
    expect(postService.publishPost).toHaveBeenCalledTimes(1);
  });

  it('publishes when the row has no job_id', async () => {
    rows = [row({ jobId: null })];
    const { processor, postService } = make();
    await processor.process(job('j1'));
    expect(postService.publishPost).toHaveBeenCalledTimes(1);
  });

  it('still skips a post that is no longer scheduled', async () => {
    rows = [row({ status: 'draft' })];
    const { processor, postService } = make();
    await expect(processor.process(job('j1'))).resolves.toMatchObject({
      skipped: true,
    });
    expect(postService.publishPost).not.toHaveBeenCalled();
  });
});
