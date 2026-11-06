import { Module } from '@nestjs/common';
import { DrizzleModule } from '../../drizzle/drizzle.module';
import { LibrarySamplesService } from './library-samples.service';

/**
 * Library sample content for new workspaces. Its own module, depending on
 * nothing but the database, so WorkspaceModule can import it without pulling
 * in the Library (media, AI, storage) or risking an import cycle.
 */
@Module({
  imports: [DrizzleModule],
  providers: [LibrarySamplesService],
  exports: [LibrarySamplesService],
})
export class LibrarySamplesModule {}
