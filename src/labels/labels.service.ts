import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, count, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import type { DbType } from '../drizzle/db';
import { DRIZZLE } from '../drizzle/drizzle.module';
import {
  LABEL_COLORS,
  postLabels,
  workspaceLabels,
  type LabelColor,
  type WorkspaceLabel,
} from '../drizzle/schema/labels.schema';
import type {
  CreateLabelDto,
  Label,
  LabelList,
  UpdateLabelDto,
} from './dto/label.dto';

/** What `remove` tells the client: Undo works for this many seconds. */
const UNDO_SECONDS = 10;
/** What the server accepts, to absorb latency on top of the 10 s. */
const RESTORE_GRACE = sql`interval '60 seconds'`;
/** Deleted labels older than this are hard-deleted by `purgeExpired`. */
const PURGE_AFTER = sql`interval '10 minutes'`;

/**
 * Wall-clock now, not `now()`: `now()` is the start of the enclosing
 * transaction, which in a long transaction (or the DB spec harness) lags the
 * clock and would shift every window.
 */
const clockNow = sql`clock_timestamp()`;

const NAME_INDEX = 'workspace_labels_name_uq';

/** Either the root db or a transaction on it. */
type Executor = Pick<
  DbType,
  'select' | 'insert' | 'update' | 'delete' | 'execute'
>;

function labelError(
  Ex:
    | typeof ConflictException
    | typeof BadRequestException
    | typeof GoneException
    | typeof NotFoundException,
  statusCode: number,
  error: string,
  code: string,
  message: string,
) {
  return new Ex({ statusCode, error, code, message });
}

const nameTaken = (name: string) =>
  labelError(
    ConflictException,
    409,
    'Conflict',
    'LABEL_NAME_TAKEN',
    `A label named "${name}" already exists.`,
  );

const notFound = () =>
  labelError(
    NotFoundException,
    404,
    'Not Found',
    'LABEL_NOT_FOUND',
    'Label not found.',
  );

/**
 * True when Postgres refused a row on the live-name unique index (23505 on
 * `workspace_labels_name_uq`). drizzle wraps driver errors, so the code may
 * sit on `cause`.
 */
