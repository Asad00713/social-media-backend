import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { and, eq, inArray, notInArray, or, sql } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import {
  mediaItems,
  STORAGE_PROVIDERS,
  type StorageProvider,
} from '../../drizzle/schema/media-library.schema';
import {
  CloudinaryService,
  type StoredSize,
} from '../../media/cloudinary.service';
import { CloudflareR2Service } from '../../media/cloudflare-r2.service';
import { itemBytesKeptSql } from '../lib/usage-sql';

/**
 * Stands in for a row id when the file has no row: matches no item id, so
 * `isFileShared` counts every row as a sharer and the reference test matches
 * by URL only.
 */
export const NO_ITEM_ID = '00000000-0000-0000-0000-000000000000';

export { STORAGE_PROVIDERS };
export type { StorageProvider, StoredSize };

/** What is needed to locate and delete a library file's bytes. */
export interface StoredFileRef {
  /**
   * The workspace the row belongs to. An R2 object is only deleted if its
   * whole key matches this workspace's layout (see `isWorkspaceR2Key`).
   * `fileUrl` is client-supplied, so without this a row could be pointed at
   * another tenant's object and used to delete it. Required for R2 deletes.
   */
  workspaceId?: string;
  storageProvider?: StorageProvider;
  cloudinaryPublicId: string | null;
  fileUrl: string;
  type: string;
  mimeType: string | null;
}

