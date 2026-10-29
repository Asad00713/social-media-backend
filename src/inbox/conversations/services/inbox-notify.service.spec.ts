import type { ConfigService } from '@nestjs/config';
import type { DbType } from '../../../drizzle/db';
import type { EmailResult, EmailService } from '../../../email/email.service';
import type { NotificationEmitterService } from '../../../notifications/notification-emitter.service';
import * as caps from '../../../workspace-members/role-capabilities';
import { InboxNotifyService } from './inbox-notify.service';
import {
  DEFAULT_INBOX_SETTINGS,
  type InboxSettings,
  type InboxSettingsService,
} from './inbox-settings.service';

const WS = 'w1';
const CONV = 'c1';

type Notify = 'assigned_and_mentions' | 'everything' | 'nothing';
type Person = { id: string; email: string; name: string | null };
type InboxArgs = {
  workspaceId: string;
  conversationId: string;
  assignedByName?: string;
  authorName?: string;
};
type RedisFake = {
  set: jest.Mock<Promise<'OK' | null>, []>;
  del: jest.Mock<Promise<number>, [string]>;
};

/** Boundary cast for a partial test double. */
function fake<T>(partial: object): T {
  return partial as unknown as T;
}

/**
 * The real service with its two DB reads replaced by in-memory answers, so
 * the recipient logic runs without a database (the reads themselves are
 * covered by inbox-notify.db.spec.ts).
 */
class StubbedNotify extends InboxNotifyService {
  members: Person[] = [];
  loadError: Error | null = null;
  private useRealLoad = false;

  protected override loadMembers(
    _workspaceId: string,
    userIds?: string[],
  ): Promise<Person[]> {
    if (this.useRealLoad) return super.loadMembers(_workspaceId, userIds);
    if (this.loadError) return Promise.reject(this.loadError);
    return Promise.resolve(
      this.members.filter((m) => !userIds || userIds.includes(m.id)),
    );
  }

  protected override displayName(userId: string): Promise<string> {
    return Promise.resolve(userId === 'actor' ? 'Hina' : 'X');
  }

  /** Exposes the real loadMembers for the role-filter test. */
  realLoadMembers(workspaceId: string): Promise<Person[]> {
    this.useRealLoad = true;
    return this.loadMembers(workspaceId);
  }
}

function build(opts: {
  members: Person[];
  notify?: Record<string, Notify>;
  redis?: Array<'OK' | null>;
  db?: object;
}) {
  const emitter = {
    inboxAssigned: jest
      .fn<Promise<unknown>, [string, InboxArgs]>()
      .mockResolvedValue({}),
    inboxNoteMention: jest
      .fn<Promise<unknown>, [string, InboxArgs]>()
      .mockResolvedValue({}),
    inboxNewMessage: jest
      .fn<Promise<unknown>, [string, InboxArgs]>()
      .mockResolvedValue({}),
  };
  const email = {
    sendEmail: jest
      .fn<
        Promise<EmailResult>,
        [{ to: string; subject: string; html: string; text?: string }]
      >()
      .mockResolvedValue({ success: true }),
  };
  const settings = {
    getMany: jest.fn((ids: string[]) => {
      const m = new Map<string, InboxSettings>();
      for (const id of ids) {
        m.set(id, {
          ...DEFAULT_INBOX_SETTINGS,
          notify: opts.notify?.[id] ?? DEFAULT_INBOX_SETTINGS.notify,
        });
      }
      return Promise.resolve(m);
    }),
  };
  const redisReplies = [...(opts.redis ?? [])];
  const redis: RedisFake = {
    del: jest.fn<Promise<number>, [string]>().mockResolvedValue(1),
    set: jest.fn<Promise<'OK' | null>, []>(() =>
      Promise.resolve(redisReplies.length ? redisReplies.shift()! : 'OK'),
    ),
  };
  const config = { get: jest.fn(() => 'https://app.test') };
  const svc = new StubbedNotify(
    fake<NotificationEmitterService>(emitter),
    fake<EmailService>(email),
    fake<InboxSettingsService>(settings),
    fake<DbType>(opts.db ?? {}),
    redis,
    fake<ConfigService>(config),
  );
  svc.members = opts.members;
  return { svc, emitter, email, redis, settings };
}

