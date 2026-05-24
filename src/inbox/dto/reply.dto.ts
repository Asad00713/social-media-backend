import { IsString, MinLength, MaxLength } from 'class-validator';

export class ReplyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  text: string;
}
