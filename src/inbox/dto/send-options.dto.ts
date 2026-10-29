import { IsBoolean, IsISO8601, IsOptional } from 'class-validator';
import type { SendOptions } from '../inbox.service';

/** Body fields every send route accepts besides its content (additive). */
export class SendOptionsDto {
  /** Mark the conversation Done with this send; omitted = the sender's setting. */
  @IsOptional()
  @IsBoolean()
  markDone?: boolean;

  /** When the sender started typing; a teammate's reply after it is a collision. */
  @IsOptional()
  @IsISO8601()
  typingStartedAt?: string;

  /** "Send mine too": skip the collision check. */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

/** Only the keys the client sent, so an absent markDone still defers to settings. */
export function toSendOptions(
  dto: Pick<SendOptionsDto, 'markDone' | 'typingStartedAt' | 'force'>,
): SendOptions {
  const opts: SendOptions = {};
  // `!= null`: an explicit JSON null passes @IsOptional and must mean "not
  // sent", never new Date(null) (the epoch, which would collide with everything).
  if (dto.markDone != null) opts.markDone = dto.markDone;
  if (dto.typingStartedAt != null) {
    opts.typingStartedAt = new Date(dto.typingStartedAt);
  }
  if (dto.force != null) opts.force = dto.force;
  return opts;
}
