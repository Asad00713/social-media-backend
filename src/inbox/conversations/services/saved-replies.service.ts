import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  eq,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { DbType } from '../../../drizzle/db';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import {
  inboxSavedReplies,
  type InboxSavedReply,
} from '../../../drizzle/schema/inbox-saved-replies.schema';
import { users } from '../../../drizzle/schema/users.schema';
import { buildSearchPattern } from '../../inbox.service';
import type { SavedReply } from '../dto/contract';
import type {
  CreateSavedReplyDto,
  UpdateSavedReplyDto,
} from '../dto/saved-replies.dto';

const SHORTCUT_INDEX = 'inbox_saved_replies_shortcut_uq';

interface Joined {
  reply: InboxSavedReply;
  creator: { id: string; name: string | null; avatarUrl: string | null } | null;
}

function present({ reply, creator }: Joined): SavedReply {
  return {
    id: reply.id,
    name: reply.name,
    shortcut: reply.shortcut,
    body: reply.body,
    usageCount: reply.usageCount,
    createdBy: creator?.id
      ? {
          id: creator.id,
          name: creator.name ?? '',
          avatarUrl: creator.avatarUrl ?? null,
        }
      : null,
    updatedAt: reply.updatedAt.toISOString(),
  };
}

/** pg 23505 on the live-shortcut index, whether or not drizzle wrapped it. */
function isShortcutClash(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; cause?: unknown };
  if (e?.code === '23505' && e.constraint === SHORTCUT_INDEX) return true;
  return e?.cause ? isShortcutClash(e.cause) : false;
}

/** Escapes LIKE metacharacters so `%`, `_` and `\` in user input match literally. */
function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

@Injectable()
export class SavedRepliesService {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  async list(workspaceId: string, q?: string): Promise<SavedReply[]> {
    const term = (q ?? '').trim().replace(/^\//, '').toLowerCase();
    const conds: (SQL | undefined)[] = [
      eq(inboxSavedReplies.workspaceId, workspaceId),
      isNull(inboxSavedReplies.deletedAt),
    ];
    if (term !== '') {
      conds.push(
        or(
          sql`${inboxSavedReplies.shortcut} LIKE ${escapeLike(term) + '%'} ESCAPE '\\'`,
          sql`${inboxSavedReplies.name} ILIKE ${buildSearchPattern(term)} ESCAPE '\\'`,
        ),
      );
    }
    const rows = await this.db
      .select({ reply: inboxSavedReplies, creator: this.creatorCols() })
      .from(inboxSavedReplies)
      .leftJoin(users, eq(users.id, inboxSavedReplies.createdByUserId))
      .where(and(...conds))
      .orderBy(asc(inboxSavedReplies.name), asc(inboxSavedReplies.id));
    return rows.map(present);
  }

  async create(
    workspaceId: string,
    userId: string,
    dto: CreateSavedReplyDto,
  ): Promise<SavedReply> {
    const id = await this.guarded(async (tx) => {
      const [row] = await tx
        .insert(inboxSavedReplies)
        .values({
          workspaceId,
          createdByUserId: userId,
          name: dto.name,
          shortcut: dto.shortcut,
          body: dto.body,
        })
        .returning({ id: inboxSavedReplies.id });
      return row.id;
    });
    return await this.getOne(workspaceId, id);
  }

  async update(
    workspaceId: string,
    id: string,
    dto: UpdateSavedReplyDto,
  ): Promise<SavedReply> {
    const patch: Partial<Pick<InboxSavedReply, 'name' | 'shortcut' | 'body'>> =
      {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.shortcut !== undefined) patch.shortcut = dto.shortcut;
    if (dto.body !== undefined) patch.body = dto.body;
    await this.guarded(async (tx) => {
      const rows = await tx
        .update(inboxSavedReplies)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(this.live(workspaceId, id))
        .returning({ id: inboxSavedReplies.id });
      if (rows.length === 0)
        throw new NotFoundException('Saved reply not found');
    });
    return await this.getOne(workspaceId, id);
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    const rows = await this.db
      .update(inboxSavedReplies)
      .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
      .where(this.live(workspaceId, id))
      .returning({ id: inboxSavedReplies.id });
    if (rows.length === 0) throw new NotFoundException('Saved reply not found');
  }

  async restore(workspaceId: string, id: string): Promise<SavedReply> {
    await this.guarded(async (tx) => {
      const rows = await tx
        .update(inboxSavedReplies)
        .set({ deletedAt: null, updatedAt: sql`now()` })
        .where(
          and(
            eq(inboxSavedReplies.id, id),
            eq(inboxSavedReplies.workspaceId, workspaceId),
            isNotNull(inboxSavedReplies.deletedAt),
          ),
        )
        .returning({ id: inboxSavedReplies.id });
      if (rows.length === 0)
        throw new NotFoundException('Saved reply not found');
    });
    return await this.getOne(workspaceId, id);
  }

  async use(workspaceId: string, id: string): Promise<{ usageCount: number }> {
    const [row] = await this.db
      .update(inboxSavedReplies)
      .set({ usageCount: sql`${inboxSavedReplies.usageCount} + 1` })
      .where(this.live(workspaceId, id))
      .returning({ usageCount: inboxSavedReplies.usageCount });
    if (!row) throw new NotFoundException('Saved reply not found');
    return { usageCount: row.usageCount };
  }

  private live(workspaceId: string, id: string): SQL | undefined {
    return and(
      eq(inboxSavedReplies.id, id),
      eq(inboxSavedReplies.workspaceId, workspaceId),
      isNull(inboxSavedReplies.deletedAt),
    );
  }

  private creatorCols() {
    return { id: users.id, name: users.name, avatarUrl: users.avatarUrl };
  }

  private async getOne(workspaceId: string, id: string): Promise<SavedReply> {
    const [row] = await this.db
      .select({ reply: inboxSavedReplies, creator: this.creatorCols() })
      .from(inboxSavedReplies)
      .leftJoin(users, eq(users.id, inboxSavedReplies.createdByUserId))
      .where(
        and(
          eq(inboxSavedReplies.id, id),
          eq(inboxSavedReplies.workspaceId, workspaceId),
        ),
      );
    if (!row) throw new NotFoundException('Saved reply not found');
    return present(row);
  }

  /**
   * Runs a write in its own transaction (a savepoint when the caller is
   * already in one). A unique violation aborts a Postgres transaction, so the
   * write is isolated for the caller's session to stay usable afterwards.
   */
  private async guarded<T>(
    fn: (tx: Parameters<Parameters<DbType['transaction']>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.db.transaction(fn);
    } catch (err) {
      if (isShortcutClash(err)) {
        throw new ConflictException({
          code: 'SHORTCUT_TAKEN',
          message: 'That shortcut is already used',
        });
      }
      throw err;
    }
  }
}
