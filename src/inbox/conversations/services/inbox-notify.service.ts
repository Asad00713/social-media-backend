import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { DbType } from '../../../drizzle/db';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { users } from '../../../drizzle/schema/users.schema';
import { workspace } from '../../../drizzle/schema/workspace.schema';
import { workspaceInvitation } from '../../../drizzle/schema/workspace-invitation.schema';
import { AppLinks } from '../../../email/links/app-links';
import {
  inboxActivity,
  INBOX_EVENT,
  type InboxActivityProps,
} from '../../../email/templates/inbox/inbox-activity';
import { NotificationEmitterService } from '../../../notifications/notification-emitter.service';
import { NotifyService } from '../../../notifications/notify.service';
import {
  roleCan,
  type WorkspaceRole,
} from '../../../workspace-members/role-capabilities';
import { InboxSettingsService } from './inbox-settings.service';

/** Anything older than this is a backfill or re-poll, not news. */
const NEW_INBOUND_MAX_AGE_MS = 60 * 60 * 1000;
/** At most one email per conversation per user in this window. */
const MAIL_WINDOW_SECONDS = 600;

interface Member {
  id: string;
  email: string;
  name: string | null;
}

type EventKind = 'assigned' | 'mention' | 'new_message';

interface RedisLike {
  set(
    key: string,
    value: string,
    mode: 'EX',
    seconds: number,
    flag: 'NX',
  ): Promise<'OK' | null>;
}

/**
 * Bell and email notifications for the Inbox (R7). Every public method is
 * fire-and-forget safe: failures are logged and never thrown, so a
 * notification problem can never undo an assignment, a note or an ingest.
 */
@Injectable()
export class InboxNotifyService {
  private readonly logger = new Logger(InboxNotifyService.name);

  constructor(
    private readonly emitter: NotificationEmitterService,
    private readonly notify: NotifyService,
    private readonly settings: InboxSettingsService,
    @Inject(DRIZZLE) private readonly db: DbType,
    @Inject('REDIS_CLIENT') private readonly redis: RedisLike,
    private readonly links: AppLinks,
  ) {}

  async assigned(args: {
    workspaceId: string;
    conversationId: string;
    assigneeUserId: string;
    actorUserId: string;
  }): Promise<void> {
    if (args.assigneeUserId === args.actorUserId) return;
    await this.safely('assigned', async () => {
      const recipients = await this.loadMembers(args.workspaceId, [
        args.assigneeUserId,
      ]);
      const actorName = await this.displayName(args.actorUserId);
      await this.fanOut(
        args.workspaceId,
        args.conversationId,
        recipients,
        'assigned',
        `${actorName} assigned you a conversation`,
        (id) =>
          this.emitter.inboxAssigned(id, {
            workspaceId: args.workspaceId,
            conversationId: args.conversationId,
            assignedByName: actorName,
          }),
      );
    });
  }

  async noteMentioned(args: {
    workspaceId: string;
    conversationId: string;
    mentionedUserIds: string[];
    actorUserId: string;
  }): Promise<void> {
    const ids = [...new Set(args.mentionedUserIds)].filter(
      (id) => id !== args.actorUserId,
    );
    if (ids.length === 0) return;
    await this.safely('noteMentioned', async () => {
      const recipients = await this.loadMembers(args.workspaceId, ids);
      const authorName = await this.displayName(args.actorUserId);
      await this.fanOut(
        args.workspaceId,
        args.conversationId,
        recipients,
        'mention',
        `${authorName} mentioned you in a note`,
        (id) =>
          this.emitter.inboxNoteMention(id, {
            workspaceId: args.workspaceId,
            conversationId: args.conversationId,
            authorName,
          }),
      );
    });
  }

  async newInbound(args: {
    workspaceId: string;
    conversationId: string;
    authorName: string;
    platformCreatedAt: Date;
  }): Promise<void> {
    // `!(age <= max)` so an invalid date (NaN) counts as stale, not fresh.
    const age = Date.now() - args.platformCreatedAt.getTime();
    if (!(age <= NEW_INBOUND_MAX_AGE_MS)) return;
    await this.safely('newInbound', async () => {
      const recipients = await this.loadMembers(args.workspaceId);
      await this.fanOut(
        args.workspaceId,
        args.conversationId,
        recipients,
        'new_message',
        `New message from ${args.authorName}`,
        (id) =>
          this.emitter.inboxNewMessage(id, {
            workspaceId: args.workspaceId,
            conversationId: args.conversationId,
            authorName: args.authorName,
          }),
      );
    });
  }

