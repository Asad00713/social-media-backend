import { Logger } from '@nestjs/common';
import type { DbType } from '../../drizzle/db';
import type {
  FailureEntry,
  PostFailureBatchService,
} from '../../email/batching/post-failure-batch.service';
import type { NotificationEmitterService } from '../../notifications/notification-emitter.service';
import type {
  NotifyInput,
  NotifyService,
} from '../../notifications/notify.service';
import type { RecipientsService } from '../../notifications/recipients.service';
import type { WorkspaceRoleService } from '../../workspace-members/workspace-role.service';
import {
  PublishFailureNotifier,
  type NotifiablePost,
} from './publish-failure-notifier.service';

const WS = 'ws-1';
const SCHEDULED = new Date('2026-11-14T13:30:00.000Z');

interface ChannelRow {
  id: number;
  username: string | null;
  accountName: string;
}

function make(opts: { creatorIsMember?: boolean } = {}) {
  let channelRows: ChannelRow[] = [
    { id: 1, username: 'lumierecafe', accountName: 'Lumiere Cafe' },
    { id: 2, username: null, accountName: 'Lumière Café' },
    { id: 3, username: 'lumiere', accountName: 'Lumiere' },
  ];
  let postRows: unknown[] = [];
  // The notifier reads channels (select...where) and, on a final job
  // failure, the post (select...where...limit).
  const db = {
    select: jest.fn(() => ({
      from: () => ({
        where: () => {
          const rows = Promise.resolve(channelRows);
          return Object.assign(rows, {
            limit: () => Promise.resolve(postRows),
          });
        },
      }),
    })),
  };
  const batch = {
    record: jest.fn<Promise<void>, [string, string, FailureEntry]>(() =>
      Promise.resolve(),
    ),
  };
  const notify = {
    notify: jest.fn(async (input: NotifyInput<unknown>) => {
      await input.bell?.();
    }),
  };
  const recipients = {
    admins: jest.fn(() =>
      Promise.resolve([
        { id: 'owner', email: 'o@x.test', name: 'Owner' },
        // The creator is also an ADMIN, unless they have left.
        ...(opts.creatorIsMember === false
          ? []
          : [{ id: 'creator', email: 'c@x.test', name: 'Creator' }]),
        { id: 'admin', email: 'a@x.test', name: 'Admin' },
      ]),
    ),
  };
  const emitter = { postFailed: jest.fn(() => Promise.resolve({})) };
  const roles = {
    getRole: jest.fn(() =>
      Promise.resolve(opts.creatorIsMember === false ? null : 'MEMBER'),
    ),
  };
  const svc = new PublishFailureNotifier(
    db as unknown as DbType,
    batch as unknown as PostFailureBatchService,
    notify as unknown as NotifyService,
    recipients as unknown as RecipientsService,
    emitter as unknown as NotificationEmitterService,
    roles as unknown as WorkspaceRoleService,
  );
  return {
    svc,
    db,
    batch,
    notify,
    recipients,
    emitter,
    roles,
    setChannels: (rows: ChannelRow[]) => (channelRows = rows),
    setPost: (row: unknown) => (postRows = row ? [row] : []),
  };
}

