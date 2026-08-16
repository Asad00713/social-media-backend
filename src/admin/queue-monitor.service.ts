import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';
import { QUEUES } from '../queue/queue.module';

export interface QueueStats {
  name: string;
  /** One-line description of what the queue does. */
  purpose: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: boolean;
  /**
   * False when the counts couldn't be read — Redis down or slow. The counts are
   * zeroed in that case rather than left as a stale guess, and the UI can mark
   * the queue as unreachable instead of showing an empty-but-healthy row.
   */
  reachable: boolean;
}

export interface FailedJobInfo {
  id: string;
  name: string;
  data: any;
  failedReason: string;
  attemptsMade: number;
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
}

export interface JobDetails {
  id: string;
  name: string;
  data: any;
  progress: number;
  attemptsMade: number;
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  failedReason?: string;
  returnValue?: any;
}

/**
 * What each queue is for, in one line. The monitor is otherwise a wall of
 * queue names that mean nothing to anyone who did not write the workers, so
 * every registered queue gets a plain-language purpose the dashboard can show.
 */
export const QUEUE_PURPOSE: Record<string, string> = {
  [QUEUES.POST_PUBLISHING]: 'Publishes scheduled posts to each platform',
  [QUEUES.TOKEN_REFRESH]: 'Refreshes expiring OAuth tokens before they lapse',
  [QUEUES.DRIP_CAMPAIGNS]: 'Sends drip-campaign posts on their schedule',
  [QUEUES.CHANNEL_SNAPSHOTS]: 'Captures periodic channel metric snapshots',
  [QUEUES.INBOX_POLLING]: 'Polls platforms for new inbox comments and messages',
  [QUEUES.SCHEDULED_INBOX]: 'Sends scheduled inbox replies at their due time',
  [QUEUES.LEAD_INTAKE]: 'Ingests inbound leads from ad forms',
  [QUEUES.LEAD_DELIVERY]: 'Delivers captured leads to their destinations',
  [QUEUES.AD_INSIGHTS_SYNC]: 'Syncs ad-account insights and spend',
  [QUEUES.SLACK_INGEST]: 'Ingests Slack events into the inbox',
  [QUEUES.TELEGRAM_INGEST]: 'Ingests Telegram messages into the inbox',
  [QUEUES.DISCORD_INGEST]: 'Ingests Discord messages into the inbox',
  [QUEUES.WHATSAPP_INGEST]: 'Ingests WhatsApp messages into the inbox',
  [QUEUES.MAESTRO_BRIDGE]: 'Relays Maestro assistant messages across channels',
};

@Injectable()
export class QueueMonitorService {
  private readonly logger = new Logger(QueueMonitorService.name);

  /**
   * Every registered queue, keyed by name. Injecting each one explicitly (rather
   * than three) is what lets the dashboard see the whole system — the old
   * three-queue list left eleven queues, inbox polling and lead delivery among
   * them, entirely unmonitored. The map is the single source both the stats loop
   * and `getQueueByName` read from, so adding a queue is one line here.
   */
  private readonly queues: Record<string, Queue>;

