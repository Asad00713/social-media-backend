import { createHash } from 'node:crypto';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { QUEUES } from '../../../queue/queue.module';
import {
  ConversationSyncService,
  SyncThreadsError,
} from './conversation-sync.service';

export interface ConversationResyncJob {
  workspaceId: string;
  threadKey: string;
}

/** Thread keys contain `:`, which BullMQ forbids in a job id, so hash them. */
export const resyncJobId = (workspaceId: string, threadKey: string): string =>
  `resync-${workspaceId}-${createHash('sha1').update(threadKey).digest('hex')}`;

export const RESYNC_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: 1_000,
};

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
  async enqueue(workspaceId: string, threadKey: string): Promise<void> {
    try {
      await this.queue.add(
        'resync',
        { workspaceId, threadKey } satisfies ConversationResyncJob,
        {
          jobId: resyncJobId(workspaceId, threadKey),
          ...RESYNC_JOB_OPTIONS,
        },
      );
    } catch (err) {
      this.logger.error(
        `could not enqueue resync for ${threadKey} in ws=${workspaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Sync every key; each failure is queued for a retry instead of being lost.
   * Never throws.
   */
  async syncOrEnqueue(
    workspaceId: string,
    threadKeys: Iterable<string>,
  ): Promise<void> {
    const keys = [...new Set(threadKeys)];
    let failed: string[] = keys;
    try {
      await this.sync.syncThreads(workspaceId, keys);
      return;
    } catch (err) {
      if (err instanceof SyncThreadsError) {
        failed = err.failures.map((f) => f.threadKey);
      }
      this.logger.error(
        `conversation sync failed for ${failed.length} thread(s) in ws=${workspaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    for (const key of failed) await this.enqueue(workspaceId, key);
  }
}

@Processor(QUEUES.INBOX_RESYNC)
export class ConversationResyncProcessor extends WorkerHost {
  constructor(private readonly sync: ConversationSyncService) {
    super();
  }

  async process(job: Job<ConversationResyncJob>): Promise<void> {
    await this.sync.syncThread(job.data.workspaceId, job.data.threadKey);
  }
}
