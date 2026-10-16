import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { MediaModule } from '../media/media.module';
import { MediaSourcesController } from './media-sources.controller';
import { MediaSourcesService } from './media-sources.service';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';

@Module({
  imports: [WorkspaceRoleModule, ChannelsModule, MediaModule],
  controllers: [MediaSourcesController],
  providers: [MediaSourcesService],
})
export class MediaSourcesModule {}
