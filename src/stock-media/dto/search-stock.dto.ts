import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import type { StockMediaType, StockProvider } from '../stock-media.types';

export class SearchStockDto {
  @IsIn(['unsplash', 'pexels'])
  provider: StockProvider;

  @IsIn(['image', 'video'])
  type: StockMediaType;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  perPage?: number;
}
