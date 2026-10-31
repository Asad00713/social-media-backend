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

/**
 * Create a design at a size this post actually needs.
 *
 * Width and height rather than a design-type name: the composer offers
 * the sizes of the channels in the draft (Instagram post 1080x1350, a
 * Story 1080x1920, a Pin 1000x1500), and those come from our own
 * per-platform capabilities, not from Canva's preset list. The legacy
 * `CreateDesignDto` maps a fixed enum of nine names onto six hardcoded
 * sizes, which cannot express "whatever this post needs".
 *
 * Canva's own bounds are 40..8000 px per side; anything outside that is
 * rejected here rather than by a 400 from Canva.
 */
export class CreateComposerDesignDto {
  @Type(() => Number)
  @IsInt()
  @Min(40)
  @Max(8000)
  width: number;

  @Type(() => Number)
  @IsInt()
  @Min(40)
  @Max(8000)
  height: number;

  /** Shown in Canva's own design list, so it is worth naming. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;
}
