import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

/** Optional body of `POST /posts/workspaces/:ws/:postId/duplicate`. */
export class DuplicatePostDto {
  /** Keep only the target on this channel. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  channelId?: number;

  /** Copy no targets: caption and media only. */
  @IsOptional()
  @IsBoolean()
  noTargets?: boolean;
}
