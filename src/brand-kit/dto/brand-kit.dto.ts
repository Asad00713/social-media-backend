import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type { AdjustPreset } from '../../drizzle/schema/brand-kits.schema';

/** Most swatches the Text tool shows in its one row. */
export const BRAND_COLORS_MAX = 12;
/** Most team presets kept per workspace. */
export const ADJUST_PRESETS_MAX = 20;
export const PRESET_NAME_MAX = 40;
export const ADJUST_VALUE_MIN = -100;
export const ADJUST_VALUE_MAX = 100;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class AdjustValuesDto {
  @IsOptional()
  @IsInt()
  @Min(ADJUST_VALUE_MIN)
  @Max(ADJUST_VALUE_MAX)
  brightness?: number;

  @IsOptional()
  @IsInt()
  @Min(ADJUST_VALUE_MIN)
  @Max(ADJUST_VALUE_MAX)
  contrast?: number;

  @IsOptional()
  @IsInt()
  @Min(ADJUST_VALUE_MIN)
  @Max(ADJUST_VALUE_MAX)
  saturation?: number;

  @IsOptional()
  @IsInt()
  @Min(ADJUST_VALUE_MIN)
  @Max(ADJUST_VALUE_MAX)
  warmth?: number;

  @IsOptional()
  @IsInt()
  @Min(ADJUST_VALUE_MIN)
  @Max(ADJUST_VALUE_MAX)
  highlights?: number;

  @IsOptional()
  @IsInt()
  @Min(ADJUST_VALUE_MIN)
  @Max(ADJUST_VALUE_MAX)
  shadows?: number;

  // No un-sharpen: the slider starts at 0.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(ADJUST_VALUE_MAX)
  sharpen?: number;
}

export class AdjustPresetDto {
  @IsString()
  @Length(1, 40)
  @Matches(/^[A-Za-z0-9_-]+$/)
  id!: string;

  @Transform(trim)
  @IsString()
  @Length(1, PRESET_NAME_MAX)
  name!: string;

  @ValidateNested()
  @Type(() => AdjustValuesDto)
  values!: AdjustValuesDto;
}

/**
 * PUT body. Every field is optional and only the fields sent are changed, so
 * the Text tool saving a colour does not overwrite presets saved meanwhile.
 * Each field is replaced whole.
 */
export class UpdateBrandKitDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(BRAND_COLORS_MAX)
  @Matches(/^#[0-9a-fA-F]{6}$/, {
    each: true,
    message: 'Each colour must be #rrggbb',
  })
  colors?: string[];

  /** A Library image of this workspace, or null to clear the logo. */
  @IsOptional()
  @ValidateIf((o: UpdateBrandKitDto) => o.logoMediaId !== null)
  @IsUUID()
  logoMediaId?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ADJUST_PRESETS_MAX)
  @ValidateNested({ each: true })
  @Type(() => AdjustPresetDto)
  adjustPresets?: AdjustPresetDto[];
}

export interface BrandKitLogoDto {
  mediaId: string;
  url: string;
  name: string;
  width: number | null;
  height: number | null;
}

/** GET/PUT answer. A workspace without a kit gets the empty one. */
export interface BrandKitDto {
  colors: string[];
  logo: BrandKitLogoDto | null;
  adjustPresets: AdjustPreset[];
  /** The caller may change it (ADMIN and OWNER). */
  canEdit: boolean;
}
