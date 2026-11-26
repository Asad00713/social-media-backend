/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- test doubles are loosely typed */
import { ForbiddenException, Logger } from '@nestjs/common';
import { campaigns } from '../../../drizzle/schema/campaigns.schema';
import { socialMediaChannels } from '../../../drizzle/schema/channels.schema';
import { posts } from '../../../drizzle/schema/posts.schema';
import { users } from '../../../drizzle/schema/users.schema';
import {
  EMAIL_JOB_SEND,
  type EmailJobData,
} from '../../../email/queue/email-job';
import { EmailOutboxService } from '../../../email/queue/email-outbox.service';
import { getTemplate } from '../../../email/templates/registry';
import { NotifyService } from '../../../notifications/notify.service';
import { DraftApprovalService } from './draft-approval.service';

const WS = '11111111-1111-4111-8111-111111111111';
const POST = '22222222-2222-4222-8222-222222222222';
const CAMPAIGN = '33333333-3333-4333-8333-333333333333';
const REQUESTER = 'u-requester';
const OWNER = 'u-owner';
const ADMIN = 'u-admin';

const PEOPLE: Record<string, { id: string; email: string; name: string }> = {
  [OWNER]: { id: OWNER, email: 'owner@example.test', name: 'Owner One' },
  [ADMIN]: { id: ADMIN, email: 'admin@example.test', name: 'Sana Noor' },
  [REQUESTER]: {
    id: REQUESTER,
    email: 'ali@example.test',
    name: 'Ali Raza',
  },
};

interface Harness {
  service: DraftApprovalService;
  row: Record<string, any>;
  queued: Array<{ id: string; data: EmailJobData }>;
  bell: { approvalRequested: jest.Mock; draftApproved: jest.Mock };
  add: jest.Mock;
  outbox: EmailOutboxService;
  prefs: { shouldSend: jest.Mock };
  recipients: Record<string, jest.Mock>;
  tables: Map<unknown, any[]>;
}

/** A select chain that resolves to the rows registered for its table. */
function fakeDb(tables: Map<unknown, any[]>) {
  const select = () => ({
    from: (table: unknown) => {
      const chain: any = {
        where: () => chain,
        limit: () => chain,
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
          Promise.resolve(tables.get(table) ?? []).then(ok, bad),
      };
      return chain;
    },
  });
  const tx = {
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => [{ id: POST }] }) }),
    }),
    insert: () => ({ values: async () => undefined }),
  };
  return { select, transaction: async (fn: (t: unknown) => unknown) => fn(tx) };
}

