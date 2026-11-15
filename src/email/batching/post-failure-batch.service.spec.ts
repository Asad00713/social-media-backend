import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { NOTIFICATION_EVENTS } from '../../notification-preferences/notification-events';
import type { PreferenceEventKey } from '../../notification-preferences/notification-events';
import type { NotificationPreferencesService } from '../../notification-preferences/notification-preferences.service';
import type { RecipientsService } from '../../notifications/recipients.service';
import type { DbType } from '../../drizzle/db';
import { AppLinks } from '../links/app-links';
import type { EmailJobData } from '../queue/email-job';
import type { EmailOutboxService } from '../queue/email-outbox.service';
import { IDEMPOTENCY_KEY_RE } from '../queue/email-job';
import { renderEmail } from '../render/render-email';
import { getTemplate } from '../templates/registry';
import type { PostFailedProps } from '../templates/publishing/post-failed';
import type { PostsFailedProps } from '../templates/publishing/posts-failed';
import type { RenderContext } from '../templates/types';
import {
  POST_FAILED_FLUSH_JOB,
  POST_FAILURE_WINDOW_MS,
  PostFailureBatchService,
  type FailureEntry,
  type PostFailedFlushData,
  type PostFailureRedis,
} from './post-failure-batch.service';

const U = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const T0 = new Date('2026-11-14T13:00:00.000Z');

/** In-memory Redis with the real list, NX and RENAME semantics the batch relies on. */
class FakeRedis implements PostFailureRedis {
  readonly lists = new Map<string, string[]>();
  readonly strings = new Map<string, string>();
  /** Runs after a DEL, so a spec can interleave a record() mid-flush. */
  afterDel: ((key: string) => Promise<void>) | null = null;

  rpush(key: string, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.push(value);
    this.lists.set(key, list);
    return Promise.resolve(list.length);
  }

  expire(key: string): Promise<number> {
    return Promise.resolve(this.lists.has(key) ? 1 : 0);
  }

  set(key: string, value: string): Promise<'OK' | null> {
    if (this.strings.has(key)) return Promise.resolve(null);
    this.strings.set(key, value);
    return Promise.resolve('OK');
  }

  async del(key: string): Promise<number> {
    const had = this.lists.delete(key) || this.strings.delete(key);
    const hook = this.afterDel;
    if (hook) {
      this.afterDel = null;
      await hook(key);
    }
    return had ? 1 : 0;
  }

  rename(from: string, to: string): Promise<'OK'> {
    const list = this.lists.get(from);
    if (!list) return Promise.reject(new Error('ERR no such key'));
    this.lists.delete(from);
    this.lists.set(to, list);
    return Promise.resolve('OK');
  }

  lrange(key: string): Promise<string[]> {
    return Promise.resolve([...(this.lists.get(key) ?? [])]);
  }

  exists(key: string): Promise<number> {
    return Promise.resolve(
      this.lists.has(key) || this.strings.has(key) ? 1 : 0,
    );
  }
}

function entry(over: Partial<FailureEntry> = {}): FailureEntry {
  return {
    postId: 'post-1',
    platform: 'instagram',
    handle: '@lumierecafe',
    caption: 'Iced caramel latte, one more week.',
    thumbnailUrl: 'https://cdn.test/t.jpg',
    scheduledFor: '2026-11-14T13:30:00.000Z',
    reason: 'Video is longer than 90 seconds',
    otherPublished: [],
    ...over,
  };
}

function make() {
  const redis = new FakeRedis();
  const queue = {
    add: jest.fn<Promise<unknown>, unknown[]>(() => Promise.resolve({})),
  };
  const prefs = { shouldSend: jest.fn(() => Promise.resolve(true)) };
  const outbox = {
    process: jest.fn<
      Promise<'sent' | 'skipped:pref' | 'skipped:suppressed'>,
      [EmailJobData, number?]
    >(() => Promise.resolve('sent')),
  };
  const recipients = {
    user: jest.fn((id: string) =>
      Promise.resolve({ id, email: 'sana@acme.test', name: 'Sana' }),
    ),
    workspace: jest.fn((id: string) =>
      Promise.resolve({ id, name: 'Rehman Workspace', timezone: 'UTC' }),
    ),
  };
  let onTime = 9;
  const where = jest.fn(() => Promise.resolve([{ count: onTime }]));
  const db = { select: jest.fn(() => ({ from: () => ({ where }) })) };
  const links = new AppLinks({
    get: () => undefined,
  } as unknown as ConfigService);
  const svc = new PostFailureBatchService(
    redis,
    queue as unknown as Queue,
    prefs as unknown as NotificationPreferencesService,
    outbox as unknown as EmailOutboxService,
    recipients as unknown as RecipientsService,
    links,
    db as unknown as DbType,
  );
  return {
    svc,
    redis,
    queue,
    prefs,
    outbox,
    recipients,
    db,
    setOnTime: (n: number) => (onTime = n),
  };
}

