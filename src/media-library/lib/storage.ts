import { HttpException } from '@nestjs/common';

export const STORAGE_ALMOST_FULL_PERCENT = 90;

export interface StorageUsage {
  used: number;
  limit: number;
}

/** Used share of the limit, one decimal, capped at 100. */
export function storagePercent(used: number, limit: number): number {
  if (limit <= 0) return used > 0 ? 100 : 0;
  return Math.min(100, Math.round((used / limit) * 1000) / 10);
}

export function storageLevel(
  used: number,
  limit: number,
): 'ok' | 'almost_full' | 'full' {
  if (limit <= 0 || used >= limit) return 'full';
  if (used / limit >= STORAGE_ALMOST_FULL_PERCENT / 100) return 'almost_full';
  return 'ok';
}

/** An empty upload still counts as one byte, so a full workspace refuses it. */
export function wouldExceed(
  used: number,
  incoming: number,
  limit: number,
): boolean {
  return used + Math.max(incoming, 1) > limit;
}

export class StorageFullException extends HttpException {
  constructor(usage: StorageUsage) {
    super(
      {
        code: 'STORAGE_FULL',
        message: 'Storage is full. Free up space or upgrade your plan.',
        used: usage.used,
        limit: usage.limit,
      },
      413,
    );
  }
}
