import { Module } from '@nestjs/common';
import { MediaLibraryModule } from '../media-library/media-library.module';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';
import { CanvaController } from './canva.controller';
import { CanvaComposerController } from './canva-composer.controller';
import { CanvaService } from './canva.service';
import { CanvaConnectionService } from './canva-connection.service';

@Module({
  imports: [MediaLibraryModule, WorkspaceRoleModule],
  controllers: [CanvaController, CanvaComposerController],
  providers: [CanvaService, CanvaConnectionService],
  exports: [CanvaService, CanvaConnectionService],
})
export class CanvaModule {}
