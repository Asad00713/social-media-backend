import { IsString, MinLength, MaxLength } from 'class-validator';
import { SendOptionsDto } from './send-options.dto';

export class ReplyDto extends SendOptionsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  text: string;
}
