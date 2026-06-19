import { IsString, MaxLength, MinLength } from 'class-validator';

// =============================================================================
// Discord Compose DTOs — post to a channel + create a channel
// =============================================================================

export class SendDiscordMessageBodyDto {
  /** Discord channel id (snowflake) to post into. */
  @IsString()
  conversationId!: string;

  /** Message body. Discord enforces a 2000-char limit per message. */
  @IsString()
  @MaxLength(2000)
  text!: string;
}

export class CreateDiscordChannelBodyDto {
  /** Channel name. Discord lowercases + replaces spaces with hyphens for text
   *  channels; we keep validation permissive and let Discord normalize. */
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;
}
