import { IsString, IsNotEmpty } from 'class-validator';

/** Body for issuing a Telegram connect deep-link token. */
export class TelegramLinkTokenDto {
  @IsString()
  @IsNotEmpty()
  workspaceId!: string;
}
