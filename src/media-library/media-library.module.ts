import { Module } from '@nestjs/common';
import { MediaLibraryController } from './media-library.controller';
import { LibraryZipController } from './library-zip.controller';
import { CategoryService } from './services/category.service';
import { MediaItemService } from './services/media-item.service';
import { TemplateService } from './services/template.service';
import { TextSnippetService } from './services/text-snippet.service';
import { SavedLinkService } from './services/saved-link.service';
import { StorageObjectService } from './services/storage-object.service';
import { RecycleBinService } from './services/recycle-bin.service';
import { RecycleBinCleanupService } from './services/recycle-bin-cleanup.service';
import { AltTextService } from './services/alt-text.service';
import { AiModule } from '../ai/ai.module';
import { MediaUsageService } from './services/media-usage.service';
import { CategoryZipService } from './services/category-zip.service';
import { StorageQuotaService } from './services/storage-quota.service';
import { LibraryStatsService } from './services/library-stats.service';
import { MediaModule } from '../media/media.module';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';

@Module({
  imports: [WorkspaceRoleModule, DrizzleModule, MediaModule, AiModule],
  controllers: [MediaLibraryController, LibraryZipController],
  providers: [
    CategoryService,
    MediaItemService,
    TemplateService,
    TextSnippetService,
    SavedLinkService,
    StorageObjectService,
    RecycleBinService,
    RecycleBinCleanupService,
    AltTextService,
    MediaUsageService,
    CategoryZipService,
    StorageQuotaService,
    LibraryStatsService,
  ],
  exports: [
    CategoryService,
    MediaItemService,
    TemplateService,
    TextSnippetService,
    SavedLinkService,
    StorageObjectService,
    StorageQuotaService,
  ],
})
export class MediaLibraryModule {}
