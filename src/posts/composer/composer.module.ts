import { Module } from '@nestjs/common';
import { ComposerController } from './composer.controller';
import { ComposerValidatorService } from './services/composer-validator.service';
import { MediaValidatorService } from './services/media-validator.service';
import { PayloadResolverService } from './services/payload-resolver.service';
import { ComposerErrorMapperService } from './services/composer-error-mapper.service';
import {
  PublishOrchestratorService,
  CHANNEL_CREDENTIALS_LOOKUP,
} from './services/publish-orchestrator.service';
import { ChannelCredentialsAdapter } from './services/channel-credentials.adapter';
import { DraftStoreService } from './services/draft-store.service';
import { ComposerSchedulingService } from './services/composer-scheduling.service';
import { QueueModule } from '../../queue/queue.module';
import { ChannelsModule } from '../../channels/channels.module';
import { DrizzleModule } from '../../drizzle/drizzle.module';
import { PostsModule } from '../posts.module';

@Module({
  imports: [DrizzleModule, ChannelsModule, PostsModule, QueueModule],
  controllers: [ComposerController],
  providers: [
    ComposerValidatorService,
    MediaValidatorService,
    PayloadResolverService,
    ComposerErrorMapperService,
    PublishOrchestratorService,
    DraftStoreService,
    ComposerSchedulingService,
    ChannelCredentialsAdapter,
    {
      provide: CHANNEL_CREDENTIALS_LOOKUP,
      useExisting: ChannelCredentialsAdapter,
    },
  ],
  exports: [ComposerValidatorService, PayloadResolverService],
})
export class ComposerModule {}
