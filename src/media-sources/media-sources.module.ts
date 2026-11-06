import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { MediaLibraryModule } from '../media-library/media-library.module';
import { MediaSourcesController } from './media-sources.controller';
import { MediaSourcesService } from './media-sources.service';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';

@Module({
  imports: [WorkspaceRoleModule, ChannelsModule, MediaLibraryModule],
  controllers: [MediaSourcesController],
  providers: [MediaSourcesService],
})
export class MediaSourcesModule {}
