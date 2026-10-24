import { IsISO8601 } from 'class-validator';

/** Most days `to` may lie after `from` (the window, measured inclusively). */
export const MAX_SPAN_RANGE_DAYS = 400;

export class SpansQueryDto {
  @IsISO8601()
  from: string;

  @IsISO8601()
  to: string;
}
