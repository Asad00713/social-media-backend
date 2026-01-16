import { IsEnum, IsOptional, IsString } from 'class-validator';
import { FEEDBACK_STATUS } from 'src/drizzle/schema';

export class UpdateFeedbackStatusDto {
  @IsEnum(FEEDBACK_STATUS)
  status: 'pending' | 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  adminNotes?: string;
}
