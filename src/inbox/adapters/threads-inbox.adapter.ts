import { Injectable, Logger } from '@nestjs/common';
import { ThreadsService } from '../../channels/services/threads.service';
import type {
  CreatedComment,
  FetchedComment,
  PlatformInboxAdapter,
  ResolvedChannel,
} from './inbox-adapter.interface';

/**
 * Threads (Meta) treats replies as standalone threads with `replied_to_id`
 * pointing at the parent. Posting a reply = creating a new thread with
 * `reply_to_id` set.
 */
@Injectable()
export class ThreadsInboxAdapter implements PlatformInboxAdapter {
  readonly platform = 'threads' as const;
  private readonly logger = new Logger(ThreadsInboxAdapter.name);

  constructor(private readonly threads: ThreadsService) {}

  async fetchComments(
    channel: ResolvedChannel,
    platformPostId: string,
    since?: Date,
  ): Promise<FetchedComment[]> {
    const entries = await this.threads.getThreadConversation(
      channel.accessToken,
      platformPostId,
    );

    const myAccountId = channel.platformAccountId;
    const myHandle =
      channel.username?.replace(/^@+/, '').trim() || channel.accountName;
    const myDisplay = channel.accountName;
    const myAvatar = channel.profilePictureUrl ?? undefined;
    const out: FetchedComment[] = [];

    for (const entry of entries) {
      // Conversation endpoint returns the root thread too — skip it.
      if (entry.id === platformPostId) continue;

      const createdAt = new Date(entry.timestamp);
      if (since && createdAt <= since) continue;

      // Threads' /conversation endpoint omits `from` on the original poster's
      // own chained replies (the first-comment we ship with each Schedura
      // post). Without this fallback those rows surface as "Unknown" in the
      // inbox. Heuristic: missing-from on a reply to a thread we own == our
      // own reply, so attribute to the channel identity.
      const isOurs =
        (!!entry.authorId && entry.authorId === myAccountId) ||
        (!entry.authorId && !entry.authorUsername);

      out.push({
        platformItemId: entry.id,
        platformParentId: entry.repliedToId ?? platformPostId,
        authorPlatformId: entry.authorId ?? (isOurs ? myAccountId : undefined),
        authorHandle: entry.authorUsername ?? (isOurs ? myHandle : undefined),
        authorDisplayName:
          entry.authorUsername ?? (isOurs ? myDisplay : undefined),
        authorAvatarUrl: isOurs ? myAvatar : undefined,
        text: entry.text ?? '',
        platformCreatedAt: createdAt,
        fromMe: isOurs,
        likeCount: entry.likeCount,
        metadata: { permalink: entry.permalink, shortcode: entry.shortcode },
      });
    }
    return out;
  }

  async replyToComment(
    channel: ResolvedChannel,
    parentCommentId: string,
    _parentPlatformPostId: string,
    text: string,
  ): Promise<CreatedComment> {
    const { postId } = await this.threads.createTextThread(
      channel.accessToken,
      channel.platformAccountId,
      text,
      parentCommentId,
    );
    return {
      platformItemId: postId,
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
    const { postId } = await this.threads.createTextThread(
      channel.accessToken,
      channel.platformAccountId,
      text,
      platformPostId,
    );
    return {
      platformItemId: postId,
      platformParentId: platformPostId,
      text,
      platformCreatedAt: new Date(),
    };
  }
}
