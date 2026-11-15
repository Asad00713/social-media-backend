import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DbType } from '../../../drizzle/db';
import type { EmailService } from '../../../email/email.service';
import type { EmailOnceService } from '../../../email/email-once.service';
import { AppLinks } from '../../../email/links/app-links';
import type { EmailFooterService } from '../../../email/queue/email-footer.service';
import type { EmailJobData } from '../../../email/queue/email-job';
import { EmailOutboxService } from '../../../email/queue/email-outbox.service';
import type { EmailSuppressionRepository } from '../../../email/suppression/email-suppression.repository';
import type { EmailTokensService } from '../../../email/tokens/email-tokens.service';
import { inboxActivity } from '../../../email/templates/inbox/inbox-activity';
import type { NotificationPreferencesService } from '../../../notification-preferences/notification-preferences.service';
import type { NotificationEmitterService } from '../../../notifications/notification-emitter.service';
import {
  NotifyService,
  type NotifyInput,
} from '../../../notifications/notify.service';
import type { RecipientsService } from '../../../notifications/recipients.service';
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
type ClaimFake = jest.Mock<Promise<boolean>, [string, number]>;

/** Boundary cast for a partial test double. */
function fake<T>(partial: object): T {
  return partial as unknown as T;
}

/**
 * The real service with its DB reads replaced by in-memory answers, so the
 * recipient logic runs without a database (the reads themselves are covered
 * by inbox-notify.db.spec.ts).
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

  protected override workspaceName(): Promise<string> {
    return Promise.resolve('Acme');
  }

  /** Exposes the real loadMembers for the role-filter test. */
  realLoadMembers(workspaceId: string): Promise<Person[]> {
    this.useRealLoad = true;
    return this.loadMembers(workspaceId);
  }
}

const links = new AppLinks({
  get: (key: string) =>
    key === 'FRONTEND_URL' ? 'https://app.test' : undefined,
} as unknown as ConfigService);

