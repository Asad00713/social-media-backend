import { Module } from '@nestjs/common';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { WorkspaceRoleModule } from '../workspace-members/workspace-role.module';
import { BrandVoiceController } from './brand-voice.controller';
import { BrandVoiceService } from './brand-voice.service';

@Module({
  imports: [DrizzleModule, WorkspaceRoleModule],
  controllers: [BrandVoiceController],
  providers: [BrandVoiceService],
  exports: [BrandVoiceService],
})
export class BrandVoiceModule {}
