import type { PaddleScheduledChange } from './paddle.types';

/**
 * Paddle subscription statuses, translated to ours.
 *
 * The thing that differs from Lemon Squeezy is where "cancelled but still paid
 * up" lives. Lemon Squeezy has a `cancelled` STATUS for it. Paddle does not:
 * a subscription cancelled at the period end stays `active` and grows a
 * `scheduled_change` of `{ action: 'cancel' }`, and only flips to `canceled`
 * when that date arrives.
 *
 * So the scheduled change has to be read, not just the status. Reading the
 * status alone would leave `cancelAtPeriodEnd` false on an account that has
 * cancelled — the billing page would show no end date and the customer would
 * have no sign their cancellation registered.
 *
 * Verbatim status values from developer.paddle.com: `active`, `canceled`
 * (one l), `past_due`, `paused`, `trialing`.
 */

/**
 * The statuses that end access. `canceled` only — a `past_due` customer is
 * still a customer whose card we are retrying, and a `paused` one keeps what
 * they paid for.
 */
export const PADDLE_TERMINAL_STATUSES = new Set(['canceled']);

export function isPaddleTerminal(status: string | null | undefined): boolean {
  return PADDLE_TERMINAL_STATUSES.has((status ?? '').toLowerCase());
}

export function mapPaddleStatus(
  paddleStatus: string | null | undefined,
  scheduledChange?: PaddleScheduledChange | null,
): { status: string; cancelAtPeriodEnd: boolean } {
  // A pending cancellation is carried by the scheduled change, not the status.
  const cancelPending = scheduledChange?.action === 'cancel';

  switch ((paddleStatus ?? '').toLowerCase()) {
    case 'trialing':
      return { status: 'trialing', cancelAtPeriodEnd: cancelPending };
    case 'paused':
      return { status: 'paused', cancelAtPeriodEnd: cancelPending };
    case 'past_due':
      return { status: 'past_due', cancelAtPeriodEnd: cancelPending };
    case 'canceled':
      // Already over. `cancelAtPeriodEnd` is false because there is no period
      // left to cancel at — our model uses it to mean "still running, ends
      // later", and leaving it true on a dead subscription would show an
      // account as cancelling when it has already gone.
      return { status: 'canceled', cancelAtPeriodEnd: false };
    case 'active':
      return { status: 'active', cancelAtPeriodEnd: cancelPending };
    default:
      // Fail open. An unrecognised status must not lock out someone paying;
      // a new Paddle status would otherwise revoke access on arrival.
      return { status: 'active', cancelAtPeriodEnd: cancelPending };
  }
}
