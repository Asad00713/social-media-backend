import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUES } from '../../../queue/queue.module';
import { ChannelProfileSnapshotHandler, type ChannelProfileSnapshotJob } from '../handlers/channel-profile-snapshot.handler';
import { PostMetricSnapshotHandler, type PostMetricSnapshotJob } from '../handlers/post-metric-snapshot.handler';
import { ChannelDailyRollupHandler, type ChannelDailyRollupJob } from '../handlers/channel-daily-rollup.handler';
import { ChannelInitialBackfillHandler, type ChannelInitialBackfillJob } from '../handlers/channel-initial-backfill.handler';

type AnyJob =
  | Job<ChannelProfileSnapshotJob>
  | Job<PostMetricSnapshotJob>
  | Job<ChannelDailyRollupJob>
  | Job<ChannelInitialBackfillJob>;

@Processor(QUEUES.CHANNEL_SNAPSHOTS)
export class ChannelSnapshotsDispatcherProcessor extends WorkerHost {
  private readonly logger = new Logger(ChannelSnapshotsDispatcherProcessor.name);

  constructor(
    private readonly profile: ChannelProfileSnapshotHandler,
    private readonly post: PostMetricSnapshotHandler,
    private readonly rollup: ChannelDailyRollupHandler,
    private readonly backfill: ChannelInitialBackfillHandler,
  ) {
    super();
  }

  async process(job: AnyJob): Promise<{ ok: boolean }> {
    switch (job.name) {
      case 'channel-profile-snapshot':
        return this.profile.handle(job.data as ChannelProfileSnapshotJob);
      case 'post-metric-snapshot':
        return this.post.handle(job.data as PostMetricSnapshotJob);
      case 'channel-daily-rollup':
        return this.rollup.handle(job.data as ChannelDailyRollupJob);
      case 'channel-initial-backfill':
        return this.backfill.handle(job.data as ChannelInitialBackfillJob);
      default:
        this.logger.warn(`Unknown job name on channel-snapshots queue: ${job.name}`);
        return { ok: true };
    }
  }
}
