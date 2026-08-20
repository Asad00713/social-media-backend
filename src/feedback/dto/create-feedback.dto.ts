import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { FEEDBACK_TYPE } from 'src/drizzle/schema';
import type { FeedbackType } from 'src/drizzle/schema';

export class CreateFeedbackDto {
  @IsEnum(FEEDBACK_TYPE)
  type: FeedbackType;

  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @IsOptional()
  @IsString()
  comment?: string;
}
