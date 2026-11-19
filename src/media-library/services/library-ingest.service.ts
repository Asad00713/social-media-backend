import { randomUUID } from 'crypto';
import {
  Injectable,
  Logger,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import {
  CloudinaryService,
  type UploadResult,
} from '../../media/cloudinary.service';
import { isStoredDocument, looksLikeDocument } from '../lib/document-file';
import {
  assertAllowedMedia,
  mimeDisagrees,
  SNIFF_BYTES,
  storedFormatDisallowed,
} from '../lib/media-allowlist';
import { DocumentNeedsR2Exception } from '../lib/storage';
import { MediaItemService, type MediaItemView } from './media-item.service';
import { StorageQuotaService } from './storage-quota.service';
import {
  cloudinaryThumbFolder,
  cloudinaryUploadFolder,
} from './storage-object.service';

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

/** The largest video poster `upload/file` takes with `purpose: 'thumbnail'` (M5). */
export const THUMBNAIL_MAX_BYTES = 10 * 1024 * 1024;

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

/**
 * The first bytes of a base64 payload (with or without a data URI).
 *
 * Derived from `SNIFF_BYTES` rather than the 16 characters this carried
 * before. 16 characters decode to exactly 12 bytes, which happens to be
 * precisely what the longest signature reads (a RIFF type, or an ISO-BMFF
 * brand, both at offsets 8-12) — so the old width worked, with nothing to
 * spare. Deriving it means a signature that ever needs one more byte does not
 * silently start reporting every video as unrecognised.
 *
 * Base64 encodes 3 bytes per 4 characters, so the character count is 4/3 of
 * the bytes wanted, rounded up to a whole 4-character group.
 */
function base64Head(data: string, bytes = SNIFF_BYTES): Buffer {
  const comma = data.startsWith('data:') ? data.indexOf(',') + 1 : 0;
  const chars = Math.ceil(bytes / 3) * 4;
  return Buffer.from(data.slice(comma, comma + chars), 'base64');
}

/** The path of a URL, or the string itself when it does not parse. */
function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** The mime type a data URI declares, if any. */
function mimeFromDataUri(data: string): string | undefined {
  return /^data:([^;,]+)[;,]/.exec(data)?.[1];
}

/**
 * A fresh location: `library/<ws>/<uuid>`, or `library-thumbs/<ws>/<uuid>`
 * for a poster, which `POST items` can never register as a Library item.
 */
function freshPublicId(
  workspaceId: string,
  purpose: 'library' | 'thumbnail' = 'library',
): string {
  const folder =
    purpose === 'thumbnail'
      ? cloudinaryThumbFolder(workspaceId)
      : cloudinaryUploadFolder(workspaceId);
  return `${folder}/${randomUUID()}`;
}

/**
 * Every server-side upload into the Library: refuse early when storage is
 * already full, store the bytes at a location the server picks, then save the
 * Library item (which re-checks under the workspace lock and deletes the
 * upload on 413).
 *
 * Every route here stores on Cloudinary, so every one refuses a document
 * (`DocumentNeedsR2Exception`): before the upload when the name, type or
 * bytes show one, and after it when only Cloudinary could tell (a URL), in
 * which case the stored copy is deleted again first.
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
    const isThumbnail = i.purpose === 'thumbnail';
    // A poster is a small image whatever the client says (M5).
    if (isThumbnail && i.buffer.length > THUMBNAIL_MAX_BYTES) {
      throw new PayloadTooLargeException(
        `A thumbnail must be ${THUMBNAIL_MAX_BYTES / (1024 * 1024)} MB or smaller`,
      );
    }
    this.refuseDocument(i.resourceType, {
      mimeType: i.mimeType,
      name: i.originalName,
      head: i.buffer.subarray(0, 16),
    });
    // And then the allowlist, on the bytes themselves. `refuseDocument`
    // above answers "is this a document" - a DENYLIST, whose default is
    // allow, so an executable or a script renamed `cat.jpg` passed it.
    this.assertMedia(i.buffer.subarray(0, SNIFF_BYTES), i.mimeType);
    await this.assertFolder(i);
    await this.quota.assertCanStore(i.workspaceId, i.buffer.length);
    const upload = await this.cloudinary.uploadFromBuffer(i.buffer, {
      publicId: freshPublicId(i.workspaceId, i.purpose),
      resourceType: isThumbnail ? 'image' : (i.resourceType ?? 'auto'),
      tags: i.tags ?? [],
    });
    await this.refuseStoredDocument(upload);
    if (isThumbnail) return { upload, libraryItem: null };
    return this.save(i, upload, itemName(i.originalName), i.mimeType);
  }

  async ingestRemoteUrl(i: IngestRemoteUrlInput): Promise<IngestResult> {
    this.refuseDocument(i.resourceType, { name: urlPath(i.url) });
    await this.assertFolder(i);
    // The size is unknown until Cloudinary has fetched it: refuse only a
    // workspace that is already full; saving the item checks the real size.
    await this.quota.assertCanStore(i.workspaceId, 1);
    const upload = await this.cloudinary.uploadFromUrl(i.url, {
      publicId: freshPublicId(i.workspaceId),
      resourceType: i.resourceType,
      tags: i.tags,
    });
    await this.refuseStoredDocument(upload);
    // The bytes were never here to sniff, so the check happens after the
    // fact on Cloudinary's own verdict - it decoded the file to store it.
    await this.refuseStoredNonMedia(upload);
    return this.save(i, upload, nameFromUrl(i.url));
  }

  async ingestBase64(i: IngestBase64Input): Promise<IngestResult> {
    this.refuseDocument(i.resourceType, {
      mimeType: mimeFromDataUri(i.data),
      head: base64Head(i.data),
    });
    this.assertMedia(base64Head(i.data), mimeFromDataUri(i.data));
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
    await this.refuseStoredDocument(upload);
    return this.save(i, upload, UNTITLED, mimeFromDataUri(i.data));
  }

  /**
   * Refuses a document before any bytes move. `raw` is Cloudinary's type for
   * a file that is neither a picture nor a video, which is always one.
   */
  private refuseDocument(
    resourceType: ResourceType | undefined,
    hints: Parameters<typeof looksLikeDocument>[0],
  ): void {
    if (resourceType === 'raw' || looksLikeDocument(hints)) {
      throw new DocumentNeedsR2Exception();
    }
  }

  /**
   * Refuses an upload Cloudinary stored whose format is not allowed media,
   * deleting the stored copy first.
   *
   * For `ingestRemoteUrl`, where the server hands over a URL and never holds
   * the bytes. Same shape as `refuseStoredDocument`, and for the same reason:
   * the only evidence available is what Cloudinary found when it decoded the
   * file.
   */
  private async refuseStoredNonMedia(upload: UploadResult): Promise<void> {
    if (!storedFormatDisallowed(upload)) return;
    if (!upload.existing) {
      try {
        await this.cloudinary.delete(upload.publicId, upload.resourceType);
      } catch (error) {
        this.logger.warn(
          `Could not delete refused upload ${upload.publicId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    throw new UnsupportedMediaTypeException(
      `A ${upload.format ?? upload.resourceType} file cannot be stored in the Library.`,
    );
  }

  /**
   * Refuses bytes that are not allowed media, and logs a declared type that
   * disagrees with them.
   *
   * The disagreement is logged rather than refused: browsers send
   * `application/octet-stream` for a perfectly good JPEG often enough that
   * refusing on a mismatch would break real uploads. The bytes have already
   * decided; the mismatch is worth seeing because a deliberate one is what an
   * upload attack looks like.
   */
  private assertMedia(head: Buffer, declaredMime: string | undefined): void {
    const found = assertAllowedMedia(head);
    if (mimeDisagrees(declaredMime, found)) {
      this.logger.warn(
        `Upload declared ${declaredMime} but its bytes are ${found.mime}; storing as ${found.mime}`,
      );
    }
  }

  /**
   * Refuses a document Cloudinary has already stored (a URL whose bytes the
   * server never saw, or a file nothing gave away): its copy is deleted, so
   * no document is left on Cloudinary. An `existing` asset is someone else's
   * and is left alone.
   */
  private async refuseStoredDocument(upload: UploadResult): Promise<void> {
    if (!isStoredDocument(upload)) return;
    if (!upload.existing) {
      try {
        await this.cloudinary.delete(upload.publicId, upload.resourceType);
      } catch (error) {
        this.logger.warn(
          `Could not delete refused document ${upload.publicId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    throw new DocumentNeedsR2Exception();
  }

  /** A bad folder fails before any bytes are stored. */
  private async assertFolder(i: IngestBase): Promise<void> {
    if (i.categoryId) {
      await this.mediaItems.assertMediaFolder(i.workspaceId, i.categoryId);
    }
  }

  /**
   * Saves the Library item. Cleanup of a failed save is `createFromUpload`'s
   * job, scoped to its locked insert: a failure after the row committed (a
   * read of the view, say) leaves bytes a row owns, and deleting them here
   * would break that row.
   */
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
