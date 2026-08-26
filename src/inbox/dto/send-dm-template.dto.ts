import { IsString, MaxLength } from 'class-validator';

export class SendDmTemplateDto {
  @IsString()
  @MaxLength(512)
  name: string;

  @IsString()
  @MaxLength(32)
  language: string;
}
