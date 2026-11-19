import {
  SWEEP_INTERVAL_MS,
  selectDmConversationsToFetch,
} from './dm-poll-window';

const NOW = new Date('2026-11-19T12:00:00Z');
const at = (iso: string) => new Date(iso);
const convo = (id: string, iso: string) => ({
  conversationId: id,
  lastMessageAt: at(iso),
});

describe('selectDmConversationsToFetch', () => {
  const since = at('2026-11-19T11:59:00Z');
  const sweptRecently = at('2026-11-19T11:30:00Z');

  it('fetches a conversation with a message newer than the cursor', () => {
    const r = selectDmConversationsToFetch(
      [convo('a', '2026-11-19T11:59:30Z')],
      since,
      sweptRecently,
      NOW,
    );
    expect(r.fetch.map((c) => c.conversationId)).toEqual(['a']);
    expect(r.skipped).toBe(0);
  });

  it('skips a conversation with nothing newer than the cursor', () => {
    const r = selectDmConversationsToFetch(
      [convo('quiet', '2026-11-19T10:00:00Z')],
      since,
      sweptRecently,
      NOW,
    );
    expect(r.fetch).toEqual([]);
    expect(r.skipped).toBe(1);
  });

  // This is the bug: three quiet conversations cost SIX Instagram calls every
  // 30 seconds and produced ~4,500 `Application request limit reached` rows.
  it('skips the quiet conversations that caused the rate-limit loop', () => {
    const r = selectDmConversationsToFetch(
      [
        convo('27878330625200802:1371521918215205', '2026-11-10T09:00:00Z'),
        convo('27878330625200802:1648812916204689', '2026-11-11T09:00:00Z'),
        convo('27878330625200802:1466218648050371', '2026-11-12T09:00:00Z'),
        convo('live', '2026-11-19T11:59:30Z'),
      ],
      since,
      sweptRecently,
      NOW,
    );
    expect(r.fetch.map((c) => c.conversationId)).toEqual(['live']);
    expect(r.skipped).toBe(3);
  });

  // Pins `>` vs `>=`. With `>=`, a conversation sitting exactly on the cursor
  // is re-fetched every single cycle — which is the loop, reintroduced.
  it('skips a conversation whose last message is exactly on the cursor', () => {
    const r = selectDmConversationsToFetch(
      [convo('boundary', since.toISOString())],
      since,
      sweptRecently,
      NOW,
    );
    expect(r.fetch).toEqual([]);
    expect(r.skipped).toBe(1);
  });

  describe('never losing a message', () => {
    it('fetches everything on a first poll, when there is no cursor', () => {
      const r = selectDmConversationsToFetch(
        [convo('a', '2026-01-01T00:00:00Z'), convo('b', '2026-01-02T00:00:00Z')],
        null,
        null,
        NOW,
      );
      expect(r.fetch).toHaveLength(2);
      expect(r.skipped).toBe(0);
    });

    // The safety net. If the platform ever fails to advance lastMessageAt, a
    // real message would otherwise sit unread forever.
    it('sweeps every conversation once the sweep interval has elapsed', () => {
      const stale = new Date(NOW.getTime() - SWEEP_INTERVAL_MS);
      const r = selectDmConversationsToFetch(
        [convo('quiet', '2026-11-01T00:00:00Z')],
        since,
        stale,
        NOW,
      );
      expect(r.fetch.map((c) => c.conversationId)).toEqual(['quiet']);
      expect(r.skipped).toBe(0);
    });

    it('sweeps when the channel has never swept', () => {
      const r = selectDmConversationsToFetch(
        [convo('quiet', '2026-11-01T00:00:00Z')],
        since,
        null,
        NOW,
      );
      expect(r.fetch).toHaveLength(1);
    });

    it('does not sweep one millisecond early', () => {
      const almost = new Date(NOW.getTime() - SWEEP_INTERVAL_MS + 1);
      const r = selectDmConversationsToFetch(
        [convo('quiet', '2026-11-01T00:00:00Z')],
        since,
        almost,
        NOW,
      );
      expect(r.fetch).toEqual([]);
      expect(r.skipped).toBe(1);
    });
  });

  it('handles an empty conversation list', () => {
    const r = selectDmConversationsToFetch([], since, sweptRecently, NOW);
    expect(r.fetch).toEqual([]);
    expect(r.skipped).toBe(0);
  });

  it('keeps the sweep interval at one hour', () => {
    expect(SWEEP_INTERVAL_MS).toBe(60 * 60 * 1000);
  });
});
