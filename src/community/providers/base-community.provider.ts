import { Logger } from '@nestjs/common';
import { SupportedPlatform } from '../../drizzle/schema/channels.schema';
import {
  CommunityCommentsResponse,
  CommunityReplyResponse,
} from '../dto/community.dto';

export interface ChannelOwnerInfo {
  id: string;
  name: string;
  username: string;
  profileImageUrl: string | null;
}

export interface FetchCommentsOptions {
  accessToken: string;
  platformAccountId: string;
  postId: string;
  maxResults?: number;
  paginationToken?: string;
  sinceId?: string;
  ownerInfo?: ChannelOwnerInfo;
}

export interface FetchMentionsOptions {
  accessToken: string;
  platformAccountId: string;
  maxResults?: number;
  paginationToken?: string;
  sinceId?: string;
}

export interface CreateReplyOptions {
  accessToken: string;
  replyToId: string;
  text: string;
  mediaUrls?: string[];
  channelMetadata?: Record<string, any>;
}

export abstract class BaseCommunityProvider {
  protected readonly logger: Logger;
  abstract readonly platform: SupportedPlatform;

  constructor() {
    this.logger = new Logger(this.constructor.name);
  }

  abstract getPostComments(
    options: FetchCommentsOptions,
  ): Promise<CommunityCommentsResponse>;

  abstract getMentions(
    options: FetchMentionsOptions,
  ): Promise<CommunityCommentsResponse>;

  abstract createReply(
    options: CreateReplyOptions,
  ): Promise<CommunityReplyResponse>;
}
