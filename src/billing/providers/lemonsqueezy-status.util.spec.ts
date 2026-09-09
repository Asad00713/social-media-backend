import { mapLemonSqueezyStatus } from './lemonsqueezy-status.util';

describe('mapLemonSqueezyStatus', () => {
  it('maps on_trial to trialing', () => {
    expect(mapLemonSqueezyStatus('on_trial')).toEqual({
      status: 'trialing',
      cancelAtPeriodEnd: false,
    });
  });

  it('maps active to active', () => {
    expect(mapLemonSqueezyStatus('active')).toEqual({
      status: 'active',
      cancelAtPeriodEnd: false,
    });
  });

  it('maps paused to paused', () => {
    expect(mapLemonSqueezyStatus('paused')).toEqual({
      status: 'paused',
      cancelAtPeriodEnd: false,
    });
  });

  it('maps past_due to past_due — dunning is still retrying', () => {
    expect(mapLemonSqueezyStatus('past_due')).toEqual({
      status: 'past_due',
      cancelAtPeriodEnd: false,
    });
  });

  // `unpaid` has no equivalent in our enum, and with store dunning disabled a
  // subscription can sit there indefinitely. Folding it into past_due keeps
  // access on while the payment problem is chased.
  it('folds unpaid into past_due', () => {
    expect(mapLemonSqueezyStatus('unpaid')).toEqual({
      status: 'past_due',
      cancelAtPeriodEnd: false,
    });
  });

  // THE TRAP. Lemon Squeezy's `cancelled` means the customer KEEPS access
  // until ends_at; only `expired` revokes. Mapping it to our `canceled` would
  // cut off a paying customer the moment they schedule a cancellation.
  it('maps cancelled to ACTIVE with cancelAtPeriodEnd, not canceled', () => {
    expect(mapLemonSqueezyStatus('cancelled')).toEqual({
      status: 'active',
      cancelAtPeriodEnd: true,
    });
  });

  it('maps expired to canceled — the only status that revokes', () => {
    expect(mapLemonSqueezyStatus('expired')).toEqual({
      status: 'canceled',
      cancelAtPeriodEnd: false,
    });
  });

  // Fail open: an unrecognised status must not lock a paying customer out.
  it('treats an unknown status as active rather than locking anyone out', () => {
    expect(mapLemonSqueezyStatus('something_new')).toEqual({
      status: 'active',
      cancelAtPeriodEnd: false,
    });
  });

  it('is case-insensitive', () => {
    expect(mapLemonSqueezyStatus('CANCELLED').cancelAtPeriodEnd).toBe(true);
  });
});
