import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { and, eq, notInArray, sql } from 'drizzle-orm';
import { REDIS_CLIENT } from '../../channels/analytics/redis-client.provider';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { posts } from '../../drizzle/schema/posts.schema';
import { NotificationPreferencesService } from '../../notification-preferences/notification-preferences.service';
import { RecipientsService } from '../../notifications/recipients.service';
import { QUEUES } from '../../queue/queue.module';
import { AppLinks } from '../links/app-links';
import { formatWhen, usableZone } from '../links/format-when';
import { EmailOutboxService } from '../queue/email-outbox.service';
import { networkName } from '../render/components/post-card';
import {
  POST_FAILED,
  type PostFailedProps,
} from '../templates/publishing/post-failed';
import {
  POSTS_FAILED,
  type PostsFailedProps,
} from '../templates/publishing/posts-failed';
import { livePosts } from '../../posts/soft-delete/soft-delete';

/** One failed post on one channel, as the window keeps it. */
export interface FailureEntry {
  postId: string;
  platform: string;
  handle: string;
  caption: string;
  thumbnailUrl: string | null;
  /** ISO time the post was meant to go out. */
  scheduledFor: string;
  reason: string;
  /** Display names of the networks the same post reached. */
  otherPublished: string[];
}

/** The `post-failed-flush` job payload. */
export interface PostFailedFlushData {
  userId: string;
  workspaceId: string;
  windowId: string;
}

/** The Redis calls the batch makes (ioredis satisfies this). */
export interface PostFailureRedis {
  rpush(key: string, value: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  set(
    key: string,
    value: string,
    mode: 'EX',
    seconds: number,
    flag?: 'NX',
  ): Promise<'OK' | null>;
  del(key: string): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

/**
 * Closes a window atomically, so two copies of one flush job (a stalled
 * re-run beside the original) can neither overwrite a batch nor take a list
 * that a newer failure is filling.
 * - The flush is done: returns -2 and touches nothing.
 * - Its batch exists (an earlier attempt or the other copy took the list):
 *   returns 2, and the caller sends that batch again under the same key.
 * - Otherwise the flush owns the list when the open key holds its windowId,
 *   or when the open key is gone (it expired in a queue backlog and no newer
 *   window opened: nobody else will send these failures). It DELs the open
 *   key if present, RENAMEs the list to the batch key and gives the batch its
 *   own TTL (RENAME keeps the list's 30 minutes, too short for a delayed
 *   retry). Returns 1.
 * - It owned the window but there was no list (0), or a newer window is open
 *   (-1: that window's list already holds this one's failures, and its flush
 *   sends them): it marks the flush done in the same step and returns.
 * KEYS: open, list, batch, done. ARGV: windowId, batch TTL, done TTL. A fixed
 * server-side script: every value travels as a key or an argument, never in
 * the script text.
 */
export const CLOSE_WINDOW_SCRIPT = `
if redis.call('EXISTS', KEYS[4]) == 1 then
  return -2
end
if redis.call('EXISTS', KEYS[3]) == 1 then
  return 2
end
local open = redis.call('GET', KEYS[1])
if open and open ~= ARGV[1] then
  redis.call('SET', KEYS[4], '1', 'EX', ARGV[3])
  return -1
end
if open then
  redis.call('DEL', KEYS[1])
end
if redis.call('EXISTS', KEYS[2]) == 0 then
  redis.call('SET', KEYS[4], '1', 'EX', ARGV[3])
  return 0
end
redis.call('RENAME', KEYS[2], KEYS[3])
redis.call('EXPIRE', KEYS[3], ARGV[2])
return 1
`;

export const POST_FAILED_FLUSH_JOB = 'post-failed-flush';
export const POST_FAILURE_WINDOW_MS = 600_000;

const LIST_TTL_S = 1800;
const OPEN_TTL_S = 900;
/** A finished flush is remembered for a day, past any stalled re-run. */
const DONE_TTL_S = 86_400;
/** A taken batch waits a day for the flush's delayed retries. */
const BATCH_TTL_S = 86_400;
const FLUSH_ATTEMPTS = 5;
const FLUSH_BACKOFF_MS = 2000;
const MAX_ROWS = 10;
const TITLE_LIMIT = 60;

const listKey = (u: string, ws: string) => `email:pf:${u}:${ws}`;
const openKey = (u: string, ws: string) => `email:pf-open:${u}:${ws}`;
/**
 * Per recipient as well as per window: windows of different people opened in
 * the same millisecond (one post failing for its creator and its admins)
 * must not share a key.
 */
const flushKey = (u: string, ws: string, windowId: string) =>
  `email:pf-flush:${u}:${ws}:${windowId}`;
const doneKey = (u: string, ws: string, windowId: string) =>
  `email:pf-done:${u}:${ws}:${windowId}`;
/** The job id and the email's idempotency key: one per window, no `:`. */
export const flushJobId = (u: string, ws: string, windowId: string) =>
  `post-failed.${u}.${ws}.${windowId}`;

/**
 * A post's title in a list or a bell: the first 60 characters of its caption
 * (59 plus `…` when cut), or `(No caption)`.
 */
export function postTitle(caption: string): string {
  const chars = Array.from(caption.trim());
  if (chars.length === 0) return '(No caption)';
  if (chars.length <= TITLE_LIMIT) return chars.join('');
  return `${chars.slice(0, TITLE_LIMIT - 1).join('')}…`;
}

function parseEntries(raw: string[]): FailureEntry[] {
  const out: FailureEntry[] = [];
  for (const line of raw) {
    try {
      out.push(JSON.parse(line) as FailureEntry);
    } catch {
      // A malformed line is dropped; the rest of the batch still goes out.
    }
  }
  return out;
}

/**
 * The same failure recorded twice (a retry, or the job's final failure after
 * publishPost already recorded it) counts once, the last one winning. A post
 * that failed on two channels stays two entries.
 */
function dedupe(entries: FailureEntry[]): FailureEntry[] {
  const byKey = new Map<string, FailureEntry>();
  for (const e of entries) {
    byKey.set(JSON.stringify([e.postId, e.platform, e.handle]), e);
  }
  return [...byKey.values()];
}

/**
 * C1 / C1a: a person's post failures in one workspace become one email per
 * 10-minute window (spec §6). Redis holds the window; a delayed job on the
 * email queue flushes it.
 */
@Injectable()
export class PostFailureBatchService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: PostFailureRedis,
    @InjectQueue(QUEUES.EMAIL) private readonly queue: Queue,
    private readonly prefs: NotificationPreferencesService,
    private readonly outbox: EmailOutboxService,
    private readonly recipients: RecipientsService,
    private readonly links: AppLinks,
    @Inject(DRIZZLE) private readonly db: DbType,
  ) {}

