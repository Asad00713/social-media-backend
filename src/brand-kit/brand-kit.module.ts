import { Module } from '@nestjs/common';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';
import { BrandKitController } from './brand-kit.controller';
import { BrandKitService } from './brand-kit.service';

@Module({
  imports: [DrizzleModule, WorkspaceRoleModule],
  controllers: [BrandKitController],
  providers: [BrandKitService],
})
export class BrandKitModule {}
