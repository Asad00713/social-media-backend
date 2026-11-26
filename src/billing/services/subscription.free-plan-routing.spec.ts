import { BadRequestException } from '@nestjs/common';
import { SubscriptionService } from './subscription.service';

/**
 * A FREE subscription must not be refused because of the account's PAYMENT
 * PROVIDER.
 *
 * This is the bug that cost a real sandbox payment on 2026-11-26, and it is
 * worth stating the whole chain because no single step looked wrong:
 *
 *  1. A new workspace is created. `WorkspaceService` calls
 *     `createSubscription({ planCode: 'FREE' })` to give the account its row.
 *  2. The provider guard ran BEFORE the FREE branch, so on a Paddle (or Lemon
 *     Squeezy) deployment it threw "Direct subscription creation is not
 *     supported for paddle".
 *  3. `WorkspaceService` catches and only LOGS that, so the workspace was
 *     created and the account silently had no `subscriptions` row.
 *  4. The customer upgraded and paid. Paddle took the money.
 *  5. `subscription.created` arrived, and `createRowFromCheckout` looked for
 *     the account's subscription row to attach the Paddle subscription to.
 *     There wasn't one, so it logged "No subscription row for user ..." and
 *     did nothing.
 *
 * The customer paid $12 and stayed on Free. Every layer behaved "correctly"
 * in isolation; only the first step was wrong, and it was wrong in a way that
 * produced no error anyone would see.
 *
 * The service is constructed with stubs rather than through a Nest module:
 * what is under test is one branch taken before any dependency is used, and
 * the assertions below rely on that — the FREE case is proven by which
 * dependency it reaches FIRST, not by a successful insert.
 */

interface Stubs {
  providerForUser: jest.Mock;
  getOrCreateStripeCustomer: jest.Mock;
}

function serviceWith(provider: string): {
  service: SubscriptionService;
  stubs: Stubs;
} {
  const stubs: Stubs = {
    providerForUser: jest.fn().mockResolvedValue(provider),
    getOrCreateStripeCustomer: jest
      .fn()
      .mockResolvedValue({ stripeCustomerId: 'cus_test' }),
  };

  const service = new SubscriptionService(
    {} as never, // StripeService
    { getOrCreateStripeCustomer: stubs.getOrCreateStripeCustomer } as never,
    {} as never, // SubscriptionLookupService
    { providerForUser: stubs.providerForUser } as never,
  );

  return { service, stubs };
}

const DTO = {
  workspaceId: '7334e522-b099-4e11-8889-f733d93ceb5e',
  userId: 'a1dc3a0d-2735-4bf4-9c07-c7ba785a9602',
};

describe('createSubscription and the account provider', () => {
  describe.each(['paddle', 'lemonsqueezy'])('on a %s account', (provider) => {
    it('refuses a PAID plan, which has no non-Stripe direct path', async () => {
      const { service } = serviceWith(provider);

      await expect(
        service.createSubscription({ ...DTO, planCode: 'BASIC' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('does NOT refuse FREE — it moves no money and touches no provider', async () => {
      const { service } = serviceWith(provider);

      // FREE gets past the guard and goes on to read the plan, so it fails on
      // the DATABASE rather than on a BadRequestException. Asserting "not
      // that exception" is the point: with the guard misplaced, this rejects
      // with BadRequestException and the account never gets its row.
      const error = await service
        .createSubscription({ ...DTO, planCode: 'FREE' })
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(error).not.toBeInstanceOf(BadRequestException);
    });

    it('creates no Stripe customer for a FREE row on a non-Stripe account', async () => {
      // The other half of the same rule. `getOrCreateStripeCustomer` used to
      // run unconditionally here, which is how a Lemon Squeezy signup once
      // acquired a `stripe_customer_id`. A FREE row needs no customer at any
      // provider, and the column is nullable.
      const { service, stubs } = serviceWith(provider);

      await service
        .createSubscription({ ...DTO, planCode: 'FREE' })
        .catch(() => undefined);

      expect(stubs.getOrCreateStripeCustomer).not.toHaveBeenCalled();
    });

    it('does not even ask which provider bills the account, for FREE', async () => {
      // FREE is provider-independent by construction. Asking would invite a
      // future edit to act on the answer.
      const { service, stubs } = serviceWith(provider);

      await service
        .createSubscription({ ...DTO, planCode: 'FREE' })
        .catch(() => undefined);

      expect(stubs.providerForUser).not.toHaveBeenCalled();
    });
  });

  it('still routes a paid Stripe subscription through the Stripe customer', async () => {
    // The guard must keep letting Stripe through, or this fix would break the
    // one provider that DOES have a direct path.
    const { service, stubs } = serviceWith('stripe');

    await service
      .createSubscription({ ...DTO, planCode: 'BASIC' })
      .catch(() => undefined);

    expect(stubs.getOrCreateStripeCustomer).toHaveBeenCalledWith(DTO.userId);
  });
});
