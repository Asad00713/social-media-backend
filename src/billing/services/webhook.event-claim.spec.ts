/**
 * The webhook dedup gate, as a CLAIM.
 *
 * `handleWebhook` opened with a SELECT for the event id followed by an INSERT,
 * with nothing between them, on a column that has carried
 * `billing_events_stripe_event_id_unique` since migration 0003. The gate never
 * used the constraint, so it was check-then-act across two statements. Proven
 * against a real Postgres, two concurrent deliveries of one event id:
 *
 *   old (select, then insert):   PROCESSED | CRASH 23505
 *   new (insert .. on conflict): PROCESSED | skipped
 *
 * Both deliveries ran the handler, and the loser 500'd on the index - a
 * response Stripe treats as a reason to deliver a THIRD time.
 *
 * The second defect lived in the same four lines. The gate tested EXISTENCE,
 * while the catch recorded the error and rethrew so that Stripe would retry.
 * The row was already present with `processed = false`, so the retry hit the
 * gate and returned early, and nothing in the codebase ever replays such a
 * row. A transient failure during `invoice.paid` dropped that payment
 * permanently and silently.
 *
 * THE FAKE
 *
 * The sibling specs' `db` fake implements `onConflictDoNothing` as a no-op
 * that returns the chain, and `returning()` as "the last row inserted". Under
 * that fake this file's central assertion would pass whether the fix works or
 * not: every claim would look like it succeeded. So the fake here ENFORCES the
 * unique constraint - a second insert of a live event id writes nothing and
 * returns no rows, exactly as Postgres does - and the mutation checks at the
 * bottom prove the tests can still fail.
 */

/* The fakes stand in for drizzle's fluent builders, whose chain types are not
   expressible here - `any` is deliberate and confined to the fakes. */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';

interface Row {
  [column: string]: unknown;
}

/** The only table this spec cares about. */
let events: Row[];
/** Insert attempts the constraint REFUSED, in order. */
let refused: string[];
let nextId: number;

/**
 * A `billing_events` store that honours the unique index on
 * `stripe_event_id`, and nothing else.
 *
 * Deliberately narrow: this spec asserts on the gate, so only the statements
 * the gate issues are modelled. A SELECT throws, rather than returning a shape
 * that quietly satisfies the caller - a fake that answers every query is how a
 * dedup test ends up proving nothing.
 */
function makeDb(): any {
  return {
    insert: () => {
      let pending: Row = {};
      let guarded = false;
      const run = (): Row[] => {
        const id = String(pending.stripeEventId);
        if (events.some((r) => r.stripeEventId === id)) {
          // Postgres: ON CONFLICT DO NOTHING writes nothing and RETURNING
          // yields no rows. Without the guard it raises 23505 instead.
          refused.push(id);
          if (guarded) return [];
          throw Object.assign(new Error('duplicate key value'), {
            code: '23505',
          });
        }
        const row = { id: nextId++, ...pending };
        events.push(row);
        return [row];
      };
      const chain: any = {
        values: (v: Row) => {
          pending = v;
          return chain;
        },
        onConflictDoNothing: () => {
          guarded = true;
          return chain;
        },
        returning: () => Promise.resolve(run().map((r) => ({ id: r.id }))),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(run()).then(resolve),
      };
      return chain;
    },

    update: () => {
      let patch: Row = {};
      const chain: any = {
        set: (v: Row) => {
          patch = v;
          return chain;
        },
        where: (c: unknown) => {
          const id = idFrom(c);
          for (const row of events) {
            if (row.stripeEventId === id) Object.assign(row, patch);
          }
          return chain;
        },
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve([]).then(resolve),
      };
      return chain;
    },

    delete: () => {
      const chain: any = {
        where: (c: unknown) => {
          const id = idFrom(c);
          events = events.filter((r) => r.stripeEventId !== id);
          return chain;
        },
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve([]).then(resolve),
      };
      return chain;
    },

    select: () => {
      throw new Error(
        'The gate must not SELECT: the claim is the insert itself.',
      );
    },
  };
}

/** The event id out of a drizzle eq(billingEvents.stripeEventId, id). */
function idFrom(condition: unknown): string {
  const chunks = ((condition as any)?.queryChunks ?? []) as unknown[];
  for (const chunk of chunks) {
    const value = (chunk as any)?.value;
    if (typeof value === 'string') return value;
  }
  throw new Error('The fake could not read an event id from the where clause.');
}

