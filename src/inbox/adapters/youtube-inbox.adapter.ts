import { Injectable, Logger } from '@nestjs/common';
import {
  YouTubeService,
  type YouTubeComment,
  type YouTubeCommentThread,
} from '../../channels/services/youtube.service';
import type {
  CreatedComment,
  FetchedComment,
  PlatformInboxAdapter,
  ResolvedChannel,
} from './inbox-adapter.interface';

/**
 * YouTube comments come in two layers:
 *   - top-level comments (commentThread.snippet.topLevelComment)
 *   - replies to that top-level comment (commentThread.replies.comments)
 *
 * Replies-of-replies do not exist on YouTube — every reply parents the
 * thread's top-level comment, never another reply. Our `platformParentId`
 * therefore always points to a top-level comment.
 */
@Injectable()
export class YoutubeInboxAdapter implements PlatformInboxAdapter {
  readonly platform = 'youtube' as const;
  private readonly logger = new Logger(YoutubeInboxAdapter.name);

  constructor(private readonly youtube: YouTubeService) {}

  async fetchComments(
    channel: ResolvedChannel,
    platformPostId: string,
    since?: Date,
  ): Promise<FetchedComment[]> {
    const threads = await this.youtube.fetchVideoComments(
      channel.accessToken,
      platformPostId,
    );

    const myChannelId = channel.platformAccountId;
    const out: FetchedComment[] = [];

    for (const thread of threads) {
      const top = thread.snippet.topLevelComment;
      const topRow = this.toRow(top, /*parentId*/ null, myChannelId, since);
      if (topRow) out.push(topRow);

      if (thread.replies?.comments?.length) {
        for (const reply of thread.replies.comments) {
          const row = this.toRow(reply, top.id, myChannelId, since);
          if (row) out.push(row);
        }
      }
    }
    return out;
  }

  private toRow(
    comment: YouTubeComment,
    parentId: string | null,
    myChannelId: string,
    since?: Date,
  ): FetchedComment | null {
    const createdAt = new Date(comment.snippet.publishedAt);
    if (since && createdAt <= since) return null;

    const authorChannelId = comment.snippet.authorChannelId?.value;
    // YouTube's "authorDisplayName" already includes the `@` prefix for the
    // new channel-handle format (e.g. `@Asad-k5p6g`). Storing that as our
    // handle would render as `@@Asad-k5p6g` downstream — strip the leading `@`.
    const rawDisplayName = comment.snippet.authorDisplayName ?? '';
    const normalizedHandle = rawDisplayName.replace(/^@+/, '').trim();
    return {
      platformItemId: comment.id,
      platformParentId: parentId,
      authorPlatformId: authorChannelId,
      authorHandle: normalizedHandle || rawDisplayName,
      authorDisplayName: rawDisplayName,
      authorAvatarUrl: comment.snippet.authorProfileImageUrl,
      text: comment.snippet.textOriginal ?? comment.snippet.textDisplay ?? '',
      platformCreatedAt: createdAt,
      fromMe: !!authorChannelId && authorChannelId === myChannelId,
      likeCount: comment.snippet.likeCount ?? 0,
      metadata: {
        updatedAt: comment.snippet.updatedAt,
        authorChannelUrl: comment.snippet.authorChannelUrl,
      },
    };
  }

  async replyToComment(
    channel: ResolvedChannel,
    parentCommentId: string,
    _parentPlatformPostId: string,
    text: string,
  ): Promise<CreatedComment> {
    // YouTube replies always parent the TOP-LEVEL comment id; nested replies
    // can't exist. If a caller hands us a nested-reply id we'd get a 400.
    // Our DB shape already enforces this (replies' platformParentId is the
    // top-level), so we just forward.
    const { commentId } = await this.youtube.replyToComment(
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
    const { commentId } = await this.youtube.postComment(
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

  // Phase 2.3 — YouTube only allows deleting comments authored by the
  // authenticated channel. Requires youtube.force-ssl scope.
  async deleteComment(
    channel: ResolvedChannel,
    platformItemId: string,
  ): Promise<boolean> {
    return this.youtube.deleteComment(channel.accessToken, platformItemId);
  }
}
