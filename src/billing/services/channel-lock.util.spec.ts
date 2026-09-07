import { planChannelLocks, LockableChannel } from './channel-lock.util';

const at = (iso: string) => new Date(iso);

/** Five channels, oldest first, all currently usable. */
const CHANNELS: LockableChannel[] = [
  { id: 1, createdAt: at('2026-01-01T00:00:00Z'), isActive: true },
  { id: 2, createdAt: at('2026-02-01T00:00:00Z'), isActive: true },
  { id: 3, createdAt: at('2026-03-01T00:00:00Z'), isActive: true },
  { id: 4, createdAt: at('2026-04-01T00:00:00Z'), isActive: true },
  { id: 5, createdAt: at('2026-05-01T00:00:00Z'), isActive: true },
];

describe('planChannelLocks', () => {
  it('locks nothing when everything already fits', () => {
    expect(planChannelLocks(CHANNELS, 5)).toEqual({
      keep: [1, 2, 3, 4, 5],
      lock: [],
      unlock: [],
    });
  });

  it('keeps the oldest and locks the newest when the ceiling drops', () => {
    const plan = planChannelLocks(CHANNELS, 3);
    expect(plan.keep).toEqual([1, 2, 3]);
    expect(plan.lock).toEqual([4, 5]);
    expect(plan.unlock).toEqual([]);
  });

  it('ignores the order channels arrive in', () => {
    const shuffled = [CHANNELS[3], CHANNELS[0], CHANNELS[4], CHANNELS[1], CHANNELS[2]];
    expect(planChannelLocks(shuffled, 3).keep).toEqual([1, 2, 3]);
  });

  it('breaks a createdAt tie by id so the answer is stable', () => {
    const sameInstant: LockableChannel[] = [
      { id: 9, createdAt: at('2026-01-01T00:00:00Z'), isActive: true },
      { id: 3, createdAt: at('2026-01-01T00:00:00Z'), isActive: true },
      { id: 7, createdAt: at('2026-01-01T00:00:00Z'), isActive: true },
    ];
    expect(planChannelLocks(sameInstant, 2).keep).toEqual([3, 7]);
    // Same answer whichever order they arrive in.
    expect(planChannelLocks([...sameInstant].reverse(), 2).keep).toEqual([3, 7]);
  });

  it('releases locked channels that fit again after an upgrade', () => {
    const partlyLocked: LockableChannel[] = [
      { id: 1, createdAt: at('2026-01-01T00:00:00Z'), isActive: true },
      { id: 2, createdAt: at('2026-02-01T00:00:00Z'), isActive: false },
      { id: 3, createdAt: at('2026-03-01T00:00:00Z'), isActive: false },
    ];
    const plan = planChannelLocks(partlyLocked, 3);
    expect(plan.unlock).toEqual([2, 3]);
    expect(plan.lock).toEqual([]);
  });

  it('releases everything when the limit is unlimited', () => {
    const allLocked = CHANNELS.map((c) => ({ ...c, isActive: false }));
    const plan = planChannelLocks(allLocked, -1);
    expect(plan.unlock).toEqual([1, 2, 3, 4, 5]);
    expect(plan.lock).toEqual([]);
  });

  it('locks everything at a zero limit', () => {
    const plan = planChannelLocks(CHANNELS, 0);
    expect(plan.keep).toEqual([]);
    expect(plan.lock).toEqual([1, 2, 3, 4, 5]);
  });

  // Re-running the plan over its own result must be a no-op, otherwise a
  // repeated webhook would churn channels in and out of the locked state.
  it('is idempotent', () => {
    const first = planChannelLocks(CHANNELS, 3);
    const applied = CHANNELS.map((c) => ({
      ...c,
      isActive: !first.lock.includes(c.id),
    }));
    const second = planChannelLocks(applied, 3);
    expect(second.lock).toEqual([]);
    expect(second.unlock).toEqual([]);
  });

  it('does not re-lock a channel that is already locked', () => {
    const alreadyLocked: LockableChannel[] = [
      { id: 1, createdAt: at('2026-01-01T00:00:00Z'), isActive: true },
      { id: 2, createdAt: at('2026-02-01T00:00:00Z'), isActive: false },
    ];
    expect(planChannelLocks(alreadyLocked, 1).lock).toEqual([]);
  });

  it('handles an account with no channels', () => {
    expect(planChannelLocks([], 3)).toEqual({ keep: [], lock: [], unlock: [] });
  });

  it('treats a null isActive as usable', () => {
    const nullActive: LockableChannel[] = [
      { id: 1, createdAt: at('2026-01-01T00:00:00Z'), isActive: null },
      { id: 2, createdAt: at('2026-02-01T00:00:00Z'), isActive: null },
    ];
    expect(planChannelLocks(nullActive, 1).lock).toEqual([2]);
  });
});
