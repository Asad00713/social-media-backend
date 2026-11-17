/**
 * The db module opens a live pool at import time, so it is replaced wholesale.
 * `rows` is what the candidate query returns; `updates` records every write so
 * a test can assert what the reconciler decided.
 */
const rows: Array<Record<string, unknown>> = [];
const updates: Array<Record<string, unknown>> = [];

jest.mock('../../drizzle/db', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: () => Promise.resolve() };
      },
    }),
  },
}));

import {
  ScheduledPostReconcilerService,
  MISSED_SCHEDULE_MESSAGE,
} from './scheduled-post-reconciler.service';

const NOW = new Date('2026-11-17T12:00:00.000Z');

/** A BullMQ queue stand-in. `state` drives what getJob reports. */
function queueWith(
  state: 'delayed' | 'completed' | 'missing',
): { queue: any; added: any[] } {
  const added: any[] = [];
  return {
    added,
    queue: {
      getJob: (id: string) =>
        Promise.resolve(
          state === 'missing'
            ? undefined
            : { id, getState: () => Promise.resolve(state) },
        ),
      add: (name: string, data: unknown, opts: Record<string, unknown>) => {
        added.push({ name, data, opts });
        return Promise.resolve({ id: opts.jobId });
      },
    },
  };
}

function scheduledPost(overrides: Record<string, unknown> = {}) {
  return {
    id: 'post-1',
    scheduledAt: new Date('2026-11-17T13:00:00.000Z'), // an hour ahead
    jobId: 'post-post-1-123',
    ...overrides,
  };
}

beforeEach(() => {
  rows.length = 0;
  updates.length = 0;
});

