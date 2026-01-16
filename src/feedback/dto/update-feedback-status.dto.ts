import { IsEnum, IsOptional, IsString } from 'class-validator';
import { FEEDBACK_STATUS } from 'src/drizzle/schema';
import type { FeedbackStatus } from 'src/drizzle/schema';

export class UpdateFeedbackStatusDto {
  @IsEnum(FEEDBACK_STATUS)
  status: FeedbackStatus;

  @IsOptional()
  @IsString()
  adminNotes?: string;
}
