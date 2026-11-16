import type { AnyTemplateDef } from '../types';
import { PAYMENT_FAILED } from './payment-failed';
import { PLAN_CHANGED } from './plan-changed';
import { TRIAL_ENDING } from './trial-ending';

/** The billing templates. Each template task appends its def here. */
export const BILLING_TEMPLATES: AnyTemplateDef[] = [
  PAYMENT_FAILED,
  TRIAL_ENDING,
  PLAN_CHANGED,
];
