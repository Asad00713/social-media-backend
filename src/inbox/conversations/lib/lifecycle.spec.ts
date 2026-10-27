import {
  applyLifecycle,
  type LifecycleState,
  type SyncIntent,
  type ThreadFacts,
} from './lifecycle';

const t1 = new Date('2026-10-26T10:00:00.000Z');
const t2 = new Date('2026-10-26T11:00:00.000Z');
const t3 = new Date('2026-10-26T12:00:00.000Z');
const t4 = new Date('2026-10-26T13:00:00.000Z');
const now = new Date('2026-10-26T15:00:00.000Z');

const state = (o: Partial<LifecycleState> = {}): LifecycleState => ({
  status: 'to_reply',
  laterUntil: null,
  laterUntilReply: false,
  doneByUserId: null,
  doneAt: null,
  doneVia: null,
  assigneeUserId: null,
  assignedByUserId: null,
  assignedAt: null,
  lastInboundAt: t1,
  lastOutboundAt: null,
  ...o,
});
const facts = (o: Partial<ThreadFacts> = {}): ThreadFacts => ({
  kind: 'dm',
  lastInboundAt: t1,
  lastOutboundAt: null,
  lastPlatformOutboundAt: null,
  unansweredInbound: 1,
  openLegacyInbound: 1,
  ...o,
});
const doneReply = (o: Partial<LifecycleState> = {}) =>
  state({
    status: 'done',
    doneVia: 'reply',
    doneByUserId: 'u1',
    doneAt: t1,
    ...o,
  });
const refresh: SyncIntent = { kind: 'refresh' };
const noDone = { doneByUserId: null, doneAt: null, doneVia: null };

