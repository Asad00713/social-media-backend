/**
 * How long a row stays in the Bin. The Bin shows `purgeAt` with it and the
 * daily cleanup purges by it, so the two always agree.
 */
export const BIN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Rows binned before this instant are due for the cleanup. */
export function binPurgeCutoff(now: Date): Date {
  return new Date(now.getTime() - BIN_RETENTION_MS);
}