  /**
   * Adds the failure to the open window, opening one (and scheduling its
   * flush) when there is none. Throws on a Redis or queue error; the caller
   * logs it.
   */
  async record(
    userId: string,
    workspaceId: string,
    entry: FailureEntry,
  ): Promise<void> {
    const list = listKey(userId, workspaceId);
    await this.redis.rpush(list, JSON.stringify(entry));
    await this.redis.expire(list, LIST_TTL_S);

    const windowId = String(Date.now());
    const open = openKey(userId, workspaceId);
    const claimed = await this.redis.set(
      open,
      windowId,
      'EX',
      OPEN_TTL_S,
      'NX',
    );
    if (claimed !== 'OK') return;

    const data: PostFailedFlushData = { userId, workspaceId, windowId };
    try {
      await this.queue.add(POST_FAILED_FLUSH_JOB, data, {
        jobId: flushJobId(userId, workspaceId, windowId),
        delay: POST_FAILURE_WINDOW_MS,
        attempts: FLUSH_ATTEMPTS,
        backoff: { type: 'exponential', delay: FLUSH_BACKOFF_MS },
      });
    } catch (err) {
      // No flush is coming for this window: release it, so the next failure
      // opens one that has a flush.
      await this.redis.del(open).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Closes the window and sends what it holds. A retry of the same job reuses
   * the batch the first attempt took (same key, same idempotency key) and
   * never touches a newer window; the batch is deleted only once handled.
   */
  async flush(
    userId: string,
    workspaceId: string,
    windowId: string,
    attemptsMade = 0,
  ): Promise<'sent' | 'empty' | 'skipped'> {
    const done = doneKey(userId, workspaceId, windowId);
    const batch = flushKey(userId, workspaceId, windowId);
    // One atomic step: a finished flush (a stalled re-run) never renames, an
    // existing batch is reused, a newer open window keeps its list (which
    // holds this window's failures too); otherwise this flush takes it.
    const closed = Number(
      await this.redis.eval(
        CLOSE_WINDOW_SCRIPT,
        4,
        openKey(userId, workspaceId),
        listKey(userId, workspaceId),
        batch,
        done,
        windowId,
        String(BATCH_TTL_S),
        String(DONE_TTL_S),
      ),
    );
    if (closed !== 1 && closed !== 2) return 'empty';

    const entries = dedupe(parseEntries(await this.redis.lrange(batch, 0, -1)));
    const outcome =
      entries.length === 0
        ? 'empty'
        : await this.send(userId, workspaceId, windowId, entries, attemptsMade);
    // Marked before the batch goes: a retry after a failed DEL sends nothing.
    await this.markDone(done);
    await this.redis.del(batch);
    return outcome;
  }

  private async markDone(key: string): Promise<void> {
    await this.redis.set(key, '1', 'EX', DONE_TTL_S);
  }

  private async send(
    userId: string,
    workspaceId: string,
    windowId: string,
    entries: FailureEntry[],
    attemptsMade: number,
  ): Promise<'sent' | 'skipped'> {
    // Re-checked now, not at record time: the person may have left the
    // workspace or switched the email off during the window.
    if (
      !(await this.prefs.shouldSend(
        userId,
        workspaceId,
        'post_failed',
        'email',
      ))
    ) {
      return 'skipped';
    }
    const [user, ws] = await Promise.all([
      this.recipients.user(userId),
      this.recipients.workspace(workspaceId),
    ]);
    if (!user || !ws) return 'skipped';
    const zone = usableZone(ws.timezone || 'UTC');

    const message =
      entries.length === 1
        ? {
            template: POST_FAILED.id,
            props: this.postFailedProps(workspaceId, entries[0], zone),
          }
        : {
            template: POSTS_FAILED.id,
            props: await this.postsFailedProps(workspaceId, entries, zone),
          };
    const status = await this.outbox.process(
      {
        ...message,
        to: { email: user.email, userId },
        workspaceId,
        idempotencyKey: flushJobId(userId, workspaceId, windowId),
      },
      attemptsMade,
    );
    return status === 'sent' ? 'sent' : 'skipped';
  }

  private postFailedProps(
    workspaceId: string,
    e: FailureEntry,
    zone: string,
  ): PostFailedProps {
    return {
      platform: e.platform,
      platformName: networkName(e.platform),
      handle: e.handle,
      when: formatWhen(new Date(e.scheduledFor), zone),
      caption: e.caption,
      thumbnailUrl: e.thumbnailUrl,
      reason: e.reason,
      otherPublished: e.otherPublished,
      editUrl: this.links.planner(workspaceId, e.postId),
    };
  }

  private async postsFailedProps(
    workspaceId: string,
    entries: FailureEntry[],
    zone: string,
  ): Promise<PostsFailedProps> {
    return {
      count: new Set(entries.map((e) => e.postId)).size,
      rows: entries.slice(0, MAX_ROWS).map((e) => ({
        platform: e.platform,
        handle: e.handle,
        when: formatWhen(new Date(e.scheduledFor), zone),
        title: postTitle(e.caption),
        reason: e.reason,
        thumbnailUrl: e.thumbnailUrl,
      })),
      more: Math.max(0, entries.length - MAX_ROWS),
      platforms: [...new Set(entries.map((e) => e.platform))],
      otherOnTime: await this.publishedToday(
        workspaceId,
        entries.map((e) => e.postId),
        zone,
      ),
      plannerUrl: this.links.planner(workspaceId),
    };
  }

  /** Posts in the workspace that went out since midnight in its time zone. */
  private async publishedToday(
    workspaceId: string,
    failedIds: string[],
    zone: string,
  ): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(posts)
      .where(and(and(
          eq(posts.workspaceId, workspaceId),
          eq(posts.status, 'published'),
          sql`${posts.publishedAt} >= (date_trunc('day', now() AT TIME ZONE ${zone}) AT TIME ZONE ${zone})`,
          notInArray(posts.id, failedIds),
        ), livePosts()));
    return Number(row?.count ?? 0);
  }
}
