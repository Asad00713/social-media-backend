import {
  UNLIMITED_HISTORY,
  clampHistory,
  periodOf,
  type ResolvedPeriod,
} from './query';

/**
 * The plan limits how far BACK Insights reads, so a clamp may only move the
 * start of the window. These tests exist mostly to pin that: moving the end,
 * or substituting "the last N days", answers a different question than the one
 * asked and the resulting chart still looks right, which is the dangerous kind
 * of wrong.
 */

// A fixed "today" so the expectations are dates, not arithmetic.
const TODAY = new Date(Date.UTC(2026, 10, 24)); // 2026-11-24

/**
 * `TODAY` is passed to `periodOf` as well as to `clampHistory`.
 *
 * It used to be given only to `clampHistory`, while `periodOf` read the real
 * clock — so the two disagreed about what day it was, and every expectation
 * here held for exactly one day. These tests passed when written and failed
 * the following morning.
 */
function preset(days: '7' | '30' | '90'): ResolvedPeriod {
  return periodOf(days, undefined, undefined, TODAY);
}

describe('clampHistory', () => {
  it('leaves a window the plan allows exactly as it is', () => {
    const p = preset('7');
    const out = clampHistory(p, 30, TODAY);
    expect(out.window).toEqual(p.window);
    expect(out.days).toBe(p.days);
    // Null, not 30: nothing was taken away, so the UI must say nothing.
    expect(out.limitedTo).toBeNull();
  });

  it('does not touch a window on an unlimited plan', () => {
    const p = preset('90');
    const out = clampHistory(p, UNLIMITED_HISTORY, TODAY);
    expect(out.window).toEqual(p.window);
    expect(out.limitedTo).toBeNull();
  });

  it('moves only the START when the window reaches too far back', () => {
    // Free asks for 90 days with 7 days of history. The end must stay at
    // yesterday — a window of "the last 7 days" and a window "ending
    // yesterday, starting 7 days ago" happen to agree here, which is why the
    // custom-range test below matters more.
    const out = clampHistory(preset('90'), 7, TODAY);
    expect(out.window.to).toBe('2026-11-23');
    expect(out.window.from).toBe('2026-11-17');
    expect(out.limitedTo).toBe(7);
  });

  it('keeps the asked-for END on a custom range, moving the start up to the limit', () => {
    // The one that catches a "last N days" shortcut: this range ends in
    // September. Replacing it with the last 7 days would answer about
    // November and the chart would look perfectly healthy.
    const p = periodOf(undefined, '2026-09-01', '2026-09-30', TODAY);
    const out = clampHistory(p, 90, TODAY);
    expect(out.window.to).toBe('2026-09-30');
    // 90 days before 2026-11-24 is 2026-08-26, which is EARLIER than the
    // asked-for start, so nothing is clamped.
    expect(out.limitedTo).toBeNull();
    expect(out.window.from).toBe('2026-09-01');
  });

  it('clamps a custom range that starts before the plan can see', () => {
    const p = periodOf(undefined, '2026-09-01', '2026-11-20', TODAY);
    const out = clampHistory(p, 30, TODAY);
    // 30 days back from 2026-11-24 is 2026-10-25.
    expect(out.window.from).toBe('2026-10-25');
    // The end the caller asked for survives.
    expect(out.window.to).toBe('2026-11-20');
    expect(out.limitedTo).toBe(30);
    // 2026-10-25 .. 2026-11-20 inclusive.
    expect(out.days).toBe(27);
  });

  it('collapses a window entirely older than the plan to its oldest readable day', () => {
    // Without this the clamp would produce `from` AFTER `to`, and a reversed
    // range reaches SQL as a BETWEEN that silently matches nothing — an empty
    // chart with no explanation.
    const p = periodOf(undefined, '2026-01-01', '2026-01-31', TODAY);
    const out = clampHistory(p, 7, TODAY);
    expect(out.window.from).toBe('2026-11-17');
    expect(out.window.to).toBe('2026-11-17');
    expect(out.days).toBe(1);
    expect(out.limitedTo).toBe(7);
    // The invariant that matters: never inverted.
    expect(out.window.from <= out.window.to).toBe(true);
  });

  it('counts the limit inclusively, so 7 days of history reaches back 7 days', () => {
    // Off by one here would give a plan 8 days or 6. 2026-11-17 .. 2026-11-23
    // is 7 days counted inclusively.
    const out = clampHistory(preset('90'), 7, TODAY);
    expect(out.days).toBe(7);
  });

  it('treats a zero or missing history value as no limit, not as zero days', () => {
    // A plan row whose features JSONB has no `insightsHistoryDays` resolves to
    // 0 at the caller. Reading that as "zero days of history" would blank
    // Insights for everyone on that plan — the failure mode has to be
    // permissive here, the same way the plan guard fails open on an error.
    const p = preset('90');
    for (const value of [0, undefined as unknown as number]) {
      const out = clampHistory(p, value, TODAY);
      expect(out.window).toEqual(p.window);
      expect(out.limitedTo).toBeNull();
    }
  });
});