function setup(
  opts: {
    scheduledAt?: Date | null;
    metadata?: Record<string, unknown>;
    mediaItems?: unknown[];
    content?: string;
    timezone?: string;
    admins?: Array<(typeof PEOPLE)[string]>;
    emailPref?: boolean;
  } = {},
): Harness {
  const row: Record<string, any> = {
    id: POST,
    status: 'draft',
    createdById: REQUESTER,
    content: opts.content ?? 'Summer menu is here',
    mediaItems: opts.mediaItems ?? [],
    platformContent: {},
    targets: [{ channelId: '7', platform: 'instagram', status: 'draft' }],
    metadata: opts.metadata ?? {},
    scheduledAt:
      opts.scheduledAt === undefined
        ? new Date('2026-10-26T13:30:00Z')
        : opts.scheduledAt,
    versionMicros: '1',
  };
  const tables = new Map<unknown, any[]>([
    [posts, [row]],
    [users, Object.values(PEOPLE)],
    [
      socialMediaChannels,
      [{ id: 7, username: 'lumierecafe', accountName: 'Lumiere Cafe' }],
    ],
    [campaigns, [{ name: 'Summer menu' }]],
  ]);

  const queued: Harness['queued'] = [];
  const add = jest.fn(async (_name: string, data: EmailJobData, o: any) => {
    queued.push({ id: o.jobId, data });
  });
  const prefs = {
    shouldSend: jest.fn(
      async (_u: string, _w: string | null, _e: string, ch: string) =>
        ch === 'email' ? (opts.emailPref ?? true) : true,
    ),
  };
  const recipients = {
    admins: jest.fn(async () =>
      (opts.admins ?? [PEOPLE[OWNER], PEOPLE[ADMIN], PEOPLE[REQUESTER]]).map(
        (p) => ({ ...p }),
      ),
    ),
    user: jest.fn(async (id: string) => PEOPLE[id] ?? null),
    workspace: jest.fn(async () => ({
      id: WS,
      name: 'Rehman Workspace',
      timezone: opts.timezone ?? 'Asia/Karachi',
    })),
    displayName: jest.fn((r: { name: string | null; email: string }) => {
      return r.name || r.email;
    }),
  };
  const outbox = new EmailOutboxService(
    { add } as any,
    {} as any,
    prefs as any,
    {} as any,
    {} as any,
    { assetBase: () => 'https://app.test/email' } as any,
    {} as any,
    {} as any,
  );
  const notify = new NotifyService(prefs as any, outbox, recipients as any);
  const bell = {
    approvalRequested: jest.fn(async () => undefined),
    draftApproved: jest.fn(async () => undefined),
  };
  const links = {
    planner: (ws: string, post: string) =>
      `https://app.test/w/${ws}/planner?post=${post}`,
  };
  const service = new DraftApprovalService(
    fakeDb(tables) as any,
    bell as any,
    notify,
    recipients as any,
    links as any,
  );
  return { service, row, queued, bell, add, outbox, prefs, recipients, tables };
}

/**
 * The notifications are fire-and-forget, so the request returns before they
 * run. Every fake here settles in microtasks, so one macrotask drains them.
 */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const ask = async (h: Harness, userId = REQUESTER) => {
  const view = await h.service.setRequired(WS, POST, userId, 'MEMBER', true);
  await settle();
  return view;
};

/** The pending request, as the approve path reads it from the row. */
function pending(h: Harness, requestedAt = '2026-10-26T09:00:00.000Z') {
  h.row.metadata = {
    ...h.row.metadata,
    approval: {
      required: true,
      requestedById: REQUESTER,
      requestedAt,
      approvedById: null,
      approvedAt: null,
      approvedFingerprint: null,
    },
  };
}

const approve = async (h: Harness, userId = ADMIN) => {
  const view = await h.service.approve(WS, POST, userId, 'ADMIN');
  await settle();
  return view;
};

const NEVER = new Promise<never>(() => undefined);
const TIMED_OUT = Symbol('timed out');

/** Resolves with the call's result, or TIMED_OUT if it is still blocked. */
const unlessBlocked = <T>(call: Promise<T>) =>
  Promise.race([
    call,
    new Promise<typeof TIMED_OUT>((resolve) =>
      setTimeout(() => resolve(TIMED_OUT), 500),
    ),
  ]);

