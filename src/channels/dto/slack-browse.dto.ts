import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

// =============================================================================
// Slack Browse DTOs
// =============================================================================

export class ListSlackChannelsQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includePrivate?: boolean;
}

export class ListSlackMembersQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  query?: string;
}

// =============================================================================
// Slack Action DTOs
// =============================================================================

export class JoinSlackChannelBodyDto {
  @IsString()
  conversationId!: string;
}

export class StartSlackDmBodyDto {
  @IsString()
  userId!: string;

  @IsString()
  @MaxLength(40000)
  text!: string;
}
