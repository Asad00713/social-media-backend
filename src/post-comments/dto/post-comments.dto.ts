import { Transform } from 'class-transformer';
import { IsBoolean, IsString, Length } from 'class-validator';
import { POST_COMMENT_MAX } from '../../drizzle/schema/post-comments.schema';

export class CreatePostCommentDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, POST_COMMENT_MAX)
  body!: string;
}

export class UpdatePostCommentDto {
  @IsBoolean()
  resolved!: boolean;
}

export interface PostCommentAuthor {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/** One comment as the API returns it. */
export interface PostCommentDto {
  id: string;
  postId: string;
  body: string;
  createdAt: string;
  resolvedAt: string | null;
  /** Null once the author's account is deleted. */
  author: PostCommentAuthor | null;
  /** The caller may delete it: its author, or an admin. */
  canDelete: boolean;
}
