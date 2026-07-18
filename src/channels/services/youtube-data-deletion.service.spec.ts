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
});
