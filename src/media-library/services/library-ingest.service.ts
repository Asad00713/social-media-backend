import { Injectable } from '@nestjs/common';
import {
  CloudinaryService,
  type UploadResult,
} from '../../media/cloudinary.service';
import { MediaItemService, type MediaItemView } from './media-item.service';
import { StorageQuotaService } from './storage-quota.service';

export interface IngestResult {
  upload: UploadResult;
  libraryItem: MediaItemView | null;
}

type ResourceType = 'image' | 'video' | 'auto' | 'raw';

interface IngestBase {
  workspaceId: string;
  userId: string;
  folder?: string;
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
  publicId?: string;
}

export interface IngestBase64Input extends IngestBase {
  data: string;
  publicId?: string;
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

/**
 * Every server-side upload into the Library: refuse early when storage is
 * already full, store the bytes, then save the Library item (which re-checks
 * under the workspace lock and deletes the upload on 413).
 */
@Injectable()
export class LibraryIngestService {
  constructor(
    private readonly cloudinary: CloudinaryService,
    private readonly quota: StorageQuotaService,
    private readonly mediaItems: MediaItemService,
  ) {}

  async ingestBuffer(i: IngestBufferInput): Promise<IngestResult> {
    await this.assertFolder(i);
    await this.quota.assertCanStore(i.workspaceId, i.buffer.length);
    const upload = await this.cloudinary.uploadFromBuffer(i.buffer, {
      folder: i.folder,
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
      folder: i.folder,
      resourceType: i.resourceType,
      tags: i.tags,
      publicId: i.publicId,
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
      folder: i.folder,
      resourceType: i.resourceType,
      tags: i.tags,
      publicId: i.publicId,
    });
    return this.save(i, upload, UNTITLED, mimeFromDataUri(i.data));
  }

  /** A bad folder fails before any bytes are stored. */
  private async assertFolder(i: IngestBase): Promise<void> {
    if (i.categoryId) {
      await this.mediaItems.assertMediaFolder(i.workspaceId, i.categoryId);
    }
  }

  private async save(
    i: IngestBase,
    upload: UploadResult,
    name: string,
    mimeType?: string,
  ): Promise<IngestResult> {
    const libraryItem = await this.mediaItems.createFromUpload(
      i.workspaceId,
      i.userId,
      upload,
      { name, mimeType, categoryId: i.categoryId, tags: i.tags },
    );
    return { upload, libraryItem };
  }
}
