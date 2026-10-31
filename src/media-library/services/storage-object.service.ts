import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, notInArray, or } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import {
  mediaItems,
  STORAGE_PROVIDERS,
  type StorageProvider,
} from '../../drizzle/schema/media-library.schema';
import { CloudinaryService } from '../../media/cloudinary.service';
import { CloudflareR2Service } from '../../media/cloudflare-r2.service';

export { STORAGE_PROVIDERS };
export type { StorageProvider };

/** What is needed to locate and delete a library file's bytes. */
export interface StoredFileRef {
  /**
   * The workspace the row belongs to. When present, an R2 object is only
   * deleted if its key sits under this workspace (keys are
   * `<prefix>/<workspaceId>/...`). `fileUrl` is client-supplied, so without
   * this a row could be pointed at another tenant's object and used to
   * delete it.
   */
  workspaceId?: string;
  storageProvider?: StorageProvider;
  cloudinaryPublicId: string | null;
  fileUrl: string;
  type: string;
  mimeType: string | null;
}

/** Cloudinary files the destroy API addresses by resource type. */
export function cloudinaryResourceType(
  ref: Pick<StoredFileRef, 'type' | 'mimeType' | 'fileUrl'>,
): 'image' | 'video' | 'raw' {
  if (ref.type === 'video') return 'video';
  if (ref.type === 'document') {
    const isPdf =
      ref.mimeType === 'application/pdf' ||
      ref.fileUrl.toLowerCase().endsWith('.pdf');
    return isPdf ? 'image' : 'raw';
  }
  return 'image';
}

/**
 * One place that knows which store holds a library file and how to remove it.
 * Library rows carry no provider column yet, so the provider is derived from
 * the URL (D3) unless the ref states it.
 */
@Injectable()
export class StorageObjectService {
  private readonly logger = new Logger(StorageObjectService.name);

  constructor(
    private readonly cloudinary: CloudinaryService,
    private readonly r2: CloudflareR2Service,
    @Inject(DRIZZLE) private readonly db: DbType,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- part of the agreed signature (D3)
  providerOf(fileUrl: string, _publicId: string | null): StorageProvider {
    return this.r2.keyFromPublicUrl(fileUrl) !== null ? 'r2' : 'cloudinary';
  }

  isOwnStorageUrl(url: string): boolean {
    return this.r2.isOwnUrl(url) || this.cloudinary.isOwnUrl(url);
  }

  /**
   * True when a row other than `exceptItemId` (any workspace, deleted or not)
   * points at the same file, so deleting the bytes would break it.
   */
  async isFileShared(
    ref: StoredFileRef,
    exceptItemId: string | string[],
    db: DbType = this.db,
  ): Promise<boolean> {
    const except = Array.isArray(exceptItemId) ? exceptItemId : [exceptItemId];
    const sameFile = ref.cloudinaryPublicId
      ? or(
          eq(mediaItems.fileUrl, ref.fileUrl),
          eq(mediaItems.cloudinaryPublicId, ref.cloudinaryPublicId),
        )
      : eq(mediaItems.fileUrl, ref.fileUrl);
    const [other] = await db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(and(sameFile, notInArray(mediaItems.id, except)))
      .limit(1);
    return !!other;
  }

  /** Idempotent: a file that is already gone is a success. */
  async deleteFile(ref: StoredFileRef): Promise<void> {
    const provider =
      ref.storageProvider ??
      this.providerOf(ref.fileUrl, ref.cloudinaryPublicId);

    if (provider === 'r2') {
      const key =
        this.r2.keyFromPublicUrl(ref.fileUrl) ?? ref.cloudinaryPublicId;
      if (!key) return;
      if (ref.workspaceId && key.split('/')[2] !== ref.workspaceId) {
        this.logger.warn(
          `Refusing to delete R2 object outside workspace ${ref.workspaceId}: ${key}`,
        );
        return;
      }
      await this.r2.deleteObject(key);
      return;
    }

    if (!ref.cloudinaryPublicId) {
      // Nothing of ours is stored for this row (e.g. an external URL).
      return;
    }
    const removed = await this.cloudinary.delete(
      ref.cloudinaryPublicId,
      cloudinaryResourceType(ref),
    );
    if (!removed) {
      this.logger.debug(
        `Cloudinary reported no such file: ${ref.cloudinaryPublicId}`,
      );
    }
  }
}
