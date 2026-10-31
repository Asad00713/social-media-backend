import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  CloudinaryService,
  type UploadResult,
} from '../../media/cloudinary.service';
import { StorageFullException } from '../lib/storage';
import { MediaItemService, type MediaItemView } from './media-item.service';
import { StorageQuotaService } from './storage-quota.service';
import { cloudinaryUploadFolder } from './storage-object.service';

export interface IngestResult {
  upload: UploadResult;
  libraryItem: MediaItemView | null;
}

type ResourceType = 'image' | 'video' | 'auto' | 'raw';

/**
 * No `folder` or `publicId`: the server picks every location itself. With
 * `overwrite: false`, a caller-chosen public id that is taken makes
 * Cloudinary return the EXISTING asset, which could be another tenant's.
 */
interface IngestBase {
  workspaceId: string;
  userId: string;
  resourceType?: ResourceType;
  tags?: string[];
  /** The Library folder to file the item into; checked before any upload. */
  categoryId?: string;
}

export interface IngestBufferInput extends IngestBase {
  buffer: Buffer;
  originalName?: string;
  mimeType?: string;
  /** A video's poster frame is stored but never becomes a Library item. */
  purpose?: 'library' | 'thumbnail';
}

export interface IngestRemoteUrlInput extends IngestBase {
  url: string;
}

export interface IngestBase64Input extends IngestBase {
  data: string;
}

const UNTITLED = 'Untitled';

/** A file name without its extension, or 'Untitled'. */
function itemName(fileName: string | undefined): string {
  const name = fileName?.trim() ?? '';
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return base || UNTITLED;
}

/** The last path segment of a URL, decoded, as an item name. */
function nameFromUrl(url: string): string {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    return itemName(last ? decodeURIComponent(last) : undefined);
  } catch {
    return UNTITLED;
  }
}

/** The mime type a data URI declares, if any. */
function mimeFromDataUri(data: string): string | undefined {
  return /^data:([^;,]+)[;,]/.exec(data)?.[1];
}

/** A fresh location in the workspace's folder: `library/<ws>/<uuid>`. */
function freshPublicId(workspaceId: string): string {
  return `${cloudinaryUploadFolder(workspaceId)}/${randomUUID()}`;
}

/**
 * Every server-side upload into the Library: refuse early when storage is
 * already full, store the bytes at a location the server picks, then save the
 * Library item (which re-checks under the workspace lock and deletes the
 * upload on 413).
 */
@Injectable()
export class LibraryIngestService {
  private readonly logger = new Logger(LibraryIngestService.name);

  constructor(
    private readonly cloudinary: CloudinaryService,
    private readonly quota: StorageQuotaService,
    private readonly mediaItems: MediaItemService,
  ) {}

  async ingestBuffer(i: IngestBufferInput): Promise<IngestResult> {
    await this.assertFolder(i);
    await this.quota.assertCanStore(i.workspaceId, i.buffer.length);
    const upload = await this.cloudinary.uploadFromBuffer(i.buffer, {
      publicId: freshPublicId(i.workspaceId),
      resourceType: i.resourceType ?? 'auto',
      tags: i.tags ?? [],
    });
    if (i.purpose === 'thumbnail') return { upload, libraryItem: null };
    return this.save(i, upload, itemName(i.originalName), i.mimeType);
  }

  async ingestRemoteUrl(i: IngestRemoteUrlInput): Promise<IngestResult> {
    await this.assertFolder(i);
    // The size is unknown until Cloudinary has fetched it: refuse only a
    // workspace that is already full; saving the item checks the real size.
    await this.quota.assertCanStore(i.workspaceId, 1);
    const upload = await this.cloudinary.uploadFromUrl(i.url, {
      publicId: freshPublicId(i.workspaceId),
      resourceType: i.resourceType,
      tags: i.tags,
    });
    return this.save(i, upload, nameFromUrl(i.url));
  }

  async ingestBase64(i: IngestBase64Input): Promise<IngestResult> {
    await this.assertFolder(i);
    await this.quota.assertCanStore(
      i.workspaceId,
      Math.floor((i.data.length * 3) / 4),
    );
    const upload = await this.cloudinary.uploadFromBase64(i.data, {
      publicId: freshPublicId(i.workspaceId),
      resourceType: i.resourceType,
      tags: i.tags,
    });
    return this.save(i, upload, UNTITLED, mimeFromDataUri(i.data));
  }

  /** A bad folder fails before any bytes are stored. */
  private async assertFolder(i: IngestBase): Promise<void> {
    if (i.categoryId) {
      await this.mediaItems.assertMediaFolder(i.workspaceId, i.categoryId);
    }
  }

  /**
   * Saves the Library item. When that fails for any reason but a 413 (which
   * `createFromUpload` already cleans up), the fresh upload is deleted
   * best-effort so no orphan stays behind. An `existing` asset is never ours
   * to delete.
   */
  private async save(
    i: IngestBase,
    upload: UploadResult,
    name: string,
    mimeType?: string,
  ): Promise<IngestResult> {
    try {
      const libraryItem = await this.mediaItems.createFromUpload(
        i.workspaceId,
        i.userId,
        upload,
        { name, mimeType, categoryId: i.categoryId, tags: i.tags },
      );
      return { upload, libraryItem };
    } catch (error) {
      if (!(error instanceof StorageFullException) && !upload.existing) {
        await this.deleteOrphan(upload);
      }
      throw error;
    }
  }

  private async deleteOrphan(upload: UploadResult): Promise<void> {
    try {
      await this.cloudinary.delete(upload.publicId, upload.resourceType);
    } catch (error) {
      this.logger.warn(
        `Could not delete orphaned upload ${upload.publicId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