describe('ScheduledPostReconcilerService', () => {
  describe('when the job is still waiting in Redis', () => {
    /**
     * The guard against double-posting. A post whose job is queued is already
     * going to fire; enqueuing a second one would race it. Everything else
     * this service does is gated behind this check failing.
     */
    it('leaves the post completely alone', async () => {
      rows.push(scheduledPost());
      const { queue, added } = queueWith('delayed');

      const result = await new ScheduledPostReconcilerService(
        queue,
      ).reconcile(NOW);

      expect(added).toHaveLength(0);
      expect(updates).toHaveLength(0);
      expect(result).toEqual({ checked: 1, rearmed: 0, failedAsMissed: 0 });
    });
  });

  describe('when the job is gone', () => {
    it('re-arms a post whose time is still ahead, at its own time', async () => {
      rows.push(scheduledPost());
      const { queue, added } = queueWith('missing');

      const result = await new ScheduledPostReconcilerService(
        queue,
      ).reconcile(NOW);

      expect(added).toHaveLength(1);
      expect(added[0].data).toEqual({ postId: 'post-1' });
      // One hour ahead, so it waits an hour — it is not published early.
      expect(added[0].opts.delay).toBe(60 * 60 * 1000);
      expect(result.rearmed).toBe(1);
    });

    it('re-arms a recently-passed post with no delay', async () => {
      rows.push(
        scheduledPost({
          scheduledAt: new Date('2026-11-17T11:30:00.000Z'), // 30 min ago
        }),
      );
      const { queue, added } = queueWith('missing');

      await new ScheduledPostReconcilerService(queue).reconcile(NOW);

      expect(added[0].opts.delay).toBe(0);
    });

    it('points the row at the new job, so the processor accepts it', async () => {
      rows.push(scheduledPost());
      const { queue, added } = queueWith('missing');

      await new ScheduledPostReconcilerService(queue).reconcile(NOW);

      expect(updates[0].jobId).toBe(added[0].opts.jobId);
    });

    /** BullMQ refuses a colon in a custom job id. */
    it('builds a job id with no colon', async () => {
      rows.push(scheduledPost());
      const { queue, added } = queueWith('missing');

      await new ScheduledPostReconcilerService(queue).reconcile(NOW);

      expect(String(added[0].opts.jobId)).not.toContain(':');
    });

    /**
     * The judgement call this service exists to get right. A post written for
     * Monday morning appearing on Thursday afternoon is worse than one that
     * never went out: the author can see a failure and decide, but cannot
     * un-publish.
     */
    it('fails a long-overdue post instead of publishing it late', async () => {
      rows.push(
        scheduledPost({
          scheduledAt: new Date('2026-11-16T12:00:00.000Z'), // 24h ago
        }),
      );
      const { queue, added } = queueWith('missing');

      const result = await new ScheduledPostReconcilerService(
        queue,
      ).reconcile(NOW);

      expect(added).toHaveLength(0); // nothing enqueued: nothing publishes
      expect(updates[0].status).toBe('failed');
      expect(updates[0].lastError).toBe(MISSED_SCHEDULE_MESSAGE);
      expect(result.failedAsMissed).toBe(1);
    });

    it('still re-arms a post just inside the grace window', async () => {
      rows.push(
        scheduledPost({
          // 5h59m ago — inside the six-hour grace
          scheduledAt: new Date('2026-11-17T06:01:00.000Z'),
        }),
      );
      const { queue, added } = queueWith('missing');

      const result = await new ScheduledPostReconcilerService(
        queue,
      ).reconcile(NOW);

      expect(added).toHaveLength(1);
      expect(result.failedAsMissed).toBe(0);
    });
  });

  describe('when the job completed', () => {
    /**
     * Completed jobs are dropped from Redis after 24h, so "no pending job" on
     * its own proves nothing. What makes re-arming safe is the pairing: a job
     * that ran would have moved the post out of `scheduled`. A row still
     * `scheduled` whose job merely completed is a genuine anomaly, and
     * re-arming is the right answer — the processor skips it if the post has
     * in fact moved on.
     */
    it('treats a completed job as not pending', async () => {
      rows.push(scheduledPost());
      const { queue, added } = queueWith('completed');

      await new ScheduledPostReconcilerService(queue).reconcile(NOW);

      expect(added).toHaveLength(1);
    });
  });

  describe('a post that never got a job id', () => {
    it('is re-armed rather than left unarmed forever', async () => {
      rows.push(scheduledPost({ jobId: null }));
      const { queue, added } = queueWith('missing');

      await new ScheduledPostReconcilerService(queue).reconcile(NOW);

      expect(added).toHaveLength(1);
    });
  });

  describe('a post held on a paused or disconnected channel', () => {
    /**
     * Held posts are `scheduled` with no publish job *on purpose*: resuming
     * the channel is what sends them (held-targets.ts,
     * ChannelPauseService.releaseAfterReconnect). They look identical to a
     * post whose job was lost, so without this check the reconciler would
     * re-arm them — publishing to a channel the user deliberately paused.
     */
    it('is left alone, not re-armed', async () => {
      rows.push(
        scheduledPost({
          jobId: null,
          targets: [
            {
              channelId: '1',
              platform: 'twitter',
              status: 'scheduled',
              heldAt: '2026-11-17T10:00:00.000Z',
            },
          ],
        }),
      );
      const { queue, added } = queueWith('missing');

      const result = await new ScheduledPostReconcilerService(
        queue,
      ).reconcile(NOW);

      expect(added).toHaveLength(0);
      expect(updates).toHaveLength(0);
      expect(result.rearmed).toBe(0);
    });

    it('still re-arms a post whose targets are not held', async () => {
      rows.push(
        scheduledPost({
          jobId: null,
          targets: [
            { channelId: '1', platform: 'twitter', status: 'scheduled' },
          ],
        }),
      );
      const { queue, added } = queueWith('missing');

      await new ScheduledPostReconcilerService(queue).reconcile(NOW);

      expect(added).toHaveLength(1);
    });
  });

  describe('resilience', () => {
    it('keeps going when one post cannot be reconciled', async () => {
      rows.push(scheduledPost({ id: 'bad' }), scheduledPost({ id: 'good' }));
      const { queue, added } = queueWith('missing');
      const realAdd = queue.add;
      let first = true;
      queue.add = (...args: unknown[]) => {
        if (first) {
          first = false;
          return Promise.reject(new Error('redis went away'));
        }
        return realAdd(...(args as [string, unknown, Record<string, unknown>]));
      };

      const result = await new ScheduledPostReconcilerService(
        queue,
      ).reconcile(NOW);

      expect(added).toHaveLength(1); // the second one still went through
      expect(result.rearmed).toBe(1);
      expect(result.checked).toBe(2);
    });

    it('does nothing when there is nothing to reconcile', async () => {
      const { queue, added } = queueWith('missing');

      const result = await new ScheduledPostReconcilerService(
        queue,
      ).reconcile(NOW);

      expect(added).toHaveLength(0);
      expect(result).toEqual({ checked: 0, rearmed: 0, failedAsMissed: 0 });
    });
  });
});
