/**
 * Lemon Squeezy subscription statuses, translated to ours.
 *
 * The one that matters is `cancelled`. Lemon Squeezy's docs are explicit that
 * customers keep access in every status EXCEPT `expired` — a `cancelled`
 * subscription runs to `ends_at` and only then expires. Verified live on
 * 2026-09-07: DELETE returned `status: cancelled` with `ends_at` a month out.
 *
 * So `cancelled` maps to our `active` plus `cancelAtPeriodEnd`, which is what
 * our own model already means by "cancelled but still paid up". Mapping the
 * word onto our `canceled` would revoke access the moment a customer
 * scheduled a cancellation.
 */
export const LS_STATUS_REVOKES_ACCESS = ['expired'];

export function mapLemonSqueezyStatus(lsStatus: string): {
  status: string;
  cancelAtPeriodEnd: boolean;
} {
  switch ((lsStatus ?? '').toLowerCase()) {
    case 'on_trial':
      return { status: 'trialing', cancelAtPeriodEnd: false };
    case 'paused':
      return { status: 'paused', cancelAtPeriodEnd: false };
    case 'past_due':
    case 'unpaid':
      return { status: 'past_due', cancelAtPeriodEnd: false };
    case 'cancelled':
      return { status: 'active', cancelAtPeriodEnd: true };
    case 'expired':
      return { status: 'canceled', cancelAtPeriodEnd: false };
    case 'active':
    default:
      // Fail open. An unrecognised status must not lock out someone paying.
      return { status: 'active', cancelAtPeriodEnd: false };
  }
}
