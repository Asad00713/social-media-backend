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
  // A size that is not a finite number is refused, never waved through.
  return !Number.isFinite(incoming) || used + Math.max(incoming, 1) > limit;
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

/** 400: a registered file is not in storage (yet); the size cannot be read. */
export class UploadNotFinishedException extends HttpException {
  constructor() {
    super({ code: 'UPLOAD_NOT_FINISHED', message: 'Upload not finished' }, 400);
  }
}

/** 503: the store could not report the size; the save can be retried. */
export class SizeUnavailableException extends HttpException {
  constructor() {
    super(
      {
        code: 'SIZE_UNAVAILABLE',
        message: 'Could not check the file size. Try again in a moment.',
      },
      503,
    );
  }
}

/**
 * 409: Cloudinary returned an asset that already existed under the chosen
 * public id. It is not ours to save or delete.
 */
export class UploadConflictException extends HttpException {
  constructor() {
    super(
      {
        code: 'UPLOAD_CONFLICT',
        message: 'The upload clashed with an existing file. Try again.',
      },
      409,
    );
  }
}
