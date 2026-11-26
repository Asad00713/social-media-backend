import {
  isPaddleTerminal,
  mapPaddleStatus,
  PADDLE_TERMINAL_STATUSES,
} from './paddle-status.util';

describe('mapPaddleStatus', () => {
  it('maps the five documented statuses', () => {
    expect(mapPaddleStatus('active')).toEqual({
      status: 'active',
      cancelAtPeriodEnd: false,
    });
    expect(mapPaddleStatus('trialing')).toEqual({
      status: 'trialing',
      cancelAtPeriodEnd: false,
    });
    expect(mapPaddleStatus('past_due')).toEqual({
      status: 'past_due',
      cancelAtPeriodEnd: false,
    });
    expect(mapPaddleStatus('paused')).toEqual({
      status: 'paused',
      cancelAtPeriodEnd: false,
    });
    expect(mapPaddleStatus('canceled')).toEqual({
      status: 'canceled',
      cancelAtPeriodEnd: false,
    });
  });

  it('reads a pending cancellation off the SCHEDULED CHANGE, not the status', () => {
    // This is the whole difference from Lemon Squeezy. Paddle keeps a
    // cancelled-at-period-end subscription `active` and records the intent in
    // `scheduled_change`; reading the status alone would leave
    // `cancelAtPeriodEnd` false, so the billing page would show no end date
    // and the customer would have no sign their cancellation registered.
    expect(mapPaddleStatus('active', { action: 'cancel' })).toEqual({
      status: 'active',
      cancelAtPeriodEnd: true,
    });
  });

  it('does not treat a scheduled PAUSE as a cancellation', () => {
    // `scheduled_change.action` is also 'pause' and 'resume'. A paused
    // subscription is not a cancelling one, and showing it as such would tell
    // a customer their account is ending when it is not.
    expect(mapPaddleStatus('active', { action: 'pause' })).toEqual({
      status: 'active',
      cancelAtPeriodEnd: false,
    });
    expect(mapPaddleStatus('active', { action: 'resume' })).toEqual({
      status: 'active',
      cancelAtPeriodEnd: false,
    });
  });

  it('carries a pending cancellation through trialing, paused and past_due', () => {
    // Someone can cancel while on trial or while past due; the end date still
    // has to show.
    for (const s of ['trialing', 'paused', 'past_due'] as const) {
      expect(mapPaddleStatus(s, { action: 'cancel' }).cancelAtPeriodEnd).toBe(
        true,
      );
    }
  });

  it('clears cancelAtPeriodEnd once the subscription is actually canceled', () => {
    // There is no period left to cancel at. Leaving it true would show a dead
    // account as still cancelling.
    expect(
      mapPaddleStatus('canceled', { action: 'cancel' }).cancelAtPeriodEnd,
    ).toBe(false);
  });

  it('fails OPEN on an unknown status', () => {
    // A status Paddle adds later must not lock out someone who is paying.
    expect(mapPaddleStatus('some_new_status')).toEqual({
      status: 'active',
      cancelAtPeriodEnd: false,
    });
    expect(mapPaddleStatus(null)).toEqual({
      status: 'active',
      cancelAtPeriodEnd: false,
    });
    expect(mapPaddleStatus(undefined)).toEqual({
      status: 'active',
      cancelAtPeriodEnd: false,
    });
  });

  it('is case-insensitive', () => {
    expect(mapPaddleStatus('ACTIVE').status).toBe('active');
    expect(mapPaddleStatus('Canceled').status).toBe('canceled');
  });
});

describe('isPaddleTerminal', () => {
  it('is true only for canceled', () => {
    // `past_due` is a customer whose card is being retried, and `paused` keeps
    // what they paid for. Treating either as terminal would revoke access from
    // someone who has not left.
    expect(isPaddleTerminal('canceled')).toBe(true);
    expect(isPaddleTerminal('past_due')).toBe(false);
    expect(isPaddleTerminal('paused')).toBe(false);
    expect(isPaddleTerminal('active')).toBe(false);
    expect(isPaddleTerminal('trialing')).toBe(false);
  });

  it('spells it with ONE l, as Paddle does', () => {
    // `cancelled` is the Lemon Squeezy spelling. A set keyed on the wrong one
    // would never match, so no Paddle subscription would ever read as ended.
    expect(PADDLE_TERMINAL_STATUSES.has('canceled')).toBe(true);
    expect(isPaddleTerminal('cancelled')).toBe(false);
  });

  it('is false for nothing at all rather than throwing', () => {
    expect(isPaddleTerminal(null)).toBe(false);
    expect(isPaddleTerminal(undefined)).toBe(false);
    expect(isPaddleTerminal('')).toBe(false);
  });
});