const mockDb = makeDb();
jest.mock('../../drizzle/db', () => ({ db: mockDb }));
jest.mock('./invoice-sync.util', () => ({
  upsertInvoiceFromStripe: jest.fn().mockResolvedValue(undefined),
  getInvoiceSubscriptionId: () => null,
}));
jest.mock('../providers/stripe-provider-row.util', () => ({
  endStripeProviderRows: jest.fn().mockResolvedValue(undefined),
  refreshStripeProviderRowStatus: jest.fn().mockResolvedValue(undefined),
}));

import { WebhookService } from './webhook.service';

/**
 * The service, with one handler under our control.
 *
 * `trial_will_end` is the handler the tests drive: it is reached by a plain
 * event type, takes nothing but the event object, and is replaced here so a
 * test can decide whether this delivery succeeds or throws.
 */
function makeService(handler: () => Promise<void>): WebhookService {
  const service = new WebhookService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  (service as any).handleTrialWillEnd = handler;
  return service;
}

function event(id: string): any {
  return {
    id,
    type: 'customer.subscription.trial_will_end',
    data: { object: {} },
  };
}

beforeEach(() => {
  events = [];
  refused = [];
  nextId = 1;
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe('the insert is the gate', () => {
  it('runs the handler once for one event id', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    await makeService(handler).handleWebhook(event('evt_1'));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0].processed).toBe(true);
  });

  /**
   * The race, as the two concurrent deliveries Postgres actually saw.
   *
   * Both calls are started before either is awaited, so the second claims
   * while the first is still inside its handler - the ordering the old
   * select-then-insert gate could not survive.
   */
  it('runs the handler ONCE when two deliveries of one event overlap', async () => {
    let release: () => void = () => undefined;
    const started = jest.fn();
    const handler = jest.fn().mockImplementation(() => {
      started();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const service = makeService(handler);

    const first = service.handleWebhook(event('evt_race'));
    const second = service.handleWebhook(event('evt_race'));

    // The loser must not wait on the winner's handler, and must not throw: a
    // 500 here is a response Stripe retries.
    await expect(second).resolves.toBeUndefined();
    expect(started).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toBeUndefined();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    // The CONSTRAINT refused the second claim, rather than the gate's own
    // SELECT happening to notice it first.
    expect(refused).toEqual(['evt_race']);
  });

  it('skips a redelivery of an event that already succeeded', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    const service = makeService(handler);

    await service.handleWebhook(event('evt_done'));
    await service.handleWebhook(event('evt_done'));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
  });
});

describe('a failed delivery is retryable', () => {
  /**
   * The lost-payment bug. The handler throws, the error propagates so Stripe
   * retries - and that retry has to get through the gate. It did not, because
   * the row was left behind with `processed = false` and the gate only asked
   * whether a row existed.
   */
  it('releases the claim so the next delivery is processed', async () => {
    const handler = jest
      .fn()
      .mockRejectedValueOnce(new Error('transient db blip'))
      .mockResolvedValueOnce(undefined);
    const service = makeService(handler);

    await expect(service.handleWebhook(event('evt_retry'))).rejects.toThrow(
      'transient db blip',
    );
    // The claim is gone, so nothing blocks the redelivery.
    expect(events).toHaveLength(0);

    await service.handleWebhook(event('evt_retry'));

    expect(handler).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(1);
    expect(events[0].processed).toBe(true);
  });

  it('still rethrows, so Stripe is told to retry', async () => {
    const service = makeService(() =>
      Promise.reject(new Error('handler exploded')),
    );
    await expect(service.handleWebhook(event('evt_throw'))).rejects.toThrow(
      'handler exploded',
    );
  });

  /**
   * A release that itself fails must not replace the original error: Stripe
   * needs the non-2xx either way, and the operator needs the real cause.
   */
  it('rethrows the handler error even if the release fails', async () => {
    const service = makeService(() =>
      Promise.reject(new Error('the real cause')),
    );
    const spy = jest.spyOn(mockDb, 'delete').mockImplementation(() => {
      throw new Error('release failed');
    });

    await expect(service.handleWebhook(event('evt_rel'))).rejects.toThrow(
      'the real cause',
    );
    spy.mockRestore();
  });
});

