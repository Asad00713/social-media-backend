import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  count,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  sql,
} from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { posts, postHistory } from '../../drizzle/schema/posts.schema';
import { users } from '../../drizzle/schema/users.schema';
import { workspace } from '../../drizzle/schema/workspace.schema';
import { workspaceInvitation } from '../../drizzle/schema/workspace-invitation.schema';
import { NotificationEmitterService } from '../../notifications/notification-emitter.service';
import type { DraftsPageDto } from '../dto/draft-ops.dto';
import type { PlannerPostDto } from '../dto/planner-post.dto';
import { isViewer, type CallerRole } from '../guest-rules';
import { buildDuplicate } from '../lib/duplicate-post';
import { decodeDraftCursor, encodeDraftCursor } from '../lib/draft-cursor';
import { PlannerPostsService } from './planner-posts.service';

/** Ready drafts first. */
const readySql = sql<number>`(${posts.readyAt} IS NOT NULL)::int`;
/** Millisecond sort key: one precision on both sides of the comparison. */
const updatedMsSql = sql<string>`floor(extract(epoch from ${posts.updatedAt}) * 1000)::bigint`;

/** Longest post excerpt put into a notification line. */
export const READY_PREVIEW_MAX = 80;

/** One-line excerpt, at most READY_PREVIEW_MAX characters including the ellipsis. */
export function readyPreview(content: string | null | undefined): string {
  const flat = (content ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return 'Untitled draft';
  return flat.length > READY_PREVIEW_MAX
    ? `${flat.slice(0, READY_PREVIEW_MAX - 1).trimEnd()}…`
    : flat;
}

@Injectable()
export class PostDraftsService {
  private readonly logger = new Logger(PostDraftsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly planner: PlannerPostsService,
    private readonly notifications: NotificationEmitterService,
  ) {}

  /**
   * Flag a draft ready (or clear the flag). Never touches `updated_at`: the
   * Drafts panel shows and sorts on "Edited", and a flag is not an edit.
   * Only a real transition records history and notifies, so a repeat call
   * is silent.
   */
  async setReady(
    workspaceId: string,
    postId: string,
    userId: string,
    role: CallerRole,
    ready: boolean,
  ): Promise<PlannerPostDto> {
    const [post] = await this.db
      .select({
        id: posts.id,
        status: posts.status,
        createdById: posts.createdById,
        content: posts.content,
      })
      .from(posts)
      .where(and(eq(posts.id, postId), eq(posts.workspaceId, workspaceId)));
    if (!post) throw new NotFoundException('Post not found');
    if (post.status !== 'draft') {
      throw new BadRequestException('Only drafts can be marked ready');
    }
    if (isViewer(role)) this.assertViewerOwnsDraft(post, userId);

    // The WHERE makes the transition atomic: two concurrent "ready" clicks
    // cannot both see a row come back. The flag and its history commit
    // together: a failed history write must not leave the flag set, or a
    // retry would find nothing to change and the history would be lost.
    const changed = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(posts)
        .set(
          ready
            ? { readyAt: sql`now()`, readyById: userId }
            : { readyAt: null, readyById: null },
        )
        .where(
          and(
            eq(posts.id, postId),
            eq(posts.workspaceId, workspaceId),
            eq(posts.status, 'draft'),
            ready ? isNull(posts.readyAt) : isNotNull(posts.readyAt),
          ),
        )
        .returning({ id: posts.id });
      if (rows.length > 0) {
        await tx.insert(postHistory).values({
          postId,
          action: ready ? 'marked_ready' : 'unmarked_ready',
          previousStatus: 'draft',
          newStatus: 'draft',
          performedById: userId,
        });
      }
      return rows.length > 0;
    });

    // Only after the commit: nobody is told about a flag that rolled back.
    if (changed && ready) {
      await this.notifyReady(workspaceId, postId, userId, post.content);
    }
    return this.planner.getOne(workspaceId, postId);
  }

  /**
   * "Copy to a new draft": any member, Guest included, may copy any post in
   * the workspace. The source is looked up inside the workspace, so another
   * tenant's id is a 404 and inserts nothing.
   */
  async duplicate(
    workspaceId: string,
    postId: string,
    userId: string,
  ): Promise<PlannerPostDto> {
    const [source] = await this.db
      .select()
      .from(posts)
      .where(and(eq(posts.id, postId), eq(posts.workspaceId, workspaceId)));
    if (!source) throw new NotFoundException('Post not found');
    const [created] = await this.db
      .insert(posts)
      .values(buildDuplicate(source, userId))
      .returning({ id: posts.id });
    return this.planner.getOne(workspaceId, created.id);
  }

  /** A viewer may only change their own drafts. */
  private assertViewerOwnsDraft(
    post: { createdById: string | null },
    userId: string,
  ): void {
    if (post.createdById !== userId) {
      throw new ForbiddenException('Viewers can only change their own drafts');
    }
  }

  /** Best effort: a notification failure must never undo the flag. */
  private async notifyReady(
    workspaceId: string,
    postId: string,
    actorId: string,
    content: string | null,
  ): Promise<void> {
    try {
      const recipients = (await this.memberUserIds(workspaceId)).filter(
        (id) => id !== actorId,
      );
      if (recipients.length === 0) return;
      const [actor] = await this.db
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, actorId));
      const markedByName = actor?.name || actor?.email || 'A teammate';
      const preview = readyPreview(content);
      await Promise.all(
        recipients.map(async (id) => {
          try {
            await this.notifications.draftReady(id, {
              workspaceId,
              postId,
              markedByName,
              preview,
            });
          } catch (err) {
            this.logger.warn(
              `draft_ready notification to ${id} failed: ${(err as Error).message}`,
            );
          }
        }),
      );
    } catch (err) {
      this.logger.warn(
        `draft_ready fan-out for post ${postId} failed: ${(err as Error).message}`,
      );
    }
  }

  /** Owner plus accepted ADMIN and MEMBER invitees (MEMBER+). */
  private async memberUserIds(workspaceId: string): Promise<string[]> {
    const [owner] = await this.db
      .select({ id: workspace.ownerId })
      .from(workspace)
      .where(eq(workspace.id, workspaceId));
    const invited = await this.db
      .select({ id: workspaceInvitation.userId })
      .from(workspaceInvitation)
      .where(
        and(
          eq(workspaceInvitation.workspaceId, workspaceId),
          eq(workspaceInvitation.status, 'ACCEPTED'),
          inArray(workspaceInvitation.role, ['ADMIN', 'MEMBER']),
        ),
      );
    const ids = new Set<string>();
    if (owner?.id) ids.add(owner.id);
    for (const r of invited) if (r.id) ids.add(r.id);
    return [...ids];
  }

  async list(
    workspaceId: string,
    q: { limit: number; cursor?: string },
  ): Promise<DraftsPageDto> {
    const base = and(
      eq(posts.workspaceId, workspaceId),
      eq(posts.status, 'draft'),
    );
    const cursor = q.cursor ? decodeDraftCursor(q.cursor) : null;
    const keyset = cursor
      ? sql`(${readySql}, ${updatedMsSql}, ${posts.id}) < (${cursor.ready}::int, ${cursor.updatedMs}::bigint, ${cursor.id}::uuid)`
      : undefined;

    const [rows, [totalRow]] = await Promise.all([
      this.db
        .select({
          post: getTableColumns(posts),
          ready: readySql.as('ready'),
          updatedMs: updatedMsSql.as('updated_ms'),
        })
        .from(posts)
        .where(and(base, keyset))
        .orderBy(
          sql`${readySql} DESC`,
          sql`${updatedMsSql} DESC`,
          sql`${posts.id} DESC`,
        )
        .limit(q.limit + 1),
      this.db.select({ n: count() }).from(posts).where(base),
    ]);

    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > q.limit && last
        ? encodeDraftCursor({
            ready: Number(last.ready) === 1 ? 1 : 0,
            updatedMs: String(last.updatedMs),
            id: last.post.id,
          })
        : null;

    return {
      drafts: await this.planner.present(page.map((r) => r.post)),
      total: Number(totalRow?.n ?? 0),
      nextCursor,
    };
  }
}
