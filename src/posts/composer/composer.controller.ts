import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { ComposerService } from './services/composer.service';
import { ComposerValidatorService } from './services/composer-validator.service';
import { PayloadResolverService } from './services/payload-resolver.service';
import { PublishOrchestratorService } from './services/publish-orchestrator.service';
import { getCapabilities } from '../../channels/analytics/platform-capabilities.registry';
import type { SupportedPlatform } from '../../drizzle/schema/channels.schema';
import { CreateDraftDto } from './dto/create-draft.dto';
import { UpdateDraftDto } from './dto/update-draft.dto';
import { PublishDraftDto } from './dto/publish-draft.dto';

@Controller('posts/workspaces/:wsId/composer')
@UseGuards(JwtAuthGuard)
export class ComposerController {
  constructor(
    private readonly composer: ComposerService,
    private readonly validator: ComposerValidatorService,
    private readonly resolver: PayloadResolverService,
    private readonly orchestrator: PublishOrchestratorService,
  ) {}

  @Post('drafts')
  async createDraft(
    @Param('wsId') wsId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: CreateDraftDto,
  ) {
    return this.composer.create(wsId, user.userId, dto);
  }

  @Get('drafts')
  async listDrafts(@Param('wsId') wsId: string, @Query('limit') limitStr?: string) {
    const limit = limitStr ? Number(limitStr) : 50;
    return this.composer.listDrafts(wsId, limit);
  }

  @Get('drafts/:draftId')
  async getDraft(@Param('wsId') wsId: string, @Param('draftId') draftId: string) {
    return this.composer.findById(wsId, draftId);
  }

  @Patch('drafts/:draftId')
  async updateDraft(
    @Param('wsId') wsId: string,
    @Param('draftId') draftId: string,
    @Body() dto: UpdateDraftDto,
  ) {
    return this.composer.update(wsId, draftId, dto);
  }

  @Delete('drafts/:draftId')
  async deleteDraft(@Param('wsId') wsId: string, @Param('draftId') draftId: string) {
    return this.composer.delete(wsId, draftId);
  }

  @Post('drafts/:draftId/validate')
  async validateDraft(@Param('wsId') wsId: string, @Param('draftId') draftId: string) {
    const draft = await this.composer.findById(wsId, draftId);
    const perChannel: Array<{
      channelId: string;
      platform: SupportedPlatform;
      ok: boolean;
      errors: unknown[];
      warnings: unknown[];
    }> = [];

    for (const channel of draft.channels) {
      const payload = this.resolver.resolve(draft, channel);
      let caps;
      try {
        caps = getCapabilities(channel.platform);
      } catch {
        perChannel.push({
          channelId: channel.channelId,
          platform: channel.platform,
          ok: false,
          errors: [{ kind: 'unsupported_feature', message: `No capabilities for platform ${channel.platform}` }],
          warnings: [],
        });
        continue;
      }
      if (!caps.composer) {
        perChannel.push({
          channelId: channel.channelId,
          platform: channel.platform,
          ok: false,
          errors: [{ kind: 'unsupported_feature', message: 'No composer capabilities for platform' }],
          warnings: [],
        });
        continue;
      }
      const r = this.validator.validate(payload, caps.composer);
      perChannel.push({
        channelId: channel.channelId,
        platform: channel.platform,
        ok: r.ok,
        errors: r.errors,
        warnings: r.warnings,
      });
    }

    return { ok: perChannel.every((c) => c.ok), perChannel };
  }

  @Post('drafts/:draftId/preview-payload')
  async previewPayload(
    @Param('wsId') wsId: string,
    @Param('draftId') draftId: string,
    @Body() body: { channelId: string },
  ) {
    const draft = await this.composer.findById(wsId, draftId);
    const channel = draft.channels.find((c) => c.channelId === body.channelId);
    if (!channel) {
      throw new BadRequestException(`Channel ${body.channelId} not selected on this draft`);
    }
    return this.resolver.resolve(draft, channel);
  }

  @Post('drafts/:draftId/publish')
  async publishDraft(
    @Param('wsId') wsId: string,
    @Param('draftId') draftId: string,
    @Body() dto: PublishDraftDto,
  ) {
    return this.orchestrator.publishDraft(wsId, draftId, { channelIds: dto.channelIds });
  }

  @Post('drafts/:draftId/retry')
  async retryDraft(
    @Param('wsId') wsId: string,
    @Param('draftId') draftId: string,
    @Body() dto: PublishDraftDto,
  ) {
    if (!dto.channelIds?.length) {
      throw new BadRequestException('retry requires channelIds');
    }
    return this.orchestrator.publishDraft(wsId, draftId, { channelIds: dto.channelIds });
  }
}