  constructor(
    @InjectQueue(QUEUES.POST_PUBLISHING) postPublishing: Queue,
    @InjectQueue(QUEUES.TOKEN_REFRESH) tokenRefresh: Queue,
    @InjectQueue(QUEUES.DRIP_CAMPAIGNS) dripCampaigns: Queue,
    @InjectQueue(QUEUES.CHANNEL_SNAPSHOTS) channelSnapshots: Queue,
    @InjectQueue(QUEUES.INBOX_POLLING) inboxPolling: Queue,
    @InjectQueue(QUEUES.SCHEDULED_INBOX) scheduledInbox: Queue,
    @InjectQueue(QUEUES.LEAD_INTAKE) leadIntake: Queue,
    @InjectQueue(QUEUES.LEAD_DELIVERY) leadDelivery: Queue,
    @InjectQueue(QUEUES.AD_INSIGHTS_SYNC) adInsightsSync: Queue,
    @InjectQueue(QUEUES.SLACK_INGEST) slackIngest: Queue,
    @InjectQueue(QUEUES.TELEGRAM_INGEST) telegramIngest: Queue,
    @InjectQueue(QUEUES.DISCORD_INGEST) discordIngest: Queue,
    @InjectQueue(QUEUES.WHATSAPP_INGEST) whatsappIngest: Queue,
    @InjectQueue(QUEUES.MAESTRO_BRIDGE) maestroBridge: Queue,
  ) {
    this.queues = {
      [QUEUES.POST_PUBLISHING]: postPublishing,
      [QUEUES.TOKEN_REFRESH]: tokenRefresh,
      [QUEUES.DRIP_CAMPAIGNS]: dripCampaigns,
      [QUEUES.CHANNEL_SNAPSHOTS]: channelSnapshots,
      [QUEUES.INBOX_POLLING]: inboxPolling,
      [QUEUES.SCHEDULED_INBOX]: scheduledInbox,
      [QUEUES.LEAD_INTAKE]: leadIntake,
      [QUEUES.LEAD_DELIVERY]: leadDelivery,
      [QUEUES.AD_INSIGHTS_SYNC]: adInsightsSync,
      [QUEUES.SLACK_INGEST]: slackIngest,
      [QUEUES.TELEGRAM_INGEST]: telegramIngest,
      [QUEUES.DISCORD_INGEST]: discordIngest,
      [QUEUES.WHATSAPP_INGEST]: whatsappIngest,
      [QUEUES.MAESTRO_BRIDGE]: maestroBridge,
    };
  }

  /** The Redis ping reuses whichever queue is first — they share a connection. */
  private get anyQueue(): Queue {
    return this.queues[QUEUES.POST_PUBLISHING];
  }

