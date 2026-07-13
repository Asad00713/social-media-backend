import { IsISO8601 } from 'class-validator';

/**
 * Query params for `GET /calendar-sync/workspaces/:workspaceId/external-events`.
 * Both bounds are required so the read is always window-bounded.
 */
export class ListExternalEventsDto {
  /** Window start (inclusive), ISO-8601. */
  @IsISO8601()
  from!: string;

  /** Window end (inclusive), ISO-8601. */
  @IsISO8601()
  to!: string;
}
