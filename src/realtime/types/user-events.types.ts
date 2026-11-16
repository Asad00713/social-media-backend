/**
 * Events sent to ONE user on the `/realtime` namespace, rather than to a
 * workspace room.
 *
 * Billing is per account, not per workspace: the subscription belongs to the
 * user who owns the workspaces, and a card number is not something every
 * member of those workspaces should receive. Each authenticated socket joins
 * `user:<id>` on connect, so these reach every tab the person has open
 * whichever workspace it is showing.
 */
export type UserEventName = 'billing.payment.changed';

/** A card the way the toast names it: `Visa •• 4242`. */
export interface BillingPaymentCard {
  /** The provider's brand code, lowercased (`visa`, `mastercard`, `amex`…). */
  brand: string;
  last4: string;
}

/**
 * The account's payment state moved.
 *
 * - `failed`: a charge was declined. Sent once per failed attempt (deduped on
 *   webhook redelivery), only to the billing owner.
 * - `recovered`: a charge went through after one or more failures — open
 *   clients close the "Payment failed" toast and banner without a reload.
 */
export interface BillingPaymentChangedPayload {
  state: 'failed' | 'recovered';
  provider: 'stripe' | 'lemonsqueezy';
  /**
   * The owner's primary workspace, for routing to its billing page when the
   * tab is not inside a workspace the owner bills. Null when they own none.
   */
  workspaceId: string | null;
  /** The declined card, when known. Always null for `recovered`. */
  card: BillingPaymentCard | null;
  occurredAt: string;
}

export interface UserEventPayloadMap {
  'billing.payment.changed': BillingPaymentChangedPayload;
}
