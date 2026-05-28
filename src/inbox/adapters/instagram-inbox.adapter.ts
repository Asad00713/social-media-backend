import { Injectable, Logger } from '@nestjs/common';
import { InstagramService } from '../../channels/services/instagram.service';
import type {
  CreatedComment,
  FetchedComment,
  PlatformInboxAdapter,
  ResolvedChannel,
} from './inbox-adapter.interface';

/**
 * Instagram Business — IG-direct API (graph.instagram.com). Comments are nested
 * one level deep: each top-level comment can have replies, but replies cannot
 * themselves be replied to (Instagram flattens nested-of-nested into the same
 * parent reply set).
 *
 * Required scope: instagram_business_manage_comments.
 */
@Injectable()
export class InstagramInboxAdapter implements PlatformInboxAdapter {
  readonly platform = 'instagram' as const;
  private readonly logger = new Logger(InstagramInboxAdapter.name);

  constructor(private readonly instagram: InstagramService) {}

  async fetchComments(
    channel: ResolvedChannel,
    platformPostId: string,
    since?: Date,
  ): Promise<FetchedComment[]> {
    const comments = await this.instagram.fetchMediaComments(
      channel.accessToken,
      platformPostId,
      since,
    );

    const myIgUserId = channel.platformAccountId;
    return comments.map((c) => ({
      platformItemId: c.id,
      platformParentId: c.parentId,
      authorPlatformId: c.author.id,
      authorHandle: c.author.name,
      authorDisplayName: c.author.name,
      text: c.message,
      platformCreatedAt: c.createdAt,
      fromMe: c.author.id === myIgUserId,
      likeCount: c.likeCount,
    }));
  }

  async replyToComment(
    channel: ResolvedChannel,
    parentCommentId: string,
    _parentPlatformPostId: string,
    text: string,
  ): Promise<CreatedComment> {
    const { commentId } = await this.instagram.replyToCommentWithUserToken(
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
    const { commentId } = await this.instagram.postCommentWithUserToken(
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

  // Phase 2.3 — delete an IG comment authored by the connected business account.
  async deleteComment(
    channel: ResolvedChannel,
    platformItemId: string,
  ): Promise<boolean> {
    return this.instagram.deleteComment(channel.accessToken, platformItemId);
  }
}