function build(opts: {
  members: Person[];
  notify?: Record<string, Notify>;
  /** The answers of the throttle claim, in order; true once they run out. */
  claims?: boolean[];
  /** Replaces the throttle claim, e.g. with a real set. */
  claim?: ClaimFake;
  /** Replaces the preference check the email is gated on. */
  prefs?: { shouldSend: jest.Mock };
  db?: object;
  /** Replaces the NotifyService double, e.g. with the real one. */
  notifyService?: NotifyService;
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
  // Like NotifyService, it runs the bell.
  const notify = {
    notify: jest.fn(async (input: NotifyInput<unknown>) => {
      await input.bell?.();
    }),
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
  const replies = [...(opts.claims ?? [])];
  const claim: ClaimFake =
    opts.claim ??
    jest.fn<Promise<boolean>, [string, number]>(() =>
      Promise.resolve(replies.length ? replies.shift()! : true),
    );
  const prefs = opts.prefs ?? {
    shouldSend: jest.fn(() => Promise.resolve(true)),
  };
  const svc = new StubbedNotify(
    fake<NotificationEmitterService>(emitter),
    opts.notifyService ?? fake<NotifyService>(notify),
    fake<InboxSettingsService>(settings),
    fake<DbType>(opts.db ?? {}),
    fake<EmailOnceService>({ claim }),
    links,
    fake<NotificationPreferencesService>(prefs),
  );
  svc.members = opts.members;
  return { svc, emitter, notify, claim, prefs, settings };
}

/** Every notify() call that carried an email. */
function emailsOf(t: ReturnType<typeof build>) {
  return t.notify.notify.mock.calls
    .map(([input]) => input)
    .filter((input) => input.email !== undefined);
}

const A: Person = { id: 'a', email: 'a@x.test', name: 'Amy' };
const B: Person = { id: 'b', email: 'b@x.test', name: 'Bob' };
const ASSIGN = {
  workspaceId: WS,
  conversationId: CONV,
  assigneeUserId: 'a',
  actorUserId: 'actor',
};

const WINDOW_MS = 600_000;

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('InboxNotifyService', () => {
  describe('assigned', () => {
    it('does nothing when assigning to yourself', async () => {
      const t = build({ members: [A] });
      await t.svc.assigned({ ...ASSIGN, actorUserId: 'a' });
      expect(t.emitter.inboxAssigned).not.toHaveBeenCalled();
      expect(t.notify.notify).not.toHaveBeenCalled();
    });

    it('bell + one inbox-activity email with a deep link for default settings', async () => {
      const t = build({ members: [A] });
      await t.svc.assigned(ASSIGN);
      expect(t.emitter.inboxAssigned).toHaveBeenCalledWith('a', {
        workspaceId: WS,
        conversationId: CONV,
        assignedByName: 'Hina',
      });
      // The bell goes first, on its own; the email follows.
      expect(t.notify.notify).toHaveBeenCalledTimes(2);
      const [bell] = t.notify.notify.mock.calls[0];
      expect(bell).toMatchObject({
        userId: 'a',
        workspaceId: WS,
        event: 'inbox_assigned',
      });
      expect(bell.email).toBeUndefined();
      const [input] = emailsOf(t);
      expect(input).toMatchObject({
        userId: 'a',
        workspaceId: WS,
        event: 'inbox_assigned',
      });
      expect(input.email).toMatchObject({
        template: inboxActivity,
        to: 'a@x.test',
        props: {
          kind: 'assigned',
          sentence: 'Hina assigned you a conversation',
          workspaceName: 'Acme',
          conversationUrl: 'https://app.test/w/w1/inbox?c=c1',
        },
      });
      expect(t.prefs.shouldSend).toHaveBeenCalledWith(
        'a',
        WS,
        'inbox_assigned',
        'email',
      );
      expect(t.claim).toHaveBeenCalledWith('inbox-mail:a:c1', 600);
    });

    it('keys the email by person, conversation and 10-minute window', async () => {
      const now = 1_800_000_123_456;
      const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
      try {
        const t = build({ members: [A] });
        await t.svc.assigned(ASSIGN);
        const key = emailsOf(t)[0].email?.idempotencyKey;
        expect(key).toBe(`inbox.a.c1.${Math.floor(now / WINDOW_MS)}`);
        expect(key).toMatch(/^[A-Za-z0-9._-]{1,200}$/);

        spy.mockReturnValue(now + WINDOW_MS);
        await t.svc.assigned(ASSIGN);
        const next = emailsOf(t)[1].email?.idempotencyKey;
        expect(next).not.toBe(key);
      } finally {
        spy.mockRestore();
      }
    });

    it('a second call inside 10 minutes keeps the bell but sends no email', async () => {
      const t = build({ members: [A], claims: [false] });
      await t.svc.assigned(ASSIGN);
      expect(t.emitter.inboxAssigned).toHaveBeenCalledTimes(1);
      expect(t.notify.notify).toHaveBeenCalledTimes(1);
      expect(emailsOf(t)).toHaveLength(0);
    });

    it('notify nothing gets neither', async () => {
      const t = build({ members: [A], notify: { a: 'nothing' } });
      await t.svc.assigned(ASSIGN);
      expect(t.emitter.inboxAssigned).not.toHaveBeenCalled();
      expect(t.notify.notify).not.toHaveBeenCalled();
    });

    it('notify everything gets bell + email', async () => {
      const t = build({ members: [A], notify: { a: 'everything' } });
      await t.svc.assigned(ASSIGN);
      expect(t.emitter.inboxAssigned).toHaveBeenCalledTimes(1);
      expect(emailsOf(t)).toHaveLength(1);
    });

    it('does not reject when the notification service throws', async () => {
      const t = build({ members: [A] });
      t.notify.notify.mockRejectedValue(new Error('queue down'));
      await expect(t.svc.assigned(ASSIGN)).resolves.toBeUndefined();
    });

    it('rings the bell even when the throttle claim never answers', async () => {
      const t = build({ members: [A] });
      t.claim.mockReturnValue(new Promise(() => undefined));
      // Not awaited: with a hung Redis the email path never finishes.
      void t.svc.assigned(ASSIGN);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(t.emitter.inboxAssigned).toHaveBeenCalledTimes(1);
      expect(emailsOf(t)).toHaveLength(0);
    });

    it('still sends the bell when the claim fails, and skips only the email', async () => {
      const t = build({ members: [A] });
      t.claim.mockRejectedValue(new Error('redis down'));
      await expect(t.svc.assigned(ASSIGN)).resolves.toBeUndefined();
      expect(t.emitter.inboxAssigned).toHaveBeenCalledTimes(1);
      expect(emailsOf(t)).toHaveLength(0);
    });

    it('skips both the claim and the email when the person switched the email off', async () => {
      const t = build({
        members: [A],
        prefs: { shouldSend: jest.fn(() => Promise.resolve(false)) },
      });
      await t.svc.assigned(ASSIGN);
      expect(t.emitter.inboxAssigned).toHaveBeenCalledTimes(1);
      expect(t.claim).not.toHaveBeenCalled();
      expect(emailsOf(t)).toHaveLength(0);
    });

    it('skips the email, not the bell, when the preference check fails', async () => {
      const t = build({
        members: [A],
        prefs: { shouldSend: jest.fn(() => Promise.reject(new Error('db'))) },
      });
      await expect(t.svc.assigned(ASSIGN)).resolves.toBeUndefined();
      expect(t.emitter.inboxAssigned).toHaveBeenCalledTimes(1);
      expect(emailsOf(t)).toHaveLength(0);
    });
  });

  describe('preferences (spec 5.3)', () => {
    /**
     * InboxNotifyService -> the real NotifyService -> the real outbox, with
     * the email preference switched off for one event.
     */
    function wired(emailOff: string) {
      const queued: EmailJobData[] = [];
      const prefs = {
        shouldSend: jest.fn((_u: string, _w: string, ev: string, ch: string) =>
          Promise.resolve(!(ch === 'email' && ev === emailOff)),
        ),
      };
      const deliver = jest.fn(() =>
        Promise.resolve({ success: true, messageId: 'm1' }),
      );
      const outbox = new EmailOutboxService(
        fake({
          add: (_name: string, data: EmailJobData) => {
            queued.push(data);
            return Promise.resolve();
          },
        }),
        fake<EmailService>({ deliver }),
        fake<NotificationPreferencesService>(prefs),
        fake<EmailSuppressionRepository>({
          isSuppressed: () => Promise.resolve(false),
        }),
        fake<EmailFooterService>({
          build: () => Promise.resolve({ reason: 'why', links: [] }),
        }),
        links,
        fake<EmailTokensService>({ unsubscribeToken: () => 'tok' }),
      );
      const once = new Set<string>();
      const claim: ClaimFake = jest.fn<Promise<boolean>, [string, number]>(
        (key) => {
          if (once.has(key)) return Promise.resolve(false);
          once.add(key);
          return Promise.resolve(true);
        },
      );
      const real = new NotifyService(
        fake<NotificationPreferencesService>(prefs),
        outbox,
        fake<RecipientsService>({}),
      );
      return { queued, outbox, real, deliver, prefs, claim };
    }

    it('notify everything with inbox_new_message email off: bell, no email', async () => {
      const w = wired('inbox_new_message');
      const t = build({
        members: [A],
        notify: { a: 'everything' },
        notifyService: w.real,
        prefs: w.prefs,
        claim: w.claim,
      });
      await t.svc.newInbound({
        workspaceId: WS,
        conversationId: CONV,
        authorName: 'Sam',
        platformCreatedAt: new Date(),
      });
      expect(t.emitter.inboxNewMessage).toHaveBeenCalledTimes(1);
      expect(w.queued).toHaveLength(0);
      expect(w.claim).not.toHaveBeenCalled();
      expect(w.deliver).not.toHaveBeenCalled();
    });

    it('a dropped new-message email does not use up the window for an assignment', async () => {
      const w = wired('inbox_new_message');
      const t = build({
        members: [A],
        notify: { a: 'everything' },
        notifyService: w.real,
        prefs: w.prefs,
        claim: w.claim,
      });
      await t.svc.newInbound({
        workspaceId: WS,
        conversationId: CONV,
        authorName: 'Sam',
        platformCreatedAt: new Date(),
      });
      await t.svc.assigned(ASSIGN);
      expect(t.emitter.inboxNewMessage).toHaveBeenCalledTimes(1);
      expect(t.emitter.inboxAssigned).toHaveBeenCalledTimes(1);
      expect(w.queued).toHaveLength(1);
      await expect(w.outbox.process(w.queued[0])).resolves.toBe('sent');
      expect(w.deliver).toHaveBeenCalledTimes(1);
    });

    it('still re-checks at send time, so an unsubscribe after enqueue is honoured', async () => {
      const w = wired('inbox_new_message');
      const t = build({
        members: [A],
        notifyService: w.real,
        prefs: w.prefs,
        claim: w.claim,
      });
      await t.svc.assigned(ASSIGN);
      expect(w.queued).toHaveLength(1);
      // Switched off between enqueue and send.
      w.prefs.shouldSend.mockResolvedValue(false);
      await expect(w.outbox.process(w.queued[0])).resolves.toBe('skipped:pref');
      expect(w.deliver).not.toHaveBeenCalled();
    });

    it('a mention is governed by inbox_mention, not by the new-message toggle', async () => {
      const w = wired('inbox_new_message');
      const t = build({ members: [A], notifyService: w.real });
      await t.svc.noteMentioned({
        workspaceId: WS,
        conversationId: CONV,
        mentionedUserIds: ['a'],
        actorUserId: 'actor',
      });
      await expect(w.outbox.process(w.queued[0])).resolves.toBe('sent');
      expect(w.deliver).toHaveBeenCalledTimes(1);
      expect(w.prefs.shouldSend).toHaveBeenCalledWith(
        'a',
        WS,
        'inbox_mention',
        'email',
      );
    });

    it('sends the assigned email with a one-click unsubscribe and the inbox tags', async () => {
      const w = wired('inbox_new_message');
      const t = build({ members: [A], notifyService: w.real });
      await t.svc.assigned(ASSIGN);
      await expect(w.outbox.process(w.queued[0])).resolves.toBe('sent');
      const [msg, opts] = w.deliver.mock.calls[0] as unknown as [
        { subject: string; html: string; headers: Record<string, string> },
        { tags: { category: string; template: string } },
      ];
      expect(msg.subject).toBe('Hina assigned you a conversation');
      expect(msg.html).toContain('https://app.test/w/w1/inbox?c=c1');
      expect(msg.headers['List-Unsubscribe-Post']).toBe(
        'List-Unsubscribe=One-Click',
      );
      expect(opts.tags).toEqual({
        category: 'inbox',
        template: 'inbox-activity',
      });
    });

    it('notify nothing reaches neither the bell nor the queue', async () => {
      const w = wired('inbox_new_message');
      const t = build({
        members: [A],
        notify: { a: 'nothing' },
        notifyService: w.real,
      });
      await t.svc.assigned(ASSIGN);
      expect(t.emitter.inboxAssigned).not.toHaveBeenCalled();
      expect(w.queued).toHaveLength(0);
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
      expect(emailsOf(t)).toHaveLength(2);
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
      expect(emailsOf(t)[0].email?.props).toMatchObject({
        kind: 'new_message',
        sentence: 'New message from Sam',
      });
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
      expect(t.notify.notify).not.toHaveBeenCalled();
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
      expect(t.notify.notify).not.toHaveBeenCalled();
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
