import { IsBoolean } from 'class-validator';

export class HideDto {
  @IsBoolean()
  hidden: boolean;
}