const A: Person = { id: 'a', email: 'a@x.test', name: 'Amy' };
const B: Person = { id: 'b', email: 'b@x.test', name: 'Bob' };
const ASSIGN = {
  workspaceId: WS,
  conversationId: CONV,
  assigneeUserId: 'a',
  actorUserId: 'actor',
};

describe('InboxNotifyService', () => {
  describe('assigned', () => {
    it('does nothing when assigning to yourself', async () => {
      const t = build({ members: [A] });
      await t.svc.assigned({ ...ASSIGN, actorUserId: 'a' });
      expect(t.emitter.inboxAssigned).not.toHaveBeenCalled();
      expect(t.email.sendEmail).not.toHaveBeenCalled();
    });

    it('bell + one email with a deep link for default settings', async () => {
      const t = build({ members: [A] });
      await t.svc.assigned(ASSIGN);
      expect(t.emitter.inboxAssigned).toHaveBeenCalledWith('a', {
        workspaceId: WS,
        conversationId: CONV,
        assignedByName: 'Hina',
      });
      expect(t.email.sendEmail).toHaveBeenCalledTimes(1);
      const mail = t.email.sendEmail.mock.calls[0][0];
      expect(mail.to).toBe('a@x.test');
      expect(mail.subject).toBe('Hina assigned you a conversation');
      expect(mail.html).toContain('https://app.test/w/w1/inbox?c=c1');
      expect(t.redis.set).toHaveBeenCalledWith(
        'inbox-mail:a:c1',
        '1',
        'EX',
        600,
        'NX',
      );
    });

    it('a second call inside 10 minutes keeps the bell but skips the email', async () => {
      const t = build({ members: [A], redis: [null] });
      await t.svc.assigned(ASSIGN);
      expect(t.emitter.inboxAssigned).toHaveBeenCalledTimes(1);
      expect(t.email.sendEmail).not.toHaveBeenCalled();
    });

    it('notify nothing gets neither', async () => {
      const t = build({ members: [A], notify: { a: 'nothing' } });
      await t.svc.assigned(ASSIGN);
      expect(t.emitter.inboxAssigned).not.toHaveBeenCalled();
      expect(t.email.sendEmail).not.toHaveBeenCalled();
    });

    it('notify everything gets bell + email', async () => {
      const t = build({ members: [A], notify: { a: 'everything' } });
      await t.svc.assigned(ASSIGN);
      expect(t.emitter.inboxAssigned).toHaveBeenCalledTimes(1);
      expect(t.email.sendEmail).toHaveBeenCalledTimes(1);
    });

    it('does not reject when the email service throws', async () => {
      const t = build({ members: [A] });
      t.email.sendEmail.mockRejectedValue(new Error('smtp down'));
      await expect(t.svc.assigned(ASSIGN)).resolves.toBeUndefined();
    });

    it('does not reject when the bell throws, and still sends the email', async () => {
      const t = build({ members: [A] });
      t.emitter.inboxAssigned.mockRejectedValue(new Error('db down'));
      await expect(t.svc.assigned(ASSIGN)).resolves.toBeUndefined();
      expect(t.email.sendEmail).toHaveBeenCalledTimes(1);
    });
  });

  describe('email failure', () => {
    it('releases the 10-minute claim when sendEmail reports failure', async () => {
      const t = build({ members: [A] });
      t.email.sendEmail.mockResolvedValue({ success: false, error: 'no key' });
      await t.svc.assigned(ASSIGN);
      expect(t.redis.del).toHaveBeenCalledWith('inbox-mail:a:c1');
    });

    it('releases the claim when sendEmail throws', async () => {
      const t = build({ members: [A] });
      t.email.sendEmail.mockRejectedValue(new Error('smtp down'));
      await t.svc.assigned(ASSIGN);
      expect(t.redis.del).toHaveBeenCalledWith('inbox-mail:a:c1');
    });

    it('keeps the claim after a successful send', async () => {
      const t = build({ members: [A] });
      t.email.sendEmail.mockResolvedValue({ success: true });
      await t.svc.assigned(ASSIGN);
      expect(t.redis.del).not.toHaveBeenCalled();
    });
  });

  describe('loadMembers role filter', () => {
    /** A drizzle-shaped chain that answers the owner query, then the members query. */
    function fakeDb(
      owner: Person[],
      accepted: Array<Person & { role: string }>,
    ) {
      const results: unknown[][] = [owner, accepted];
      const chain = {
        select: () => chain,
        from: () => chain,
        innerJoin: () => chain,
        where: () => Promise.resolve(results.shift() ?? []),
      };
      return chain;
    }

    it('drops an accepted member whose role lacks inbox:view', async () => {
      const spy = jest
        .spyOn(caps, 'roleCan')
        .mockImplementation((role) => role !== 'GUEST');
      try {
        const t = build({
          members: [],
          db: fakeDb(
            [{ id: 'o', email: 'o@x.test', name: 'Owner' }],
            [
              { id: 'm', email: 'm@x.test', name: 'M', role: 'MEMBER' },
              { id: 'g', email: 'g@x.test', name: 'G', role: 'GUEST' },
            ],
          ),
        });
        const out = await t.svc.realLoadMembers(WS);
        expect(out.map((m) => m.id).sort()).toEqual(['m', 'o']);
        expect(spy).toHaveBeenCalledWith('GUEST', 'inbox:view');
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('noteMentioned', () => {
    it('notifies the mentioned people but never the actor', async () => {
      const t = build({
        members: [A, B, { id: 'actor', email: 'h@x.test', name: 'Hina' }],
      });
      await t.svc.noteMentioned({
        workspaceId: WS,
        conversationId: CONV,
        mentionedUserIds: ['actor', 'a', 'b'],
        actorUserId: 'actor',
      });
      expect(
        t.emitter.inboxNoteMention.mock.calls.map((c) => c[0]).sort(),
      ).toEqual(['a', 'b']);
      expect(t.emitter.inboxNoteMention).toHaveBeenCalledWith('a', {
        workspaceId: WS,
        conversationId: CONV,
        authorName: 'Hina',
      });
      expect(t.email.sendEmail).toHaveBeenCalledTimes(2);
    });

    it('ignores a mentioned user who is not a workspace member', async () => {
      const t = build({ members: [A] });
      await t.svc.noteMentioned({
        workspaceId: WS,
        conversationId: CONV,
        mentionedUserIds: ['a', 'stranger'],
        actorUserId: 'actor',
      });
      expect(t.emitter.inboxNoteMention.mock.calls.map((c) => c[0])).toEqual([
        'a',
      ]);
    });
  });

  describe('newInbound', () => {
    it('reaches only users whose notify is everything', async () => {
      const t = build({
        members: [A, B],
        notify: { a: 'everything', b: 'assigned_and_mentions' },
      });
      await t.svc.newInbound({
        workspaceId: WS,
        conversationId: CONV,
        authorName: 'Sam',
        platformCreatedAt: new Date(Date.now() - 60_000),
      });
      expect(t.emitter.inboxNewMessage.mock.calls.map((c) => c[0])).toEqual([
        'a',
      ]);
      expect(t.emitter.inboxNewMessage).toHaveBeenCalledWith('a', {
        workspaceId: WS,
        conversationId: CONV,
        authorName: 'Sam',
      });
      expect(t.email.sendEmail.mock.calls[0][0].subject).toBe(
        'New message from Sam',
      );
    });

    it('an item two hours old reaches nobody', async () => {
      const t = build({ members: [A], notify: { a: 'everything' } });
      await t.svc.newInbound({
        workspaceId: WS,
        conversationId: CONV,
        authorName: 'Sam',
        platformCreatedAt: new Date(Date.now() - 2 * 3600_000),
      });
      expect(t.emitter.inboxNewMessage).not.toHaveBeenCalled();
      expect(t.email.sendEmail).not.toHaveBeenCalled();
    });

    it('an invalid platformCreatedAt counts as stale and reaches nobody', async () => {
      const t = build({ members: [A], notify: { a: 'everything' } });
      await t.svc.newInbound({
        workspaceId: WS,
        conversationId: CONV,
        authorName: 'Sam',
        platformCreatedAt: new Date(NaN),
      });
      expect(t.emitter.inboxNewMessage).not.toHaveBeenCalled();
      expect(t.email.sendEmail).not.toHaveBeenCalled();
    });

    it('does not reject when loading recipients fails', async () => {
      const t = build({ members: [A] });
      t.svc.loadError = new Error('db down');
      await expect(
        t.svc.newInbound({
          workspaceId: WS,
          conversationId: CONV,
          authorName: 'Sam',
          platformCreatedAt: new Date(),
        }),
      ).resolves.toBeUndefined();
    });
  });
});
