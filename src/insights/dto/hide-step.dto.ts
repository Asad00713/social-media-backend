import { IsIn } from 'class-validator';
import {
  HIDE_REASONS,
  type HideReason,
} from '../../drizzle/schema/insight-hidden-steps.schema';

/** POST /next-steps/:id/hide: why the card goes away, which says for how long. */
export class HideStepDto {
  @IsIn(HIDE_REASONS)
  reason: HideReason;
}
