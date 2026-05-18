import { Module } from '@nestjs/common';
import { ComposerController } from './composer.controller';
import { ComposerService } from './services/composer.service';
import { ComposerValidatorService } from './services/composer-validator.service';
import { MediaValidatorService } from './services/media-validator.service';
import { PayloadResolverService } from './services/payload-resolver.service';
import { ComposerErrorMapperService } from './services/composer-error-mapper.service';
import {
  PublishOrchestratorService,
  CHANNEL_CREDENTIALS_LOOKUP,
} from './services/publish-orchestrator.service';
import { ChannelCredentialsAdapter } from './services/channel-credentials.adapter';
import { ChannelsModule } from '../../channels/channels.module';
import { DrizzleModule } from '../../drizzle/drizzle.module';
import { PostsModule } from '../posts.module';

@Module({
  imports: [
    DrizzleModule,
    ChannelsModule,
    PostsModule,
  ],
  controllers: [ComposerController],
  providers: [
    ComposerService,
    ComposerValidatorService,
    MediaValidatorService,
    PayloadResolverService,
    ComposerErrorMapperService,
    PublishOrchestratorService,
    ChannelCredentialsAdapter,
    { provide: CHANNEL_CREDENTIALS_LOOKUP, useExisting: ChannelCredentialsAdapter },
  ],
  exports: [ComposerService, ComposerValidatorService, PayloadResolverService],
})
export class ComposerModule {}
