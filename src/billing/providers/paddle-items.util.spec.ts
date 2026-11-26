import {
  quantityOf,
  toWriteList,
  withBasePlanSwapped,
  withItem,
  withoutItem,
} from './paddle-items.util';
import type { PaddleSubscriptionItem } from './paddle.types';

function item(priceId: string, quantity: number): PaddleSubscriptionItem {
  return {
    price: { id: priceId, product_id: `pro_for_${priceId}` },
    quantity,
  };
}

/** A real shape: a base plan plus three add-ons at different quantities. */
const LOADED: PaddleSubscriptionItem[] = [
  item('pri_base_pro', 1),
  item('pri_channel', 4),
  item('pri_member', 2),
  item('pri_ai', 3),
];

describe('toWriteList', () => {
  it('carries every line with its quantity', () => {
    expect(toWriteList(LOADED)).toEqual([
      { price_id: 'pri_base_pro', quantity: 1 },
      { price_id: 'pri_channel', quantity: 4 },
      { price_id: 'pri_member', quantity: 2 },
      { price_id: 'pri_ai', quantity: 3 },
    ]);
  });

  it('does not alias the source items', () => {
    const out = toWriteList(LOADED);
    out[0].quantity = 99;
    expect(LOADED[0].quantity).toBe(1);
  });
});

describe('withItem', () => {
  it('adds a line the subscription does not have', () => {
    const out = withItem(LOADED, 'pri_workspace', 2);
    expect(out).toHaveLength(5);
    expect(out.at(-1)).toEqual({ price_id: 'pri_workspace', quantity: 2 });
  });

  it('updates a line it already has, in place', () => {
    const out = withItem(LOADED, 'pri_channel', 9);
    expect(out).toHaveLength(4);
    expect(out[1]).toEqual({ price_id: 'pri_channel', quantity: 9 });
  });

  it('KEEPS every other paid line', () => {
    // The whole hazard of Paddle's replace-the-array update: a line left out
    // of the request is removed from the subscription, so a change to one
    // add-on that dropped the others would silently stop billing for them
    // while the customer still had them.
    const out = withItem(LOADED, 'pri_channel', 9);
    expect(out.map((i) => i.price_id)).toEqual([
      'pri_base_pro',
      'pri_channel',
      'pri_member',
      'pri_ai',
    ]);
    expect(out.find((i) => i.price_id === 'pri_member')?.quantity).toBe(2);
    expect(out.find((i) => i.price_id === 'pri_ai')?.quantity).toBe(3);
  });

  it('never carries the base plan away with an add-on change', () => {
    const out = withItem(LOADED, 'pri_ai', 1);
    expect(out[0]).toEqual({ price_id: 'pri_base_pro', quantity: 1 });
  });

  it('refuses a quantity below 1, naming the alternative', () => {
    // Paddle's minimum is 1. Sending 0 is not "remove" there — it is a 400,
    // and the caller's intent was a removal, which has its own function.
    expect(() => withItem(LOADED, 'pri_channel', 0)).toThrow(/withoutItem/);
    expect(() => withItem(LOADED, 'pri_channel', -1)).toThrow(/withoutItem/);
  });

  it('refuses NaN rather than sending it', () => {
    expect(() => withItem(LOADED, 'pri_channel', Number.NaN)).toThrow();
  });
});

describe('withoutItem', () => {
  it('drops only the named line', () => {
    const out = withoutItem(LOADED, 'pri_member');
    expect(out.map((i) => i.price_id)).toEqual([
      'pri_base_pro',
      'pri_channel',
      'pri_ai',
    ]);
  });

  it('is idempotent for a line that is not there', () => {
    // A second press of Remove must not fail in a way that reads as a
    // different problem.
    expect(withoutItem(LOADED, 'pri_nothing')).toEqual(toWriteList(LOADED));
  });

  it('can empty an add-on-only list', () => {
    expect(withoutItem([item('pri_channel', 1)], 'pri_channel')).toEqual([]);
  });
});

describe('withBasePlanSwapped', () => {
  it('swaps the plan and keeps every add-on at its quantity', () => {
    // Moving Basic -> Pro must not cost someone the extra channels they paid
    // for.
    const out = withBasePlanSwapped(LOADED, 'pri_base_pro', 'pri_base_max');
    expect(out).toEqual([
      { price_id: 'pri_base_max', quantity: 1 },
      { price_id: 'pri_channel', quantity: 4 },
      { price_id: 'pri_member', quantity: 2 },
      { price_id: 'pri_ai', quantity: 3 },
    ]);
  });

  it('keeps the plan in its original position', () => {
    const out = withBasePlanSwapped(LOADED, 'pri_base_pro', 'pri_base_max');
    expect(out[0].price_id).toBe('pri_base_max');
  });

  it('forces the plan to quantity 1', () => {
    // Base prices are capped at a maximum quantity of 1 in Paddle, so a
    // stored quantity above that is bad data; carrying it over would turn a
    // plan change into a 400 at best and a double charge at worst.
    const out = withBasePlanSwapped(
      [item('pri_base_pro', 3), item('pri_channel', 2)],
      'pri_base_pro',
      'pri_base_max',
    );
    expect(out[0]).toEqual({ price_id: 'pri_base_max', quantity: 1 });
  });

  it('refuses to guess when the old base price is not on the subscription', () => {
    // Inferring "which of these is the plan" is what would delete an add-on
    // the first time a catalogue id changed.
    expect(() =>
      withBasePlanSwapped(LOADED, 'pri_base_stale', 'pri_base_max'),
    ).toThrow(/refusing to guess/);
  });
});

describe('quantityOf', () => {
  it('reads what Paddle currently bills', () => {
    expect(quantityOf(LOADED, 'pri_channel')).toBe(4);
  });

  it('is 0 for a price with no line, not undefined', () => {
    // Callers do arithmetic on this.
    expect(quantityOf(LOADED, 'pri_nothing')).toBe(0);
  });
});
