import { Injectable, Logger } from '@nestjs/common';
import { FacebookService } from '../../channels/services/facebook.service';
import type {
  CreatedComment,
  FetchedComment,
  PlatformInboxAdapter,
  ResolvedChannel,
} from './inbox-adapter.interface';

/**
 * Facebook Pages — comments live under each post. We use the Page access token
 * (channel.accessToken is already that for FB Page channels) for both reads
 * and writes.
 *
 * Required scopes: pages_read_user_content + pages_manage_engagement.
 */
@Injectable()
export class FacebookInboxAdapter implements PlatformInboxAdapter {
  readonly platform = 'facebook' as const;
  private readonly logger = new Logger(FacebookInboxAdapter.name);

  constructor(private readonly facebook: FacebookService) {}

  async fetchComments(
    channel: ResolvedChannel,
    platformPostId: string,
    since?: Date,
  ): Promise<FetchedComment[]> {
    const comments = await this.facebook.fetchPostComments(
      channel.accessToken,
      platformPostId,
      since,
    );

    const myPageId = channel.platformAccountId;
    return comments.map((c) => ({
      platformItemId: c.id,
      platformParentId: c.parentId,
      authorPlatformId: c.author.id,
      authorHandle: c.author.id, // FB doesn't expose stable @-handles for non-Page commenters
      authorDisplayName: c.author.name,
      authorAvatarUrl: c.author.pictureUrl,
      text: c.message,
      platformCreatedAt: c.createdAt,
      fromMe: c.author.id === myPageId,
      likeCount: c.likeCount,
    }));
  }

  async replyToComment(
    channel: ResolvedChannel,
    parentCommentId: string,
    _parentPlatformPostId: string,
    text: string,
  ): Promise<CreatedComment> {
    const { commentId } = await this.facebook.replyToComment(
      channel.accessToken,
      parentCommentId,
      text,
    );
    return {
      platformItemId: commentId,
      platformParentId: parentCommentId,
      text,
      platformCreatedAt: new Date(),
    };
  }

  async commentOnPost(
    channel: ResolvedChannel,
    platformPostId: string,
    text: string,
  ): Promise<CreatedComment> {
    const { commentId } = await this.facebook.postComment(
      channel.platformAccountId,
      channel.accessToken,
      platformPostId,
      text,
    );
    return {
      platformItemId: commentId,
      platformParentId: null,
      text,
      platformCreatedAt: new Date(),
    };
  }

  // Phase 2.3 — delete a comment authored by the page.
  async deleteComment(
    channel: ResolvedChannel,
    platformItemId: string,
  ): Promise<boolean> {
    return this.facebook.deleteComment(channel.accessToken, platformItemId);
  }
}