describe('DraftApprovalService emails', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('C3 approval needed', () => {
    it('emails each approver except the requester, with the C3 footer reason', async () => {
      const h = setup();
      await ask(h);

      expect(h.queued.map((q) => q.data.to.email).sort()).toEqual([
        'admin@example.test',
        'owner@example.test',
      ]);
      for (const { data } of h.queued) {
        expect(data.template).toBe('approval-needed');
        expect(data.workspaceId).toBe(WS);
        expect(getTemplate(data.template).footerReason?.(data.props)).toBe(
          'You get this because you approve posts in Rehman Workspace.',
        );
      }
      expect(
        h.bell.approvalRequested.mock.calls.map((c) => c[0]).sort(),
      ).toEqual([ADMIN, OWNER]);
    });

    it('fills the card from the first target, the workspace zone and the campaign', async () => {
      const h = setup({ metadata: { campaignId: CAMPAIGN } });
      await ask(h);

      expect(h.queued[0].data.props).toEqual({
        requesterName: 'Ali Raza',
        platform: 'instagram',
        platformName: 'Instagram',
        handle: '@lumierecafe',
        when: 'Oct 26, 2026 at 6:30 PM GMT+5',
        caption: 'Summer menu is here',
        thumbnailUrl: null,
        campaignName: 'Summer menu',
        goesOut: 'Oct 26, 2026 at 6:30 PM GMT+5',
        reviewUrl: `https://app.test/w/${WS}/planner?post=${POST}`,
        workspaceName: 'Rehman Workspace',
      });
    });

    it('names a Google Business Profile channel like the other emails do', async () => {
      const h = setup();
      h.row.targets = [
        { channelId: '7', platform: 'google_business', status: 'draft' },
      ];
      h.tables.set(socialMediaChannels, []);
      await ask(h);
      expect(h.queued[0].data.props).toMatchObject({
        platform: 'google_business',
        platformName: 'Google Business Profile',
        handle: 'Google Business Profile',
      });
    });

    it('shows Not scheduled yet for a draft with no time', async () => {
      const h = setup({ scheduledAt: null });
      await ask(h);
      const props: any = h.queued[0].data.props;
      expect(props.goesOut).toBe('Not scheduled yet');
      expect(props.when).toBe('Not scheduled yet');
    });

    it('leaves the campaign out when the post has none, or it no longer exists', async () => {
      const none = setup();
      await ask(none);
      expect((none.queued[0].data.props as any).campaignName).toBeNull();

      const gone = setup({ metadata: { campaignId: CAMPAIGN } });
      gone.tables.set(campaigns, []);
      await ask(gone);
      expect((gone.queued[0].data.props as any).campaignName).toBeNull();

      const junk = setup({ metadata: { campaignId: 'not-a-uuid' } });
      await ask(junk);
      expect((junk.queued[0].data.props as any).campaignName).toBeNull();
    });

    it('uses the account name when the channel has no username, and the network when it is gone', async () => {
      const noName = setup();
      noName.tables.set(socialMediaChannels, [
        { id: 7, username: null, accountName: 'Lumiere Cafe' },
      ]);
      await ask(noName);
      expect((noName.queued[0].data.props as any).handle).toBe('Lumiere Cafe');

      const missing = setup();
      missing.tables.set(socialMediaChannels, []);
      await ask(missing);
      expect((missing.queued[0].data.props as any).handle).toBe('Instagram');
    });

    it('shows an image as the thumbnail, a video by its thumbnail, and refuses non-http urls', async () => {
      const image = setup({
        mediaItems: [{ url: 'https://cdn.test/a.jpg', type: 'image' }],
      });
      await ask(image);
      expect((image.queued[0].data.props as any).thumbnailUrl).toBe(
        'https://cdn.test/a.jpg',
      );

      const video = setup({
        mediaItems: [
          {
            url: 'https://cdn.test/a.mp4',
            type: 'video',
            thumbnailUrl: 'https://cdn.test/t.jpg',
          },
        ],
      });
      await ask(video);
      expect((video.queued[0].data.props as any).thumbnailUrl).toBe(
        'https://cdn.test/t.jpg',
      );

      const bare = setup({
        mediaItems: [{ url: 'https://cdn.test/a.mp4', type: 'video' }],
      });
      await ask(bare);
      expect((bare.queued[0].data.props as any).thumbnailUrl).toBeNull();

      const odd = setup({
        mediaItems: [{ url: 'javascript:alert(1)', type: 'image' }],
      });
      await ask(odd);
      expect((odd.queued[0].data.props as any).thumbnailUrl).toBeNull();
    });

    it('uses one key per request and per approver: a retry repeats it, a new request does not', async () => {
      const h = setup();
      await ask(h);
      const first = h.queued.map((q) => q.id).sort();
      expect(first).toHaveLength(2);
      for (const id of first) {
        expect(id).toMatch(/^approval-requested\.[0-9a-f-]+\.\d+\.u-[a-z]+$/);
        expect(id).not.toContain(':');
      }
      expect(new Set(first).size).toBe(2);

      // The same request notified again (a retry) lands on the same keys.
      await (h.service as any).notifyApprovers(
        WS,
        h.row,
        REQUESTER,
        '2026-10-26T09:00:00.000Z',
      );
      await (h.service as any).notifyApprovers(
        WS,
        h.row,
        REQUESTER,
        '2026-10-26T09:00:00.000Z',
      );
      const repeats = h.queued.slice(2).map((q) => q.id);
      expect(repeats.slice(0, 2).sort()).toEqual(repeats.slice(2).sort());

      // A resubmission after an edit is a new request, so a new key.
      await (h.service as any).notifyApprovers(
        WS,
        h.row,
        REQUESTER,
        '2026-10-27T09:00:00.000Z',
      );
      const later = h.queued.slice(-2).map((q) => q.id);
      expect(later.some((id) => first.includes(id))).toBe(false);
    });

    it('turning approval_request email off stops the email but not the bell', async () => {
      const h = setup({ emailPref: false });
      await ask(h);

      expect(h.bell.approvalRequested).toHaveBeenCalledTimes(2);
      // The email is enqueued, then the worker's preference check drops it.
      expect(h.queued).toHaveLength(2);
      for (const { data } of h.queued) {
        await expect(h.outbox.process(data)).resolves.toBe('skipped:pref');
      }
      expect(h.prefs.shouldSend).toHaveBeenCalledWith(
        ADMIN,
        WS,
        'approval_request',
        'email',
      );
    });

    it('turning the app bell off stops the bell but not the email', async () => {
      const h = setup();
      h.prefs.shouldSend.mockImplementation(
        async (_u: string, _w: unknown, _e: string, ch: string) =>
          ch === 'email',
      );
      await ask(h);
      expect(h.bell.approvalRequested).not.toHaveBeenCalled();
      expect(h.queued).toHaveLength(2);
    });

    it('does not email the requester even when they are the only admin', async () => {
      const h = setup({ admins: [PEOPLE[REQUESTER]] });
      await ask(h);
      expect(h.queued).toHaveLength(0);
      expect(h.bell.approvalRequested).not.toHaveBeenCalled();
    });

    it('never fails the request when the email queue is down, and logs no address or caption', async () => {
      const h = setup({ content: 'SECRET CAPTION TEXT' });
      h.add.mockRejectedValue(new Error('redis is down'));
      const view = await ask(h);

      expect(view).toBeDefined();
      expect(h.bell.approvalRequested).toHaveBeenCalledTimes(2);
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('redis is down');
      expect(logged).not.toContain('@example.test');
      expect(logged).not.toContain('SECRET CAPTION TEXT');
    });

    it('does not wait for the notifications: a lookup that never answers does not block the request', async () => {
      const h = setup();
      h.recipients.admins.mockReturnValue(NEVER);
      const view = await unlessBlocked(
        h.service.setRequired(WS, POST, REQUESTER, 'MEMBER', true),
      );
      expect(view).not.toBe(TIMED_OUT);
    });

    it('skips the email but still rings the bell when the request time is unreadable', async () => {
      const h = setup();
      await (h.service as any).notifyApprovers(
        WS,
        h.row,
        REQUESTER,
        'not a date',
      );
      expect(h.queued).toHaveLength(0);
      expect(h.bell.approvalRequested).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`post ${POST} is unreadable`),
      );
    });

    it('does not warn about an unreadable time when no email would be queued', async () => {
      const onlyRequester = setup({ admins: [PEOPLE[REQUESTER]] });
      await (onlyRequester.service as any).notifyApprovers(
        WS,
        onlyRequester.row,
        REQUESTER,
        'not a date',
      );
      const noWorkspace = setup();
      noWorkspace.recipients.workspace.mockResolvedValue(null);
      await (noWorkspace.service as any).notifyApprovers(
        WS,
        noWorkspace.row,
        REQUESTER,
        'not a date',
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it('never fails the request when the recipient lookup throws', async () => {
      const h = setup();
      h.recipients.admins.mockRejectedValue(new Error('db gone'));
      await expect(ask(h)).resolves.toBeDefined();
      expect(h.queued).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`approval fan-out for post ${POST} failed`),
      );
    });
  });

  describe('C4 post approved', () => {
    it('emails the requester, from the approver, with the post facts', async () => {
      const h = setup();
      pending(h);
      await approve(h);

      expect(h.queued).toHaveLength(1);
      const { id, data } = h.queued[0];
      expect(data.template).toBe('post-approved');
      expect(data.to).toEqual({ email: 'ali@example.test', userId: REQUESTER });
      expect(data.workspaceId).toBe(WS);
      expect(id).toMatch(new RegExp(`^post-approved\\.${POST}\\.\\d+$`));
      expect(data.props).toEqual({
        approverName: 'Sana Noor',
        platform: 'instagram',
        platformName: 'Instagram',
        handle: '@lumierecafe',
        when: 'Oct 26, 2026 at 6:30 PM GMT+5',
        caption: 'Summer menu is here',
        thumbnailUrl: null,
        goesOutSentence:
          'It goes out on Instagram Oct 26, 2026 at 6:30 PM GMT+5. Nothing else to do.',
        plannerUrl: `https://app.test/w/${WS}/planner?post=${POST}`,
      });
      expect(h.bell.draftApproved).toHaveBeenCalledWith(
        REQUESTER,
        expect.objectContaining({
          workspaceId: WS,
          postId: POST,
          approvedByName: 'Sana Noor',
        }),
      );
    });

    it('says it is ready to schedule when there is no time', async () => {
      const h = setup({ scheduledAt: null });
      pending(h);
      await approve(h);
      const props: any = h.queued[0].data.props;
      expect(props.goesOutSentence).toBe("It's ready to schedule.");
      expect(props.when).toBe('Not scheduled yet');
    });

    it('turning post_approved email off stops the email but not the bell', async () => {
      const h = setup({ emailPref: false });
      pending(h);
      await approve(h);
      expect(h.bell.draftApproved).toHaveBeenCalledTimes(1);
      await expect(h.outbox.process(h.queued[0].data)).resolves.toBe(
        'skipped:pref',
      );
      expect(h.prefs.shouldSend).toHaveBeenCalledWith(
        REQUESTER,
        WS,
        'post_approved',
        'email',
      );
    });

    it('does not wait for the notifications: a lookup that never answers does not block the approval', async () => {
      const h = setup();
      pending(h);
      h.recipients.workspace.mockReturnValue(NEVER);
      const view = await unlessBlocked(
        h.service.approve(WS, POST, ADMIN, 'ADMIN'),
      );
      expect(view).not.toBe(TIMED_OUT);
      expect(view).toMatchObject({ required: true });
    });

    it('skips the email but still rings the bell when the approval time is unreadable', async () => {
      const h = setup();
      await (h.service as any).notifyRequester(WS, h.row, ADMIN, REQUESTER, '');
      expect(h.queued).toHaveLength(0);
      expect(h.bell.draftApproved).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`post ${POST} is unreadable`),
      );
    });

    it('names a Google Business Profile channel like the other emails do', async () => {
      const h = setup();
      h.row.targets = [
        { channelId: '7', platform: 'google_business', status: 'draft' },
      ];
      pending(h);
      await approve(h);
      expect(h.queued[0].data.props).toMatchObject({
        platformName: 'Google Business Profile',
        goesOutSentence:
          'It goes out on Google Business Profile Oct 26, 2026 at 6:30 PM GMT+5. Nothing else to do.',
      });
    });

    it('does not warn about an unreadable time when the workspace is gone', async () => {
      const h = setup();
      h.recipients.workspace.mockResolvedValue(null);
      await (h.service as any).notifyRequester(WS, h.row, ADMIN, REQUESTER, '');
      expect(warn).not.toHaveBeenCalled();
    });

    it('turning the post_approved bell off stops the bell but not the email', async () => {
      const h = setup();
      pending(h);
      h.prefs.shouldSend.mockImplementation(
        async (_u: string, _w: unknown, _e: string, ch: string) =>
          ch === 'email',
      );
      await approve(h);
      expect(h.bell.draftApproved).not.toHaveBeenCalled();
      expect(h.queued).toHaveLength(1);
    });

    it('never fails the approval when the email queue is down', async () => {
      const h = setup();
      pending(h);
      h.add.mockRejectedValue(new Error('redis is down'));
      await expect(approve(h)).resolves.toBeDefined();
      expect(h.bell.draftApproved).toHaveBeenCalledTimes(1);
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).not.toContain('@example.test');
    });

    it('queues with the send job name and a key that passes the outbox check', async () => {
      const h = setup();
      pending(h);
      await approve(h);
      expect(h.add).toHaveBeenCalledWith(
        EMAIL_JOB_SEND,
        expect.anything(),
        expect.objectContaining({ jobId: h.queued[0].id }),
      );
    });
  });

  describe('who may ask for approval', () => {
    const OTHER_MEMBER = 'u-other-member';

    it('refuses a MEMBER who is not the author and cannot approve', async () => {
      const h = setup();
      const call = h.service.setRequired(
        WS,
        POST,
        OTHER_MEMBER,
        'MEMBER',
        true,
      );
      await expect(call).rejects.toBeInstanceOf(ForbiddenException);
      await expect(call).rejects.toThrow(
        'Only the author or an approver can ask for approval on this draft.',
      );
      expect(h.row.metadata.approval).toBeUndefined();
    });

    it('answers the current view to a non-author MEMBER when approval is already on, and writes nothing', async () => {
      const h = setup();
      pending(h);
      const before = JSON.stringify(h.row.metadata);
      const view = await h.service.setRequired(
        WS,
        POST,
        OTHER_MEMBER,
        'MEMBER',
        true,
      );
      await settle();
      expect(view).toMatchObject({ required: true });
      expect(JSON.stringify(h.row.metadata)).toBe(before);
      expect(h.bell.approvalRequested).not.toHaveBeenCalled();
    });

    it('still refuses a non-author MEMBER when the call would write: a policy request nobody has sent yet', async () => {
      const h = setup();
      h.row.metadata = {
        approval: {
          required: true,
          byPolicy: true,
          requestedById: REQUESTER,
          requestedAt: '2026-10-26T09:00:00.000Z',
          notifiedAt: null,
          approvedById: null,
          approvedAt: null,
          approvedFingerprint: null,
        },
      };
      await expect(
        h.service.setRequired(WS, POST, OTHER_MEMBER, 'MEMBER', true),
      ).rejects.toThrow(
        'Only the author or an approver can ask for approval on this draft.',
      );
      expect(h.bell.approvalRequested).not.toHaveBeenCalled();
    });

    it('lets the author ask', async () => {
      const h = setup();
      await expect(ask(h, REQUESTER)).resolves.toBeDefined();
      expect(h.bell.approvalRequested).toHaveBeenCalled();
    });

    it.each(['ADMIN', 'OWNER'] as const)(
      'lets %s ask for a draft someone else wrote',
      async (role) => {
        const h = setup();
        await h.service.setRequired(WS, POST, ADMIN, role, true);
        await settle();
        expect(h.bell.approvalRequested).toHaveBeenCalled();
      },
    );

    it('keeps turning approval off for approvers only', async () => {
      const h = setup();
      pending(h);
      await expect(
        h.service.setRequired(WS, POST, OTHER_MEMBER, 'MEMBER', false),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        h.service.setRequired(WS, POST, ADMIN, 'ADMIN', false),
      ).resolves.toBeDefined();
    });
  });
});
