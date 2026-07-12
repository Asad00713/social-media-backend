import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CanvaConnectionService } from './canva-connection.service';
import { CanvaService } from './canva.service';
import { CloudinaryService } from '../media/cloudinary.service';
import { ListComposerDesignsDto, ImportComposerDesignDto } from './dto/composer.dto';
import type {
  ComposerCanvaDesignsResult,
  ComposerCanvaImportResult,
  ComposerCanvaStatus,
} from './canva-composer.types';

const DEFAULT_DESIGNS_LIMIT = 30;

/**
 * Secure, server-side Canva composer routes.
 *
 * Unlike `CanvaController` (legacy flow — access tokens travel in request
 * bodies / redirect URLs), every route here resolves the workspace's stored
 * Canva connection server-side via `CanvaConnectionService.getValidAccessToken`
 * and never returns a raw Canva token to the client. Workspace scoping mirrors
 * `MediaSourcesController` (`:workspaceId` path param) rather than a JWT claim,
 * since the JWT payload doesn't carry `workspaceId` for every session.
 */
@Controller('canva/composer/workspaces/:workspaceId')
@UseGuards(JwtAuthGuard)
export class CanvaComposerController {
  constructor(
    private readonly connectionService: CanvaConnectionService,
    private readonly canvaService: CanvaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  @Get('status')
  @HttpCode(HttpStatus.OK)
  async status(
    @Param('workspaceId') workspaceId: string,
  ): Promise<ComposerCanvaStatus> {
    const connection = await this.connectionService.getByWorkspace(workspaceId);
    if (!connection) {
      return { connected: false };
    }
    return {
      connected: true,
      displayName: connection.displayName ?? undefined,
    };
  }

  @Post('designs')
  @HttpCode(HttpStatus.OK)
  async designs(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: ListComposerDesignsDto,
  ): Promise<ComposerCanvaDesignsResult> {
    const accessToken = await this.connectionService.getValidAccessToken(
      workspaceId,
    );
    const result = await this.canvaService.listDesigns(
      accessToken,
      dto.limit ?? DEFAULT_DESIGNS_LIMIT,
      dto.continuation,
      dto.query,
    );

    const items = result.designs
      .filter((design) => !!design.thumbnail?.url)
      .map((design) => ({
        id: design.id,
        title: design.title,
        thumbnailUrl: design.thumbnail!.url,
        width: design.thumbnail!.width,
        height: design.thumbnail!.height,
        updatedAt: design.updatedAt,
      }));

    return { items, continuation: result.continuation };
  }

  @Post('import')
  @HttpCode(HttpStatus.OK)
  async import(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: ImportComposerDesignDto,
  ): Promise<ComposerCanvaImportResult> {
    const accessToken = await this.connectionService.getValidAccessToken(
      workspaceId,
    );

    const job = await this.canvaService.exportDesign(
      accessToken,
      dto.designId,
      { format: 'png', quality: 'high' },
    );
    const urls = await this.canvaService.waitForExport(
      accessToken,
      dto.designId,
      job.id,
    );

    const exportUrl = urls[0];
    if (!exportUrl) {
      throw new BadRequestException('Canva export produced no download URL');
    }

    // Canva export URLs are temporary — always download + re-upload to our
    // own storage rather than hotlinking them from the composer.
    const response = await fetch(exportUrl);
    if (!response.ok) {
      throw new BadRequestException('Failed to download Canva export');
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    const uploaded = await this.cloudinary.uploadFromBuffer(buffer, {
      folder: 'composer/canva',
      resourceType: 'image',
    });

    return {
      url: uploaded.secureUrl,
      type: 'image',
      width: uploaded.width,
      height: uploaded.height,
      sizeBytes: uploaded.bytes,
    };
  }
}
