import { IsBoolean, IsString, Length } from 'class-validator';

export class LikeCommentDto {
  @IsBoolean()
  liked: boolean;
}

export class HideCommentDto {
  @IsBoolean()
  hidden: boolean;
}

export class PrivateReplyDto {
  @IsString()
  @Length(1, 1000)
  text: string;
}
