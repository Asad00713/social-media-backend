import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import type { BrowseKind } from '../media-sources.types';

export class BrowseSourceDto {
  @IsIn(['media', 'images', 'videos', 'folders', 'search'])
  kind: BrowseKind;

  @IsOptional()
  @IsString()
  path?: string;

  @IsOptional()
  @IsString()
  query?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
