import { BadRequestException } from '@nestjs/common';

/** Rows touched per statement by a bulk action. */
export const BULK_CHUNK = 500;

/**
 * A bulk request names its rows one way: an explicit `ids` list, or
 * `selectAll` with the list's filter. Both, or neither, is a 400.
 */
export function assertIdsXorSelectAll(dto: {
  ids?: string[];
  selectAll?: unknown;
}): void {
  const hasIds = dto.ids !== undefined;
  const hasSelectAll = dto.selectAll !== undefined;
  if (hasIds === hasSelectAll) {
    throw new BadRequestException('Send ids or selectAll, not both');
  }
}

/** Splits `xs` into consecutive runs of at most `size`. */
export function chunk<T>(xs: T[], size = BULK_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) {
    out.push(xs.slice(i, i + size));
  }
  return out;
}
