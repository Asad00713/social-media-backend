import { IsEnum } from 'class-validator';
import { FEEDBACK_TYPE } from 'src/drizzle/schema';
import type { FeedbackType } from 'src/drizzle/schema';

export class DismissFeedbackDto {
  @IsEnum(FEEDBACK_TYPE)
  type: FeedbackType;
}
