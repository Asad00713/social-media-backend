import { IsArray, IsOptional, IsString } from 'class-validator';

export class PublishDraftDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  channelIds?: string[];
}
