import { ForbiddenException } from '@nestjs/common';
import {
  PAID_ONLY_PLATFORMS,
  PLAN_UPGRADE_REQUIRED,
  entitledPlanCode,
  isPaidOnlyPlatform,
  isPaidPlan,
  isPlatformAllowedOnPlan,
  planUpgradeRequired,
} from './paid-only-platforms';
import { errorCodeOf } from './services/channel-limit.error';

describe('paid-only platforms', () => {
  it('X (twitter) is the paid-only platform', () => {
    expect(PAID_ONLY_PLATFORMS).toEqual(['twitter']);
    expect(isPaidOnlyPlatform('twitter')).toBe(true);
  });

  it('every other platform is not paid-only', () => {
    for (const p of ['linkedin', 'facebook', 'instagram', 'bluesky'] as const) {
      expect(isPaidOnlyPlatform(p)).toBe(false);
    }
  });

  it('FREE does not allow X; any other plan does', () => {
    expect(isPlatformAllowedOnPlan('twitter', 'FREE')).toBe(false);
    expect(isPlatformAllowedOnPlan('twitter', 'PRO')).toBe(true);
    expect(isPlatformAllowedOnPlan('twitter', 'MAX')).toBe(true);
  });

  it('FREE allows every platform that is not paid-only', () => {
    expect(isPlatformAllowedOnPlan('linkedin', 'FREE')).toBe(true);
    expect(isPlatformAllowedOnPlan('bluesky', 'FREE')).toBe(true);
  });

  it('isPaidPlan is false only for FREE', () => {
    expect(isPaidPlan('FREE')).toBe(false);
    expect(isPaidPlan('PRO')).toBe(true);
  });
});

describe('entitledPlanCode', () => {
  it('is FREE with no subscription', () => {
    expect(entitledPlanCode(null)).toBe('FREE');
    expect(entitledPlanCode(undefined)).toBe('FREE');
  });

  it('is the plan of an active subscription (incl. cancelling at period end)', () => {
    expect(entitledPlanCode({ planCode: 'PRO', status: 'active' })).toBe('PRO');
  });

  // The rule every other entitlement uses (AccountChannelsService.limitForUser,
  // UsageService): anything but `active` gets FREE's allowance.
  it.each(['trialing', 'past_due', 'canceled', 'paused', 'incomplete'])(
    'is FREE for status %p',
    (status) => {
      expect(entitledPlanCode({ planCode: 'PRO', status })).toBe('FREE');
    },
  );
});

describe('planUpgradeRequired', () => {
  it('is a coded 403 in the CHANNEL_LIMIT_REACHED style', () => {
    const err = planUpgradeRequired('twitter');
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse()).toEqual({
      statusCode: 403,
      error: 'Forbidden',
      code: PLAN_UPGRADE_REQUIRED,
      feature: 'x',
      message: 'X is available on paid plans.',
    });
    expect(errorCodeOf(err)).toBe('PLAN_UPGRADE_REQUIRED');
  });
});