export function isNameClash(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; e && i < 3; i++) {
    const pg = e as { code?: unknown; constraint?: unknown };
    if (pg.code === '23505' && pg.constraint === NAME_INDEX) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** '' or whitespace-only means "no description". */
const cleanDescription = (d: string | null | undefined) =>
  d === undefined ? undefined : d === null || d.trim() === '' ? null : d.trim();

/**
 * The workspace label catalogue (spec §5.9). Every query is scoped by
 * `workspace_id`; a label id from another workspace is a 404. Deleting is
 * soft so Undo can restore it; `purgeExpired` hard-deletes old deletions
 * lazily as the first statement of every label write (no cron).
 *
 * Writes run in `db.transaction`: in production a real transaction, under
 * the DB spec harness a savepoint, so a refused insert (23505) never poisons
 * the caller's transaction.
 */
@Injectable()
export class LabelsService {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  /** Live labels in name order, with how many posts carry each and when last. */
  async list(workspaceId: string): Promise<LabelList> {
    const labels = await this.select(this.db, workspaceId);
    return { labels, total: labels.length };
  }

  /** Live label names in name order (the composer's catalogue). */
  async catalogueNames(workspaceId: string): Promise<string[]> {
    const rows = await this.db
      .select({ name: workspaceLabels.name })
      .from(workspaceLabels)
      .where(this.live(workspaceId))
      .orderBy(sql`lower(${workspaceLabels.name})`, workspaceLabels.id);
    return rows.map((r) => r.name);
  }

  /**
   * The colour a new label gets when none is chosen: the first palette
   * colour used by the fewest live labels, ties broken in palette order.
   */
  async nextColor(
    workspaceId: string,
    tx: Executor = this.db,
  ): Promise<LabelColor> {
    const rows = await tx
      .select({ color: workspaceLabels.color, n: count() })
      .from(workspaceLabels)
      .where(this.live(workspaceId))
      .groupBy(workspaceLabels.color);
    const used = new Map(rows.map((r) => [r.color, Number(r.n)]));
    let best: LabelColor = LABEL_COLORS[0];
    for (const c of LABEL_COLORS) {
      if ((used.get(c) ?? 0) < (used.get(best) ?? 0)) best = c;
    }
    return best;
  }

  async create(
    workspaceId: string,
    userId: string,
    dto: CreateLabelDto,
  ): Promise<Label> {
    return this.write(workspaceId, dto.name, async (tx) => {
      const [row] = await tx
        .insert(workspaceLabels)
        .values({
          workspaceId,
          name: dto.name,
          color: dto.color ?? (await this.nextColor(workspaceId, tx)),
          description: cleanDescription(dto.description) ?? null,
          createdBy: userId,
        })
        .returning();
      return this.present(row, 0, null);
    });
  }

  async update(
    workspaceId: string,
    labelId: string,
    dto: UpdateLabelDto,
  ): Promise<Label> {
    return this.write(workspaceId, dto.name ?? '', async (tx) => {
      const description = cleanDescription(dto.description);
      const [row] = await tx
        .update(workspaceLabels)
        .set({
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.color !== undefined && { color: dto.color }),
          ...(description !== undefined && { description }),
          updatedAt: clockNow,
        })
        .where(and(eq(workspaceLabels.id, labelId), this.live(workspaceId)))
        .returning({ id: workspaceLabels.id });
      if (!row) throw notFound();
      return this.one(tx, workspaceId, labelId);
    });
  }

  /**
   * Moves every post of `labelId` onto `intoId` (posts already carrying the
   * target keep their one row), then hard-deletes the source. `moved` is the
   * number of posts that gained the target.
   */
  async merge(
    workspaceId: string,
    labelId: string,
    intoId: string,
  ): Promise<{ target: Label; moved: number }> {
    if (labelId.toLowerCase() === intoId.toLowerCase()) {
      throw labelError(
        BadRequestException,
        400,
        'Bad Request',
        'MERGE_SAME_LABEL',
        'A label cannot be merged into itself.',
      );
    }
    return this.db.transaction(async (tx) => {
      await this.purgeExpired(workspaceId, tx);
      // Lock both rows so a concurrent delete or merge cannot slip between
      // the checks and the move.
      const found = await tx
        .select({ id: workspaceLabels.id })
        .from(workspaceLabels)
        .where(
          and(
            inArray(workspaceLabels.id, [labelId, intoId]),
            this.live(workspaceId),
          ),
        )
        .for('update');
      if (found.length !== 2) throw notFound();

      const inserted = await tx.execute<{ post_id: string }>(sql`
        INSERT INTO post_labels (post_id, label_id)
        SELECT post_id, ${intoId}::uuid FROM post_labels WHERE label_id = ${labelId}
        ON CONFLICT DO NOTHING
        RETURNING post_id`);
      await tx
        .delete(workspaceLabels)
        .where(
          and(
            eq(workspaceLabels.id, labelId),
            eq(workspaceLabels.workspaceId, workspaceId),
          ),
        );
      return {
        target: await this.one(tx, workspaceId, intoId),
        moved: inserted.rows.length,
      };
    });
  }

  /** Soft delete. Its post_labels rows stay until the purge. */
  async remove(
    workspaceId: string,
    labelId: string,
  ): Promise<{ undoUntil: string }> {
    return this.db.transaction(async (tx) => {
      await this.purgeExpired(workspaceId, tx);
      const [row] = await tx
        .update(workspaceLabels)
        .set({ deletedAt: clockNow, updatedAt: clockNow })
        .where(and(eq(workspaceLabels.id, labelId), this.live(workspaceId)))
        .returning({ deletedAt: workspaceLabels.deletedAt });
      if (!row?.deletedAt) throw notFound();
      return {
        undoUntil: new Date(
          row.deletedAt.getTime() + UNDO_SECONDS * 1000,
        ).toISOString(),
      };
    });
  }

  /**
   * Undo of `remove`, accepted for 60 s after the delete. A live label is
   * returned as is. 410 once the window has passed; 409 when the name was
   * taken by another label meanwhile.
   */
  async restore(workspaceId: string, labelId: string): Promise<Label> {
    let name = '';
    return this.write(
      workspaceId,
      () => name,
      async (tx) => {
        const [current] = await tx
          .select({
            name: workspaceLabels.name,
            deleted: sql<boolean>`${workspaceLabels.deletedAt} IS NOT NULL`,
            restorable: sql<boolean>`${workspaceLabels.deletedAt} > ${clockNow} - ${RESTORE_GRACE}`,
          })
          .from(workspaceLabels)
          .where(
            and(
              eq(workspaceLabels.id, labelId),
              eq(workspaceLabels.workspaceId, workspaceId),
            ),
          )
          .for('update');
        if (!current) throw notFound();
        name = current.name;
        if (current.deleted) {
          if (!current.restorable) {
            throw labelError(
              GoneException,
              410,
              'Gone',
              'UNDO_EXPIRED',
              'This delete can no longer be undone.',
            );
          }
          await tx
            .update(workspaceLabels)
            .set({ deletedAt: null, updatedAt: clockNow })
            .where(
              and(
                eq(workspaceLabels.id, labelId),
                eq(workspaceLabels.workspaceId, workspaceId),
              ),
            );
        }
        return this.one(tx, workspaceId, labelId);
      },
    );
  }

  /**
   * Hard-deletes this workspace's labels deleted more than 10 minutes ago;
   * their post_labels rows go with them (ON DELETE CASCADE).
   */
  async purgeExpired(
    workspaceId: string,
    tx: Executor = this.db,
  ): Promise<void> {
    await tx
      .delete(workspaceLabels)
      .where(
        and(
          eq(workspaceLabels.workspaceId, workspaceId),
          sql`${workspaceLabels.deletedAt} < ${clockNow} - ${PURGE_AFTER}`,
        ),
      );
  }

  // ---------------------------------------------------------------------------

  /**
   * Runs a write in a transaction that purges first, and turns a clash on
   * the live-name index into 409 LABEL_NAME_TAKEN.
   */
  private async write<T>(
    workspaceId: string,
    name: string | (() => string),
    fn: (tx: Executor) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.db.transaction(async (tx) => {
        await this.purgeExpired(workspaceId, tx);
        return fn(tx);
      });
    } catch (err) {
      if (isNameClash(err)) {
        throw nameTaken(typeof name === 'function' ? name() : name);
      }
      throw err;
    }
  }

  private live(workspaceId: string) {
    return and(
      eq(workspaceLabels.workspaceId, workspaceId),
      isNull(workspaceLabels.deletedAt),
    );
  }

  private async one(
    tx: Executor,
    workspaceId: string,
    labelId: string,
  ): Promise<Label> {
    const [label] = await this.select(tx, workspaceId, labelId);
    if (!label) throw notFound();
    return label;
  }

  /** Live labels with their usage, name order; one label when `labelId` is set. */
  private async select(
    tx: Executor,
    workspaceId: string,
    labelId?: string,
  ): Promise<Label[]> {
    const rows = await tx
      .select({
        label: workspaceLabels,
        postCount: count(postLabels.postId),
        lastUsedAt: max(postLabels.createdAt),
      })
      .from(workspaceLabels)
      .leftJoin(postLabels, eq(postLabels.labelId, workspaceLabels.id))
      .where(
        and(
          this.live(workspaceId),
          labelId ? eq(workspaceLabels.id, labelId) : undefined,
        ),
      )
      .groupBy(workspaceLabels.id)
      .orderBy(sql`lower(${workspaceLabels.name})`, workspaceLabels.id);
    return rows.map((r) =>
      this.present(r.label, Number(r.postCount), r.lastUsedAt),
    );
  }

  private present(
    row: WorkspaceLabel,
    postCount: number,
    lastUsedAt: Date | string | null,
  ): Label {
    return {
      id: row.id,
      name: row.name,
      color: row.color,
      description: row.description,
      postCount,
      lastUsedAt:
        lastUsedAt === null ? null : new Date(lastUsedAt).toISOString(),
    };
  }
}
