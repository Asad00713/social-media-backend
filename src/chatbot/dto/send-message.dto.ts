import { IsString, IsNotEmpty, IsOptional, IsUUID } from 'class-validator';

export class SendMessageDto {
  @IsString()
  @IsNotEmpty()
  message: string;

  /** Optional: current page/route the user is on (for navigation context) */
  @IsString()
  @IsOptional()
  currentRoute?: string;

  /** Optional: ID of a message the user is replying to (quote/reference) */
  @IsUUID()
  @IsOptional()
  replyToMessageId?: string;
}
