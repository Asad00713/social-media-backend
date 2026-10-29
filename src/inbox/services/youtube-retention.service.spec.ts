import { Test } from '@nestjs/testing';
import {
  YoutubeRetentionService,
  YOUTUBE_RETENTION_DAYS,
} from './youtube-retention.service';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { ConversationResyncService } from '../conversations/services/conversation-resync.service';

const sync = { syncOrEnqueue: jest.fn().mockResolvedValue(undefined) };

const execute = jest.fn();
const fakeDb = { execute };

async function build() {
  const mod = await Test.createTestingModule({
    providers: [
      YoutubeRetentionService,
      { provide: DRIZZLE, useValue: fakeDb },
      { provide: ConversationResyncService, useValue: sync },
    ],
  }).compile();
  return mod.get(YoutubeRetentionService);
}

/** The SQL the service built, flattened to one searchable string. */
function sqlText(): string {
  const arg = execute.mock.calls[0][0];
  return JSON.stringify(arg);
}

describe('YoutubeRetentionService', () => {
  beforeEach(() => {
    execute.mockReset();
    execute.mockResolvedValue({ rowCount: 0, rows: [] });
  });

  it('retains for 30 days', () => {
    expect(YOUTUBE_RETENTION_DAYS).toBe(30);
  });

  it('reports how many rows it wiped', async () => {
    execute.mockResolvedValue({ rowCount: 7, rows: [] });
    const svc = await build();
    const result = await svc.wipeExpiredContent(new Date('2026-07-18T00:00:00Z'));
    expect(result.wiped).toBe(7);
  });

  // The spec's top risk is the window being wrong. Assert the real cutoff value
  // rather than string-matching a serialized SQL object, which is brittle.
  it('computes the cutoff exactly 30 days before the supplied clock', async () => {
    const svc = await build();
    const result = await svc.wipeExpiredContent(new Date('2026-07-18T00:00:00Z'));
    expect(result.cutoff.toISOString()).toBe('2026-06-18T00:00:00.000Z');
  });

  // The single most destructive way to get this wrong: this obligation is
  // YouTube's, and applying it to other platforms would delete their users'
  // comments for no reason.
  it('scopes the wipe to youtube only', async () => {
    const svc = await build();
    await svc.wipeExpiredContent(new Date('2026-07-18T00:00:00Z'));
    expect(sqlText()).toContain('youtube');
  });

  // The spec's top risk: measuring from row-insert time deletes comments early
  // and, on a backfill, deletes fresh ones.
  //
  // Note the negative assertion cannot be `not.toContain('created_at')` —
  // "platform_created_at" contains that substring, so such a test would fail
  // against a CORRECT implementation. Assert on the bare column with a word
  // boundary instead.
  it('measures the window from the comment timestamp, not the row insert time', async () => {
    const svc = await build();
    await svc.wipeExpiredContent(new Date('2026-07-18T00:00:00Z'));
    const sql = sqlText();
    expect(sql).toContain('platform_created_at');
    expect(/[^_]created_at/.test(sql)).toBe(false);
  });

  it('nulls every identifying column and nothing else', async () => {
    const svc = await build();
    await svc.wipeExpiredContent(new Date('2026-07-18T00:00:00Z'));
    const sql = sqlText();
    for (const col of [
      'text',
      'author_display_name',
      'author_avatar_url',
      'author_handle',
      'author_platform_id',
    ]) {
      expect(sql).toContain(col);
    }
    // The row and its non-identifying fields survive — this is a wipe, not a delete.
    expect(sql).toContain('UPDATE');
    expect(sql).not.toContain('DELETE');
  });

  // YoutubeInboxAdapter stores the same channel id as a URL under
  // metadata.authorChannelUrl (src/inbox/adapters/youtube-inbox.adapter.ts).
  // Nulling author_platform_id but leaving that key in the surviving jsonb
  // would leave the commenter fully identifiable — the whole point of this
  // job would be defeated.
  it('also strips metadata.authorChannelUrl, and selects rows that carry only that key', async () => {
    const svc = await build();
    await svc.wipeExpiredContent(new Date('2026-07-18T00:00:00Z'));
    const sql = sqlText();
    expect(sql).toContain("metadata = metadata - 'authorChannelUrl'");
    expect(sql).toContain("metadata ? 'authorChannelUrl'");
  });

  // Analytics is III.E.4.b data and may be kept indefinitely. Touching those
  // tables here would destroy the analytics product for no policy reason.
  it('never touches the analytics tables', async () => {
    const svc = await build();
    await svc.wipeExpiredContent(new Date('2026-07-18T00:00:00Z'));
    const sql = sqlText();
    expect(sql).not.toContain('channel_snapshots');
    expect(sql).not.toContain('channel_analytics_daily');
    expect(sql).not.toContain('post_metric_snapshots');
  });

  // Already-wiped rows must not be re-counted on every run, or the log line
  // reports the same rows as newly wiped forever.
  it('skips rows whose content is already wiped', async () => {
    const svc = await build();
    await svc.wipeExpiredContent(new Date('2026-07-18T00:00:00Z'));
    expect(sqlText()).toContain('IS NOT NULL');
  });

  it('re-syncs the affected conversations once per workspace after the wipe', async () => {
    sync.syncOrEnqueue.mockClear();
    execute.mockResolvedValueOnce({
      rowCount: 3,
      rows: [
        { workspace_id: 'w1', thread_key: '1:v1' },
        { workspace_id: 'w1', thread_key: '1:v1' },
        { workspace_id: 'w2', thread_key: '2:v2' },
      ],
    });
    const svc = await build();
    await svc.wipeExpiredContent(new Date('2026-07-18T00:00:00Z'));
    expect(sync.syncOrEnqueue).toHaveBeenCalledTimes(2);
    expect(sync.syncOrEnqueue).toHaveBeenCalledWith('w1', new Set(['1:v1']));
    expect(sync.syncOrEnqueue).toHaveBeenCalledWith('w2', new Set(['2:v2']));
  });

  it('also re-syncs stale conversations whose items were already wiped (self-heal)', async () => {
    sync.syncOrEnqueue.mockClear();
    execute
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rows: [{ workspace_id: 'w1', thread_key: '1:old' }],
      });
    const svc = await build();
    const res = await svc.wipeExpiredContent(new Date('2026-07-18T00:00:00Z'));
    expect(res.wiped).toBe(0);
    expect(sync.syncOrEnqueue).toHaveBeenCalledWith('w1', new Set(['1:old']));
    expect(JSON.stringify(execute.mock.calls[1][0])).toContain(
      'inbox_conversations',
    );
  });
});
