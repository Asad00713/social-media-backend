import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { calendarNotes } from '../../drizzle/schema/calendar-notes.schema';
import { users } from '../../drizzle/schema/users.schema';
import type { CallerRole } from '../../posts/guest-rules';
import type {
  CreateNoteDto,
  PlannerNoteDto,
  UpdateNoteDto,
} from '../dto/planner-notes.dto';
import { assertDateRange, isCalendarDate } from '../lib/calendar-date';

const DAY_INDEX = 'calendar_notes_workspace_date_uq';

/** pg error code and constraint, whether the driver wraps the error or not. */
function pgError(err: unknown): { code?: string; constraint?: string } {
  const e = err as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  return e?.code ? e : (e?.cause ?? {});
}

/**
 * Day notes are shared workspace annotations: the route guard
 * (`posts:publish`) decides who may write, and any such caller may edit or
 * delete any note of the workspace. `role` is part of the signatures for
 * future rules and is deliberately unused. Every write is scoped
 * `id AND workspace_id`, so a note id from another workspace is a 404.
 * `date` is a plain calendar date: there is no time zone maths here.
 */
@Injectable()
export class PlannerNotesService {
  constructor(@Inject(DRIZZLE) private readonly db: DbType) {}

  private select() {
    return this.db
      .select({
        id: calendarNotes.id,
        date: calendarNotes.date,
        body: calendarNotes.body,
        color: calendarNotes.color,
        updatedAt: calendarNotes.updatedAt,
        authorId: users.id,
        authorName: users.name,
      })
      .from(calendarNotes)
      .leftJoin(users, eq(users.id, calendarNotes.createdById));
  }

  private present(row: {
    id: string;
    date: string;
    body: string;
    color: PlannerNoteDto['color'];
    updatedAt: Date;
    authorId: string | null;
    authorName: string | null;
  }): PlannerNoteDto {
    return {
      id: row.id,
      date: row.date,
      body: row.body,
      color: row.color,
      author: row.authorId
        ? { id: row.authorId, name: row.authorName ?? 'Unknown' }
        : null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async load(workspaceId: string, id: string): Promise<PlannerNoteDto> {
    const [row] = await this.select()
      .where(
        and(
          eq(calendarNotes.id, id),
          eq(calendarNotes.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('Note not found');
    return this.present(row);
  }

  async list(
    workspaceId: string,
    from: string,
    to: string,
  ): Promise<PlannerNoteDto[]> {
    assertDateRange(from, to);
    const rows = await this.select()
      .where(
        and(
          eq(calendarNotes.workspaceId, workspaceId),
          gte(calendarNotes.date, from),
          lte(calendarNotes.date, to),
        ),
      )
      .orderBy(asc(calendarNotes.date));
    return rows.map((r) => this.present(r));
  }

  async create(
    workspaceId: string,
    userId: string,
    _role: CallerRole,
    dto: CreateNoteDto,
  ): Promise<PlannerNoteDto> {
    if (!isCalendarDate(dto.date)) {
      throw new BadRequestException('date must be a valid calendar date');
    }
    let id: string;
    try {
      const [row] = await this.db
        .insert(calendarNotes)
        .values({
          workspaceId,
          date: dto.date,
          body: dto.body,
          color: dto.color,
          createdById: userId,
        })
        .returning({ id: calendarNotes.id });
      id = row.id;
    } catch (err) {
      const pg = pgError(err);
      if (pg.code === '23505' && pg.constraint === DAY_INDEX) {
        throw new ConflictException('A note for this day already exists');
      }
      throw err;
    }
    return await this.load(workspaceId, id);
  }

  async update(
    workspaceId: string,
    id: string,
    userId: string,
    _role: CallerRole,
    dto: UpdateNoteDto,
  ): Promise<PlannerNoteDto> {
    const [row] = await this.db
      .update(calendarNotes)
      .set({
        ...(dto.body !== undefined && { body: dto.body }),
        ...(dto.color !== undefined && { color: dto.color }),
        updatedById: userId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(calendarNotes.id, id),
          eq(calendarNotes.workspaceId, workspaceId),
        ),
      )
      .returning({ id: calendarNotes.id });
    if (!row) throw new NotFoundException('Note not found');
    return await this.load(workspaceId, id);
  }

  // `userId` and `role` are kept for future rules (see class comment).
  /* eslint-disable @typescript-eslint/no-unused-vars */
  async remove(
    workspaceId: string,
    id: string,
    _userId: string,
    _role: CallerRole,
  ): Promise<void> {
    /* eslint-enable @typescript-eslint/no-unused-vars */
    const rows = await this.db
      .delete(calendarNotes)
      .where(
        and(
          eq(calendarNotes.id, id),
          eq(calendarNotes.workspaceId, workspaceId),
        ),
      )
      .returning({ id: calendarNotes.id });
    if (rows.length === 0) throw new NotFoundException('Note not found');
  }
}
