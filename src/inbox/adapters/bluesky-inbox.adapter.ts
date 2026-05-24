import { Injectable, Logger } from '@nestjs/common';
import {
  BlueskyService,
  type BlueskyThreadNode,
  type BlueskyThreadPost,
} from '../../channels/services/bluesky.service';
import type {
  CreatedComment,
  FetchedComment,
  PlatformInboxAdapter,
  ResolvedChannel,
} from './inbox-adapter.interface';

/**
 * Bluesky uses the AT Protocol. Comments == replies — every post is just an
 * `app.bsky.feed.post` with an optional `reply` ref. To "comment on a post"
 * is to create a new post whose `reply` points at the target.
 */
@Injectable()
export class BlueskyInboxAdapter implements PlatformInboxAdapter {
  readonly platform = 'bluesky' as const;
  private readonly logger = new Logger(BlueskyInboxAdapter.name);

  constructor(private readonly bluesky: BlueskyService) {}

  // ──────────────────────────────────────────────────────────────────────
  // Fetch — flatten the thread tree into one row per reply.
  //
  // We always resolve the canonical ROOT URI before walking, because a single
  // Schedura thread-mode publish creates multiple Bluesky URIs (the 1/2 +
  // 2/2 chained reply), and depending on how Schedura's composer stores
  // them, the poller might hand us either. If we're handed a chained-reply
  // URI, we have to remap so all the comments group under the SAME inbox
  // thread (the root) instead of duplicating across two threads.
  // ──────────────────────────────────────────────────────────────────────
  async fetchComments(
    channel: ResolvedChannel,
    platformPostId: string,
    since?: Date,
  ): Promise<FetchedComment[]> {
    // Step 1: fetch what we were asked for. If this URI is itself a reply,
    // its `record.reply.root.uri` points at the canonical root. Hop there
    // and re-fetch with the actual root so we see the whole tree.
    let tree;
    try {
      tree = await this.bluesky.getPostThread(
        channel.accessToken,
        platformPostId,
        6,
      );
    } catch (err) {
      // Post deleted / private — graceful empty result.
      this.logger.warn(
        `Bluesky fetchComments: cannot fetch ${platformPostId}: ${(err as Error).message}`,
      );
      return [];
    }

    const replyRef = tree.post?.record?.reply?.root?.uri;
    let canonicalPostId = tree.post?.uri ?? platformPostId;

    if (replyRef && replyRef !== canonicalPostId) {
      this.logger.log(
        `Bluesky fetchComments: ${platformPostId} is a reply; hopping to root ${replyRef}`,
      );
      try {
        tree = await this.bluesky.getPostThread(
          channel.accessToken,
          replyRef,
          6,
        );
        canonicalPostId = tree.post?.uri ?? replyRef;
      } catch (err) {
        // Root deleted — fall back to the original (reply) tree we already
        // have, but keep canonicalPostId = the replyRef so dedup still works.
        this.logger.warn(
          `Bluesky fetchComments: root ${replyRef} not reachable (${(err as Error).message}); using reply subtree`,
        );
        canonicalPostId = replyRef;
      }
    }

    const myDid = resolveDid(channel);
    const result: FetchedComment[] = [];

    // Walk children only — the post itself isn't a "comment".
    if (tree.replies?.length) {
      for (const child of tree.replies) {
        this.walk(child, tree.post.uri, myDid, since, canonicalPostId, result);
      }
    }
    return result;
  }

  private walk(
    node: BlueskyThreadNode,
    parentUri: string,
    myDid: string | undefined,
    since: Date | undefined,
    canonicalPostId: string,
    out: FetchedComment[],
  ): void {
    const post = node.post;
    if (!post) return;
    const createdAt = new Date(post.record.createdAt ?? post.indexedAt);
    if (since && createdAt <= since) {
      // Older than cursor — Bluesky returns full subtree so we still walk
      // children (newer replies could exist under older parents).
    } else {
      out.push({
        platformItemId: post.uri,
        platformParentId: parentUri,
        // Force every comment to group under the canonical root URI, even if
        // the poller's target stored a chained reply URI instead.
        platformPostId: canonicalPostId,
        authorPlatformId: post.author.did,
        authorHandle: post.author.handle,
        authorDisplayName: post.author.displayName ?? post.author.handle,
        authorAvatarUrl: post.author.avatar,
        text: post.record.text ?? '',
        platformCreatedAt: createdAt,
        fromMe: !!myDid && post.author.did === myDid,
        likeCount: post.likeCount ?? 0,
        metadata: { cid: post.cid },
      });
    }

    if (node.replies?.length) {
      for (const child of node.replies) {
        this.walk(child, post.uri, myDid, since, canonicalPostId, out);
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Reply to a specific comment — needs root + parent CIDs from the thread.
  // ──────────────────────────────────────────────────────────────────────
  async replyToComment(
    channel: ResolvedChannel,
    parentCommentId: string,
    parentPlatformPostId: string,
    text: string,
  ): Promise<CreatedComment> {
    const did = resolveDid(channel);
    if (!did) throw new Error('Bluesky channel is missing DID');

    // Fetch the thread of the original post; find the parent comment in it
    // so we can grab both its CID and the root's CID.
    const tree = await this.bluesky.getPostThread(
      channel.accessToken,
      parentPlatformPostId,
      6,
    );

    const rootPost = tree.post;
    const parentPost = findPostByUri(tree, parentCommentId);
    if (!parentPost) {
      throw new Error(
        `Parent comment ${parentCommentId} not found in thread ${parentPlatformPostId}`,
      );
    }

    const created = await this.bluesky.createTextPost(
      channel.accessToken,
      did,
      text,
      {
        root: { uri: rootPost.uri, cid: rootPost.cid },
        parent: { uri: parentPost.uri, cid: parentPost.cid },
      },
    );

    return {
      platformItemId: created.uri,
      platformParentId: parentPost.uri,
      text,
      platformCreatedAt: new Date(),
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  // New top-level comment on a post — needs the post's CID.
  // ──────────────────────────────────────────────────────────────────────
  async commentOnPost(
    channel: ResolvedChannel,
    platformPostId: string,
    text: string,
  ): Promise<CreatedComment> {
    const did = resolveDid(channel);
    if (!did) throw new Error('Bluesky channel is missing DID');

    const [post] = await this.bluesky.getPosts(channel.accessToken, [
      platformPostId,
    ]);
    if (!post) throw new Error(`Post ${platformPostId} not found`);

    const created = await this.bluesky.createTextPost(
      channel.accessToken,
      did,
      text,
      // Shorthand — both root + parent equal the post itself.
      { uri: post.uri, cid: post.cid },
    );

    return {
      platformItemId: created.uri,
      platformParentId: post.uri,
      text,
      platformCreatedAt: new Date(),
    };
  }
}

function resolveDid(channel: ResolvedChannel): string | undefined {
  return (channel.metadata?.did as string | undefined) ?? channel.platformAccountId;
}

function findPostByUri(
  node: BlueskyThreadNode,
  uri: string,
): BlueskyThreadPost | null {
  if (node.post?.uri === uri) return node.post;
  if (node.replies?.length) {
    for (const child of node.replies) {
      const hit = findPostByUri(child, uri);
      if (hit) return hit;
    }
  }
  return null;
}
