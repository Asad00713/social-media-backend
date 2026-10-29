import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { DbType } from '../../../drizzle/db';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { inboxConversations } from '../../../drizzle/schema/inbox-conversations.schema';
import { inboxNotes } from '../../../drizzle/schema/inbox-notes.schema';
import { users } from '../../../drizzle/schema/users.schema';
import { roleCan } from '../../../workspace-members/role-capabilities';
import { WorkspaceRoleService } from '../../../workspace-members/workspace-role.service';
import type { TimelineEntry, UserRef } from '../dto/contract';
import type { CreateNoteDto } from '../dto/inbox-notes.dto';
import { noteEntryOf } from '../lib/timeline-entry';
import { InboxNotifyService } from './inbox-notify.service';
import { InboxRealtimeService } from './inbox-realtime.service';

type NoteEntry = Extract<TimelineEntry, { kind: 'note' }>;

const toRef = (u: {
  id: string;
  name: string | null;
  avatarUrl: string | null;
}): UserRef => ({ id: u.id, name: u.name ?? '', avatarUrl: u.avatarUrl });

/**
 * Internal notes on a conversation. D1: this service opens no transaction;
 * realtime and notifications run only after the insert has committed.
 */
@Injectable()
export class InboxNotesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly roles: WorkspaceRoleService,
    private readonly notify: InboxNotifyService,
    private readonly realtime: InboxRealtimeService,
  ) {}

  async create(
    workspaceId: string,
    conversationId: string,
    userId: string,
    dto: CreateNoteDto,
  ): Promise<NoteEntry> {
    await this.requireConversation(workspaceId, conversationId);
    const mentionIds = [...new Set(dto.mentionUserIds)];
    await this.requireMentionable(workspaceId, mentionIds);

    const [note] = await this.db
      .insert(inboxNotes)
      .values({
        conversationId,
        workspaceId,
        authorUserId: userId,
        body: dto.body,
        mentionedUserIds: mentionIds,
      })
      .returning();

    const refs = await this.userRefs([userId, ...mentionIds]);
    const author = refs.get(userId) ?? {
      id: userId,
      name: '',
      avatarUrl: null,
    };
    const mentions = mentionIds.flatMap((id) => refs.get(id) ?? []);
    const entry = noteEntryOf(note, author, mentions, userId);

    // The insert is committed: now tell clients and the mentioned people.
    this.realtime.timelineAppended(workspaceId, conversationId, entry, null);
    await this.notify.noteMentioned({
      workspaceId,
      conversationId,
      mentionedUserIds: mentionIds,
      actorUserId: userId,
    });
    return entry;
  }

  async remove(
    workspaceId: string,
    conversationId: string,
    noteId: string,
    userId: string,
  ): Promise<{ ok: true }> {
    const [note] = await this.db
      .select({ id: inboxNotes.id, authorUserId: inboxNotes.authorUserId })
      .from(inboxNotes)
      .where(
        and(
          eq(inboxNotes.id, noteId),
          eq(inboxNotes.conversationId, conversationId),
          eq(inboxNotes.workspaceId, workspaceId),
        ),
      );
    if (!note) throw new NotFoundException('Note not found');
    if (note.authorUserId !== userId) {
      throw new ForbiddenException('You can only delete your own notes');
    }
    await this.db.delete(inboxNotes).where(eq(inboxNotes.id, noteId));
    // No entry to append: a null entry tells clients to refetch the timeline.
    this.realtime.timelineAppended(workspaceId, conversationId, null, null);
    return { ok: true };
  }

  private async requireConversation(
    workspaceId: string,
    conversationId: string,
  ): Promise<void> {
    const [row] = await this.db
      .select({ id: inboxConversations.id })
      .from(inboxConversations)
      .where(
        and(
          eq(inboxConversations.id, conversationId),
          eq(inboxConversations.workspaceId, workspaceId),
        ),
      );
    if (!row) throw new NotFoundException('Conversation not found');
  }

  /**
   * Owner or ACCEPTED member with inbox:view: the same rule
   * InboxNotifyService uses to pick who is notified, so a valid mention can
   * never silently go un-notified.
   */
  private async requireMentionable(
    workspaceId: string,
    userIds: string[],
  ): Promise<void> {
    const roles = await Promise.all(
      userIds.map((id) => this.roles.getRole(workspaceId, id)),
    );
    if (roles.some((r) => r === null || !roleCan(r, 'inbox:view'))) {
      throw new BadRequestException('Only workspace members can be mentioned');
    }
  }

  private async userRefs(ids: string[]): Promise<Map<string, UserRef>> {
    const rows = await this.db
      .select({ id: users.id, name: users.name, avatarUrl: users.avatarUrl })
      .from(users)
      .where(inArray(users.id, [...new Set(ids)]));
    return new Map(rows.map((u) => [u.id, toRef(u)]));
  }
}