  /**
   * Applies each recipient's notify level, then hands the bell and the
   * (throttled) email to NotifyService, which applies the person's own
   * per-channel preferences on top of the level.
   */
  private async fanOut(
    workspaceId: string,
    conversationId: string,
    recipients: Member[],
    kind: EventKind,
    sentence: string,
    bell: (userId: string) => Promise<unknown>,
  ): Promise<void> {
    if (recipients.length === 0) return;
    let workspaceName: Promise<string> | undefined;
    const nameOf = () => (workspaceName ??= this.workspaceName(workspaceId));
    const settings = await this.settings.getMany(
      recipients.map((r) => r.id),
      workspaceId,
    );
    await Promise.all(
      recipients.map(async (r) => {
        const notify = settings.get(r.id)?.notify ?? 'assigned_and_mentions';
        if (notify === 'nothing') return;
        if (kind === 'new_message' && notify !== 'everything') return;
        const email = await this.mailFor(
          r,
          workspaceId,
          conversationId,
          { kind, sentence },
          nameOf,
        );
        await this.safely(`notify ${r.id}`, () =>
          this.notify.notify({
            userId: r.id,
            workspaceId,
            event: INBOX_EVENT[kind],
            bell: () => bell(r.id),
            email,
          }),
        );
      }),
    );
  }

  /**
   * The email for one person, or undefined when their 10-minute throttle for
   * this conversation is still running. Never throws, so a Redis or lookup
   * failure costs the email and not the bell.
   */
  private async mailFor(
    to: Member,
    workspaceId: string,
    conversationId: string,
    what: Pick<InboxActivityProps, 'kind' | 'sentence'>,
    workspaceName: () => Promise<string>,
  ) {
    try {
      const key = `inbox-mail:${to.id}:${conversationId}`;
      const claimed = await this.redis.set(
        key,
        '1',
        'EX',
        MAIL_WINDOW_SECONDS,
        'NX',
      );
      if (claimed !== 'OK') return undefined;
      const props: InboxActivityProps = {
        ...what,
        workspaceName: await workspaceName(),
        conversationUrl: this.links.inbox(workspaceId, conversationId),
      };
      return {
        template: inboxActivity,
        props,
        to: to.email,
        // One mail per person and conversation in each 10-minute window.
        idempotencyKey: `inbox.${to.id}.${conversationId}.${Math.floor(Date.now() / (MAIL_WINDOW_SECONDS * 1000))}`,
      };
    } catch (err) {
      this.logger.warn(
        `inbox email for ${to.id} skipped: ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  protected async workspaceName(workspaceId: string): Promise<string> {
    const [row] = await this.db
      .select({ name: workspace.name })
      .from(workspace)
      .where(eq(workspace.id, workspaceId));
    return row?.name ?? 'your workspace';
  }

  /**
   * The workspace owner plus accepted members whose role has `inbox:view`
   * (D22), optionally narrowed to `userIds`.
   */
  protected async loadMembers(
    workspaceId: string,
    userIds?: string[],
  ): Promise<Member[]> {
    if (userIds && userIds.length === 0) return [];
    const [owner] = await this.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(workspace)
      .innerJoin(users, eq(users.id, workspace.ownerId))
      .where(eq(workspace.id, workspaceId));
    const accepted = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: workspaceInvitation.role,
      })
      .from(workspaceInvitation)
      .innerJoin(users, eq(users.id, workspaceInvitation.userId))
      .where(
        and(
          eq(workspaceInvitation.workspaceId, workspaceId),
          eq(workspaceInvitation.status, 'ACCEPTED'),
        ),
      );
    const byId = new Map<string, Member>();
    if (owner) byId.set(owner.id, owner);
    for (const m of accepted) {
      if (!roleCan(m.role as WorkspaceRole, 'inbox:view')) continue;
      if (!byId.has(m.id))
        byId.set(m.id, { id: m.id, email: m.email, name: m.name });
    }
    const all = [...byId.values()];
    return userIds ? all.filter((m) => userIds.includes(m.id)) : all;
  }

  protected async displayName(userId: string): Promise<string> {
    const [u] = await this.db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, userId));
    return u?.name || u?.email || 'A teammate';
  }

  private async safely(
    what: string,
    fn: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.warn(
        `inbox notification (${what}) failed: ${(err as Error).message}`,
      );
    }
  }
}
