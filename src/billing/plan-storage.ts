/**
 * Library storage each plan grants per workspace, in bytes (500 MB, 2 GB,
 * 10 GB, 25 GB). Migration 0054 writes the same values to
 * `plans.storage_bytes_per_workspace`; keep the two in step.
 */
export const PLAN_STORAGE_BYTES = {
  FREE: 524288000,
  BASIC: 2147483648,
  PRO: 10737418240,
  MAX: 26843545600,
} as const;

export const FREE_STORAGE_BYTES = PLAN_STORAGE_BYTES.FREE;
