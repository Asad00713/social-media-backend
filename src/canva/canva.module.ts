import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { CanvaController } from './canva.controller';
import { CanvaComposerController } from './canva-composer.controller';
import { CanvaService } from './canva.service';
import { CanvaConnectionService } from './canva-connection.service';

@Module({
  imports: [MediaModule],
  controllers: [CanvaController, CanvaComposerController],
  providers: [CanvaService, CanvaConnectionService],
  exports: [CanvaService, CanvaConnectionService],
})
export class CanvaModule {}
