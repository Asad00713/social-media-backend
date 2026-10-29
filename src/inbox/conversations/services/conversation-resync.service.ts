import { createHash } from 'node:crypto';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { QUEUES } from '../../../queue/queue.module';
import type { SyncIntent } from '../lib/lifecycle';
import {
  ConversationSyncService,
  SyncThreadsError,
} from './conversation-sync.service';

/** The authored outbound intent, JSON-safe (a retried first sync needs it, N5). */
export interface ResyncIntentPayload {
  userId: string;
  markDone: boolean;
  at: string;
}

export type ConversationResyncJob =
  | {
      type: 'sync';
      workspaceId: string;
      threadKey: string;
      intent?: ResyncIntentPayload;
    }
  | { type: 'rekey'; workspaceId: string; fromKey: string; toKey: string };

const sha1 = (s: string): string =>
  createHash('sha1').update(s).digest('hex');

/** Thread keys contain `:`, which BullMQ forbids in a job id, so hash them. */
export const resyncJobId = (workspaceId: string, threadKey: string): string =>
  `resync-${workspaceId}-${sha1(threadKey)}`;

export const rekeyJobId = (
  workspaceId: string,
  fromKey: string,
  toKey: string,
): string => `rekey-${workspaceId}-${sha1(`${fromKey}>${toKey}`)}`;

/**
 * `removeOnComplete/Fail: true` frees the (deduped) job id as soon as a run
 * ends, so a later failure for the same thread can queue again. Failures are
 * logged by the processor on every attempt instead of being kept in Redis.
 */
export const RESYNC_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: true,
};

/** Delay of the follow-up run queued behind one that is already running. */
const FOLLOW_UP_DELAY_MS = 2_000;

const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export function intentPayloadOf(
  intent: SyncIntent | undefined,
): ResyncIntentPayload | undefined {
  if (!intent || intent.kind !== 'outbound') return undefined;
  return {
    userId: intent.userId,
    markDone: intent.markDone,
    at: intent.at.toISOString(),
  };
}

/**
 * A conversation row that failed to sync is never left stale: the failed
 * thread is queued here (deduped per thread) and retried with backoff. A sync
 * is an idempotent re-aggregate under the advisory lock, so a retry is safe.
 */
@Injectable()
export class ConversationResyncService {
  private readonly logger = new Logger(ConversationResyncService.name);

  constructor(
    @InjectQueue(QUEUES.INBOX_RESYNC) private readonly queue: Queue,
    private readonly sync: ConversationSyncService,
  ) {}

  /** Never throws: it is called from catch blocks. */
  async enqueue(
    workspaceId: string,
    threadKey: string,
    intent?: SyncIntent,
  ): Promise<void> {
    const payload = intentPayloadOf(intent);
    const data: ConversationResyncJob = {
      type: 'sync',
      workspaceId,
      threadKey,
      ...(payload ? { intent: payload } : {}),
    };
    await this.put(resyncJobId(workspaceId, threadKey), 'resync', data);
  }

  /** Retry a rekey whose move failed. Never throws. */
  async enqueueRekey(
    workspaceId: string,
    fromKey: string,
    toKey: string,
  ): Promise<void> {
    await this.put(rekeyJobId(workspaceId, fromKey, toKey), 'rekey', {
      type: 'rekey',
      workspaceId,
      fromKey,
      toKey,
    });
  }

  /**
   * BullMQ treats an existing job id, in ANY state, as a duplicate:
   *  - waiting/delayed: it will run later and read the newest facts, so skip;
   *  - failed/completed: remove it so the id is free, then add;
   *  - active: it may have read its facts before our write committed, so queue
   *    one follow-up run behind it (`-next`).
   */
  private async put(
    jobId: string,
    name: string,
    data: ConversationResyncJob,
    delay?: number,
  ): Promise<void> {
    try {
      const existing = await this.queue.getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        if (state === 'failed' || state === 'completed') {
          await existing.remove();
        } else if (state === 'active') {
          if (jobId.endsWith('-next')) return; // one follow-up is enough
          await this.put(`${jobId}-next`, name, data, FOLLOW_UP_DELAY_MS);
          return;
        } else {
          return;
        }
      }
      await this.queue.add(name, data, {
        jobId,
        ...RESYNC_JOB_OPTIONS,
        ...(delay ? { delay } : {}),
      });
    } catch (err) {
      this.logger.error(`could not enqueue ${jobId}: ${errMsg(err)}`);
    }
  }

  /**
   * Sync every key; each failure is logged with its own cause and queued for a
   * retry instead of being lost. Never throws.
   */
  async syncOrEnqueue(
    workspaceId: string,
    threadKeys: Iterable<string>,
  ): Promise<void> {
    const keys = [...new Set(threadKeys)];
    try {
      await this.sync.syncThreads(workspaceId, keys);
      return;
    } catch (err) {
      if (err instanceof SyncThreadsError) {
        for (const f of err.failures) {
          this.logger.error(
            `conversation sync failed for ${f.threadKey} in ws=${workspaceId}: ${errMsg(f.error)}`,
          );
          await this.enqueue(workspaceId, f.threadKey);
        }
        return;
      }
      this.logger.error(
        `conversation sync failed for ${keys.length} thread(s) in ws=${workspaceId}: ${errMsg(err)}`,
      );
    }
    for (const key of keys) await this.enqueue(workspaceId, key);
  }
}

@Processor(QUEUES.INBOX_RESYNC)
export class ConversationResyncProcessor extends WorkerHost {
  private readonly logger = new Logger(ConversationResyncProcessor.name);

  constructor(private readonly sync: ConversationSyncService) {
    super();
  }

  async process(job: Job<ConversationResyncJob>): Promise<void> {
    const d = job.data;
    try {
      if (d.type === 'rekey') {
        await this.sync.rekey(d.workspaceId, d.fromKey, d.toKey);
        return;
      }
      const intent: SyncIntent = d.intent
        ? {
            kind: 'outbound',
            userId: d.intent.userId,
            markDone: d.intent.markDone,
            at: new Date(d.intent.at),
          }
        : { kind: 'refresh' };
      await this.sync.syncThread(d.workspaceId, d.threadKey, intent);
    } catch (err) {
      const what =
        d.type === 'rekey' ? `rekey ${d.fromKey} -> ${d.toKey}` : d.threadKey;
      this.logger.error(
        `resync of ${what} in ws=${d.workspaceId} failed (attempt ${job.attemptsMade + 1}): ${errMsg(err)}`,
      );
      throw err;
    }
  }
}
