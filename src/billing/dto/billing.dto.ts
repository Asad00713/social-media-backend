import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsInt,
  IsIn,
  Min,
  Max,
} from 'class-validator';

/**
 * Request bodies for the billing controller.
 *
 * These exist because the global ValidationPipe is configured with
 * `whitelist: true` and `forbidNonWhitelisted: true`, and that pipe only acts
 * on DTO *classes*. An inline body type (`@Body() body: { ... }`) is erased at
 * compile time, so the pipe sees no metadata, strips nothing, and validates
 * nothing — every field arrives exactly as the caller sent it.
 *
 * That is how `trialPeriodDays` became an unbounded, caller-controlled number
 * on the way to Stripe's `trial_period_days`. Anything reaching money or
 * entitlements must be a class with decorators.
 */

export const ADDON_TYPES = [
  'EXTRA_CHANNEL',
  'EXTRA_MEMBER',
  'EXTRA_WORKSPACE',
  'EXTRA_AI_TOKENS',
] as const;

export type AddonTypeDto = (typeof ADDON_TYPES)[number];

/** Upper bound on a promotional trial, in days. */
export const MAX_TRIAL_PERIOD_DAYS = 30;

export class CreateSubscriptionBodyDto {
  @IsString()
  @IsNotEmpty()
  planCode: string;

  @IsString()
  @IsOptional()
  paymentMethodId?: string;

  /**
   * Bounded deliberately. This value is passed to Stripe as
   * `trial_period_days`, so an unbounded number grants unbounded free service —
   * and `trialing` is not one of SUSPENDED_STATUSES, so no guard would catch it.
   */
  @IsInt()
  @Min(0)
  @Max(MAX_TRIAL_PERIOD_DAYS)
  @IsOptional()
  trialPeriodDays?: number;
}

export class CreateCheckoutSessionBodyDto {
  @IsString()
  @IsNotEmpty()
  planCode: string;
}

export class CancelSubscriptionBodyDto {
  @IsBoolean()
  @IsOptional()
  cancelAtPeriodEnd?: boolean;
}

export class PurchaseAddonBodyDto {
  @IsIn(ADDON_TYPES)
  addonType: AddonTypeDto;

  @IsInt()
  @Min(1)
  quantity: number;
}

export class RemoveAddonBodyDto {
  @IsInt()
  @Min(1)
  @IsOptional()
  quantity?: number;
}

export class ChangePlanBodyDto {
  @IsString()
  @IsNotEmpty()
  newPlanCode: string;
}

export class AddPaymentMethodBodyDto {
  @IsString()
  @IsNotEmpty()
  paymentMethodId: string;

  @IsBoolean()
  @IsOptional()
  setAsDefault?: boolean;
}
