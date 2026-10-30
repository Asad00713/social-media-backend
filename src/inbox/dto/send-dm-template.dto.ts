import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class SendDmTemplateDto {
  @IsString()
  @MaxLength(512)
  name: string;

  @IsString()
  @MaxLength(32)
  language: string;

  /** Mark the conversation Done with this send; omitted = the sender's setting. */
  @IsOptional()
  @IsBoolean()
  markDone?: boolean;
}