/**
 * WHAT THE RELEASE EXPOSES
 *
 * Releasing the claim is what makes a retry possible, and a retry re-runs the
 * handler from the top. Every write a handler performs before a later await
 * point can therefore happen twice, so each one needs a key of its own.
 *
 * `failed_payments` was the one that did not have one: no unique constraint of
 * any kind, a bare `insert`, and ~8 further await points after it, several of
 * which write. That matters because the dunning gate counts ROWS -
 * `unresolvedFailures.length >= MAX_FAILED_ATTEMPTS` - so a duplicate row
 * restricts an account a full failure early: every owned workspace dropped to
 * FREE limits with all purchased add-ons zeroed, from a transient database
 * error.
 *
 * Asserted on the source. Driving `handleInvoicePaymentFailed` behaviourally
 * would mean standing up invoices, subscriptions, workspace usage, plans and
 * the limit fan-out - most of the billing module - to observe one `INSERT`
 * clause, and `webhook.payment-alerts.spec.ts` already owns that harness. The
 * property here is narrow and exact: the insert must claim the event id, under
 * the PARTIAL index 0089 creates.
 */
describe('every write the retry can repeat carries its own key', () => {
  const source = readFileSync(join(__dirname, 'webhook.service.ts'), 'utf8');

  /** The `failed_payments` insert, up to the end of its statement. */
  function failedPaymentInsert(): string {
    const start = source.indexOf('.insert(failedPayments)');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf(';', start);
    return source.slice(start, end);
  }

  it('the failed_payments insert claims the Stripe event id', () => {
    const insert = failedPaymentInsert();
    expect(insert).toMatch(/onConflictDoNothing/);
    expect(insert).toMatch(/target:\s*failedPayments\.stripeEventId/);
  });

  it('the row carries the event id, or the claim would be on null', () => {
    // `stripeEventId: eventId` - the handler already receives it, for the
    // alert key. A row inserted without it falls outside the partial index
    // and every delivery appends another.
    expect(source).toMatch(/stripeEventId:\s*eventId/);
  });

  /**
   * The bug this nearly shipped with. 0089's index is partial, and Postgres
   * does NOT infer a partial index from a bare `ON CONFLICT (col)`: it raises
   * "there is no unique or exclusion constraint matching the ON CONFLICT
   * specification". Verified against Postgres both ways - without the
   * predicate that error would 500 EVERY payment failure.
   */
  it('names the index predicate, so the partial index is inferred', () => {
    const insert = failedPaymentInsert();
    expect(insert).toMatch(/where:\s*sql`/);
    expect(insert).toMatch(/IS NOT NULL/);
  });

  it('does not silently overwrite the recorded failure', () => {
    // A redelivery has nothing new to say about a failure already recorded,
    // and DO UPDATE would reset fields the dunning logic owns.
    expect(failedPaymentInsert()).not.toMatch(/onConflictDoUpdate/);
  });

  /**
   * The comment at the alert claim used to say redelivery was "stopped
   * earlier by the billing_events check". After the release that holds only
   * for an event that SUCCEEDED, and it was the reasoning that made the
   * unguarded insert look safe.
   */
  it('no longer claims billing_events stops a redelivery outright', () => {
    expect(source).not.toMatch(
      /Redelivery of the same event is stopped earlier by/,
    );
  });
});

/**
 * MUTATION CHECKS
 *
 * The fake is the thing most likely to be wrong here, so each check
 * reintroduces one half of the original defect against this same fake and
 * asserts the behaviour the suite above relies on.
 */
describe('the tests fail when the bug comes back', () => {
  it('an unguarded insert (no ON CONFLICT) raises 23505 on the second claim', async () => {
    // What the old gate did once two deliveries got past its SELECT. The fake
    // raises where Postgres raises - inside the statement - so the throw is
    // synchronous here rather than a rejected promise.
    const claim = (id: string) =>
      mockDb.insert().values({ stripeEventId: id }).returning();

    await claim('evt_mut');
    expect(() => claim('evt_mut')).toThrow('duplicate key value');
    expect(refused).toEqual(['evt_mut']);
  });

  it('keeping the row on failure blocks the retry', async () => {
    const handler = jest.fn().mockRejectedValue(new Error('boom'));
    const service = makeService(handler);
    // The old behaviour: the claim is never released.
    const spy = jest
      .spyOn(mockDb, 'delete')
      .mockImplementation(() => ({ where: () => undefined }) as never);

    await expect(service.handleWebhook(event('evt_stuck'))).rejects.toThrow(
      'boom',
    );
    expect(events).toHaveLength(1);

    // The retry is now refused by the gate - the event is lost, which is the
    // bug this change removes.
    await service.handleWebhook(event('evt_stuck'));
    expect(handler).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });
});
