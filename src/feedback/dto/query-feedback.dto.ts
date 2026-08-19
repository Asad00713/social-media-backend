import { IsEnum, IsOptional } from 'class-validator';
import { FEEDBACK_TYPE } from 'src/drizzle/schema';
import type { FeedbackType } from 'src/drizzle/schema';

/**
 * Optional `?type=` filter shared by the public list, the public stats, and
 * the admin list. The public endpoints default to `app` in the controller;
 * the admin list has no default so admins see everything.
 */
export class QueryFeedbackDto {
  @IsOptional()
  @IsEnum(FEEDBACK_TYPE)
  type?: FeedbackType;
}