describe('applyLifecycle', () => {
  it('1. newer inbound reopens a done thread', () => {
    const r = applyLifecycle(
      doneReply(),
      facts({ lastInboundAt: t2 }),
      refresh,
      now,
    );
    expect(r.next).toMatchObject({ status: 'to_reply', ...noDone });
    expect(r.reopened).toBe(true);
    expect(r.next.lastInboundAt).toEqual(t2);
  });

  it('2. newer inbound wakes a later(untilReply)', () => {
    const prev = state({ status: 'later', laterUntilReply: true });
    const r = applyLifecycle(prev, facts({ lastInboundAt: t2 }), refresh, now);
    expect(r.next).toMatchObject({
      status: 'to_reply',
      laterUntil: null,
      laterUntilReply: false,
    });
    expect(r.reopened).toBe(true);
  });

  it('3. newer inbound keeps a timed later', () => {
    const prev = state({ status: 'later', laterUntil: t3 });
    const r = applyLifecycle(prev, facts({ lastInboundAt: t2 }), refresh, now);
    expect(r.next.status).toBe('later');
    expect(r.next.laterUntil).toEqual(t3);
  });

  it('4. same lastInboundAt stays done', () => {
    const r = applyLifecycle(doneReply(), facts(), refresh, now);
    expect(r.next.status).toBe('done');
    expect(r.reopened).toBe(false);
  });

  it('5. platform reply closes the thread', () => {
    const r = applyLifecycle(
      state(),
      facts({
        lastPlatformOutboundAt: t2,
        lastOutboundAt: t2,
        unansweredInbound: 0,
      }),
      refresh,
      now,
    );
    expect(r.next).toMatchObject({
      status: 'done',
      doneVia: 'platform',
      doneByUserId: null,
      doneAt: t2,
    });
  });

  it('6. platform reply on a comment thread with unanswered stays open', () => {
    const r = applyLifecycle(
      state(),
      facts({
        kind: 'comment_thread',
        lastPlatformOutboundAt: t2,
        lastOutboundAt: t2,
        unansweredInbound: 1,
      }),
      refresh,
      now,
    );
    expect(r.next.status).toBe('to_reply');
  });

  it('7. dm outbound markDone closes', () => {
    const r = applyLifecycle(
      state(),
      facts({ lastOutboundAt: t2 }),
      { kind: 'outbound', userId: 'u1', markDone: true, at: t2 },
      now,
    );
    expect(r.next).toMatchObject({
      status: 'done',
      doneVia: 'reply',
      doneByUserId: 'u1',
      doneAt: t2,
    });
    expect(r.markedDone).toBe(true);
  });

  it('8. replying to one of five comments stays to_reply (R2)', () => {
    const r = applyLifecycle(
      state(),
      facts({
        kind: 'comment_thread',
        unansweredInbound: 4,
        lastOutboundAt: t2,
      }),
      { kind: 'outbound', userId: 'u1', markDone: true, at: t2 },
      now,
    );
    expect(r.next.status).toBe('to_reply');
    expect(r.markedDone).toBe(false);
  });

  it('9. comment thread fully answered closes', () => {
    const r = applyLifecycle(
      state(),
      facts({
        kind: 'comment_thread',
        unansweredInbound: 0,
        lastOutboundAt: t2,
      }),
      { kind: 'outbound', userId: 'u1', markDone: true, at: t2 },
      now,
    );
    expect(r.next.status).toBe('done');
    expect(r.markedDone).toBe(true);
  });

  it('10. markDone false keeps status, takes lastOutboundAt from facts', () => {
    const r = applyLifecycle(
      state(),
      facts({ lastOutboundAt: t2 }),
      { kind: 'outbound', userId: 'u1', markDone: false, at: t2 },
      now,
    );
    expect(r.next.status).toBe('to_reply');
    expect(r.next.lastOutboundAt).toEqual(t2);
  });

  it('11. a newer inbound than the send keeps to_reply', () => {
    const r = applyLifecycle(
      state({ lastInboundAt: t3 }),
      facts({ lastInboundAt: t3, lastOutboundAt: t2 }),
      { kind: 'outbound', userId: 'u1', markDone: true, at: t2 },
      now,
    );
    expect(r.next.status).toBe('to_reply');
    expect(r.markedDone).toBe(false);
  });

  it('12. our own send overwrites a platform done', () => {
    const prev = state({ status: 'done', doneVia: 'platform', doneAt: t2 });
    const r = applyLifecycle(
      prev,
      facts({
        lastOutboundAt: t2,
        lastPlatformOutboundAt: t2,
        unansweredInbound: 0,
      }),
      { kind: 'outbound', userId: 'u1', markDone: true, at: t2 },
      now,
    );
    expect(r.next).toMatchObject({
      status: 'done',
      doneVia: 'reply',
      doneByUserId: 'u1',
    });
  });

  it.each([
    ['echo now carries an author', null, 'to_reply'],
    ['a real platform reply', t2, 'done'],
  ] as const)(
    '13. keep-open send over platform done: %s',
    (_n, plat, expected) => {
      const prev = state({
        status: 'done',
        doneVia: 'platform',
        doneAt: t2,
        lastOutboundAt: t2,
      });
      const r = applyLifecycle(
        prev,
        facts({
          lastOutboundAt: t2,
          lastPlatformOutboundAt: plat,
          unansweredInbound: 0,
        }),
        { kind: 'outbound', userId: 'u1', markDone: false, at: t2 },
        now,
      );
      expect(r.next.status).toBe(expected);
      if (expected === 'to_reply') expect(r.next).toMatchObject(noDone);
    },
  );

  it('14. manual status changes', () => {
    const done = applyLifecycle(
      state(),
      facts(),
      { kind: 'manual', userId: 'u1', status: 'done' },
      now,
    );
    expect(done.next).toMatchObject({
      status: 'done',
      doneVia: 'manual',
      doneByUserId: 'u1',
      doneAt: now,
    });
    const later = applyLifecycle(
      done.next,
      facts(),
      { kind: 'manual', userId: 'u1', status: 'later', laterUntil: t3 },
      now,
    );
    expect(later.next).toMatchObject({
      status: 'later',
      laterUntil: t3,
      ...noDone,
    });
    const back = applyLifecycle(
      later.next,
      facts(),
      { kind: 'manual', userId: 'u1', status: 'to_reply' },
      now,
    );
    expect(back.next).toMatchObject({
      status: 'to_reply',
      laterUntil: null,
      laterUntilReply: false,
    });
  });

  it('15. manual assignee', () => {
    const set = applyLifecycle(
      state(),
      facts(),
      { kind: 'manual', userId: 'u1', assignee: { userId: 'u2' } },
      now,
    );
    expect(set.next).toMatchObject({
      status: 'to_reply',
      assigneeUserId: 'u2',
      assignedByUserId: 'u1',
      assignedAt: now,
    });
    const cleared = applyLifecycle(
      set.next,
      facts(),
      { kind: 'manual', userId: 'u1', assignee: { userId: null } },
      now,
    );
    expect(cleared.next).toMatchObject({
      status: 'to_reply',
      assigneeUserId: null,
      assignedByUserId: null,
      assignedAt: null,
    });
  });

  it('16. legacy_status', () => {
    const closed = applyLifecycle(
      state(),
      facts({ openLegacyInbound: 0 }),
      { kind: 'legacy_status', userId: 'u1' },
      now,
    );
    expect(closed.next).toMatchObject({
      status: 'done',
      doneVia: 'manual',
      doneByUserId: 'u1',
    });
    const reopened = applyLifecycle(
      doneReply(),
      facts({ openLegacyInbound: 2 }),
      { kind: 'legacy_status', userId: 'u1' },
      now,
    );
    expect(reopened.next).toMatchObject({ status: 'to_reply', ...noDone });
  });

  it.each([
    ['matching later', state({ status: 'later', laterUntil: t3 }), 'to_reply'],
    ['different later', state({ status: 'later', laterUntil: t4 }), 'later'],
    ['done', doneReply(), 'done'],
  ] as const)('17. wake(t3) on %s', (_n, prev, expected) => {
    const r = applyLifecycle(
      prev,
      facts(),
      { kind: 'wake', laterUntil: t3 },
      now,
    );
    expect(r.next.status).toBe(expected);
    if (expected === 'to_reply') expect(r.next.laterUntil).toBeNull();
  });

  it('18. initial state', () => {
    const noInbound = facts({ lastInboundAt: null, lastOutboundAt: t2 });
    const out = applyLifecycle(
      null,
      noInbound,
      { kind: 'outbound', userId: 'u1', markDone: false, at: t2 },
      now,
    );
    expect(out.next).toMatchObject({
      status: 'done',
      doneVia: 'reply',
      doneByUserId: 'u1',
    });
    const plat = applyLifecycle(null, noInbound, refresh, now);
    expect(plat.next).toMatchObject({
      status: 'done',
      doneVia: 'platform',
      doneAt: t2,
    });
    expect(applyLifecycle(null, facts(), refresh, now).next.status).toBe(
      'to_reply',
    );
  });
});