function post(over: Partial<NotifiablePost> = {}): NotifiablePost {
  return {
    id: 'post-1',
    workspaceId: WS,
    createdById: 'creator',
    status: 'failed',
    content: 'Iced caramel latte, one more week.',
    mediaItems: [
      { url: 'https://cdn.test/v.mp4', type: 'video', thumbnailUrl: null },
    ] as unknown as NotifiablePost['mediaItems'],
    platformContent: {},
    scheduledAt: SCHEDULED,
    targets: [
      {
        channelId: '1',
        platform: 'instagram',
        status: 'failed',
        errorMessage: 'Video is longer than 90 seconds',
      },
    ],
    ...over,
  };
}

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('PublishFailureNotifier.onPublishOutcome', () => {
  it('user-initiated publish (triggeredBy "user") records nothing', async () => {
    const { svc, batch, notify } = make();
    await svc.onPublishOutcome(post(), 'user');
    expect(batch.record).not.toHaveBeenCalled();
    expect(notify.notify).not.toHaveBeenCalled();
  });

  it('a published or still-held post records nothing', async () => {
    const { svc, batch } = make();
    await svc.onPublishOutcome(post({ status: 'published' }), 'scheduler');
    await svc.onPublishOutcome(post({ status: 'scheduled' }), 'scheduler');
    expect(batch.record).not.toHaveBeenCalled();
  });

  it('rings the bell and records the failure for the creator plus owner and admins, once each', async () => {
    const { svc, batch, notify, emitter } = make();
    await svc.onPublishOutcome(post(), 'scheduler');

    const users = batch.record.mock.calls.map(([u]) => u);
    expect(users).toEqual(['creator', 'owner', 'admin']);
    const entry: FailureEntry = {
      postId: 'post-1',
      platform: 'instagram',
      handle: '@lumierecafe',
      caption: 'Iced caramel latte, one more week.',
      thumbnailUrl: null,
      scheduledFor: SCHEDULED.toISOString(),
      reason: 'Video is longer than 90 seconds',
      otherPublished: [],
    };
    for (const call of batch.record.mock.calls) {
      expect(call[1]).toBe(WS);
      expect(call[2]).toEqual(entry);
    }
    expect(notify.notify).toHaveBeenCalledTimes(3);
    expect(notify.notify.mock.calls[0][0]).toMatchObject({
      userId: 'creator',
      workspaceId: WS,
      event: 'post_failed',
    });
    expect(notify.notify.mock.calls[0][0].email).toBeUndefined();
    expect(emitter.postFailed).toHaveBeenCalledWith(
      'creator',
      'Instagram',
      'Iced caramel latte, one more week.',
      'Video is longer than 90 seconds',
    );
  });

  it('leaves out a creator who is no longer a member', async () => {
    const { svc, batch, roles } = make({ creatorIsMember: false });
    await svc.onPublishOutcome(post(), 'scheduler');
    expect(roles.getRole).toHaveBeenCalledWith(WS, 'creator');
    expect(batch.record.mock.calls.map(([u]) => u)).toEqual(['owner', 'admin']);
  });

  it('partially_published notifies with the published platforms in otherPublished', async () => {
    const { svc, batch, emitter } = make();
    await svc.onPublishOutcome(
      post({
        status: 'partially_published',
        targets: [
          { channelId: '3', platform: 'facebook', status: 'published' },
          {
            channelId: '1',
            platform: 'instagram',
            status: 'failed',
            errorMessage: 'Video is longer than 90 seconds',
          },
          { channelId: '4', platform: 'tiktok', status: 'published' },
          {
            channelId: '2',
            platform: 'linkedin',
            status: 'failed',
            errorMessage: 'Image is larger than LinkedIn allows',
          },
        ],
      }),
      'scheduler',
    );

    const forCreator = batch.record.mock.calls
      .filter(([u]) => u === 'creator')
      .map(([, , e]) => e);
    expect(forCreator.map((e) => [e.platform, e.handle])).toEqual([
      ['instagram', '@lumierecafe'],
      ['linkedin', 'Lumière Café'],
    ]);
    for (const e of forCreator) {
      expect(e.otherPublished).toEqual(['Facebook', 'TikTok']);
    }
    expect(emitter.postFailed).toHaveBeenCalledWith(
      'creator',
      'LinkedIn',
      'Iced caramel latte, one more week.',
      'Image is larger than LinkedIn allows',
    );
  });

  it("uses the channel's own caption and image, and (No caption) for a blank one", async () => {
    const { svc, batch, emitter } = make();
    await svc.onPublishOutcome(
      post({
        content: '',
        mediaItems: [
          { url: 'https://cdn.test/a.jpg', type: 'image' },
        ] as unknown as NotifiablePost['mediaItems'],
      }),
      'scheduler',
    );
    expect(batch.record.mock.calls[0][2]).toMatchObject({
      caption: '',
      thumbnailUrl: 'https://cdn.test/a.jpg',
    });
    expect(emitter.postFailed.mock.calls[0]).toEqual([
      'creator',
      'Instagram',
      '(No caption)',
      'Video is longer than 90 seconds',
    ]);

    batch.record.mockClear();
    await svc.onPublishOutcome(
      post({
        platformContent: {
          instagram: { overrides: { text: 'IG only words' } },
        },
      }),
      'scheduler',
    );
    expect(batch.record.mock.calls[0][2].caption).toBe('IG only words');
  });

  it('never throws, and logs no address, when recording fails', async () => {
    const { svc, batch } = make();
    batch.record.mockRejectedValue(new Error('redis down'));
    await expect(
      svc.onPublishOutcome(post(), 'scheduler'),
    ).resolves.toBeUndefined();
    // Every recipient was still tried.
    expect(batch.record).toHaveBeenCalledTimes(3);
    const lines = warn.mock.calls.map(([m]) => String(m));
    expect(lines.some((l) => l.includes('redis down'))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/@x\.test/);
  });

  it('never throws when the recipient lookup fails', async () => {
    const { svc, recipients } = make();
    recipients.admins.mockRejectedValueOnce(new Error('db down'));
    await expect(
      svc.onPublishOutcome(post(), 'scheduler'),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe('PublishFailureNotifier.onFinalJobFailure', () => {
  it('records every target that did not go out as failed with the job error', async () => {
    const { svc, batch, setPost } = make();
    setPost(
      post({
        status: 'publishing',
        targets: [
          { channelId: '1', platform: 'instagram', status: 'scheduled' },
          { channelId: '3', platform: 'facebook', status: 'published' },
        ],
      }),
    );
    await svc.onFinalJobFailure('post-1', new Error('database timeout'));

    const entries = batch.record.mock.calls.map(([, , e]) => e);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      postId: 'post-1',
      platform: 'instagram',
      reason: 'database timeout',
      otherPublished: ['Facebook'],
    });
  });

  it('does nothing for a post that is gone or went out', async () => {
    const { svc, batch, setPost } = make();
    setPost(null);
    await svc.onFinalJobFailure('post-1', new Error('x'));
    setPost(post({ status: 'published' }));
    await svc.onFinalJobFailure('post-1', new Error('x'));
    expect(batch.record).not.toHaveBeenCalled();
  });

  it('never throws when the post cannot be read', async () => {
    const { svc, db } = make();
    db.select.mockImplementationOnce(() => {
      throw new Error('db down');
    });
    await expect(
      svc.onFinalJobFailure('post-1', new Error('x')),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
