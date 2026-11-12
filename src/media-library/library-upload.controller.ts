import { randomUUID } from 'crypto';
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { WorkspaceAccessService } from '../workspace-members/workspace-access.service';
import { CloudinaryService } from '../media/cloudinary.service';
import { CloudflareR2Service } from '../media/cloudflare-r2.service';
import {
  GetSignedUploadParamsDto,
  PresignComposerDocumentDto,
  PresignComposerVideoDto,
  UploadFileBodyDto,
  UploadFromBase64Dto,
  UploadFromUrlDto,
} from '../media/dto/media.dto';
import { LibraryIngestService } from './services/library-ingest.service';
import { StorageQuotaService } from './services/storage-quota.service';
import { cloudinaryUploadFolder } from './services/storage-object.service';

interface AuthUser {
  userId: string;
  email: string;
}

const UPLOADED = 'Media uploaded successfully';

/**
 * Every upload entry point under `/media`. Each one needs `posts:draft` on
 * the workspace it names and checks storage before any bytes move; the three
 * `upload/*` calls also create the Library item (contract, "Uploads"). The
 * server picks every storage location: a client `folder` or `publicId` is
 * accepted (old clients send them) but never used.
 * Paths are unchanged from when these lived on `MediaController`.
 */
@Controller('media')
export class LibraryUploadController {
  constructor(
    private readonly ingest: LibraryIngestService,
    private readonly quota: StorageQuotaService,
    private readonly cloudinaryService: CloudinaryService,
    private readonly r2Service: CloudflareR2Service,
    private readonly access: WorkspaceAccessService,
  ) {}

  @Post('upload/url')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async uploadFromUrl(
    @Body() dto: UploadFromUrlDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.access.assertCan(dto.workspaceId, user.userId, 'posts:draft');
    const { upload, libraryItem } = await this.ingest.ingestRemoteUrl({
      workspaceId: dto.workspaceId,
      userId: user.userId,
      url: dto.url,
      resourceType: dto.resourceType,
      tags: dto.tags,
      categoryId: dto.categoryId,
    });
    return { message: UPLOADED, ...upload, libraryItem };
  }

  @Post('upload/base64')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async uploadFromBase64(
    @Body() dto: UploadFromBase64Dto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.access.assertCan(dto.workspaceId, user.userId, 'posts:draft');
    const { upload, libraryItem } = await this.ingest.ingestBase64({
      workspaceId: dto.workspaceId,
      userId: user.userId,
      data: dto.data,
      resourceType: dto.resourceType,
      tags: dto.tags,
      categoryId: dto.categoryId,
    });
    return { message: UPLOADED, ...upload, libraryItem };
  }

  /**
   * Multipart upload to Cloudinary. A `thumbnail` ignores `categoryId` and
   * `tags`. A document (PDF, PPT, PPTX, DOC, DOCX, or any other non-media
   * file) is refused with 400 `DOCUMENT_NEEDS_R2`: documents are stored on R2
   * through `r2/presign-composer-document`.
   */
  @Post('upload/file')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: 100 * 1024 * 1024, // 100MB max
      },
    }),
  )
  async uploadFile(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadFileBodyDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.access.assertCan(dto.workspaceId, user.userId, 'posts:draft');
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    const purpose = dto.purpose ?? 'library';
    const isThumbnail = purpose === 'thumbnail';
    const tags =
      !isThumbnail && dto.tags
        ? dto.tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : [];

    const { upload, libraryItem } = await this.ingest.ingestBuffer({
      workspaceId: dto.workspaceId,
      userId: user.userId,
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
      resourceType: dto.resourceType ?? 'auto',
      tags,
      categoryId: isThumbnail ? undefined : dto.categoryId,
      purpose,
    });

    return {
      message: UPLOADED,
      originalName: file.originalname,
      mimeType: file.mimetype,
      ...upload,
      libraryItem,
    };
  }

  /**
   * Signed parameters for a direct browser upload to Cloudinary. The
   * signature pins one fresh public id in this workspace's folder with
   * `overwrite: false`, so the upload lands there in either folder mode and
   * `POST items` can tell it was issued for this workspace (SEC5). The
   * client's `folder` is ignored. Pictures and videos only: `POST items`
   * refuses a document stored this way and deletes it again.
   */
  @Post('signed-upload-params')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getSignedUploadParams(
    @Body() dto: GetSignedUploadParamsDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.access.assertCan(dto.workspaceId, user.userId, 'posts:draft');
    await this.quota.assertCanStore(dto.workspaceId, dto.bytes);

    const params = this.cloudinaryService.generateSignedUploadParams(
      `${cloudinaryUploadFolder(dto.workspaceId)}/${randomUUID()}`,
    );
    return {
      ...params,
      uploadUrl: `https://api.cloudinary.com/v1_1/${params.cloudName}/auto/upload`,
    };
  }

  /**
   * Cloudflare R2 presigned upload for composer videos.
   *
   * Composer videos (TikTok primarily, but routable to any video-capable
   * platform) are stored in R2 under the `composer/videos/...` prefix so they
   * can lifecycle separately from inbox media. The browser uploads bytes
   * directly to R2 via the returned `uploadUrl` — Schedura's API never
   * touches the video, which is critical for multi-GB TikTok uploads.
   *
   * The caller must be able to draft in `dto.workspaceId`; the R2 key path
   * embeds that workspace, so without the check anyone could write under a
   * foreign workspace's prefix.
   */
  @Post('r2/presign-composer-video')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async presignComposerVideo(
    @Body() dto: PresignComposerVideoDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.access.assertCan(dto.workspaceId, user.userId, 'posts:draft');
    await this.quota.assertCanStore(dto.workspaceId, dto.sizeBytes);
    return this.r2Service.createPresignedUpload({
      workspaceId: dto.workspaceId,
      userId: user.userId,
      kind: 'composer-video',
      contentType: dto.contentType,
      sizeBytes: dto.sizeBytes,
      filename: dto.filename,
    });
  }

  /**
   * Cloudflare R2 presigned upload for a document: a LinkedIn Document
   * post's file, and every document the Library stores (the one route that
   * takes a document; the Cloudinary routes refuse them).
   *
   * R2 rather than `upload/file`: that path stores on Cloudinary, which
   * answers 401 to anyone fetching a PDF while the account's "Allow delivery
   * of PDF and ZIP files" setting is off, and the LinkedIn publisher must
   * fetch the file to upload it to the Documents API. The browser registers
   * the stored file with `POST items` (type `document`) afterwards, exactly
   * as it does a composer video.
   */
  @Post('r2/presign-composer-document')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async presignComposerDocument(
    @Body() dto: PresignComposerDocumentDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.access.assertCan(dto.workspaceId, user.userId, 'posts:draft');
    await this.quota.assertCanStore(dto.workspaceId, dto.sizeBytes);
    return this.r2Service.createPresignedUpload({
      workspaceId: dto.workspaceId,
      userId: user.userId,
      kind: 'composer-document',
      contentType: dto.contentType,
      sizeBytes: dto.sizeBytes,
      filename: dto.filename,
    });
  }
}
