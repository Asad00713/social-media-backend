import { Module } from '@nestjs/common';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';
import { ShortLinkRedirectController } from './short-link-redirect.controller';
import { ShortLinksController } from './short-links.controller';
import { ShortLinksService } from './short-links.service';

@Module({
  imports: [DrizzleModule, WorkspaceRoleModule],
  controllers: [ShortLinksController, ShortLinkRedirectController],
  providers: [ShortLinksService],
})
export class ShortLinksModule {}
