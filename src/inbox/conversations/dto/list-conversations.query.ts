import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { InboxSort, InboxType, InboxView } from './contract';

const VIEWS = ['to_reply', 'later', 'done', 'scheduled'] as const;
const TYPES = ['all', 'message', 'comment', 'mention'] as const;
const SORTS = ['newest', 'oldest', 'window'] as const;

export class ListConversationsQueryDto {
  @IsOptional()
  @IsIn(VIEWS)
  view?: InboxView = 'to_reply';

  @IsOptional()
  @IsIn(TYPES)
  type?: InboxType = 'all';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === undefined
      ? undefined
      : ((Array.isArray(value) ? value : [value]) as unknown[]).map((v) =>
          typeof v === 'string' && v.trim() !== '' ? Number(v) : v,
        ),
  )
  @IsInt({ each: true })
  @ArrayMaxSize(50)
  channelIds?: number[];

  @IsOptional()
  @IsIn(['me', 'unassigned'])
  assigned?: 'me' | 'unassigned';

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === '1' || value === 'true') return true;
    if (value === '0' || value === 'false') return false;
    return value;
  })
  @IsBoolean()
  unread?: boolean;

  @IsOptional()
  @IsIn(SORTS)
  sort?: InboxSort = 'newest';

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 30;
}
