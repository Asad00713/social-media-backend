import { IsIn, IsObject, IsString, IsOptional, IsUUID } from 'class-validator'

export class UpsertDraftDto {
  @IsOptional() @IsUUID() id?: string
  @IsIn(['boost', 'lead_gen']) kind!: 'boost' | 'lead_gen'
  @IsObject() state!: Record<string, unknown>
  @IsString() currentStep!: string
}
