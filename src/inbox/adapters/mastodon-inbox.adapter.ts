import { Injectable, Logger } from '@nestjs/common';
import { MastodonService } from '../../channels/services/mastodon.service';
import type {
  CreatedComment,
  FetchedComment,
  PlatformInboxAdapter,
  ResolvedChannel,
} from './inbox-adapter.interface';

/**
 * Mastodon comments use the standard status API — replies are statuses with
 * `in_reply_to_id` set. Threading is flat: each reply points to its parent,
 * but `/statuses/:id/context` returns the entire descendant list in order.
 */
@Injectable()
export class MastodonInboxAdapter implements PlatformInboxAdapter {
  readonly platform = 'mastodon' as const;
  private readonly logger = new Logger(MastodonInboxAdapter.name);

  constructor(private readonly mastodon: MastodonService) {}

  async fetchComments(
    channel: ResolvedChannel,
    platformPostId: string,
    since?: Date,
  ): Promise<FetchedComment[]> {
    const instanceUrl = resolveInstanceUrl(channel);
    if (!instanceUrl) throw new Error('Mastodon channel is missing instanceUrl');

    const { descendants } = await this.mastodon.getStatusContext(
      instanceUrl,
      channel.accessToken,
      platformPostId,
    );

    const myAccountId = channel.platformAccountId;
    const out: FetchedComment[] = [];

    for (const node of descendants) {
      const createdAt = new Date(node.created_at);
      if (since && createdAt <= since) continue;

      out.push({
        platformItemId: node.id,
        // Parent is the immediate reply target; for top-level replies that's
        // the original post (== platformPostId).
        platformParentId: node.in_reply_to_id ?? platformPostId,
        authorPlatformId: node.account.id,
        authorHandle: node.account.acct,
        authorDisplayName: node.account.display_name || node.account.username,
        authorAvatarUrl: node.account.avatar,
        text: stripHtml(node.content),
        platformCreatedAt: createdAt,
        fromMe: node.account.id === myAccountId,
        likeCount: node.favourites_count ?? 0,
        metadata: { url: node.url },
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
    const instanceUrl = resolveInstanceUrl(channel);
    if (!instanceUrl) throw new Error('Mastodon channel is missing instanceUrl');

    const created = await this.mastodon.createStatus(
      instanceUrl,
      channel.accessToken,
      text,
      { inReplyToId: parentCommentId },
    );

    return {
      platformItemId: created.id,
      platformParentId: parentCommentId,
      text,
      platformCreatedAt: new Date(created.createdAt),
    };
  }

  async commentOnPost(
    channel: ResolvedChannel,
    platformPostId: string,
    text: string,
  ): Promise<CreatedComment> {
    const instanceUrl = resolveInstanceUrl(channel);
    if (!instanceUrl) throw new Error('Mastodon channel is missing instanceUrl');

    const created = await this.mastodon.createStatus(
      instanceUrl,
      channel.accessToken,
      text,
      { inReplyToId: platformPostId },
    );

    return {
      platformItemId: created.id,
      platformParentId: platformPostId,
      text,
      platformCreatedAt: new Date(created.createdAt),
    };
  }
}

function resolveInstanceUrl(channel: ResolvedChannel): string | undefined {
  return (
    (channel.metadata?.instanceUrl as string | undefined) ??
    (channel.metadata?.instance as string | undefined)
  );
}

/** Mastodon returns HTML — strip tags for our inbox text. Preserves whitespace. */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
