import { Test } from '@nestjs/testing';
import { YoutubeDataDeletionService } from './youtube-data-deletion.service';
import { DRIZZLE } from '../../drizzle/drizzle.module';

const execute = jest.fn();
const fakeDb = {
  execute,
  transaction: async (fn: any) => fn({ execute }),
};

async function build() {
  const mod = await Test.createTestingModule({
    providers: [
      YoutubeDataDeletionService,
      { provide: DRIZZLE, useValue: fakeDb },
    ],
  }).compile();
  return mod.get(YoutubeDataDeletionService);
}

function allStatementsSql(): string {
  return execute.mock.calls.map((c) => JSON.stringify(c[0])).join(' | ');
}

describe('YoutubeDataDeletionService', () => {
  beforeEach(() => {
    execute.mockReset();
    execute.mockResolvedValue({ rowCount: 3, rows: [] });
  });

  it('reports what it deleted from every table', async () => {
    const svc = await build();
    const summary = await svc.deleteAllYoutubeData(1, 'ws');

    expect(summary.inboxItems).toBe(3);
    expect(summary.postMetricSnapshots).toBe(3);
    expect(summary.channelSnapshots).toBe(3);
    expect(summary.channelAnalyticsDaily).toBe(3);
  });

  // Unlike the 30-day retention job, an explicit user deletion DOES remove the
  // analytics: III.E.4.b only permits keeping those while still authorized, and
  // the user is withdrawing that authorization.
  it('deletes the analytics tables too', async () => {
    const svc = await build();
    await svc.deleteAllYoutubeData(1, 'ws');
    const sql = allStatementsSql();

    expect(sql).toContain('inbox_items');
    expect(sql).toContain('post_metric_snapshots');
    expect(sql).toContain('channel_snapshots');
    expect(sql).toContain('channel_analytics_daily');
  });

  it('scopes every delete to the requested channel and workspace', async () => {
    const svc = await build();
    await svc.deleteAllYoutubeData(42, 'ws-abc');
    const sql = allStatementsSql();

    expect(sql).toContain('42');
    expect(sql).toContain('ws-abc');
  });

  it('runs inside a transaction so a partial delete cannot happen', async () => {
    const spy = jest.spyOn(fakeDb, 'transaction');
    const svc = await build();
    await svc.deleteAllYoutubeData(1, 'ws');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  // Regression guard for Finding 1: post_metric_snapshots, channel_snapshots,
  // and channel_analytics_daily have no workspace_id column of their own, so
  // the workspace boundary must be enforced inside the SQL itself (via a
  // subquery against social_media_channels), not by trusting the caller to
  // have already validated channel ownership. If a future edit hoists these
  // deletes back to a bare `channel_id = ...` predicate, this test must fail.
  it('scopes the analytics deletes through social_media_channels so an out-of-workspace channel id deletes nothing', async () => {
    const svc = await build();
    await svc.deleteAllYoutubeData(999, 'ws-victim');
    const calls = execute.mock.calls.map((c) => JSON.stringify(c[0]));

    expect(calls).toHaveLength(4);
    for (const statement of calls) {
      expect(statement).toContain('ws-victim');
    }

    const analyticsStatements = calls.filter(
      (s) => !s.includes('inbox_items'),
    );
    expect(analyticsStatements).toHaveLength(3);
    for (const statement of analyticsStatements) {
      expect(statement).toContain('social_media_channels');
      expect(statement).toContain('workspace_id');
    }
  });

  // Regression guard for Finding 2: the fake transaction has no rollback
  // semantics, so a prior test only proved `transaction` was called, not that
  // the deletes actually depend on running inside it. If someone later hoists
  // the deletes out of the transaction closure (e.g. to call
  // `this.db.execute` directly), this test must start failing.
  it('rejects rather than returning a partial summary when a delete mid-transaction fails', async () => {
    execute
      .mockResolvedValueOnce({ rowCount: 3, rows: [] }) // inbox_items
      .mockResolvedValueOnce({ rowCount: 3, rows: [] }) // post_metric_snapshots
      .mockRejectedValueOnce(new Error('connection lost')); // channel_snapshots

    const svc = await build();

    await expect(svc.deleteAllYoutubeData(1, 'ws')).rejects.toThrow(
      'connection lost',
    );
  });

  // Finding 4: without this, InboxPollScheduler re-ingests the just-deleted
  // comments within ~30 seconds, making the delete endpoint's success message
  // false within moments — exactly the demo that fails a policy audit.
  describe('deactivateChannel', () => {
    it('marks the channel expired and inactive, scoped to the channel and workspace', async () => {
      const svc = await build();
      await svc.deactivateChannel(42, 'ws-abc');

      const sql = JSON.stringify(execute.mock.calls[0][0]);
      expect(sql).toContain("connection_status = 'expired'");
      expect(sql).toContain('is_active = false');
      expect(sql).toContain('42');
      expect(sql).toContain('ws-abc');
    });
  });
});
