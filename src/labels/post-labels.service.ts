import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import { normaliseLabels } from '../posts/composer/lib/draft-organise';
import { LabelsService } from './labels.service';

/** Either the root db or a transaction on it. */
type Executor = Pick<
  DbType,
  'select' | 'insert' | 'update' | 'delete' | 'execute'
>;

const LABEL_FK = 'post_labels_label_id_fkey';

/**
 * A label this write resolved or collided with vanished before the write
 * finished (deleted or merged away by another request). Retried once.
 */
class LabelGoneError extends Error {
  constructor(name: string) {
    super(`Label "${name}" vanished while it was being created`);
  }
}

/**
 * True when the label this write was about to use is gone: a
 * `LabelGoneError`, or Postgres refusing a post_labels row with 23503 on
 * `post_labels_label_id_fkey` (a merge or purge deleted the label between our
 * resolve and our insert). drizzle may wrap the driver error.
 */
function isLabelGone(err: unknown): boolean {
  if (err instanceof LabelGoneError) return true;
  let e: unknown = err;
  for (let i = 0; e && i < 3; i++) {
    const pg = e as { code?: unknown; constraint?: unknown };
    if (pg.code === '23503' && pg.constraint === LABEL_FK) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Which labels a post carries (`post_labels`), by name for the composer and
 * by id for the Planner. Never reads or writes `posts.metadata`: the labels
 * that used to live there were copied by migration 0092 and are no longer
 * read.
 */
@Injectable()
export class PostLabelsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly labels: LabelsService,
  ) {}

  /**
   * Replaces the post's live labels with `names`: normalised, resolved to
   * live labels case-insensitively, the missing ones created (next palette
   * colour, no creator). Rows of soft-deleted labels are left alone, so the
   * label's Undo still brings it back on this post.
   *
   * A label merged (or purged) by another request between the resolve and
   * the insert fails the insert's foreign key (or, for a name being created,
   * vanishes between the conflict and the re-select); the whole write is then
   * rolled back and done once more, so the name resolves to whatever is live
   * now.
   */
  async setForPost(
    workspaceId: string,
    postId: string,
    names: string[],
  ): Promise<void> {
    const wanted = normaliseLabels(names);
    for (let attempt = 1; ; attempt++) {
      try {
        await this.db.transaction(async (tx) => {
          await this.lockPost(tx, workspaceId, postId);
          const ids = await this.resolveIds(tx, workspaceId, wanted);
          await this.replace(tx, postId, ids);
        });
        return;
      } catch (err) {
        if (attempt === 1 && isLabelGone(err)) continue;
        throw err;
      }
    }
  }

  /** Live label names per post, in name order. Posts without any are absent. */
  async namesForPosts(postIds: string[]): Promise<Map<string, string[]>> {
    return this.livePerPost(postIds, 'name');
  }

  /** Live label ids per post, in name order. Posts without any are absent. */
  async idsForPosts(postIds: string[]): Promise<Map<string, string[]>> {
    return this.livePerPost(postIds, 'id');
  }

  // ---------------------------------------------------------------------------

  /**
   * 404 unless the post is in this workspace. The row lock serialises two
   * saves of one post, so their label sets never interleave into a union.
   */
  private async lockPost(
    tx: Executor,
    workspaceId: string,
    postId: string,
  ): Promise<void> {
    const found = await tx.execute(sql`
      SELECT id FROM posts
      WHERE id = ${postId} AND workspace_id = ${workspaceId}
      FOR NO KEY UPDATE`);
    if (found.rows.length === 0) throw new NotFoundException('Post not found');
  }

  /** The live label id for each name, creating the ones that do not exist. */
  private async resolveIds(
    tx: Executor,
    workspaceId: string,
    names: string[],
  ): Promise<string[]> {
    if (names.length === 0) return [];
    const keys = names.map((n) => n.toLowerCase());
    const found = await tx.execute<{ id: string; key: string }>(sql`
      SELECT id, lower(name) AS key FROM workspace_labels
      WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL
        AND lower(name) = ANY(${sql.param(keys)}::text[])`);
    const byKey = new Map(found.rows.map((r) => [r.key, r.id]));

    const ids: string[] = [];
    for (const name of names) {
      const id =
        byKey.get(name.toLowerCase()) ??
        (await this.create(tx, workspaceId, name));
      ids.push(id);
    }
    return ids;
  }

  /**
   * A new live label. A concurrent create of the same name wins the unique
   * index; that label is then the one used. If that label is itself gone by
   * the re-select (deleted or merged in between), `LabelGoneError` sends the
   * whole write round the single retry.
   */
  private async create(
    tx: Executor,
    workspaceId: string,
    name: string,
  ): Promise<string> {
    const color = await this.labels.nextColor(workspaceId, tx);
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO workspace_labels (workspace_id, name, color)
      VALUES (${workspaceId}, ${name}, ${color})
      ON CONFLICT (workspace_id, lower(name)) WHERE deleted_at IS NULL
      DO NOTHING
      RETURNING id`);
    if (inserted.rows[0]) return inserted.rows[0].id;
    const existing = await tx.execute<{ id: string }>(sql`
      SELECT id FROM workspace_labels
      WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL
        AND lower(name) = lower(${name})`);
    if (!existing.rows[0]) throw new LabelGoneError(name);
    return existing.rows[0].id;
  }

  /** The post's live labels become exactly `ids`. */
  private async replace(
    tx: Executor,
    postId: string,
    ids: string[],
  ): Promise<void> {
    await tx.execute(sql`
      DELETE FROM post_labels pl
      USING workspace_labels l
      WHERE pl.post_id = ${postId}
        AND l.id = pl.label_id AND l.deleted_at IS NULL
        AND pl.label_id <> ALL(${sql.param(ids)}::uuid[])`);
    if (ids.length === 0) return;
    await tx.execute(sql`
      INSERT INTO post_labels (post_id, label_id)
      SELECT ${postId}, unnest(${sql.param(ids)}::uuid[])
      ON CONFLICT DO NOTHING`);
  }

  private async livePerPost(
    postIds: string[],
    column: 'id' | 'name',
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (postIds.length === 0) return out;
    const rows = await this.db.execute<{ post_id: string; value: string }>(sql`
      SELECT pl.post_id, ${sql.raw(`l.${column}`)} AS value
      FROM post_labels pl
      JOIN workspace_labels l ON l.id = pl.label_id AND l.deleted_at IS NULL
      WHERE pl.post_id = ANY(${sql.param(postIds)}::uuid[])
      ORDER BY lower(l.name), l.id`);
    for (const r of rows.rows) {
      const list = out.get(r.post_id);
      if (list) list.push(r.value);
      else out.set(r.post_id, [r.value]);
    }
    return out;
  }
}
