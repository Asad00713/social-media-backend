import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  CreateSubscriptionBodyDto,
  PurchaseAddonBodyDto,
  MAX_TRIAL_PERIOD_DAYS,
} from './billing.dto';

/**
 * These bodies used to be inline types on the controller. The global
 * ValidationPipe only acts on DTO classes, so an inline type meant no
 * validation at all — `trialPeriodDays` reached Stripe's `trial_period_days`
 * exactly as the caller sent it.
 */

async function errorsFor<T extends object>(
  cls: new () => T,
  payload: Record<string, unknown>,
): Promise<string[]> {
  const dto = plainToInstance(cls, payload);
  const errors = await validate(dto as object);
  return errors.map((e) => e.property);
}

describe('CreateSubscriptionBodyDto', () => {
  it('accepts a plan code with no trial', async () => {
    expect(
      await errorsFor(CreateSubscriptionBodyDto, { planCode: 'PRO' }),
    ).toEqual([]);
  });

  it('accepts a trial inside the bound', async () => {
    expect(
      await errorsFor(CreateSubscriptionBodyDto, {
        planCode: 'PRO',
        trialPeriodDays: 14,
      }),
    ).toEqual([]);
  });

  it('accepts exactly the maximum trial', async () => {
    expect(
      await errorsFor(CreateSubscriptionBodyDto, {
        planCode: 'PRO',
        trialPeriodDays: MAX_TRIAL_PERIOD_DAYS,
      }),
    ).toEqual([]);
  });

  // The bug this DTO exists to close: an unbounded trial is free service.
  it('rejects a 100-year trial', async () => {
    expect(
      await errorsFor(CreateSubscriptionBodyDto, {
        planCode: 'MAX',
        trialPeriodDays: 36500,
      }),
    ).toEqual(['trialPeriodDays']);
  });

  it('rejects one day past the maximum', async () => {
    expect(
      await errorsFor(CreateSubscriptionBodyDto, {
        planCode: 'PRO',
        trialPeriodDays: MAX_TRIAL_PERIOD_DAYS + 1,
      }),
    ).toEqual(['trialPeriodDays']);
  });

  it('rejects a negative trial', async () => {
    expect(
      await errorsFor(CreateSubscriptionBodyDto, {
        planCode: 'PRO',
        trialPeriodDays: -1,
      }),
    ).toEqual(['trialPeriodDays']);
  });

  it('rejects a fractional trial', async () => {
    expect(
      await errorsFor(CreateSubscriptionBodyDto, {
        planCode: 'PRO',
        trialPeriodDays: 7.5,
      }),
    ).toEqual(['trialPeriodDays']);
  });

  it('rejects a missing plan code', async () => {
    expect(await errorsFor(CreateSubscriptionBodyDto, {})).toEqual([
      'planCode',
    ]);
  });
});

describe('PurchaseAddonBodyDto', () => {
  it('accepts a known add-on type', async () => {
    expect(
      await errorsFor(PurchaseAddonBodyDto, {
        addonType: 'EXTRA_CHANNEL',
        quantity: 2,
      }),
    ).toEqual([]);
  });

  it('rejects an unknown add-on type', async () => {
    expect(
      await errorsFor(PurchaseAddonBodyDto, {
        addonType: 'EXTRA_EVERYTHING',
        quantity: 1,
      }),
    ).toEqual(['addonType']);
  });

  it('rejects a zero or negative quantity', async () => {
    expect(
      await errorsFor(PurchaseAddonBodyDto, {
        addonType: 'EXTRA_CHANNEL',
        quantity: 0,
      }),
    ).toEqual(['quantity']);
  });
});
