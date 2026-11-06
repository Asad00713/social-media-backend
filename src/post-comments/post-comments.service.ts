import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { posts } from '../drizzle/schema/posts.schema';
import { postComments } from '../drizzle/schema/post-comments.schema';
import { users } from '../drizzle/schema/users.schema';
import type { CallerRole } from '../posts/guest-rules';
import { roleCan } from '../workspace-members/role-capabilities';
import type { PostCommentDto } from './dto/post-comments.dto';

/**
 * True when Postgres says the table does not exist (42P01): the code is
 * deployed but 0058 is not applied yet. drizzle wraps driver errors, so the
 * code may sit on `cause`.
 */
export function isMissingTable(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; e && i < 3; i++) {
    if ((e as { code?: unknown }).code === '42P01') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

const NOT_READY = 'Comments are not available yet. Try again shortly.';

/** Who may delete someone else's comment (ADMIN and OWNER). */
const MODERATE_CAPABILITY = 'team:manage' as const;

const canModerate = (role: CallerRole): boolean =>
  role === 'SUPER_ADMIN' ||
  (role !== undefined && roleCan(role, MODERATE_CAPABILITY));

type Author = { name: string; avatarUrl: string | null };

/**
 * Team comments on a post. Every read and write is scoped to the workspace
 * in the path and to a post of that workspace; the route guard has already
 * checked the caller is a member.
 */
@Injectable()
export class PostCommentsService {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /** Oldest first. An empty thread if the table is not there yet. */
  async list(
    workspaceId: string,
    postId: string,
    userId: string,
    role: CallerRole,
  ): Promise<PostCommentDto[]> {
    await this.assertPost(workspaceId, postId);
    try {
      const rows = await this.db
        .select({
          comment: postComments,
          authorName: users.name,
          authorEmail: users.email,
          authorAvatar: users.avatarUrl,
        })
        .from(postComments)
        .leftJoin(users, eq(users.id, postComments.userId))
        .where(
          and(
            eq(postComments.postId, postId),
            eq(postComments.workspaceId, workspaceId),
          ),
        )
        .orderBy(asc(postComments.createdAt), asc(postComments.id));
      return rows.map((r) =>
        this.present(
          r.comment,
          r.comment.userId
            ? {
                name: r.authorName || r.authorEmail || 'A teammate',
                avatarUrl: r.authorAvatar ?? null,
              }
            : null,
          userId,
          role,
        ),
      );
    } catch (err) {
      if (isMissingTable(err)) return [];
      throw err;
    }
  }

  async create(
    workspaceId: string,
    postId: string,
    userId: string,
    role: CallerRole,
    body: string,
  ): Promise<PostCommentDto> {
    await this.assertPost(workspaceId, postId);
    const [row] = await this.write(() =>
      this.db
        .insert(postComments)
        .values({ postId, workspaceId, userId, body })
        .returning(),
    );
    return this.present(row, await this.authorOf(userId), userId, role);
  }

  /** Resolve or reopen. Anyone who can see the thread may. */
  async setResolved(
    workspaceId: string,
    postId: string,
    commentId: string,
    userId: string,
    role: CallerRole,
    resolved: boolean,
  ): Promise<PostCommentDto> {
    const [row] = await this.write(() =>
      this.db
        .update(postComments)
        .set({ resolvedAt: resolved ? new Date() : null })
        .where(this.oneComment(workspaceId, postId, commentId))
        .returning(),
    );
    if (!row) throw new NotFoundException('Comment not found');
    const author = row.userId ? await this.authorOf(row.userId) : null;
    return this.present(row, author, userId, role);
  }

  /** The author may delete their own comment; an admin may delete any. */
  async remove(
    workspaceId: string,
    postId: string,
    commentId: string,
    userId: string,
    role: CallerRole,
  ): Promise<void> {
    const [row] = await this.write(() =>
      this.db
        .select({ userId: postComments.userId })
        .from(postComments)
        .where(this.oneComment(workspaceId, postId, commentId)),
    );
    if (!row) throw new NotFoundException('Comment not found');
    if (row.userId !== userId && !canModerate(role)) {
      throw new ForbiddenException('Only its author or an admin can delete it');
    }
    await this.db
      .delete(postComments)
      .where(this.oneComment(workspaceId, postId, commentId));
  }

  // ---------------------------------------------------------------------------

  private oneComment(workspaceId: string, postId: string, commentId: string) {
    return and(
      eq(postComments.id, commentId),
      eq(postComments.postId, postId),
      eq(postComments.workspaceId, workspaceId),
    );
  }

  /** 404 unless the post exists in this workspace. */
  private async assertPost(workspaceId: string, postId: string): Promise<void> {
    const [post] = await this.db
      .select({ id: posts.id })
      .from(posts)
      .where(and(eq(posts.id, postId), eq(posts.workspaceId, workspaceId)));
    if (!post) throw new NotFoundException('Post not found');
  }

  private async authorOf(userId: string): Promise<Author> {
    const [me] = await this.db
      .select({ name: users.name, email: users.email, avatar: users.avatarUrl })
      .from(users)
      .where(eq(users.id, userId));
    return {
      name: me?.name || me?.email || 'A teammate',
      avatarUrl: me?.avatar ?? null,
    };
  }

  /** A write against a table that is not there yet is a clear 503. */
  private async write<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (isMissingTable(err)) throw new ServiceUnavailableException(NOT_READY);
      throw err;
    }
  }

  private present(
    row: typeof postComments.$inferSelect,
    author: Author | null,
    userId: string,
    role: CallerRole,
  ): PostCommentDto {
    return {
      id: row.id,
      postId: row.postId,
      body: row.body,
      createdAt: row.createdAt.toISOString(),
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      author: row.userId && author ? { id: row.userId, ...author } : null,
      canDelete: row.userId === userId || canModerate(role),
    };
  }
}
