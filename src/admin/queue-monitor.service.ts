import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';
import { QUEUES } from '../queue/queue.module';

export interface QueueStats {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: boolean;
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

@Injectable()
export class QueueMonitorService {
  private readonly logger = new Logger(QueueMonitorService.name);

  constructor(
    @InjectQueue(QUEUES.POST_PUBLISHING) private postPublishingQueue: Queue,
    @InjectQueue(QUEUES.TOKEN_REFRESH) private tokenRefreshQueue: Queue,
    @InjectQueue(QUEUES.DRIP_CAMPAIGNS) private dripCampaignsQueue: Queue,
  ) {}

  /**
   * Get all queues with their stats
   */
  async getAllQueueStats(): Promise<QueueStats[]> {
    const queues = [
      { name: QUEUES.POST_PUBLISHING, queue: this.postPublishingQueue },
      { name: QUEUES.TOKEN_REFRESH, queue: this.tokenRefreshQueue },
      { name: QUEUES.DRIP_CAMPAIGNS, queue: this.dripCampaignsQueue },
    ];

    const stats = await Promise.all(
      queues.map(async ({ name, queue }) => {
        const [waiting, active, completed, failed, delayed, isPaused] =
          await Promise.all([
            queue.getWaitingCount(),
            queue.getActiveCount(),
            queue.getCompletedCount(),
            queue.getFailedCount(),
            queue.getDelayedCount(),
            queue.isPaused(),
          ]);

        return {
          name,
          waiting,
          active,
          completed,
          failed,
          delayed,
          paused: isPaused,
        };
      }),
    );

    return stats;
  }

  /**
   * Get stats for a specific queue
   */
  async getQueueStats(queueName: string): Promise<QueueStats | null> {
    const queue = this.getQueueByName(queueName);
    if (!queue) return null;

    const [waiting, active, completed, failed, delayed, isPaused] =
      await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getCompletedCount(),
        queue.getFailedCount(),
        queue.getDelayedCount(),
        queue.isPaused(),
      ]);

    return {
      name: queueName,
      waiting,
      active,
      completed,
      failed,
      delayed,
      paused: isPaused,
    };
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
  async getAggregateStats(): Promise<{
    totalWaiting: number;
    totalActive: number;
    totalCompleted: number;
    totalFailed: number;
    totalDelayed: number;
    queuesHealthy: number;
    queuesPaused: number;
  }> {
    const stats = await this.getAllQueueStats();

    return {
      totalWaiting: stats.reduce((sum, s) => sum + s.waiting, 0),
      totalActive: stats.reduce((sum, s) => sum + s.active, 0),
      totalCompleted: stats.reduce((sum, s) => sum + s.completed, 0),
      totalFailed: stats.reduce((sum, s) => sum + s.failed, 0),
      totalDelayed: stats.reduce((sum, s) => sum + s.delayed, 0),
      queuesHealthy: stats.filter((s) => !s.paused).length,
      queuesPaused: stats.filter((s) => s.paused).length,
    };
  }

  /**
   * Get queue by name
   */
  private getQueueByName(name: string): Queue | null {
    switch (name) {
      case QUEUES.POST_PUBLISHING:
        return this.postPublishingQueue;
      case QUEUES.TOKEN_REFRESH:
        return this.tokenRefreshQueue;
      case QUEUES.DRIP_CAMPAIGNS:
        return this.dripCampaignsQueue;
      default:
        return null;
    }
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