  /**
   * Pings Redis through a live queue's own connection and times the round trip.
   *
   * Reuses the BullMQ client rather than opening a socket of its own, so this
   * checks the exact connection the workers depend on — a false "up" from a
   * separate healthy connection is not possible. Never throws: a refused or
   * timed-out ping is what "down" means here, and the health endpoint has to
   * report it, not crash on it.
   */
  async pingRedis(): Promise<{ ok: boolean; latencyMs: number | null }> {
    const start = Date.now();

    // Both steps have to be inside the race, not just the ping. When Redis is
    // down, `queue.client` is a promise that stays pending until a connection is
    // established — it never rejects — so awaiting it *before* the race is where
    // the whole health request hangs. Racing the entire operation against a
    // timeout means a lost race (whatever the reason) reads as "down", which is
    // exactly what the health check is here to report.
    const attempt = (async () => {
      const client = await this.anyQueue.client;
      await client.ping();
    })();

    try {
      await Promise.race([
        attempt,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Redis ping timed out')), 2000),
        ),
      ]);
      return { ok: true, latencyMs: Date.now() - start };
    } catch (error) {
      this.logger.warn(`Redis ping failed: ${(error as Error).message}`);
      return { ok: false, latencyMs: null };
    }
  }

  /**
   * Reads one queue's counts, but never hangs on them. Every count is a Redis
   * round-trip, and when Redis is down ioredis queues the command and waits for
   * a reconnection that may never come — so a bare `await` here would hang the
   * whole overview. Racing against a short timeout turns an unreachable queue
   * into a zeroed, `reachable: false` row instead of a stuck request.
   */
  private async readQueueStats(
    name: string,
    queue: Queue,
  ): Promise<QueueStats> {
    const base = { name, purpose: QUEUE_PURPOSE[name] ?? '' };
    try {
      const counts = Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getCompletedCount(),
        queue.getFailedCount(),
        queue.getDelayedCount(),
        queue.isPaused(),
      ]);
      const [waiting, active, completed, failed, delayed, isPaused] =
        (await Promise.race([
          counts,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Queue read timed out')), 2000),
          ),
        ])) as [number, number, number, number, number, boolean];

      return {
        ...base,
        waiting,
        active,
        completed,
        failed,
        delayed,
        paused: isPaused,
        reachable: true,
      };
    } catch (error) {
      this.logger.warn(
        `Queue "${name}" stats unavailable: ${(error as Error).message}`,
      );
      return {
        ...base,
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: false,
        reachable: false,
      };
    }
  }

  /**
   * Get all queues with their stats
   */
  async getAllQueueStats(): Promise<QueueStats[]> {
    const stats = await Promise.all(
      Object.entries(this.queues).map(([name, queue]) =>
        this.readQueueStats(name, queue),
      ),
    );

    // Stable, name-sorted order so the table doesn't reshuffle between polls.
    return stats.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get stats for a specific queue
   */
  async getQueueStats(queueName: string): Promise<QueueStats | null> {
    const queue = this.getQueueByName(queueName);
    if (!queue) return null;
    return this.readQueueStats(queueName, queue);
  }

  /**
   * Get failed jobs from a queue
   */
  async getFailedJobs(queueName: string, limit = 20): Promise<FailedJobInfo[]> {
    const queue = this.getQueueByName(queueName);
    if (!queue) return [];

    const jobs = await queue.getFailed(0, limit - 1);

    return jobs.map((job) => ({
      id: job.id || '',
      name: job.name,
      data: this.sanitizeJobData(job.data),
      failedReason: job.failedReason || 'Unknown',
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
    }));
  }

  /**
   * Get active jobs from a queue
   */
  async getActiveJobs(queueName: string, limit = 20): Promise<JobDetails[]> {
    const queue = this.getQueueByName(queueName);
    if (!queue) return [];

    const jobs = await queue.getActive(0, limit - 1);

    return jobs.map((job) => this.formatJobDetails(job));
  }

  /**
   * Get waiting jobs from a queue
   */
  async getWaitingJobs(queueName: string, limit = 20): Promise<JobDetails[]> {
    const queue = this.getQueueByName(queueName);
    if (!queue) return [];

    const jobs = await queue.getWaiting(0, limit - 1);

    return jobs.map((job) => this.formatJobDetails(job));
  }

  /**
   * Get delayed jobs from a queue
   */
  async getDelayedJobs(queueName: string, limit = 20): Promise<JobDetails[]> {
    const queue = this.getQueueByName(queueName);
    if (!queue) return [];

    const jobs = await queue.getDelayed(0, limit - 1);

    return jobs.map((job) => this.formatJobDetails(job));
  }

  /**
   * Get completed jobs from a queue (recent)
   */
  async getCompletedJobs(queueName: string, limit = 20): Promise<JobDetails[]> {
    const queue = this.getQueueByName(queueName);
    if (!queue) return [];

    const jobs = await queue.getCompleted(0, limit - 1);

    return jobs.map((job) => this.formatJobDetails(job));
  }

  /**
   * Retry a failed job
   */
  async retryFailedJob(
    queueName: string,
    jobId: string,
  ): Promise<{ success: boolean; message: string }> {
    const queue = this.getQueueByName(queueName);
    if (!queue) {
      return { success: false, message: 'Queue not found' };
    }

    const job = await queue.getJob(jobId);
    if (!job) {
      return { success: false, message: 'Job not found' };
    }

    const state = await job.getState();
    if (state !== 'failed') {
      return { success: false, message: `Job is not failed (state: ${state})` };
    }

    await job.retry();
    this.logger.log(`Retried failed job ${jobId} in queue ${queueName}`);

    return { success: true, message: `Job ${jobId} has been queued for retry` };
  }

  /**
   * Retry all failed jobs in a queue
   */
  async retryAllFailedJobs(
    queueName: string,
  ): Promise<{ success: boolean; count: number; message: string }> {
    const queue = this.getQueueByName(queueName);
    if (!queue) {
      return { success: false, count: 0, message: 'Queue not found' };
    }

    const failedJobs = await queue.getFailed(0, 1000);
    let retriedCount = 0;

    for (const job of failedJobs) {
      try {
        await job.retry();
        retriedCount++;
      } catch (error) {
        this.logger.warn(`Failed to retry job ${job.id}: ${error.message}`);
      }
    }

    this.logger.log(
      `Retried ${retriedCount} failed jobs in queue ${queueName}`,
    );

    return {
      success: true,
      count: retriedCount,
      message: `Retried ${retriedCount} failed jobs`,
    };
  }

  /**
   * Remove a failed job
   */
  async removeFailedJob(
    queueName: string,
    jobId: string,
  ): Promise<{ success: boolean; message: string }> {
    const queue = this.getQueueByName(queueName);
    if (!queue) {
      return { success: false, message: 'Queue not found' };
    }

    const job = await queue.getJob(jobId);
    if (!job) {
      return { success: false, message: 'Job not found' };
    }

    await job.remove();
    this.logger.log(`Removed job ${jobId} from queue ${queueName}`);

    return { success: true, message: `Job ${jobId} has been removed` };
  }

  /**
   * Clean old jobs from a queue
   */
  async cleanQueue(
    queueName: string,
    type: 'completed' | 'failed' | 'delayed' | 'wait',
    gracePeriodMs = 24 * 60 * 60 * 1000, // 24 hours default
  ): Promise<{ success: boolean; count: number; message: string }> {
    const queue = this.getQueueByName(queueName);
    if (!queue) {
      return { success: false, count: 0, message: 'Queue not found' };
    }

    const count = await queue.clean(gracePeriodMs, 1000, type);
    this.logger.log(
      `Cleaned ${count.length} ${type} jobs from queue ${queueName}`,
    );

    return {
      success: true,
      count: count.length,
      message: `Cleaned ${count.length} ${type} jobs older than ${gracePeriodMs / 1000 / 60 / 60} hours`,
    };
  }

  /**
   * Pause a queue
   */
  async pauseQueue(
    queueName: string,
  ): Promise<{ success: boolean; message: string }> {
    const queue = this.getQueueByName(queueName);
    if (!queue) {
      return { success: false, message: 'Queue not found' };
    }

    await queue.pause();
    this.logger.log(`Paused queue ${queueName}`);

    return { success: true, message: `Queue ${queueName} has been paused` };
  }

  /**
   * Resume a queue
   */
  async resumeQueue(
    queueName: string,
  ): Promise<{ success: boolean; message: string }> {
    const queue = this.getQueueByName(queueName);
    if (!queue) {
      return { success: false, message: 'Queue not found' };
    }

    await queue.resume();
    this.logger.log(`Resumed queue ${queueName}`);

    return { success: true, message: `Queue ${queueName} has been resumed` };
  }

  /**
   * Get aggregate stats across all queues
   */
  /**
   * Rolls a set of queue stats into headline totals. Takes the stats it was
   * given rather than re-fetching — the caller already read them once, and a
   * second pass would double the Redis round-trips (and the chance to hang).
   */
  aggregate(stats: QueueStats[]): {
    totalWaiting: number;
    totalActive: number;
    totalCompleted: number;
    totalFailed: number;
    totalDelayed: number;
    queuesHealthy: number;
    queuesPaused: number;
    queuesUnreachable: number;
  } {
    return {
      totalWaiting: stats.reduce((sum, s) => sum + s.waiting, 0),
      totalActive: stats.reduce((sum, s) => sum + s.active, 0),
      totalCompleted: stats.reduce((sum, s) => sum + s.completed, 0),
      totalFailed: stats.reduce((sum, s) => sum + s.failed, 0),
      totalDelayed: stats.reduce((sum, s) => sum + s.delayed, 0),
      queuesHealthy: stats.filter((s) => s.reachable && !s.paused).length,
      queuesPaused: stats.filter((s) => s.paused).length,
      queuesUnreachable: stats.filter((s) => !s.reachable).length,
    };
  }

  /**
   * Get queue by name. Reads the same map the stats loop does, so every
   * registered queue is reachable for actions, not just the three that used to
   * be listed here.
   */
  private getQueueByName(name: string): Queue | null {
    return this.queues[name] ?? null;
  }

  /**
   * Format job details for API response
   */
  private formatJobDetails(job: Job): JobDetails {
    return {
      id: job.id || '',
      name: job.name,
      data: this.sanitizeJobData(job.data),
      progress: typeof job.progress === 'number' ? job.progress : 0,
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      failedReason: job.failedReason,
      returnValue: job.returnvalue,
    };
  }

  /**
   * Sanitize job data for API response (remove sensitive info)
   */
  private sanitizeJobData(data: any): any {
    if (!data) return data;

    const sanitized = { ...data };

    // Remove sensitive fields
    const sensitiveFields = [
      'accessToken',
      'refreshToken',
      'token',
      'password',
      'secret',
      'apiKey',
    ];

    for (const field of sensitiveFields) {
      if (sanitized[field]) {
        sanitized[field] = '[REDACTED]';
      }
    }

    return sanitized;
  }
}
