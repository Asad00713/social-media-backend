import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import {
  NOTE_COLORS,
  type NoteColor,
} from '../../drizzle/schema/calendar-notes.schema';
import { IsCalendarDate } from '../lib/calendar-date';

export { NOTE_COLORS };
export type { NoteColor };

export class CreateNoteDto {
  @IsCalendarDate()
  date: string;

  @IsString()
  @Length(1, 500)
  body: string;

  @IsIn(NOTE_COLORS)
  color: NoteColor;
}

export class UpdateNoteDto {
  @IsOptional()
  @IsString()
  @Length(1, 500)
  body?: string;

  @IsOptional()
  @IsIn(NOTE_COLORS)
  color?: NoteColor;
}

export class ListNotesQueryDto {
  @IsCalendarDate()
  from: string;

  @IsCalendarDate()
  to: string;
}

export interface PlannerNoteDto {
  id: string;
  /** yyyy-MM-dd */
  date: string;
  body: string;
  color: NoteColor;
  author: { id: string; name: string } | null;
  /** ISO-8601 instant */
  updatedAt: string;
}
