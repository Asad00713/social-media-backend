import { IsString, IsOptional, IsInt, IsIn, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateConversationDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  workspaceId: string;
}

export class ConversationQueryDto {
  @IsString()
  workspaceId: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}

export class MessageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}

export class MessageFeedbackDto {
  @IsString()
  @IsIn(['good', 'bad'])
  rating: 'good' | 'bad';

  @IsString()
  @IsOptional()
  comment?: string;
}

export class UsageQueryDto {
  @IsString()
  workspaceId: string;
}

export class SearchConversationsDto {
  @IsString()
  workspaceId: string;

  @IsString()
  q: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;
}
