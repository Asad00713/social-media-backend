import { IsArray, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'

export class GeoCityDto {
  @IsString() key!: string
  @IsOptional() @IsInt() radius?: number
}

export class InterestDto {
  @IsString() id!: string
  @IsString() name!: string
}

export class AudienceDto {
  @IsInt() @Min(13) @Max(65) ageMin!: number
  @IsInt() @Min(13) @Max(65) ageMax!: number
  @IsArray() @IsString({ each: true }) genders!: ('male' | 'female' | 'all')[]
  @IsOptional() @IsArray() @IsString({ each: true }) countries?: string[]
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => GeoCityDto) cities?: GeoCityDto[]
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => InterestDto) interests?: InterestDto[]
}
