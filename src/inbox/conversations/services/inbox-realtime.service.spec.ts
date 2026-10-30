import { Logger } from '@nestjs/common';
import { InboxRealtimeService } from './inbox-realtime.service';
import { computeLegacyCounts } from '../../legacy-counts';

jest.mock('../../legacy-counts', () => ({
  computeLegacyCounts: jest.fn(),
}));

const WS = 'ws-1';
const legacy = {
  perChannel: [{ channelId: 1, comments: 2, dms: 3 }],
  smartFolders: { all: 1, unread: 1, needs_reply: 0, done: 0 },
  total: 5,
};
const counts = {
  toReply: 4,
  later: 1,
  scheduled: 0,
  answeredToday: { total: 0, by: [] },
};

/** Advance fake time, then let the flush's awaited queries settle. */
async function tick(ms: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('InboxRealtimeService', () => {
  let emitter: { emit: jest.Mock };
  let presenter: { loadRows: jest.Mock; counts: jest.Mock };
  let db: { execute: jest.Mock };
  let archived: Map<string, string | null>;
  let service: InboxRealtimeService;
  let logError: jest.SpyInstance;

  const emitted = (name: string) =>
    (
      emitter.emit.mock.calls as [string, string, Record<string, unknown>][]
    ).filter((c) => c[1] === name);

  beforeEach(() => {
    jest.useFakeTimers();
    logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    emitter = { emit: jest.fn() };
    archived = new Map();
    presenter = {
      loadRows: jest.fn((ws: string, ids: string[]) =>
        Promise.resolve(ids.map((id) => ({ id }))),
      ),
      counts: jest.fn().mockResolvedValue(counts),
    };
    // The flush selects archived_at for the id; a missing key = row gone.
    db = {
      execute: jest.fn((q: { queryChunks: unknown[] }) => {
        // drizzle keeps interpolated strings raw in queryChunks.
        const id = q.queryChunks.find(
          (v): v is string => typeof v === 'string' && /^c[0-9]+$/.test(v),
        );
        const known = id !== undefined && archived.has(id);
        return Promise.resolve({
          rows: known ? [{ archived_at: archived.get(id) }] : [],
        });
      }),
    };
    (computeLegacyCounts as jest.Mock).mockResolvedValue(legacy);
    service = new InboxRealtimeService(
      emitter as never,
      presenter as never,
      db as never,
    );
    archived.set('c1', null);
    archived.set('c2', null);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('conversationChanged', () => {
    it('collapses 400 calls inside 250 ms into one upserted after 300 ms', async () => {
      for (let i = 0; i < 400; i++) {
        service.conversationChanged(WS, 'c1');
        if (i % 2 === 1) await tick(1); // ~200ms total
      }
      // The loop ends at 200 ms; the last call was at 199 ms.
      await tick(298);
      expect(emitted('inbox.conversation.upserted')).toHaveLength(0);
      await tick(1);
      const ups = emitted('inbox.conversation.upserted');
      expect(ups).toHaveLength(1);
      expect(ups[0]).toEqual([
        WS,
        'inbox.conversation.upserted',
        { workspaceId: WS, row: { id: 'c1' } },
      ]);
      expect(presenter.loadRows).toHaveBeenCalledTimes(1);
    });

    it('debounces per conversation id', async () => {
      service.conversationChanged(WS, 'c1');
      service.conversationChanged(WS, 'c2');
      await tick(300);
      expect(emitted('inbox.conversation.upserted')).toHaveLength(2);
    });

    it('emits removed when the row is archived', async () => {
      archived.set('c1', '2026-10-20T00:00:00Z');
      service.conversationChanged(WS, 'c1');
      await tick(300);
      expect(emitted('inbox.conversation.upserted')).toHaveLength(0);
      expect(emitted('inbox.conversation.removed')[0][2]).toEqual({
        workspaceId: WS,
        id: 'c1',
      });
    });

    it('emits removed when the row is gone', async () => {
      service.conversationChanged(WS, 'c9');
      await tick(300);
      expect(emitted('inbox.conversation.removed')).toHaveLength(1);
    });
  });

  describe('conversationRemoved', () => {
    it('emits removed immediately and cancels a pending upsert', async () => {
      service.conversationChanged(WS, 'c1');
      service.conversationRemoved(WS, 'c1');
      expect(emitted('inbox.conversation.removed')).toHaveLength(1);
      await tick(1000);
      expect(emitted('inbox.conversation.upserted')).toHaveLength(0);
      expect(emitted('inbox.conversation.removed')).toHaveLength(1);
    });
  });

  describe('timelineAppended', () => {
    const entry = { kind: 'message', id: 'm1' } as never;

    it('emits an append that carries its entry immediately', () => {
      service.timelineAppended(WS, 'c1', entry, null);
      expect(emitter.emit).toHaveBeenCalledWith(WS, 'inbox.timeline.appended', {
        workspaceId: WS,
        conversationId: 'c1',
        entry,
        commentId: null,
      });
    });

    it('debounces a lone entry-less append 300 ms and keeps its commentId', async () => {
      service.timelineAppended(WS, 'c1', null, 'cm1');
      await tick(299);
      expect(emitted('inbox.timeline.appended')).toHaveLength(0);
      await tick(1);
      expect(emitted('inbox.timeline.appended')).toEqual([
        [
          WS,
          'inbox.timeline.appended',
          {
            workspaceId: WS,
            conversationId: 'c1',
            entry: null,
            commentId: 'cm1',
          },
        ],
      ]);
    });

    it('collapses a 400-comment burst into one refetch signal per conversation (I3)', async () => {
      for (let i = 0; i < 400; i++) {
        service.timelineAppended(WS, 'c1', null, `cm${i}`);
        if (i % 2 === 1) await tick(1); // ~200 ms of webhook burst
      }
      service.timelineAppended(WS, 'c2', null, 'other');
      await tick(300);
      const out = emitted('inbox.timeline.appended');
      expect(out).toHaveLength(2);
      expect(out.find((c) => c[2].conversationId === 'c1')![2]).toEqual({
        workspaceId: WS,
        conversationId: 'c1',
        entry: null,
        commentId: null,
      });
      expect(out.find((c) => c[2].conversationId === 'c2')![2]).toMatchObject({
        commentId: 'other',
      });
      await tick(1000);
      expect(emitted('inbox.timeline.appended')).toHaveLength(2);
    });

    it('an entry in the middle of a burst still goes out at once', async () => {
      service.timelineAppended(WS, 'c1', null, 'cm1');
      service.timelineAppended(WS, 'c1', entry, null);
      expect(emitted('inbox.timeline.appended')).toHaveLength(1);
      await tick(300);
      expect(emitted('inbox.timeline.appended')).toHaveLength(2);
    });
  });

  describe('countsChanged', () => {
    it('debounces 500 ms, max wait 2000 ms, then once more after calls stop', async () => {
      for (let t = 0; t < 3000; t += 100) {
        service.countsChanged(WS);
        await tick(100);
      }
      // The max wait forced one flush at 2000 ms.
      expect(emitted('inbox.conversation.counts.changed')).toHaveLength(1);
      // The last call was at 2900 ms; the trailing flush is due at 3400 ms.
      await tick(399);
      expect(emitted('inbox.conversation.counts.changed')).toHaveLength(1);
      await tick(1);
      expect(emitted('inbox.conversation.counts.changed')).toHaveLength(2);
      await tick(5000);
      expect(emitted('inbox.conversation.counts.changed')).toHaveLength(2);
    });

    it('emits both events with exactly their payloads', async () => {
      service.countsChanged(WS);
      await tick(500);
      expect(emitted('inbox.conversation.counts.changed')[0][2]).toStrictEqual({
        workspaceId: WS,
        counts,
      });
      const old = emitted('inbox.counts.changed')[0][2];
      expect(old).toStrictEqual({
        workspaceId: WS,
        perChannel: legacy.perChannel,
        smartFolders: legacy.smartFolders,
      });
      expect(old).not.toHaveProperty('counts');
    });
  });

  it('logs a failing flush and still serves the next one', async () => {
    presenter.counts.mockRejectedValueOnce(new Error('boom'));
    service.countsChanged(WS);
    await tick(500);
    expect(logError).toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
    service.countsChanged(WS);
    await tick(500);
    expect(emitted('inbox.conversation.counts.changed')).toHaveLength(1);

    presenter.loadRows.mockRejectedValueOnce(new Error('boom'));
    service.conversationChanged(WS, 'c1');
    await tick(300);
    service.conversationChanged(WS, 'c1');
    await tick(300);
    expect(emitted('inbox.conversation.upserted')).toHaveLength(1);
  });

  describe('stale flushes', () => {
    const deferred = <T>() => {
      let resolve!: (v: T) => void;
      const promise = new Promise<T>((r) => (resolve = r));
      return { promise, resolve };
    };

    it('drops an in-flight upsert when the conversation is removed meanwhile', async () => {
      const late = deferred<{ id: string }[]>();
      presenter.loadRows.mockReturnValueOnce(late.promise);
      service.conversationChanged(WS, 'c1');
      await tick(300); // flush is now awaiting loadRows
      service.conversationRemoved(WS, 'c1');
      late.resolve([{ id: 'c1' }]);
      await tick(0);
      expect(emitted('inbox.conversation.upserted')).toHaveLength(0);
      expect(emitted('inbox.conversation.removed')).toHaveLength(1);
    });

    it('lets only the newer of two overlapping flushes emit', async () => {
      const slow = deferred<{ id: string; v: string }[]>();
      presenter.loadRows
        .mockReturnValueOnce(slow.promise)
        .mockResolvedValueOnce([{ id: 'c1', v: 'new' }]);
      service.conversationChanged(WS, 'c1');
      await tick(300); // flush 1 in flight
      service.conversationChanged(WS, 'c1');
      await tick(300); // flush 2 completes
      slow.resolve([{ id: 'c1', v: 'old' }]);
      await tick(0);
      const ups = emitted('inbox.conversation.upserted');
      expect(ups).toHaveLength(1);
      expect(ups[0][2]).toEqual({
        workspaceId: WS,
        row: { id: 'c1', v: 'new' },
      });
    });

    it('lets only the newer of two overlapping counts flushes emit', async () => {
      const slow = deferred<typeof counts>();
      presenter.counts
        .mockReturnValueOnce(slow.promise)
        .mockResolvedValueOnce({ ...counts, toReply: 99 });
      service.countsChanged(WS);
      await tick(500); // flush 1 in flight
      service.countsChanged(WS);
      await tick(500); // flush 2 completes
      slow.resolve(counts);
      await tick(0);
      const out = emitted('inbox.conversation.counts.changed');
      expect(out).toHaveLength(1);
      expect(out[0][2]).toMatchObject({ counts: { toReply: 99 } });
      expect(emitted('inbox.counts.changed')).toHaveLength(1);
    });

    it('keeps no per-conversation or per-workspace state once flushes are done', async () => {
      const late = deferred<{ id: string }[]>();
      presenter.loadRows.mockReturnValueOnce(late.promise);
      service.conversationChanged(WS, 'c1');
      await tick(300);
      service.conversationRemoved(WS, 'c1');
      late.resolve([{ id: 'c1' }]);
      service.conversationChanged(WS, 'c2');
      service.countsChanged(WS);
      service.timelineAppended(WS, 'c2', null, 'cm1');
      await tick(600);
      const state = service as unknown as Record<string, Map<string, unknown>>;
      for (const m of Object.values(state)) {
        if (m instanceof Map) expect(m.size).toBe(0);
      }
    });
  });
});