/** The windowId of the n-th scheduled flush. */
function windowOf(
  queue: { add: jest.Mock<Promise<unknown>, unknown[]> },
  n = 0,
): string {
  return (queue.add.mock.calls[n][1] as PostFailedFlushData).windowId;
}

function sentProps<P>(
  outbox: { process: jest.Mock<Promise<string>, [EmailJobData, number?]> },
  n = 0,
): P {
  return outbox.process.mock.calls[n][0].props as P;
}

const CTX: RenderContext = {
  assetBaseUrl: 'https://app.test/email',
  footer: { reason: 'Why line', links: [] },
};

beforeEach(() => {
  // Only the clock is fake: React Email's render needs real timers.
  jest.useFakeTimers({
    now: T0,
    doNotFake: [
      'nextTick',
      'queueMicrotask',
      'setImmediate',
      'clearImmediate',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
    ],
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('PostFailureBatchService.record', () => {
  it('first failure opens a window and schedules one delayed flush with a colon-free jobId', async () => {
    const { svc, queue, redis } = make();
    await svc.record(U, WS, entry());

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      'post-failed-flush',
      expect.anything(),
      expect.objectContaining({
        delay: 600000,
        jobId: expect.not.stringContaining(':') as unknown,
      }),
    );
    const [name, data, opts] = queue.add.mock.calls[0] as unknown as [
      string,
      unknown,
      Record<string, unknown>,
    ];
    expect(name).toBe(POST_FAILED_FLUSH_JOB);
    expect(data).toEqual({
      userId: U,
      workspaceId: WS,
      windowId: String(T0.getTime()),
    });
    expect(opts).toEqual({
      jobId: `post-failed.${U}.${WS}.${T0.getTime()}`,
      delay: POST_FAILURE_WINDOW_MS,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
    });
    expect(IDEMPOTENCY_KEY_RE.test(opts.jobId as string)).toBe(true);
    expect(redis.lists.get(`email:pf:${U}:${WS}`)).toHaveLength(1);
  });

  it('a second failure in the window schedules nothing new', async () => {
    const { svc, queue, redis } = make();
    await svc.record(U, WS, entry({ postId: 'a' }));
    jest.setSystemTime(T0.getTime() + 60_000);
    await svc.record(U, WS, entry({ postId: 'b' }));

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(redis.lists.get(`email:pf:${U}:${WS}`)).toHaveLength(2);
  });

  it('a failed schedule releases the window, so the next failure tries again', async () => {
    const { svc, queue, redis } = make();
    queue.add.mockRejectedValueOnce(new Error('redis down'));
    await expect(svc.record(U, WS, entry())).rejects.toThrow('redis down');
    expect(redis.strings.has(`email:pf-open:${U}:${WS}`)).toBe(false);

    await svc.record(U, WS, entry({ postId: 'b' }));
    expect(queue.add).toHaveBeenCalledTimes(2);
  });
});

describe('PostFailureBatchService.flush', () => {
  it('flush with one entry sends post-failed; three entries send posts-failed', async () => {
    const { svc, queue, outbox } = make();
    await svc.record(U, WS, entry({ otherPublished: ['Facebook'] }));
    await expect(svc.flush(U, WS, windowOf(queue))).resolves.toBe('sent');

    const one = outbox.process.mock.calls[0][0];
    expect(one).toMatchObject({
      template: 'post-failed',
      to: { email: 'sana@acme.test', userId: U },
      workspaceId: WS,
      idempotencyKey: `post-failed.${U}.${WS}.${T0.getTime()}`,
    });
    expect(sentProps<PostFailedProps>(outbox)).toEqual({
      platform: 'instagram',
      platformName: 'Instagram',
      handle: '@lumierecafe',
      when: 'Nov 14, 2026 at 1:30 PM UTC',
      caption: 'Iced caramel latte, one more week.',
      thumbnailUrl: 'https://cdn.test/t.jpg',
      reason: 'Video is longer than 90 seconds',
      otherPublished: ['Facebook'],
      editUrl: `http://localhost:3001/w/${WS}/planner?post=post-1`,
    });

    jest.setSystemTime(T0.getTime() + POST_FAILURE_WINDOW_MS + 1000);
    await svc.record(U, WS, entry({ postId: 'a' }));
    await svc.record(U, WS, entry({ postId: 'b', platform: 'tiktok' }));
    await svc.record(U, WS, entry({ postId: 'c', platform: 'linkedin' }));
    await expect(svc.flush(U, WS, windowOf(queue, 1))).resolves.toBe('sent');

    const many = outbox.process.mock.calls[1][0];
    expect(many.template).toBe('posts-failed');
    expect(many.idempotencyKey).toBe(
      `post-failed.${U}.${WS}.${T0.getTime() + POST_FAILURE_WINDOW_MS + 1000}`,
    );
    const props = sentProps<PostsFailedProps>(outbox, 1);
    expect(props).toMatchObject({
      count: 3,
      more: 0,
      otherOnTime: 9,
      plannerUrl: `http://localhost:3001/w/${WS}/planner`,
    });
    expect(props.rows.map((r) => r.platform)).toEqual([
      'instagram',
      'tiktok',
      'linkedin',
    ]);
    expect(props.rows[0]).toEqual({
      platform: 'instagram',
      handle: '@lumierecafe',
      when: 'Nov 14, 2026 at 1:30 PM UTC',
      title: 'Iced caramel latte, one more week.',
      reason: 'Video is longer than 90 seconds',
      thumbnailUrl: 'https://cdn.test/t.jpg',
    });

    const r = await renderEmail(getTemplate('posts-failed'), props, CTX);
    expect(r.subject).toBe("3 posts didn't publish today");
    expect(r.preheader).toBe(
      'Instagram, TikTok and LinkedIn each turned one down.',
    );
    expect(r.text).toContain(
      'Each one needs a quick fix. Your other 9 posts went out on time.',
    );
  });

  it('formats times in the workspace time zone', async () => {
    const { svc, queue, outbox, recipients } = make();
    recipients.workspace.mockResolvedValueOnce({
      id: WS,
      name: 'Rehman Workspace',
      timezone: 'Asia/Karachi',
    });
    await svc.record(U, WS, entry());
    await svc.flush(U, WS, windowOf(queue));
    expect(sentProps<PostFailedProps>(outbox).when).toBe(
      'Nov 14, 2026 at 6:30 PM GMT+5',
    );
  });

  it('flush dedupes the same post', async () => {
    const { svc, queue, outbox } = make();
    await svc.record(U, WS, entry({ reason: 'first try' }));
    await svc.record(U, WS, entry({ reason: 'second try' }));
    await svc.flush(U, WS, windowOf(queue));

    expect(outbox.process).toHaveBeenCalledTimes(1);
    expect(outbox.process.mock.calls[0][0].template).toBe('post-failed');
    expect(sentProps<PostFailedProps>(outbox).reason).toBe('second try');
  });

  it('keeps one post that failed on two networks as two rows', async () => {
    const { svc, queue, outbox } = make();
    await svc.record(U, WS, entry({ platform: 'instagram' }));
    await svc.record(U, WS, entry({ platform: 'tiktok' }));
    await svc.flush(U, WS, windowOf(queue));

    expect(outbox.process.mock.calls[0][0].template).toBe('posts-failed');
    const props = sentProps<PostsFailedProps>(outbox);
    expect(props.count).toBe(2);
    expect(props.rows.map((r) => r.platform)).toEqual(['instagram', 'tiktok']);
  });

  it('a failure recorded during flush lands in a new window', async () => {
    const { svc, queue, outbox, redis } = make();
    await svc.record(U, WS, entry({ postId: 'a' }));
    const first = windowOf(queue);
    jest.setSystemTime(T0.getTime() + POST_FAILURE_WINDOW_MS);

    // Between "DEL open" and "RENAME": it opens a new window at once.
    redis.afterDel = async () => {
      await svc.record(U, WS, entry({ postId: 'b' }));
    };
    await svc.flush(U, WS, first);
    expect(queue.add).toHaveBeenCalledTimes(2);
    const second = windowOf(queue, 1);
    expect(second).not.toBe(first);

    // After the RENAME: it waits in the new window's list.
    await svc.record(U, WS, entry({ postId: 'c' }));
    expect(queue.add).toHaveBeenCalledTimes(2);
    await svc.flush(U, WS, second);

    const delivered = outbox.process.mock.calls.flatMap(([data]) => {
      const p = data.props as Partial<PostFailedProps & PostsFailedProps>;
      return p.rows ? p.rows.map((r) => r.title) : [p.caption];
    });
    // Every failure reaches the person exactly once.
    expect(delivered).toHaveLength(3);
    const keys = outbox.process.mock.calls.map(([d]) => d.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });

  it('flush skips a recipient removed from the workspace (shouldSend false)', async () => {
    const { svc, queue, outbox, prefs, redis } = make();
    await svc.record(U, WS, entry());
    // Removed during the 10-minute window: the catalogue's membership check
    // now answers no.
    prefs.shouldSend.mockResolvedValueOnce(false);

    await expect(svc.flush(U, WS, windowOf(queue))).resolves.toBe('skipped');
    expect(prefs.shouldSend).toHaveBeenCalledWith(
      U,
      WS,
      'post_failed',
      'email',
    );
    expect(outbox.process).not.toHaveBeenCalled();
    expect(redis.lists.size).toBe(0);
  });

  it('returns empty when the window holds nothing', async () => {
    const { svc, outbox } = make();
    await expect(svc.flush(U, WS, String(T0.getTime()))).resolves.toBe('empty');
    expect(outbox.process).not.toHaveBeenCalled();
  });

  it('a retry of the same flush resends the same batch under the same key', async () => {
    const { svc, queue, outbox, redis } = make();
    await svc.record(U, WS, entry());
    const windowId = windowOf(queue);
    outbox.process.mockRejectedValueOnce(new Error('resend 503'));
    await expect(svc.flush(U, WS, windowId)).rejects.toThrow('resend 503');

    // A failure after the first attempt belongs to a new window, not the retry.
    jest.setSystemTime(T0.getTime() + POST_FAILURE_WINDOW_MS + 5000);
    await svc.record(U, WS, entry({ postId: 'later' }));

    await expect(svc.flush(U, WS, windowId, 1)).resolves.toBe('sent');
    const [first, retry] = outbox.process.mock.calls;
    expect(retry[0].idempotencyKey).toBe(first[0].idempotencyKey);
    expect(retry[0].template).toBe('post-failed');
    expect(retry[1]).toBe(1);
    expect(redis.lists.get(`email:pf:${U}:${WS}`)).toHaveLength(1);
    expect(redis.strings.has(`email:pf-open:${U}:${WS}`)).toBe(true);
  });

  it('15 failures → 10 rows and "and 5 more"', async () => {
    const { svc, queue, outbox } = make();
    for (let i = 0; i < 15; i += 1) {
      await svc.record(U, WS, entry({ postId: `p${i}` }));
    }
    await svc.flush(U, WS, windowOf(queue));

    const props = sentProps<PostsFailedProps>(outbox);
    expect(props.count).toBe(15);
    expect(props.rows).toHaveLength(10);
    expect(props.more).toBe(5);
    const r = await renderEmail(getTemplate('posts-failed'), props, CTX);
    expect(r.subject).toBe("15 posts didn't publish today");
    expect(r.text).toContain('and 5 more');
    expect(r.preheader).toBe('Instagram turned them down.');
  });

  it('omits "Your other N posts" when none went out today', async () => {
    const { svc, queue, outbox, setOnTime } = make();
    setOnTime(0);
    await svc.record(U, WS, entry({ postId: 'a' }));
    await svc.record(U, WS, entry({ postId: 'b' }));
    await svc.flush(U, WS, windowOf(queue));

    const props = sentProps<PostsFailedProps>(outbox);
    expect(props.otherOnTime).toBe(0);
    const r = await renderEmail(getTemplate('posts-failed'), props, CTX);
    expect(r.text).toContain('Each one needs a quick fix.');
    expect(r.text).not.toContain('went out on time');
  });

  it('empty caption renders (No caption); a 5000-char caption is truncated', async () => {
    const { svc, queue, outbox } = make();
    await svc.record(U, WS, entry({ caption: '' }));
    await svc.flush(U, WS, windowOf(queue));
    const blank = await renderEmail(
      getTemplate('post-failed'),
      sentProps<PostFailedProps>(outbox),
      CTX,
    );
    expect(blank.html).toContain('(No caption)');

    jest.setSystemTime(T0.getTime() + POST_FAILURE_WINDOW_MS + 1000);
    const long = `<script>alert("x")</script> & ${'a'.repeat(5000)}`;
    await svc.record(U, WS, entry({ caption: long, reason: 'r'.repeat(500) }));
    await svc.flush(U, WS, windowOf(queue, 1));
    const props = sentProps<PostFailedProps>(outbox, 1);
    const r = await renderEmail(getTemplate('post-failed'), props, CTX);
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;');
    expect(r.html).not.toContain('a'.repeat(280));
    expect(r.html).toContain('…');
    // The red callout carries the reason, cut to 200.
    expect(r.html).toContain(`${'r'.repeat(199)}…`);
    expect(r.html).not.toContain('r'.repeat(200));

    jest.setSystemTime(T0.getTime() + 2 * POST_FAILURE_WINDOW_MS + 2000);
    await svc.record(U, WS, entry({ postId: 'x', caption: '   ' }));
    await svc.record(U, WS, entry({ postId: 'y', caption: long }));
    await svc.flush(U, WS, windowOf(queue, 2));
    const rows = sentProps<PostsFailedProps>(outbox, 2).rows;
    expect(rows[0].title).toBe('(No caption)');
    expect(Array.from(rows[1].title)).toHaveLength(60);
    expect(rows[1].title.endsWith('…')).toBe(true);
  });
});

describe('C1 / C1a copy', () => {
  const c1: PostFailedProps = {
    platform: 'instagram',
    platformName: 'Instagram',
    handle: '@lumierecafe',
    when: 'Today, 6:30 PM',
    caption: 'Iced caramel latte',
    thumbnailUrl: null,
    reason: "Instagram didn't accept the video",
    otherPublished: ['Facebook', 'TikTok'],
    editUrl: 'https://app.test/w/ws/planner?post=p1',
  };

  it('C1 says which networks went out, else asks for a fix', async () => {
    const def = getTemplate('post-failed');
    const r = await renderEmail(def, c1, CTX);
    expect(r.subject).toBe("Your Instagram post didn't publish");
    expect(r.preheader).toBe(
      "Instagram didn't accept it. Edit it and we'll try again.",
    );
    expect(r.text).toContain(
      'The same post on Facebook and TikTok went out on time.',
    );
    expect(r.text).not.toContain('Fix it and publish again.');
    expect(r.text).not.toContain('Why this happens');
    expect(r.html).toContain('Edit post');
    expect(r.html).toContain('icon-danger.png');

    const alone = await renderEmail(def, { ...c1, otherPublished: [] }, CTX);
    expect(alone.text).toContain('Fix it and publish again.');
    expect(alone.text).not.toContain('went out on time');
  });

  it('C1a says "1 post" for one other post on time', async () => {
    const props: PostsFailedProps = {
      count: 2,
      rows: [],
      more: 0,
      otherOnTime: 1,
      plannerUrl: 'https://app.test/w/ws/planner',
    };
    const r = await renderEmail(getTemplate('posts-failed'), props, CTX);
    expect(r.text).toContain('Your other 1 post went out on time.');
    expect(r.html).toContain('Open Planner');
  });

  it('both templates sit behind a toggleable preference, never a locked one', () => {
    for (const id of ['post-failed', 'posts-failed']) {
      const def = getTemplate(id);
      expect(def.footer).toBe('notification');
      expect(def.category).toBe('publishing');
      expect(def.event).toBe('post_failed');
      const rule = NOTIFICATION_EVENTS[def.event as PreferenceEventKey].email;
      expect(rule).not.toBeNull();
      expect(rule?.locked).toBe(false);
    }
  });
});
