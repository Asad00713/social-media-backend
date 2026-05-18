import { Module } from '@nestjs/common';
import { ComposerController } from './composer.controller';
import { ComposerService } from './services/composer.service';
import { ComposerValidatorService } from './services/composer-validator.service';
import { MediaValidatorService } from './services/media-validator.service';
import { PayloadResolverService } from './services/payload-resolver.service';

@Module({
  controllers: [ComposerController],
  providers: [
    ComposerService,
    ComposerValidatorService,
    MediaValidatorService,
    PayloadResolverService,
  ],
  exports: [ComposerService, ComposerValidatorService, PayloadResolverService],
})
export class ComposerModule {}
