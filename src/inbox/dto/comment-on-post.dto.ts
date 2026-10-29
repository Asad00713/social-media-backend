import { IsString, MaxLength, MinLength } from 'class-validator';

/** A new top-level comment: `{ text }` only (markDone does not apply). */
export class CommentOnPostDto {
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  text: string;
}