/** Characters and segments that never appear in a key we generated. */
const FORBIDDEN_KEY_CHARS = /[%?#\\]/;

/**
 * True only for a key that R2 issued for this workspace. Mirrors the layout
 * `CloudflareR2Service` builds for composer media:
 * `composer/videos/<workspaceId>/<user segment>/<timestamp>-<24 hex><ext>`.
 * Only that prefix is allowed: the Library stores composer media, and the
 * `inbox/*` objects belong to message rows `isFileShared` cannot see. `fileUrl` is client-supplied, so the
 * whole key is matched, not just one segment: no traversal, no encoded
 * separators, no query or fragment.
 */
export function isWorkspaceR2Key(key: string, workspaceId: string): boolean {
  if (FORBIDDEN_KEY_CHARS.test(key)) return false;
  if (key.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    return false;
  }
  const escaped = workspaceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^composer/videos/${escaped}/[A-Za-z0-9-]+/\\d+-[0-9a-f]{24}(?:\\.[A-Za-z0-9]+)?$`,
  ).test(key);
}

/**
 * The Cloudinary folder a workspace's direct uploads go to. The signed upload
 * params pin it, so a public id under it was issued for this workspace (SEC5).
 */
export function cloudinaryUploadFolder(workspaceId: string): string {
  return `library/${workspaceId}`;
}

/**
 * Where a workspace's posters (video thumbnails) go. It is deliberately not
 * under `cloudinaryUploadFolder`, so `POST items` can never register a poster
 * as a Library item.
 */
export function cloudinaryThumbFolder(workspaceId: string): string {
  return `library-thumbs/${workspaceId}`;
}

/**
 * Where a workspace's own Cloudinary objects live: `upload` for Library files
 * (`cloudinaryUploadFolder`), `thumbnail` for video posters
 * (`cloudinaryThumbFolder`).
 */
export type WorkspaceLocation = 'upload' | 'thumbnail';

/** True only for a public id inside this workspace's folder for `location`. */
export function isWorkspaceCloudinaryPublicId(
  publicId: string,
  workspaceId: string,
  location: WorkspaceLocation = 'upload',
): boolean {
  if (FORBIDDEN_KEY_CHARS.test(publicId)) return false;
  const folder =
    location === 'thumbnail'
      ? cloudinaryThumbFolder(workspaceId)
      : cloudinaryUploadFolder(workspaceId);
  const prefix = `${folder}/`;
  if (!publicId.startsWith(prefix) || publicId.length === prefix.length) {
    return false;
  }
  return !publicId.split('/').some((s) => s === '' || s === '.' || s === '..');
}

/**
 * True when a Cloudinary delivery URL shows exactly this public id:
 * `.../<resource>/upload/[v<version>/]<public id>[.<ext>]`. No transformation
 * segments: a registered file is the URL its upload returned.
 */
function cloudinaryUrlShows(url: string, publicId: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  const at = path.indexOf('/upload/');
  if (at < 0) return false;
  const rest = path.slice(at + '/upload/'.length).replace(/^v\d+\//, '');
  if (rest === publicId) return true;
  return (
    rest.startsWith(`${publicId}.`) &&
    /^[A-Za-z0-9]+$/.test(rest.slice(publicId.length + 1))
  );
}

/**
 * The public id a plain Cloudinary delivery URL shows (the inverse of
 * `cloudinaryUrlShows`), or null. A URL with transformation segments yields a
 * public id `cloudinaryUrlShows` then rejects, so the pair stays exact.
 */
export function cloudinaryPublicIdFromUrl(url: string): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const at = path.indexOf('/upload/');
  if (at < 0) return null;
  const rest = path.slice(at + '/upload/'.length).replace(/^v\d+\//, '');
  const publicId = rest.replace(/\.[A-Za-z0-9]+$/, '');
  return publicId || null;
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
 * Rows carry `storage_provider` (written at create, backfilled by migration
 * 0054). A ref without one falls back to the URL (D3), and an R2 URL always
 * wins over a 'cloudinary' value (see `deleteFile`).
 */
@Injectable()
export class StorageObjectService {
  private readonly logger = new Logger(StorageObjectService.name);

  constructor(
    private readonly cloudinary: CloudinaryService,
    private readonly r2: CloudflareR2Service,
    @Inject(DRIZZLE) private readonly db: DbType,
  ) {}

  providerOf(fileUrl: string): StorageProvider {
    return this.r2.keyFromPublicUrl(fileUrl) !== null ? 'r2' : 'cloudinary';
  }

  /**
   * Which store holds a ref's bytes, and its R2 key when the URL shows one.
   * The column defaults to 'cloudinary', so a row inserted by an instance
   * that predates it (the deploy window) or missed by 0054's backfill can say
   * 'cloudinary' for an R2 file. A URL under our R2 public base is proof of
   * R2; the column decides only when the URL proves nothing.
   */
  private resolveStore(ref: StoredFileRef): {
    provider: StorageProvider;
    urlKey: string | null;
  } {
    const urlKey = this.r2.keyFromPublicUrl(ref.fileUrl);
    const provider: StorageProvider =
      urlKey !== null
        ? 'r2'
        : (ref.storageProvider ?? this.providerOf(ref.fileUrl));
    return { provider, urlKey };
  }

  isOwnStorageUrl(url: string): boolean {
    return this.r2.isOwnUrl(url) || this.cloudinary.isOwnUrl(url);
  }

  /**
   * SEC5: a file the client registers (`POST items` after a direct upload)
   * must be an object this workspace stored: an R2 key R2 issued for it, or a
   * public id in its Cloudinary upload folder on our own cloud, shown by the
   * URL. Anything else (a foreign URL, another workspace's object) is
   * refused, so a row can never be pointed at bytes it does not own.
   *
   * `location: 'thumbnail'` asks the same of a video poster (M6): a
   * Cloudinary public id under `library-thumbs/<ws>/`. Posters never live in
   * R2, so an R2 URL is refused there.
   */
  assertWorkspaceObject(
    ref: Pick<StoredFileRef, 'fileUrl' | 'cloudinaryPublicId'>,
    workspaceId: string,
    location: WorkspaceLocation = 'upload',
  ): void {
    const r2Key = this.r2.keyFromPublicUrl(ref.fileUrl);
    const publicId = ref.cloudinaryPublicId;
    const isOwned =
      r2Key !== null
        ? location === 'upload' &&
          isWorkspaceR2Key(r2Key, workspaceId) &&
          (!publicId || publicId === r2Key)
        : !!publicId &&
          this.cloudinary.isOwnUrl(ref.fileUrl) &&
          isWorkspaceCloudinaryPublicId(publicId, workspaceId, location) &&
          cloudinaryUrlShows(ref.fileUrl, publicId);
    if (!isOwned) {
      throw new BadRequestException(
        location === 'thumbnail'
          ? 'thumbnailUrl must be a poster uploaded to this workspace (purpose=thumbnail)'
          : 'The file must be uploaded to this workspace before it is saved',
      );
    }
  }

  /**
   * The stored poster behind a `thumbnailUrl` (M6): it must pass
   * `assertWorkspaceObject` for this workspace's thumbnail location, else
   * 400. Only a ref from here may have its bytes discarded as a poster.
   */
  posterRef(thumbnailUrl: string, workspaceId: string): StoredFileRef {
    const ref: StoredFileRef = {
      workspaceId,
      storageProvider: 'cloudinary',
      cloudinaryPublicId: cloudinaryPublicIdFromUrl(thumbnailUrl),
      fileUrl: thumbnailUrl,
      type: 'image',
      mimeType: null,
    };
    this.assertWorkspaceObject(ref, workspaceId, 'thumbnail');
    return ref;
  }

  /**
   * `posterRef` without the 400: null for no thumbnail, or one that is not a
   * poster of this workspace (a foreign URL, an image's own URL, another
   * workspace's poster).
   */
  posterRefOf(
    thumbnailUrl: string | null | undefined,
    workspaceId: string,
  ): StoredFileRef | null {
    if (thumbnailUrl == null) return null;
    try {
      return this.posterRef(thumbnailUrl, workspaceId);
    } catch {
      return null;
    }
  }

  /**
   * The stored size of a file, asked of the store that holds it: `missing`
   * when the object is not there (or nothing of ours is named), `error` when
   * the store cannot be asked or gives no length.
   */
  async realSize(ref: StoredFileRef): Promise<StoredSize> {
    const { provider, urlKey } = this.resolveStore(ref);

    if (provider === 'r2') {
      const key = urlKey ?? ref.cloudinaryPublicId;
      if (!key) return { kind: 'missing' };
      try {
        const head = await this.r2.verifyObject(key);
        if (!head.exists) return { kind: 'missing' };
        return typeof head.contentLength === 'number'
          ? { kind: 'size', bytes: head.contentLength }
          : { kind: 'error' };
      } catch (error) {
        this.logger.warn(
          `Could not read the size of R2 object ${key}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return { kind: 'error' };
      }
    }

    if (!ref.cloudinaryPublicId) return { kind: 'missing' };
    return this.cloudinary.getResourceBytes(
      ref.cloudinaryPublicId,
      cloudinaryResourceType(ref),
    );
  }

  /**
   * True when a post, an unmaterialised campaign slot, an evergreen entry or
   * a template of the workspace uses this file URL, by the shared byte-keep
   * builder (`itemBytesKeptSql`, the single definition) with its own
   * workspace scoping. The file has no row here, so no item id can match.
   * Without a workspace the answer is "referenced": a guard must never delete
   * what it cannot check.
   */
  async isFileReferenced(
    ref: Pick<StoredFileRef, 'fileUrl' | 'workspaceId'>,
    db: DbType = this.db,
  ): Promise<boolean> {
    if (!ref.workspaceId) return true;
    const res = await db.execute<{ referenced: boolean }>(
      sql`SELECT ${itemBytesKeptSql({
        id: sql`${NO_ITEM_ID}`,
        fileUrl: sql`${ref.fileUrl}`,
        workspaceId: sql`${ref.workspaceId}`,
      })} AS referenced`,
    );
    return res.rows[0]?.referenced === true;
  }

  /**
   * True when a row other than `exceptItemId` (any workspace, deleted or not)
   * points at the same file, as its file or as its thumbnail (a video's
   * poster), so deleting the bytes would break it. Rows only: every caller
   * pairs it with `isFileReferenced`, which holds the post, campaign and
   * template arms.
   */
  async isFileShared(
    ref: StoredFileRef,
    exceptItemId: string | string[],
    db: DbType = this.db,
  ): Promise<boolean> {
    const except = Array.isArray(exceptItemId) ? exceptItemId : [exceptItemId];
    const sameFile = or(
      eq(mediaItems.fileUrl, ref.fileUrl),
      eq(mediaItems.thumbnailUrl, ref.fileUrl),
      ref.cloudinaryPublicId
        ? eq(mediaItems.cloudinaryPublicId, ref.cloudinaryPublicId)
        : undefined,
    );
    const [other] = await db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(and(sameFile, notInArray(mediaItems.id, except)))
      .limit(1);
    return !!other;
  }

  /**
   * One query for a whole page: which of these rows' files are also
   * referenced by a row outside `exceptItemIds` (any workspace, deleted or
   * not), matched by `file_url`, by `cloudinary_public_id`, or by a row
   * showing the file as its `thumbnail_url` (a video's poster), the same
   * rule as `isFileShared`. Each arm is indexed (0054). Rows only: purge
   * pairs it with `findReferencedItems`, which holds the post, campaign and
   * template arms.
   */
  async findSharedFiles(
    refs: Pick<StoredFileRef, 'fileUrl' | 'cloudinaryPublicId'>[],
    exceptItemIds: string[],
    db: DbType = this.db,
  ): Promise<{ urls: Set<string>; publicIds: Set<string> }> {
    const urls = [...new Set(refs.map((r) => r.fileUrl))];
    const publicIds = [
      ...new Set(
        refs.map((r) => r.cloudinaryPublicId).filter((p): p is string => !!p),
      ),
    ];
    const shared = { urls: new Set<string>(), publicIds: new Set<string>() };
    if (urls.length === 0) return shared;

    const sameFile = or(
      inArray(mediaItems.fileUrl, urls),
      inArray(mediaItems.thumbnailUrl, urls),
      publicIds.length > 0
        ? inArray(mediaItems.cloudinaryPublicId, publicIds)
        : undefined,
    );
    const conditions = [sameFile];
    if (exceptItemIds.length > 0) {
      conditions.push(notInArray(mediaItems.id, exceptItemIds));
    }
    const found = await db
      .select({
        fileUrl: mediaItems.fileUrl,
        thumbnailUrl: mediaItems.thumbnailUrl,
        publicId: mediaItems.cloudinaryPublicId,
      })
      .from(mediaItems)
      .where(and(...conditions));
    const asked = new Set(urls);
    for (const row of found) {
      shared.urls.add(row.fileUrl);
      if (row.thumbnailUrl && asked.has(row.thumbnailUrl)) {
        shared.urls.add(row.thumbnailUrl);
      }
      if (row.publicId) shared.publicIds.add(row.publicId);
    }
    return shared;
  }

  /**
   * One query for a whole page: which of these items a post, campaign slot,
   * evergreen entry or template still uses (`itemBytesKeptSql`: the `/usage`
   * test plus templates, SEC4 and I1). Their rows may go, but their bytes
   * must stay, or a scheduled post or a template loses its media.
   */
  async findReferencedItems(
    itemIds: string[],
    db: DbType = this.db,
  ): Promise<Set<string>> {
    if (itemIds.length === 0) return new Set();
    const found = await db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(
        and(
          inArray(mediaItems.id, itemIds),
          itemBytesKeptSql({
            id: mediaItems.id,
            fileUrl: mediaItems.fileUrl,
            workspaceId: mediaItems.workspaceId,
          }),
        ),
      );
    return new Set(found.map((r) => r.id));
  }

  /** Idempotent: a file that is already gone is a success. */
  async deleteFile(ref: StoredFileRef): Promise<void> {
    // `resolveStore`: an R2 URL wins over the column. The workspace / key
    // gates below apply either way.
    const { provider, urlKey } = this.resolveStore(ref);

    if (provider === 'r2') {
      const key = urlKey ?? ref.cloudinaryPublicId;
      if (!key) return;
      if (!ref.workspaceId || !isWorkspaceR2Key(key, ref.workspaceId)) {
        this.logger.warn(
          `Refusing to delete R2 object not proven to belong to workspace ${ref.workspaceId ?? '(none)'}: ${key}`,
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
