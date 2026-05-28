import {
  IsString,
  IsOptional,
  IsISO8601,
  MinLength,
  MaxLength,
} from 'class-validator';

export class UpdateScheduledMessageDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  text?: string;

  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}
