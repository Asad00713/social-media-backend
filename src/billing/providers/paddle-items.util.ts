import type {
  PaddleItemWrite,
  PaddleSubscriptionItem,
} from './paddle.types';

/**
 * Building the `items` array for `PATCH /subscriptions/{id}`.
 *
 * Paddle's update REPLACES the whole array. Its doc is explicit: "Send the
 * complete list of items that you'd like to be on a subscription — including
 * existing items. If you omit items, they're removed from the subscription."
 *
 * That makes every add-on change a read-modify-write, and makes a dropped
 * entry a CANCELLATION of a paid line rather than a no-op. Stripe and Lemon
 * Squeezy both address one item at a time, so neither adapter has this
 * hazard, and neither has a helper to copy. Pure and tested on its own
 * because the failure is silent: the call succeeds, and the customer quietly
 * stops being billed for something they still have.
 */

/** The current subscription's items, as a write list, in their own order. */
export function toWriteList(
  items: readonly PaddleSubscriptionItem[],
): PaddleItemWrite[] {
  return items.map((i) => ({ price_id: i.price.id, quantity: i.quantity }));
}

/**
 * The list with `priceId` set to `quantity` — added when absent, updated when
 * present, and every other line carried through untouched.
 */
export function withItem(
  items: readonly PaddleSubscriptionItem[],
  priceId: string,
  quantity: number,
): PaddleItemWrite[] {
  if (!(quantity >= 1)) {
    throw new Error(
      `Paddle requires a quantity of at least 1; got ${quantity}. ` +
        'Use withoutItem to take a line off a subscription.',
    );
  }
  const next = toWriteList(items);
  const at = next.findIndex((i) => i.price_id === priceId);
  if (at === -1) next.push({ price_id: priceId, quantity });
  else next[at] = { price_id: priceId, quantity };
  return next;
}

/**
 * The list without `priceId`.
 *
 * Returns the list unchanged when that price is not on the subscription,
 * rather than throwing: a remove is idempotent, and a second press of
 * "Remove" must not be able to fail in a way that suggests something else
 * went wrong.
 */
export function withoutItem(
  items: readonly PaddleSubscriptionItem[],
  priceId: string,
): PaddleItemWrite[] {
  return toWriteList(items).filter((i) => i.price_id !== priceId);
}

/**
 * The list with the base plan's price swapped, add-ons untouched.
 *
 * A plan change must not disturb the add-ons: someone moving Basic -> Pro
 * keeps the extra channels they bought. The OLD base price is named
 * explicitly rather than inferred, because inferring "which of these is the
 * base plan" from the array is exactly the guess that would silently delete
 * an add-on when a catalogue id changes.
 */
export function withBasePlanSwapped(
  items: readonly PaddleSubscriptionItem[],
  oldPriceId: string,
  newPriceId: string,
): PaddleItemWrite[] {
  const list = toWriteList(items);
  const at = list.findIndex((i) => i.price_id === oldPriceId);
  if (at === -1) {
    throw new Error(
      `Paddle subscription does not carry base price ${oldPriceId}; ` +
        'refusing to guess which item is the plan.',
    );
  }
  // The base plan is always quantity 1 — its Paddle prices are capped at a
  // maximum of 1 — so the old quantity is deliberately not carried over.
  list[at] = { price_id: newPriceId, quantity: 1 };
  return list;
}

/** The quantity Paddle currently bills for a price, or 0 when it has no line. */
export function quantityOf(
  items: readonly PaddleSubscriptionItem[],
  priceId: string,
): number {
  return items.find((i) => i.price.id === priceId)?.quantity ?? 0;
}
