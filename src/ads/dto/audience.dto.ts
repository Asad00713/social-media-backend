import { IsArray, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'

export class GeoCityDto {
  @IsString() key!: string
  @IsOptional() @IsInt() radius?: number
}

export class TargetingItemDto {
  @IsString() id!: string
  @IsString() name!: string
}

// kept as a named alias so call sites that imported InterestDto still compile
export class InterestDto extends TargetingItemDto {}

export class AudienceDto {
  @IsInt() @Min(13) @Max(65) ageMin!: number
  @IsInt() @Min(13) @Max(65) ageMax!: number
  @IsArray() @IsString({ each: true }) genders!: ('male' | 'female' | 'all')[]
  @IsOptional() @IsArray() @IsString({ each: true }) countries?: string[]
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => GeoCityDto) cities?: GeoCityDto[]
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => InterestDto) interests?: InterestDto[]
  // === New in Wave 2.0 ===
  /** Meta locale IDs (e.g. 6 = English, 1031 = Urdu). Empty array = no restriction. */
  @IsOptional() @IsArray() @IsInt({ each: true }) languages?: number[]
  /** Behaviour targeting items (Meta returns id+name from /search?type=adTargetingCategory&class=behaviors). */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => TargetingItemDto) behaviors?: TargetingItemDto[]
  /** Demographics targeting items (same endpoint, class=demographics). */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => TargetingItemDto) demographics?: TargetingItemDto[]
}
