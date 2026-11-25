/**
 * The parts of Paddle's Billing API (version 1) this adapter reads.
 *
 * Hand-written rather than pulled from `@paddle/paddle-node-sdk`: the
 * interface here is OUR billing intent, the adapter already owns the mapping,
 * and the SDK would add a dependency whose types change on its own schedule
 * for shapes we touch in about a dozen places. The field names below are from
 * developer.paddle.com, and `paddle.client.ts` pins `Paddle-Version: 1` so
 * they cannot drift under us.
 */

/** `GET /subscriptions/{id}` → `data.status`. */
export type PaddleSubscriptionStatus =
  | 'active'
  | 'canceled'
  | 'past_due'
  | 'paused'
  | 'trialing';

/** Note the single "l": Paddle spells it `canceled`, not `cancelled`. */
export const PADDLE_CANCELED: PaddleSubscriptionStatus = 'canceled';

export interface PaddleMoney {
  /** Minor units, as a STRING: "3000" is $30.00. Paddle's own doc note: */
  /** "Although represented as a string, this value must be a valid integer." */
  amount: string;
  currency_code: string;
}

export interface PaddlePrice {
  id: string;
  product_id: string;
  unit_price?: PaddleMoney;
  /** Our `item_type` / `units_per_quantity`, set when the price was created. */
  custom_data?: Record<string, unknown> | null;
}

export interface PaddleProduct {
  id: string;
  name?: string;
  /** Our `plan_code`. */
  custom_data?: Record<string, unknown> | null;
}

/**
 * One line on a subscription.
 *
 * `price` is a SNAPSHOT: Paddle's doc says it "reflects the price entity at
 * the time it was added to the subscription". So `price.custom_data` read off
 * a live subscription may be older than the catalogue, which is why
 * `itemTypeOf` treats it as a hint and `provider_prices` as the truth.
 */
export interface PaddleSubscriptionItem {
  price: PaddlePrice;
  product?: PaddleProduct;
  quantity: number;
  status?: 'active' | 'inactive' | 'trialing';
  recurring?: boolean;
}

export interface PaddleScheduledChange {
  action: 'cancel' | 'pause' | 'resume';
  effective_at?: string;
}

export interface PaddleManagementUrls {
  update_payment_method?: string | null;
  cancel?: string | null;
}

export interface PaddleSubscription {
  id: string;
  status: PaddleSubscriptionStatus;
  customer_id: string;
  currency_code?: string;
  next_billed_at?: string | null;
  canceled_at?: string | null;
  paused_at?: string | null;
  scheduled_change?: PaddleScheduledChange | null;
  management_urls?: PaddleManagementUrls | null;
  items: PaddleSubscriptionItem[];
}

/** `GET /transactions?subscription_id=…` → `data[]`. */
export type PaddleTransactionStatus =
  | 'draft'
  | 'ready'
  | 'billed'
  | 'paid'
  | 'completed'
  | 'canceled'
  | 'past_due';

export interface PaddleTransaction {
  id: string;
  status: PaddleTransactionStatus;
  subscription_id?: string | null;
  invoice_number?: string | null;
  currency_code?: string;
  billed_at?: string | null;
  created_at: string;
  details?: { totals?: { grand_total?: string } } | null;
}

export interface PaddleCustomer {
  id: string;
  email: string;
  name?: string | null;
}

/**
 * `POST /subscriptions/{id}` item bodies take `price_id`, not a nested price.
 *
 * `quantity` may be omitted for an existing item whose quantity is unchanged,
 * but this adapter always sends it: the array REPLACES what is on the
 * subscription, so an omission that was meant as "leave it alone" is one
 * typo away from meaning "I did not mean to send this item at all".
 */
export interface PaddleItemWrite {
  price_id: string;
  quantity: number;
}

/**
 * How Paddle bills a mid-cycle change (`proration_billing_mode`).
 *
 * Verbatim from developer.paddle.com. There is no documented default, and the
 * field is REQUIRED whenever items change, so every call site here states one.
 */
export type PaddleProrationMode =
  | 'prorated_immediately'
  | 'prorated_next_billing_period'
  | 'full_immediately'
  | 'full_next_billing_period'
  | 'do_not_bill';

/** Paddle's envelope: every response body is `{ data, meta }`. */
export interface PaddleEnvelope<T> {
  data: T;
  meta?: { request_id?: string; pagination?: { next?: string | null } };
}
