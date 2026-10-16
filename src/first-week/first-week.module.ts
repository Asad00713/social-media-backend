import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ChannelsModule } from '../channels/channels.module';
import { PexelsModule } from '../pexels/pexels.module';
import { ComposerModule } from '../posts/composer/composer.module';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';
import { FirstWeekController } from './first-week.controller';
import { FirstWeekProcessor } from './first-week.processor';
import { FirstWeekRunService } from './first-week-run.service';
import { FirstWeekService } from './first-week.service';
import { FirstWeekStockImageService } from './first-week-stock-image.service';
import { FirstWeekTriggerModule } from './first-week-trigger.module';

/**
 * Home "first week": brand profile + five drafted posts.
 *
 *   - FirstWeekTriggerModule (leaf): repository, queue producer, backfill trigger.
 *   - AiModule: AiTextService + AiTokenService (the run is metered).
 *   - ChannelsModule: UnsplashService.  PexelsModule: PexelsService.
 *   - ComposerModule: DraftStoreService + ComposerSchedulingService.
 *   - WorkspaceRoleModule: the capability guard only (not WorkspaceMembersModule,
 *     which pulls Billing into a cycle; see its docs).
 */
@Module({
  imports: [
    AiModule,
    ChannelsModule,
    PexelsModule,
    ComposerModule,
    WorkspaceRoleModule,
    FirstWeekTriggerModule,
  ],
  controllers: [FirstWeekController],
  providers: [
    FirstWeekService,
    FirstWeekRunService,
    FirstWeekStockImageService,
    FirstWeekProcessor,
  ],
})
export class FirstWeekModule {}
