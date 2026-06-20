import { IsNotEmpty, IsString } from 'class-validator';

export class ConnectTelegramBotDto {
  @IsString()
  @IsNotEmpty()
  token!: string;
}
