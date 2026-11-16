import { BadRequestException, Logger } from '@nestjs/common';
import type { DbType } from '../../drizzle/db';
import type {
  FailureEntry,
  PostFailureBatchService,
} from '../../email/batching/post-failure-batch.service';
import type { EmailOnceService } from '../../email/email-once.service';
import type { NotificationEmitterService } from '../../notifications/notification-emitter.service';
import type {
  NotifyInput,
  NotifyService,
} from '../../notifications/notify.service';
import type { RecipientsService } from '../../notifications/recipients.service';
import type { WorkspaceRoleService } from '../../workspace-members/workspace-role.service';
import { PartialPublishError } from '../publishers/base.publisher';
import {
  GENERIC_REASON,
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

function make(
  opts: { creatorIsMember?: boolean; onceKeys?: Set<string> } = {},
) {
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
  // Every claim wins unless a test passes its own key set (EmailOnceService).
  const once = {
    claim: jest.fn((key: string, _ttl: number) => {
      const keys = opts.onceKeys;
      if (!keys) return Promise.resolve(true);
      if (keys.has(key)) return Promise.resolve(false);
      keys.add(key);
      return Promise.resolve(true);
    }),
  };
  const svc = new PublishFailureNotifier(
    db as unknown as DbType,
    batch as unknown as PostFailureBatchService,
    notify as unknown as NotifyService,
    recipients as unknown as RecipientsService,
    emitter as unknown as NotificationEmitterService,
    roles as unknown as WorkspaceRoleService,
    once as unknown as EmailOnceService,
  );
  return {
    svc,
    once,
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

  it('keeps a target reason from the publisher, but not internal text or a blank one', async () => {
    const { svc, batch } = make();
    await svc.onPublishOutcome(
      post({
        targets: [
          {
            channelId: '1',
            platform: 'instagram',
            status: 'failed',
            errorMessage: 'Video is longer than 90 seconds',
          },
          {
            channelId: '2',
            platform: 'linkedin',
            status: 'failed',
            errorMessage: 'Failed query: select * from "social_media_channels"',
          },
          { channelId: '3', platform: 'facebook', status: 'failed' },
        ],
      }),
      'scheduler',
    );
    const forCreator = batch.record.mock.calls
      .filter(([u]) => u === 'creator')
      .map(([, , e]) => e.reason);
    expect(forCreator).toEqual([
      'Video is longer than 90 seconds',
      GENERIC_REASON,
      GENERIC_REASON,
    ]);
  });

  it('keeps no URL in a target reason, in the bell or the email', async () => {
    const { svc, batch, emitter } = make();
    const signed = 'https://cdn.test/u/7/v.mp4?X-Amz-Signature=abc';
    await svc.onPublishOutcome(
      post({
        targets: [
          {
            channelId: '1',
            platform: 'twitter',
            status: 'failed',
            errorMessage: `Failed to upload media: ${signed}`,
          },
          {
            channelId: '2',
            platform: 'twitter',
            status: 'failed',
            errorMessage: `Failed to download media from ${signed}`,
          },
          {
            channelId: '3',
            platform: 'facebook',
            status: 'failed',
            errorMessage: `The video at ${signed} is too long`,
          },
        ],
      }),
      'scheduler',
    );
    const forCreator = batch.record.mock.calls
      .filter(([u]) => u === 'creator')
      .map(([, , e]) => e.reason);
    expect(forCreator).toEqual([
      'Failed to upload media',
      'Failed to download media',
      'The video at the media file is too long',
    ]);
    const bells = emitter.postFailed.mock.calls as unknown as string[][];
    expect(bells.length).toBeGreaterThan(0);
    for (const call of bells) expect(call[3]).not.toMatch(/https?:\/\//);
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
  it('records every target that did not go out, with a publish refusal kept as the reason', async () => {
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
    await svc.onFinalJobFailure(
      'post-1',
      new BadRequestException('Post has no target channels'),
    );

    const entries = batch.record.mock.calls.map(([, , e]) => e);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      postId: 'post-1',
      platform: 'instagram',
      reason: 'Post has no target channels',
      otherPublished: ['Facebook'],
    });
  });

  it('a database error never reaches the bell or the email: the generic reason does', async () => {
    const { svc, batch, emitter, setPost } = make();
    setPost(post({ status: 'publishing' }));
    const dbError = new Error(
      'Failed query: select "id" from "posts" where "id" = $1\nparams: post-1',
    );
    await svc.onFinalJobFailure('post-1', dbError);

    expect(GENERIC_REASON).toBe("Schedura couldn't publish it.");
    for (const [, , e] of batch.record.mock.calls) {
      expect(e.reason).toBe(GENERIC_REASON);
    }
    for (const call of emitter.postFailed.mock.calls as unknown as string[][]) {
      expect(call[3]).toBe(GENERIC_REASON);
    }
    // The raw text is logged, by post id only.
    const logged = warn.mock.calls.map(([m]) => String(m)).join('\n');
    expect(logged).toContain('Post post-1');
    expect(logged).toContain('Failed query');
  });

  it('a plain error from the job (a timeout, a bug) is not shown either', async () => {
    const { svc, batch, setPost } = make();
    setPost(post({ status: 'publishing' }));
    await svc.onFinalJobFailure('post-1', new Error('database timeout'));
    expect(batch.record.mock.calls[0][2].reason).toBe(GENERIC_REASON);
  });

  it('keeps no URL in a kept job error', async () => {
    const { svc, batch, setPost } = make();
    setPost(post({ status: 'publishing' }));
    await svc.onFinalJobFailure(
      'post-1',
      new PartialPublishError(
        'Failed to upload media: https://cdn.test/u/7/a.jpg',
        [],
      ),
    );
    for (const [, , e] of batch.record.mock.calls) {
      expect(e.reason).toBe('Failed to upload media');
    }
  });

  it('a reason that was only a URL becomes the generic reason', async () => {
    const { svc, batch } = make();
    await svc.onPublishOutcome(
      post({
        targets: [
          {
            channelId: '1',
            platform: 'twitter',
            status: 'failed',
            errorMessage: 'https://cdn.test/u/7/a.jpg',
          },
        ],
      }),
      'scheduler',
    );
    expect(batch.record.mock.calls[0][2].reason).toBe(GENERIC_REASON);
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

describe('PublishFailureNotifier bell dedupe', () => {
  it('a scheduler failure then the final job failure rings the bell once per person, and still records both for the email window', async () => {
    const { svc, emitter, batch, once, setPost } = make({
      onceKeys: new Set<string>(),
    });
    const failed = post();
    setPost(failed);

    await svc.onPublishOutcome(failed, 'scheduler');
    await svc.onFinalJobFailure('post-1', new Error('Job timed out'));

    // creator, owner, admin: one bell each for (post-1, channel 1).
    expect(emitter.postFailed).toHaveBeenCalledTimes(3);
    // The email window dedupes these itself at flush time.
    expect(batch.record).toHaveBeenCalledTimes(6);
    expect(once.claim).toHaveBeenCalledWith(
      'post-failed-bell.post-1.1.creator',
      600,
    );
  });

  it('a second channel of the same post rings its own bell', async () => {
    const { svc, emitter } = make({ onceKeys: new Set<string>() });
    const failed = post({
      targets: [
        { channelId: '1', platform: 'instagram', status: 'failed' },
        { channelId: '3', platform: 'facebook', status: 'failed' },
      ],
    });

    await svc.onPublishOutcome(failed, 'scheduler');

    expect(emitter.postFailed).toHaveBeenCalledTimes(6);
  });
});
