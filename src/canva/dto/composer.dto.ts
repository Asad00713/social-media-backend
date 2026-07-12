import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class ListComposerDesignsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  continuation?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  query?: string;
}

export class ImportComposerDesignDto {
  @IsString()
  @MinLength(1)
  designId: string;
}
