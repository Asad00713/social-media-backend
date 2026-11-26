/**
 * Which providers' trials the sweep covers.
 *
 * The unit spec next door drives the cron through a fake that resolves to
 * fixed rows whatever the clauses say, so it cannot see WHICH subscriptions
 * the query asks for — and a hard-coded `provider` filter is invisible to it.
 * That is how a Paddle trial went unwarned: the sweep's join pinned
 * `provider = 'lemonsqueezy'`, so Paddle customers were joined away and
 * charged with no notice.
 *
 * These tests therefore run the real query against the shared table-aware
 * fake, which honours the where clause, and assert on WHO was mailed.
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { Logger } from '@nestjs/common';
import { makeFakeDb, type Row } from './testing/fake-db';
import { TrialEndingCron } from './trial-ending.cron';

const NOW = new Date('2026-11-14T09:00:00Z');
const HOUR_MS = 60 * 60 * 1000;
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR_MS);

const { store, db } = makeFakeDb();

interface SeedSub {
  id: number;
  userId: string;
  /** One provider row per entry: a cutover account holds two. */
  providers: { provider: string; itemType?: string }[];
  status?: string;
  trialEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
}

function seed(subs: SeedSub[]): {
  trialEnding: jest.Mock;
  cron: TrialEndingCron;
} {
  const subscriptions: Row[] = [];
  const provider_subscriptions: Row[] = [];
  let rowId = 1;

  for (const s of subs) {
    subscriptions.push({
      id: s.id,
      userId: s.userId,
      planCode: 'PRO',
      status: s.status ?? 'trialing',
      cancelAtPeriodEnd: s.cancelAtPeriodEnd ?? false,
      trialEnd: s.trialEnd === undefined ? at(60) : s.trialEnd,
    });
    for (const p of s.providers) {
      provider_subscriptions.push({
        id: rowId++,
        subscriptionId: s.id,
        provider: p.provider,
        itemType: p.itemType ?? 'BASE_PLAN',
        providerSubscriptionId: `p-${rowId}`,
      });
    }
  }

  store.reset({ subscriptions, provider_subscriptions });

  const trialEnding = jest.fn().mockResolvedValue(undefined);
  return {
    trialEnding,
    cron: new TrialEndingCron(db, { trialEnding } as never),
  };
}

/** The user ids mailed, sorted, so an assertion does not depend on row order. */
const mailed = (trialEnding: jest.Mock): string[] =>
  (trialEnding.mock.calls as Array<[{ userId: string }]>)
    .map(([arg]) => arg.userId)
    .sort();

describe('TrialEndingCron: every provider that can run a trial', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('warns a Paddle trial', async () => {
    // The bug. Paddle is a Merchant of Record like Lemon Squeezy and runs
    // trials the same way, so its customers must be warned before the first
    // charge.
    const { cron, trialEnding } = seed([
      { id: 1, userId: 'paddle-user', providers: [{ provider: 'paddle' }] },
    ]);

    await expect(cron.sendDue(NOW)).resolves.toBe(1);
    expect(mailed(trialEnding)).toEqual(['paddle-user']);
  });

  it('still warns a Lemon Squeezy trial', async () => {
    // The provider that already worked. Widening the sweep must not move the
    // filter from "only Lemon Squeezy" to "only Paddle".
    const { cron, trialEnding } = seed([
      { id: 1, userId: 'ls-user', providers: [{ provider: 'lemonsqueezy' }] },
    ]);

    await expect(cron.sendDue(NOW)).resolves.toBe(1);
    expect(mailed(trialEnding)).toEqual(['ls-user']);
  });

  it('warns both providers in one sweep', async () => {
    const { cron, trialEnding } = seed([
      { id: 1, userId: 'ls-user', providers: [{ provider: 'lemonsqueezy' }] },
      { id: 2, userId: 'paddle-user', providers: [{ provider: 'paddle' }] },
    ]);

    await expect(cron.sendDue(NOW)).resolves.toBe(2);
    expect(mailed(trialEnding)).toEqual(['ls-user', 'paddle-user']);
  });

  it('mails a cutover account holding rows at two providers exactly once', async () => {
    // A join across `provider_subscriptions` yields one row PER provider row,
    // so an account mid-cutover would be handed to the email service twice.
    // `BillingEmailService.trialEnding` claims per subscription, so the
    // second send is swallowed in production — but `sendDue`'s own count, and
    // any future claim change, would be wrong. Dedupe at the query.
    const { cron, trialEnding } = seed([
      {
        id: 1,
        userId: 'cutover-user',
        providers: [{ provider: 'lemonsqueezy' }, { provider: 'paddle' }],
      },
    ]);

    await expect(cron.sendDue(NOW)).resolves.toBe(1);
    expect(trialEnding).toHaveBeenCalledTimes(1);
    expect(mailed(trialEnding)).toEqual(['cutover-user']);
  });

  it('ignores a trial whose only provider row is an add-on', async () => {
    // The `itemType: 'BASE_PLAN'` condition. An EXTRA_CHANNEL row is not the
    // thing being trialled, and reading it as one would mail an account whose
    // plan nobody is trialling.
    const { cron, trialEnding } = seed([
      {
        id: 1,
        userId: 'addon-only',
        providers: [{ provider: 'paddle', itemType: 'EXTRA_CHANNEL' }],
      },
    ]);

    await expect(cron.sendDue(NOW)).resolves.toBe(0);
    expect(trialEnding).not.toHaveBeenCalled();
  });

  it('keeps the window, the status and the cancel check', async () => {
    // Widening the PROVIDER must not widen anything else: these are the rows
    // the sweep has always been required to skip.
    const { cron, trialEnding } = seed([
      { id: 1, userId: 'due', providers: [{ provider: 'paddle' }] },
      // Exactly three days out is in; a minute past it is not.
      {
        id: 2,
        userId: 'edge-in',
        trialEnd: at(72),
        providers: [{ provider: 'paddle' }],
      },
      {
        id: 3,
        userId: 'too-far',
        trialEnd: new Date(at(72).getTime() + 60_000),
        providers: [{ provider: 'paddle' }],
      },
      // Already over: nobody left to warn.
      {
        id: 4,
        userId: 'expired',
        trialEnd: at(-1),
        providers: [{ provider: 'paddle' }],
      },
      // Chose to leave.
      {
        id: 5,
        userId: 'leaving',
        cancelAtPeriodEnd: true,
        providers: [{ provider: 'paddle' }],
      },
      // Not on trial at all.
      {
        id: 6,
        userId: 'paying',
        status: 'active',
        providers: [{ provider: 'paddle' }],
      },
      {
        id: 7,
        userId: 'no-trial-end',
        trialEnd: null,
        providers: [{ provider: 'paddle' }],
      },
    ]);

    await expect(cron.sendDue(NOW)).resolves.toBe(2);
    expect(mailed(trialEnding)).toEqual(['due', 'edge-in']);
  });
});
