import { InboxNotifyService } from './inbox-notify.service';
import { DEFAULT_INBOX_SETTINGS } from './inbox-settings.service';

const WS = 'w1';
const CONV = 'c1';

type Notify = 'assigned_and_mentions' | 'everything' | 'nothing';

function build(opts: {
  members: Array<{ id: string; email: string; name: string | null }>;
  notify?: Record<string, Notify>;
  redis?: Array<'OK' | null>;
}) {
  const emitter = {
    inboxAssigned: jest.fn().mockResolvedValue({}),
    inboxNoteMention: jest.fn().mockResolvedValue({}),
    inboxNewMessage: jest.fn().mockResolvedValue({}),
  };
  const email = { sendEmail: jest.fn().mockResolvedValue(true) };
  const settings = {
    getMany: jest.fn(async (ids: string[]) => {
      const m = new Map();
      for (const id of ids) {
        m.set(id, {
          ...DEFAULT_INBOX_SETTINGS,
          notify: opts.notify?.[id] ?? DEFAULT_INBOX_SETTINGS.notify,
        });
      }
      return m;
    }),
  };
  const redisReplies = [...(opts.redis ?? [])];
  const redis = {
    set: jest.fn(async () =>
      redisReplies.length ? redisReplies.shift()! : 'OK',
    ),
  };
  const config = { get: jest.fn(() => 'https://app.test') };
  const svc = new InboxNotifyService(
    emitter as any,
    email as any,
    settings as any,
    {} as any,
    redis as any,
    config as any,
  );
  // DB access is isolated in these two methods (covered by the DB spec).
  jest
    .spyOn(svc as any, 'loadMembers')
    .mockImplementation(async (...a: any[]) => {
      const ids: string[] | undefined = a[1];
      return opts.members.filter((m) => !ids || ids.includes(m.id));
    });
  jest
    .spyOn(svc as any, 'displayName')
    .mockImplementation(async (id: any) => (id === 'actor' ? 'Hina' : 'X'));
  return { svc, emitter, email, redis, settings };
}

const A = { id: 'a', email: 'a@x.test', name: 'Amy' };
const B = { id: 'b', email: 'b@x.test', name: 'Bob' };
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

    it('does not reject when loading recipients fails', async () => {
      const t = build({ members: [A] });
      (t.svc as any).loadMembers.mockRejectedValue(new Error('db down'));
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
