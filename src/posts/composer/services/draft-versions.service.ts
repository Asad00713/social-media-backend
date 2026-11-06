import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, notInArray } from 'drizzle-orm';
import type { DbType } from '../../../drizzle/db';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { postHistory, posts } from '../../../drizzle/schema/posts.schema';
import { users } from '../../../drizzle/schema/users.schema';
import {
  MAX_VERSIONS,
  VERSION_ACTION,
  describeChange,
  readVersion,
  sameSnapshot,
  type DraftSnapshot,
  type VersionChange,
  type VersionDetails,
} from '../lib/draft-versions';

export interface DraftVersionDto {
  id: string;
  createdAt: string;
  author: { id: string; name: string; avatarUrl: string | null } | null;
  change: VersionChange;
  /** The caption as it was, for "Copy text". */
  text: string;
  mediaCount: number;
  channelCount: number;
}

export interface DraftVersionsDto {
  /** Restore writes only to a draft; the client says why when it cannot. */
  postStatus: string;
  versions: DraftVersionDto[];
}

/**
 * Version history for a post: one `post_history` row per save whose content
 * changed, holding a snapshot in `details`. No table of its own — the
 * history table already has the post, the author, the time and a jsonb bag,
 * and it cascades with the post.
 *
 * Bounded: a save that changes nothing writes nothing, and every write
 * prunes the post's snapshots to the newest MAX_VERSIONS.
 */
@Injectable()
export class DraftVersionsService {
  private readonly logger = new Logger(DraftVersionsService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /**
   * Record a snapshot after a save. Best effort: the save has already
   * happened, and a history write that fails must not turn it into an error.
   */
  async record(
    postId: string,
    userId: string,
    snapshot: DraftSnapshot,
    opts: { restoredFrom?: string } = {},
  ): Promise<void> {
    try {
      const [latest] = await this.db
        .select({ details: postHistory.details })
        .from(postHistory)
        .where(
          and(
            eq(postHistory.postId, postId),
            eq(postHistory.action, VERSION_ACTION),
          ),
        )
        .orderBy(desc(postHistory.createdAt))
        .limit(1);
      const prev = readVersion(latest?.details);
      if (prev && sameSnapshot(prev.snapshot, snapshot)) return;

      const change: VersionChange = opts.restoredFrom
        ? { kind: 'restored', fromAt: opts.restoredFrom }
        : describeChange(prev?.snapshot ?? null, snapshot);
      const details: VersionDetails = { snapshot, change };
      await this.db.insert(postHistory).values({
        postId,
        action: VERSION_ACTION,
        performedById: userId,
        details,
        // The statement's clock, not the transaction's: "newest" orders
        // these rows, and two saves inside one transaction would tie on now().
        createdAt: new Date(),
      });
      await this.prune(postId);
    } catch (err) {
      this.logger.warn(
        `Version snapshot for post ${postId} failed: ${(err as Error).message}`,
      );
    }
  }

  /** Newest first, at most MAX_VERSIONS. 404 for a post outside the workspace. */
  async list(workspaceId: string, postId: string): Promise<DraftVersionsDto> {
    const post = await this.findPost(workspaceId, postId);
    const rows = await this.db
      .select({
        id: postHistory.id,
        createdAt: postHistory.createdAt,
        details: postHistory.details,
        authorId: users.id,
        authorName: users.name,
        authorEmail: users.email,
        authorAvatar: users.avatarUrl,
      })
      .from(postHistory)
      .leftJoin(users, eq(users.id, postHistory.performedById))
      .where(
        and(
          eq(postHistory.postId, postId),
          eq(postHistory.action, VERSION_ACTION),
        ),
      )
      .orderBy(desc(postHistory.createdAt))
      .limit(MAX_VERSIONS);

    const versions: DraftVersionDto[] = [];
    for (const r of rows) {
      const v = readVersion(r.details);
      if (!v) continue;
      versions.push({
        id: r.id,
        createdAt: new Date(r.createdAt).toISOString(),
        author: r.authorId
          ? {
              id: r.authorId,
              name: r.authorName || r.authorEmail || 'A teammate',
              avatarUrl: r.authorAvatar ?? null,
            }
          : null,
        change: v.change,
        text: v.snapshot.text ?? '',
        mediaCount: v.snapshot.mediaItems?.length ?? 0,
        channelCount: v.snapshot.channels?.length ?? 0,
      });
    }
    return { postStatus: post.status, versions };
  }

  /**
   * The snapshot to write back, and when it was taken. Only a draft can be
   * restored: rewriting a scheduled post through the draft path would drop
   * it to a draft while its job still waits in the queue.
   */
  async loadForRestore(
    workspaceId: string,
    postId: string,
    versionId: string,
  ): Promise<{
    post: { status: string; metadata: unknown };
    snapshot: DraftSnapshot;
    createdAt: string;
  }> {
    const post = await this.findPost(workspaceId, postId);
    if (post.status !== 'draft') {
      throw new ConflictException(
        'Only a draft can be restored. Unschedule the post first.',
      );
    }
    const [row] = await this.db
      .select({
        details: postHistory.details,
        createdAt: postHistory.createdAt,
      })
      .from(postHistory)
      .where(
        and(
          eq(postHistory.id, versionId),
          eq(postHistory.postId, postId),
          eq(postHistory.action, VERSION_ACTION),
        ),
      )
      .limit(1);
    const v = readVersion(row?.details);
    if (!row || !v) throw new NotFoundException('Version not found');
    return {
      post,
      snapshot: v.snapshot,
      createdAt: new Date(row.createdAt).toISOString(),
    };
  }

  private async findPost(
    workspaceId: string,
    postId: string,
  ): Promise<{ status: string; metadata: unknown }> {
    const [post] = await this.db
      .select({ status: posts.status, metadata: posts.metadata })
      .from(posts)
      .where(and(eq(posts.id, postId), eq(posts.workspaceId, workspaceId)))
      .limit(1);
    if (!post) throw new NotFoundException('Post not found');
    return post;
  }

  /** Keep the newest MAX_VERSIONS snapshots; other history rows are untouched. */
  private async prune(postId: string): Promise<void> {
    const keep = this.db
      .select({ id: postHistory.id })
      .from(postHistory)
      .where(
        and(
          eq(postHistory.postId, postId),
          eq(postHistory.action, VERSION_ACTION),
        ),
      )
      .orderBy(desc(postHistory.createdAt))
      .limit(MAX_VERSIONS);
    await this.db
      .delete(postHistory)
      .where(
        and(
          eq(postHistory.postId, postId),
          eq(postHistory.action, VERSION_ACTION),
          notInArray(postHistory.id, keep),
        ),
      );
  }
}
