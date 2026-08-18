import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EvergreenService } from './evergreen.service';

/**
 * Fires daily at 03:00 UTC. Belt-and-suspenders sweep against a dead
 * evergreen rotation chain: for every ACTIVE evergreen campaign's ACTIVE
 * category, re-arms any channel that has no future `scheduled` occurrence.
 * Idempotent — `EvergreenService.armCategory`'s own per-channel coverage
 * check means a channel that's already armed is skipped, so running this
 * against a perfectly healthy fleet of campaigns is a safe no-op.
 *
 * Mirrors `src/ads/schedulers/ad-insights-sync.scheduler.ts` for style.
 * `ScheduleModule.forRoot()` is already registered in `AppModule` — this
 * class only needs to be a `@Cron`-decorated provider in `CampaignsModule`.
 */
@Injectable()
export class EvergreenReconcileCron {
  private readonly logger = new Logger(EvergreenReconcileCron.name);

  constructor(private readonly evergreen: EvergreenService) {}

  @Cron('0 3 * * *', { timeZone: 'UTC', name: 'evergreenReconcile' })
  async reconcile(): Promise<void> {
    this.logger.log('evergreenReconcile: sweeping for dead rotation chains');
    await this.evergreen.reconcile();
  }
}
