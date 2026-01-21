import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { MediaLibraryController } from './media-library.controller';
import { CategoryService } from './services/category.service';
import { MediaItemService } from './services/media-item.service';
import { TemplateService } from './services/template.service';
import { TextSnippetService } from './services/text-snippet.service';
import { SavedLinkService } from './services/saved-link.service';
import { RecycleBinCleanupService } from './services/recycle-bin-cleanup.service';
import { MediaModule } from '../media/media.module';
import { DrizzleModule } from '../drizzle/drizzle.module';

@Module({
  imports: [DrizzleModule, MediaModule, ScheduleModule.forRoot()],
  controllers: [MediaLibraryController],
  providers: [
    CategoryService,
    MediaItemService,
    TemplateService,
    TextSnippetService,
    SavedLinkService,
    RecycleBinCleanupService,
  ],
  exports: [
    CategoryService,
    MediaItemService,
    TemplateService,
    TextSnippetService,
    SavedLinkService,
  ],
})
export class MediaLibraryModule {}
