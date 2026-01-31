import {
  IsNumber,
  IsOptional,
  IsString,
  IsArray,
  MinLength,
  MaxLength,
} from 'class-validator';

// =============================================================================
// Request DTOs
// =============================================================================

export class GetPostRepliesDto {
  @IsNumber()
  channelId: number;

  @IsString()
  @MinLength(1)
  postId: string; // platformPostId (e.g., tweet ID)

  @IsOptional()
  @IsString()
  paginationToken?: string;

  @IsOptional()
  @IsString()
  sinceId?: string;
}

export class GetMentionsDto {
  @IsNumber()
  channelId: number;

  @IsOptional()
  @IsString()
  paginationToken?: string;

  @IsOptional()
  @IsString()
  sinceId?: string;
}

export class CreateReplyDto {
  @IsNumber()
  channelId: number;

  @IsString()
  @MinLength(1)
  replyToId: string; // The platform post ID to reply to

  @IsString()
  @MinLength(1)
  @MaxLength(25000) // Generous limit; platform-specific limits enforced by providers
  text: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mediaUrls?: string[]; // URLs of media to attach to the reply
}

// =============================================================================
// Response Interfaces
// =============================================================================

export interface CommunityCommentAuthor {
  id: string;
  name: string;
  username: string;
  profileImageUrl: string | null;
}

export interface CommunityCommentMetrics {
  likeCount: number;
  replyCount: number;
  repostCount: number;
}

export interface CommunityComment {
  id: string;
  platform: string;
  text: string;
  createdAt: string;
  author: CommunityCommentAuthor;
  metrics?: CommunityCommentMetrics;
  parentId?: string;
  conversationId?: string;
  platformUrl?: string;
}

export interface CommunityCommentsResponse {
  comments: CommunityComment[];
  pagination: {
    nextToken?: string;
    newestId?: string;
    oldestId?: string;
  };
}

export interface CommunityReplyResponse {
  id: string;
  platform: string;
  text: string;
  createdAt: string;
  platformUrl?: string;
}

export interface FullCommentsResponse {
  audienceComments: CommunityComment[];
  ownerReplies: CommunityComment[];
  thread: CommunityComment[]; // Combined and sorted by createdAt
  pagination: {
    nextToken?: string;
    newestId?: string;
    oldestId?: string;
  };
}
