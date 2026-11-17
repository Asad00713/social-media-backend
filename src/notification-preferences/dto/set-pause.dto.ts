import { IsISO8601, Matches, ValidateIf } from 'class-validator';

/**
 * A calendar date, a time of day and an explicit zone: `Z` or `+05:00`. The
 * calendar form is required because `IsISO8601` also accepts week and ordinal
 * dates (`2026-W49-1`, `2026-335`), which `new Date()` cannot parse.
 */
const INSTANT_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * `until` is an ISO 8601 instant that ends the pause, or an explicit `null`
 * that clears it. `@IsOptional()` is deliberately not used: it would also let
 * a missing `until` through, so a malformed body would silently clear the
 * pause. `ValidateIf` skips validation for `null` only; `undefined` and every
 * other non-ISO value fail. The instant must carry a time and a zone, so a
 * bare date or a zone-less time (read as server-local) cannot be sent.
 */
export class SetPauseDto {
  @ValidateIf((o: SetPauseDto) => o.until !== null)
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(INSTANT_WITH_ZONE)
  until: string | null;
}
