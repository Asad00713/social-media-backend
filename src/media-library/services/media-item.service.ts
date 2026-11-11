import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  BadGatewayException,
} from '@nestjs/common';
import {
  eq,
  and,
  desc,
  asc,
  ilike,
  sql,
  inArray,
  gt,
  gte,
  not,
  or,
  type SQL,
} from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import {
  mediaItems,
  mediaCategories,
  NewMediaItem,
  MediaLibraryItem,
  MediaCategory,
} from '../../drizzle/schema/media-library.schema';
import { users } from '../../drizzle/schema/users.schema';
import { binPurgeCutoff } from '../lib/bin-retention';
import { ilikePattern } from '../lib/search';
import {
  itemPostCountSql,
  itemReferencedSql,
  withUsageLock,
} from '../lib/usage-sql';
import { ratioBounds } from '../lib/ratio';
import { toUserRef, USER_REF_COLUMNS } from '../lib/user-ref';
import { assertIdsXorSelectAll, bulkTargetsBin, chunk } from '../lib/bulk';
import { isCloudinaryDocumentUrl } from '../lib/document-file';
import {
  DocumentNeedsR2Exception,
  SizeUnavailableException,
  StorageFullException,
  UploadConflictException,
  UploadNotFinishedException,
  wouldExceed,
} from '../lib/storage';
import { mediaTypeFromUpload } from '../lib/upload-type';
import { isSampleAssetUrl } from '../samples/sample-assets';
import type { Page, UserRef } from '../dto/contract';
import type { UploadResult } from '../../media/cloudinary.service';
import {
  NO_ITEM_ID,
  StorageObjectService,
  type StoredFileRef,
} from './storage-object.service';
import { StorageQuotaService } from './storage-quota.service';
import {
  CreateMediaItemDto,
  UpdateMediaItemDto,
  MediaItemQueryDto,
  BulkActionDto,
} from '../dto/media-library.dto';

/** A media item as the list and the Preview read it. */
export type MediaItemView = MediaLibraryItem & {
  category: MediaCategory | null;
  uploadedBy: UserRef | null;
};

/** What `createFromUpload` needs besides the upload itself. */
export interface UploadItemMeta {
  name: string;
  mimeType?: string;
  categoryId?: string;
  tags?: string[];
}

/** Files deleted from storage at once during a purge. */
const PURGE_CONCURRENCY = 8;
/** Rows read per page when purging the bin. */
const PURGE_BATCH = 200;
/** Rows deleted per statement, to stay far below the parameter limit. */
const DELETE_CHUNK = 1000;
/** The `name` column's width. */
const NAME_MAX = 255;

@Injectable()
export class MediaItemService {
  private readonly logger = new Logger(MediaItemService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly storageObjects: StorageObjectService,
    private readonly quota: StorageQuotaService,
  ) {}

  /**
   * An item may be filed only into a media folder. Template, snippet and link
   * folders hold other kinds of thing. Also the guard for uploads.
   */
  async assertMediaFolder(
    workspaceId: string,
    categoryId: string,
  ): Promise<void> {
    const [folder] = await this.db
      .select({ name: mediaCategories.name, type: mediaCategories.type })
      .from(mediaCategories)
      .where(
        and(
          eq(mediaCategories.id, categoryId),
          eq(mediaCategories.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (!folder) {
      throw new NotFoundException('Folder not found');
    }
    if (folder.type !== 'media') {
      throw new BadRequestException(
        `Folder "${folder.name}" is not a media folder`,
      );
    }
  }

  /**
   * Registers a file the client uploaded directly (R2 presign or a signed
   * Cloudinary upload). Saving the same stored object twice returns the first
   * row (B3). Otherwise the file must belong to this workspace (SEC5), and
   * its size is asked of the store: the client's `fileSize` is never used. A
   * file the store cannot size is refused (400 not uploaded yet, 503 retry);
   * a file that would go over the limit is deleted again and refused with
   * 413.
   */
  async create(
    workspaceId: string,
    userId: string,
    dto: CreateMediaItemDto,
  ): Promise<MediaItemView> {
    if (dto.categoryId) {
      await this.assertMediaFolder(workspaceId, dto.categoryId);
    }
    // M6: no thumbnail, or a poster this workspace stored (purpose=thumbnail).
    const poster =
      dto.thumbnailUrl != null
        ? this.storageObjects.posterRef(dto.thumbnailUrl, workspaceId)
        : null;

    const ref: StoredFileRef = {
      workspaceId,
      storageProvider: this.storageObjects.providerOf(dto.fileUrl),
      cloudinaryPublicId: dto.cloudinaryPublicId ?? null,
      fileUrl: dto.fileUrl,
      type: dto.type,
      mimeType: dto.mimeType ?? null,
    };

    // Fast path, before any provider call. `insertChecked` repeats the check
    // under the lock, where it is race-safe.
    const existing = await this.findLiveCopy(workspaceId, ref, this.db);
    if (existing) return this.viewOf(existing.id);

    this.storageObjects.assertWorkspaceObject(ref, workspaceId);
    // Documents live on R2 only. One uploaded to Cloudinary directly (signed
    // params) is deleted again, unless a row or a post already uses it.
    if (
      ref.storageProvider === 'cloudinary' &&
      (dto.type === 'document' || isCloudinaryDocumentUrl(dto.fileUrl))
    ) {
      await this.discardUnusedFile({ ...ref, type: 'document' }, 'refused');
      throw new DocumentNeedsR2Exception();
    }
    const size = await this.storageObjects.realSize(ref);
    if (size.kind === 'missing') throw new UploadNotFinishedException();
    if (size.kind === 'error') throw new SizeUnavailableException();
    const bytes = size.bytes;

    const values: NewMediaItem = {
      workspaceId,
      uploadedById: userId,
      type: dto.type,
      name: dto.name,
      description: dto.description,
      fileUrl: dto.fileUrl,
      thumbnailUrl: dto.thumbnailUrl,
      mimeType: dto.mimeType,
      width: dto.width,
      height: dto.height,
      duration: dto.duration,
      cloudinaryPublicId: dto.cloudinaryPublicId,
      cloudinaryAssetId: dto.cloudinaryAssetId,
      storageProvider: ref.storageProvider,
      categoryId: dto.categoryId,
      tags: dto.tags || [],
      altText: dto.altText,
      pageCount: dto.pageCount,
    };
    let id: string;
    try {
      id = await this.insertChecked(workspaceId, userId, values, ref, bytes);
    } catch (error) {
      // The poster was uploaded for this save alone; insertChecked already
      // discarded the file itself (M5).
      if (error instanceof StorageFullException && poster) {
        await this.discardUnusedFile(poster, 'refused');
      }
      throw error;
    }
    // A file URL posts already use (re-registered after a purge, say) (I4).
    await this.recountUsage(workspaceId, id);
    return this.viewOf(id);
  }

  /**
   * Saves a file the server just stored in Cloudinary as a Library item. The
   * size is the upload's own; the same lock, idempotency and delete-on-413 as
   * `create` apply (B2). An asset Cloudinary already held under that public
   * id is refused with 409 and left alone: it belongs to someone else.
   */
  async createFromUpload(
    workspaceId: string,
    userId: string,
    upload: UploadResult,
    meta: UploadItemMeta,
  ): Promise<MediaItemView> {
    if (upload.existing) {
      this.logger.error(
        `Cloudinary returned an existing asset for ${upload.publicId} (workspace ${workspaceId}); refusing to save it`,
      );
      throw new UploadConflictException();
    }
    const type = mediaTypeFromUpload({
      resourceType: upload.resourceType,
      format: upload.format,
      mimeType: meta.mimeType,
    });
    const ref: StoredFileRef = {
      workspaceId,
      storageProvider: 'cloudinary',
      cloudinaryPublicId: upload.publicId,
      fileUrl: upload.secureUrl,
      type,
      mimeType: meta.mimeType ?? null,
    };
    const values: NewMediaItem = {
      workspaceId,
      uploadedById: userId,
      type,
      name: meta.name.slice(0, NAME_MAX),
      fileUrl: upload.secureUrl,
      thumbnailUrl:
        upload.thumbnailUrl ??
        (type === 'image' || type === 'gif' ? upload.secureUrl : null),
      mimeType: meta.mimeType ?? null,
      width: upload.width ?? null,
      height: upload.height ?? null,
      // The column holds whole seconds; Cloudinary reports a float.
      duration:
        upload.duration !== undefined ? Math.round(upload.duration) : null,
      cloudinaryPublicId: upload.publicId,
      storageProvider: 'cloudinary',
      // Cloudinary also reports a GIF's frame count as `pages`.
      pageCount: type === 'document' ? (upload.pages ?? null) : null,
      categoryId: meta.categoryId ?? null,
      tags: meta.tags ?? [],
    };
    let id: string;
    try {
      id = await this.insertChecked(
        workspaceId,
        userId,
        values,
        ref,
        upload.bytes,
      );
    } catch (error) {
      // The server stored these bytes a moment ago for this row alone; the
      // row never committed, so they are an orphan. A 413 is already cleaned
      // up inside insertChecked.
      if (!(error instanceof StorageFullException)) {
        await this.discardUnusedFile(ref, 'orphaned');
      }
      throw error;
    }
    // The row is committed from here on: its bytes are never an orphan, so a
    // failing recount or read must not reach the cleanup above.
    await this.recountUsage(workspaceId, id);
    return this.viewOf(id);
  }

  /**
   * Sets `usage_count` from the posts that use the item, by the 0055
   * trigger's own test (`postRefSql`). The trigger only fires on post
   * writes, so a row created for a URL posts already hold needs this (I4).
   */
  private async recountUsage(workspaceId: string, itemId: string) {
    await withUsageLock(this.db, workspaceId, (tx) =>
      tx
        .update(mediaItems)
        .set({
          usageCount: itemPostCountSql({
            id: mediaItems.id,
            fileUrl: mediaItems.fileUrl,
            workspaceId: mediaItems.workspaceId,
          }),
        })
        .where(
          and(
            eq(mediaItems.id, itemId),
            eq(mediaItems.workspaceId, workspaceId),
          ),
        ),
    );
  }

  /**
   * Inserts under the workspace's storage lock: the duplicate check, the
   * usage read and the insert all run on the locked transaction, so two
   * parallel saves cannot both pass the check. A refused file is deleted
   * from storage unless something still uses it. Returns the row's id; the
   * caller reads the view after the commit.
   */
  private async insertChecked(
    workspaceId: string,
    userId: string,
    values: NewMediaItem,
    ref: StoredFileRef,
    bytes: number,
  ): Promise<string> {
    let id: string;
    try {
      id = await this.quota.runLocked(workspaceId, async (tx) => {
        const existing = await this.findLiveCopy(workspaceId, ref, tx);
        if (existing) return existing.id;

        const usage = await this.quota.getUsage(workspaceId, tx);
        if (wouldExceed(usage.used, bytes, usage.limit)) {
          throw new StorageFullException(usage);
        }
        const [created] = await tx
          .insert(mediaItems)
          .values({
            ...values,
            workspaceId,
            uploadedById: userId,
            fileSize: bytes,
          })
          .returning({ id: mediaItems.id });
        return created.id;
      });
    } catch (error) {
      if (error instanceof StorageFullException) {
        await this.discardUnusedFile(ref, 'refused');
      }
      throw error;
    }

    this.logger.log(
      `Created media item "${values.name}" for workspace ${workspaceId}`,
    );
    return id;
  }

  /**
   * A live row of this workspace for the same stored object: the same public
   * id when there is one, else the same file URL (B3, D15).
   */
  private async findLiveCopy(
    workspaceId: string,
    ref: StoredFileRef,
    db: DbType,
  ): Promise<{ id: string } | undefined> {
    const sameFile = ref.cloudinaryPublicId
      ? or(
          eq(mediaItems.cloudinaryPublicId, ref.cloudinaryPublicId),
          eq(mediaItems.fileUrl, ref.fileUrl),
        )
      : eq(mediaItems.fileUrl, ref.fileUrl);
    const [row] = await db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(
        and(
          eq(mediaItems.workspaceId, workspaceId),
          eq(mediaItems.isDeleted, false),
          sameFile,
        ),
      )
      .orderBy(asc(mediaItems.createdAt), asc(mediaItems.id))
      .limit(1);
    return row;
  }

  /**
   * Deletes the bytes of a file that has no row, unless something still uses
   * them: a Library row of any workspace (as its file or its thumbnail), or a
   * post, campaign slot, evergreen entry or template (the shared byte-keep
   * builder). A failure is logged, not thrown.
   */
  private async discardUnusedFile(
    ref: StoredFileRef,
    reason: 'refused' | 'orphaned' | 'purged',
  ): Promise<void> {
    try {
      if (await this.storageObjects.isFileShared(ref, NO_ITEM_ID)) return;
      if (await this.storageObjects.isFileReferenced(ref)) return;
      await this.storageObjects.deleteFile(ref);
    } catch (error) {
      this.logger.warn(
        `Could not delete ${reason} file ${ref.cloudinaryPublicId ?? ref.fileUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** One item as a `MediaItemView`, with its folder and uploader. */
  private async viewOf(itemId: string): Promise<MediaItemView> {
    return this.readView(eq(mediaItems.id, itemId));
  }

  /** The one read behind every single-item `MediaItemView` (`findOne`, saves). */
  private async readView(where: SQL | undefined): Promise<MediaItemView> {
    const [row] = await this.db
      .select(this.viewSelection())
      .from(mediaItems)
      .leftJoin(mediaCategories, eq(mediaItems.categoryId, mediaCategories.id))
      .leftJoin(users, eq(mediaItems.uploadedById, users.id))
      .where(where)
      .limit(1);
    if (!row) throw new NotFoundException('Media item not found');
    return {
      ...row.item,
      category: row.category,
      uploadedBy: toUserRef(row.uploader),
    };
  }

  /**
   * The WHERE clause of `GET items`, shared with bulk select-all so "every
   * match" means exactly what the list shows. Ignores `limit`, `offset` and
   * the sort.
   */
  buildItemConditions(workspaceId: string, query: MediaItemQueryDto): SQL[] {
    const {
      type,
      categoryId,
      isDeleted = false,
      search,
      tags,
      gifOnly,
      ratio,
      addedSince,
      uploadedBy,
      neverUsed,
    } = query;
    // `starred` is the contract name and wins over the legacy `isStarred`.
    const starred = query.starred ?? query.isStarred;

    const conditions: SQL[] = [
      eq(mediaItems.workspaceId, workspaceId),
      eq(mediaItems.isDeleted, isDeleted),
    ];

    if (type === 'images') {
      conditions.push(inArray(mediaItems.type, ['image', 'gif']));
    } else if (type) {
      conditions.push(eq(mediaItems.type, type));
    }

    if (gifOnly) {
      conditions.push(eq(mediaItems.type, 'gif'));
    }

    if (categoryId) {
      conditions.push(eq(mediaItems.categoryId, categoryId));
    }

    if (starred !== undefined) {
      conditions.push(eq(mediaItems.isStarred, starred));
    }

    if (search) {
      conditions.push(ilike(mediaItems.name, ilikePattern(search)));
    }

    if (tags && tags.length > 0) {
      conditions.push(
        sql`${mediaItems.tags} @> ${JSON.stringify(tags)}::jsonb`,
      );
    }

    if (ratio) {
      // Multiplied out (width >= min × height) so no row divides by zero.
      // The bounds are cast because a bare parameter next to an integer
      // column would be read as an integer.
      const { min, max } = ratioBounds(ratio);
      conditions.push(
        sql`(${mediaItems.width} > 0 AND ${mediaItems.height} > 0 AND ${mediaItems.width} >= ${min}::float8 * ${mediaItems.height} AND ${mediaItems.width} <= ${max}::float8 * ${mediaItems.height})`,
      );
    }

    if (addedSince) {
      // ISO 8601 allows forms Date cannot read (2026-W05, 2026-123); those
      // are a bad request, not an Invalid Date reaching Postgres as a 500.
      const since = new Date(addedSince);
      if (Number.isNaN(since.getTime())) {
        throw new BadRequestException(
          'addedSince must be a calendar date or date-time',
        );
      }
      conditions.push(gte(mediaItems.createdAt, since));
    }

    if (uploadedBy) {
      conditions.push(eq(mediaItems.uploadedById, uploadedBy));
    }

    if (neverUsed) {
      conditions.push(
        not(
          itemReferencedSql({
            id: mediaItems.id,
            fileUrl: mediaItems.fileUrl,
            workspaceId: mediaItems.workspaceId,
          }),
        ),
      );
    }

    return conditions;
  }

  /**
   * ORDER BY for `GET items`. Every order ends in `id DESC`: without a
   * deterministic tiebreaker Postgres returns ties in heap order, and an
   * UPDATE (starring an asset) moves the tuple to the end of the heap, so the
   * starred image jumped to the bottom of the grid.
   */
  private itemOrder(query: MediaItemQueryDto): SQL[] {
    const byNewest = [desc(mediaItems.createdAt), desc(mediaItems.id)];

    switch (query.sort) {
      case 'newest':
        return byNewest;
      case 'oldest':
        return [asc(mediaItems.createdAt), asc(mediaItems.id)];
      case 'most_used':
        return [sql`${mediaItems.usageCount} DESC NULLS LAST`, ...byNewest];
      case 'recently_used':
        return [sql`${mediaItems.lastUsedAt} DESC NULLS LAST`, ...byNewest];
      case 'name':
        return [sql`lower(${mediaItems.name}) ASC`, ...byNewest];
      case 'size':
        return [sql`${mediaItems.fileSize} DESC NULLS LAST`, ...byNewest];
    }

    // Legacy sortBy/sortOrder, for callers that do not send `sort` yet.
    const { sortBy = 'createdAt', sortOrder = 'desc' } = query;
    const sortColumn = {
      createdAt: mediaItems.createdAt,
      name: mediaItems.name,
      usageCount: mediaItems.usageCount,
      lastUsedAt: mediaItems.lastUsedAt,
    }[sortBy];
    const orderFn = sortOrder === 'asc' ? asc : desc;

    // `lastUsedAt` stays null until an asset is used, so "never used" belongs
    // after everything that has been used. Postgres puts NULLS FIRST for DESC
    // by default, which ranked untouched assets above used ones.
    const primaryOrder =
      sortBy === 'lastUsedAt'
        ? sortOrder === 'asc'
          ? sql`${mediaItems.lastUsedAt} ASC NULLS LAST`
          : sql`${mediaItems.lastUsedAt} DESC NULLS LAST`
        : orderFn(sortColumn);
    return [primaryOrder, ...byNewest];
  }

  /** The columns a `MediaItemView` is read from; uploader left-joined. */
  private viewSelection() {
    return {
      item: mediaItems,
      category: mediaCategories,
      uploader: USER_REF_COLUMNS,
    };
  }

  /**
   * Get all media items for a workspace with filtering
   */
  async findAll(
    workspaceId: string,
    query: MediaItemQueryDto = {},
  ): Promise<Page<MediaItemView>> {
    const { limit = 50, offset = 0 } = query;
    const conditions = this.buildItemConditions(workspaceId, query);

    const rows = await this.db
      .select(this.viewSelection())
      .from(mediaItems)
      .leftJoin(mediaCategories, eq(mediaItems.categoryId, mediaCategories.id))
      .leftJoin(users, eq(mediaItems.uploadedById, users.id))
      .where(and(...conditions))
      .orderBy(...this.itemOrder(query))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(mediaItems)
      .where(and(...conditions));

    return {
      items: rows.map((row) => ({
        ...row.item,
        category: row.category,
        uploadedBy: toUserRef(row.uploader),
      })),
      total: count,
      limit,
      offset,
    };
  }

  /**
   * Get recently created items
   */
  async findRecent(workspaceId: string, limit = 20) {
    const items = await this.db
      .select()
      .from(mediaItems)
      .where(
        and(
          eq(mediaItems.workspaceId, workspaceId),
          eq(mediaItems.isDeleted, false),
        ),
      )
      .orderBy(desc(mediaItems.createdAt))
      .limit(limit);

    return items;
  }

  /**
   * Get a single media item by ID
   */
  async findOne(workspaceId: string, itemId: string): Promise<MediaItemView> {
    return this.readView(
      and(eq(mediaItems.id, itemId), eq(mediaItems.workspaceId, workspaceId)),
    );
  }

  /**
   * Update a media item
   */
  async update(
    workspaceId: string,
    itemId: string,
    dto: UpdateMediaItemDto,
  ): Promise<MediaItemView> {
    const existing = await this.findOne(workspaceId, itemId);

    // Validate category if changing. A null `categoryId` skips this on purpose:
    // it means "take this out of its folder", and there is no target type to
    // match against. `undefined` (field omitted) leaves the folder untouched.
    if (dto.categoryId && dto.categoryId !== existing.categoryId) {
      await this.assertMediaFolder(workspaceId, dto.categoryId);
    }

    const updateData: Partial<typeof mediaItems.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.categoryId !== undefined) updateData.categoryId = dto.categoryId;
    if (dto.tags !== undefined) updateData.tags = dto.tags;
    if (dto.isStarred !== undefined) updateData.isStarred = dto.isStarred;
    if (dto.altText !== undefined) updateData.altText = dto.altText;

    await this.db
      .update(mediaItems)
      .set(updateData)
      .where(
        and(eq(mediaItems.id, itemId), eq(mediaItems.workspaceId, workspaceId)),
      );

    this.logger.log(`Updated media item ${itemId}`);

    // Single-item writes answer with the contract's MediaItem (M9).
    return this.findOne(workspaceId, itemId);
  }

  /**
   * Soft delete a media item (move to recycle bin)
   */
  async softDelete(
    workspaceId: string,
    itemId: string,
    userId: string,
  ): Promise<MediaItemView> {
    await this.findOne(workspaceId, itemId);

    await this.db
      .update(mediaItems)
      .set({
        isDeleted: true,
        deletedAt: new Date(),
        deletedById: userId,
        updatedAt: new Date(),
      })
      .where(
        and(eq(mediaItems.id, itemId), eq(mediaItems.workspaceId, workspaceId)),
      );

    this.logger.log(`Soft deleted media item ${itemId}`);

    return this.findOne(workspaceId, itemId);
  }

  /**
   * Restore a media item from recycle bin
   */
  async restore(workspaceId: string, itemId: string): Promise<MediaItemView> {
    const [item] = await this.db
      .select()
      .from(mediaItems)
      .where(
        and(
          eq(mediaItems.id, itemId),
          eq(mediaItems.workspaceId, workspaceId),
          eq(mediaItems.isDeleted, true),
        ),
      )
      .limit(1);

    if (!item) {
      throw new NotFoundException('Item not found in recycle bin');
    }

    await this.db
      .update(mediaItems)
      .set({
        isDeleted: false,
        deletedAt: null,
        deletedById: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(mediaItems.id, itemId), eq(mediaItems.workspaceId, workspaceId)),
      );

    this.logger.log(`Restored media item ${itemId}`);

    return this.findOne(workspaceId, itemId);
  }

  /**
   * Permanently delete a media item from the Bin. The row stays when storage
   * refuses, so the user can retry instead of leaving an orphaned file behind.
   * A live item, or one restored meanwhile, is a 404: purging only touches
   * binned rows.
   */
  async permanentDelete(workspaceId: string, itemId: string) {
    const item = await this.findOne(workspaceId, itemId);
    if (!item.isDeleted) {
      throw new NotFoundException('Item not found in recycle bin');
    }

    const { deletedIds, failedIds } = await this.purgeItems([item]);
    if (failedIds.length > 0) {
      throw new BadGatewayException(
        'Could not delete the file from storage. Try again.',
      );
    }
    if (deletedIds.length === 0) {
      throw new NotFoundException('Item not found in recycle bin');
    }

    this.logger.log(`Permanently deleted media item ${itemId}`);

    return { success: true, message: 'Media item permanently deleted' };
  }

  /**
   * Deletes the files behind `rows` (at most PURGE_CONCURRENCY at a time) and
   * then only the rows whose file is gone. A file another row outside this set
   * still points at, or that a post, campaign slot, evergreen entry or
   * template still uses (SEC4, I1), is left in storage; its row is removed
   * all the same.
   *
   * Only binned rows are purged: a live row in `candidates` is skipped, and
   * the DELETE re-checks `is_deleted`, so a row restored while its file was
   * deleting survives and is not reported in `deletedIds`.
   *
   * A sample row (0057) loses its row only, never its file: the file is one
   * bundled copy every workspace's samples point at. This is the one place a
   * media row's file is deleted (delete forever, bulk, Bin delete, empty Bin
   * and the retention purge all come here), so the guard is here.
   */
  async purgeItems(
    candidates: MediaLibraryItem[],
  ): Promise<{ deletedIds: string[]; failedIds: string[] }> {
    const binned = candidates.filter((r) => r.isDeleted === true);
    const sampleIds = binned.filter(isSampleFileRow).map((r) => r.id);
    const rows = binned.filter((r) => !isSampleFileRow(r));
    const setIds = rows.map((r) => r.id);

    // Rows inside the set that share a file URL or a public id delete it once.
    const groupOf = new Map<string, MediaLibraryItem[]>();
    const groups = new Set<MediaLibraryItem[]>();
    for (const row of rows) {
      const keys = [`u:${row.fileUrl}`];
      if (row.cloudinaryPublicId) keys.push(`p:${row.cloudinaryPublicId}`);
      const known = keys
        .map((k) => groupOf.get(k))
        .filter((g): g is MediaLibraryItem[] => !!g);
      let group = known[0];
      if (!group) {
        group = [];
        groups.add(group);
      }
      // Merge any other group this row bridges into the first one.
      for (const other of known.slice(1)) {
        if (other !== group) {
          group.push(...other);
          groups.delete(other);
          for (const moved of other) {
            groupOf.set(`u:${moved.fileUrl}`, group);
            if (moved.cloudinaryPublicId) {
              groupOf.set(`p:${moved.cloudinaryPublicId}`, group);
            }
          }
        }
      }
      group.push(row);
      for (const k of keys) groupOf.set(k, group);
    }

    // One query each for the whole page, not one per file.
    const shared = await this.storageObjects.findSharedFiles(
      rows,
      setIds,
      this.db,
    );
    const referenced = await this.storageObjects.findReferencedItems(
      setIds,
      this.db,
    );

    const deletedIds: string[] = [...sampleIds];
    const failedIds: string[] = [];
    const queue = [...groups];

    const worker = async () => {
      for (let group = queue.shift(); group; group = queue.shift()) {
        try {
          // Another row shares the file, or a post / slot / template uses it.
          const isFileInUse = group.some(
            (r) =>
              referenced.has(r.id) ||
              shared.urls.has(r.fileUrl) ||
              (!!r.cloudinaryPublicId &&
                shared.publicIds.has(r.cloudinaryPublicId)),
          );
          // TOCTOU: a row created between the share check and this delete can
          // still lose its file. A restore is re-checked right before the
          // storage call: a group with any row restored is skipped whole (no
          // file, no row, not counted). What remains is a restore landing
          // between that re-check and deleteFile, one round trip wide.
          if (!isFileInUse) {
            if (!(await this.isGroupStillBinned(group))) continue;
            const distinctUrls = new Map(
              group.map((r) => [
                r.cloudinaryPublicId
                  ? `p:${r.cloudinaryPublicId}`
                  : `u:${r.fileUrl}`,
                r,
              ]),
            );
            for (const ref of distinctUrls.values()) {
              await this.storageObjects.deleteFile(ref);
            }
          }
          deletedIds.push(...group.map((r) => r.id));
        } catch (error) {
          for (const row of group) {
            failedIds.push(row.id);
            this.logger.warn(
              `Failed to delete file for media item ${row.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PURGE_CONCURRENCY, queue.length) }, worker),
    );

    // Residual race: a restore that lands after its file was deleted keeps
    // the row but not the bytes (unless shared). Closing it needs a row lock
    // held across the storage call; accepted, like the TOCTOU above.
    const purgedIds: string[] = [];
    for (let i = 0; i < deletedIds.length; i += DELETE_CHUNK) {
      const gone = await this.db
        .delete(mediaItems)
        .where(
          and(
            inArray(mediaItems.id, deletedIds.slice(i, i + DELETE_CHUNK)),
            eq(mediaItems.isDeleted, true),
          ),
        )
        .returning({ id: mediaItems.id });
      purgedIds.push(...gone.map((r) => r.id));
    }

    await this.discardPosters(rows, purgedIds);

    return { deletedIds: purgedIds, failedIds };
  }

  /**
   * Deletes the posters (video thumbnails under `library-thumbs/<ws>/`) of
   * rows that are now gone, by `discardUnusedFile`: a poster another row,
   * a post, a campaign entry or a template still shows is kept, and a failed
   * check keeps it too (M5). Runs after the rows are deleted, so the purged
   * row no longer counts as a sharer.
   */
  private async discardPosters(
    rows: MediaLibraryItem[],
    purgedIds: string[],
  ): Promise<void> {
    const gone = new Set(purgedIds);
    const posters = new Map<string, StoredFileRef>();
    for (const row of rows) {
      if (!gone.has(row.id)) continue;
      const poster = this.storageObjects.posterRefOf(
        row.thumbnailUrl,
        row.workspaceId,
      );
      if (poster) posters.set(poster.fileUrl, poster);
    }
    const queue = [...posters.values()];
    const worker = async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        await this.discardUnusedFile(p, 'purged');
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PURGE_CONCURRENCY, queue.length) }, worker),
    );
  }

  /** Whether every row of a purge group is still in the Bin. */
  private async isGroupStillBinned(
    group: MediaLibraryItem[],
  ): Promise<boolean> {
    const ids = group.map((r) => r.id);
    const workspaceIds = [...new Set(group.map((r) => r.workspaceId))];
    const binned = await this.db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(
        and(
          inArray(mediaItems.id, ids),
          inArray(mediaItems.workspaceId, workspaceIds),
          eq(mediaItems.isDeleted, true),
        ),
      );
    return binned.length === ids.length;
  }

  /**
   * Purges every deleted item in scope, a page at a time by id. The cursor
   * always moves past the page, so a row whose file will not delete cannot
   * stall the loop.
   */
  async purgeDeleted(scope: {
    workspaceId?: string;
    deletedBefore?: Date;
  }): Promise<{ deleted: number; failed: number }> {
    const base: SQL[] = [eq(mediaItems.isDeleted, true)];
    if (scope.workspaceId) {
      base.push(eq(mediaItems.workspaceId, scope.workspaceId));
    }
    if (scope.deletedBefore) {
      // The Bin shows purgeAt from the same COALESCE (legacy rows have no
      // deleted_at), so what it promises is what the cleanup does.
      base.push(
        sql`COALESCE(${mediaItems.deletedAt}, ${mediaItems.updatedAt}) < ${scope.deletedBefore}`,
      );
    }

    let deleted = 0;
    let failed = 0;
    let cursor: string | undefined;

    for (;;) {
      const page = await this.db
        .select()
        .from(mediaItems)
        .where(and(...base, cursor ? gt(mediaItems.id, cursor) : undefined))
        .orderBy(asc(mediaItems.id))
        .limit(PURGE_BATCH);
      if (page.length === 0) break;

      const result = await this.purgeItems(page);
      deleted += result.deletedIds.length;
      failed += result.failedIds.length;
      cursor = page[page.length - 1].id;
    }

    return { deleted, failed };
  }

  /**
   * Bulk actions on media items: on `ids`, or with `selectAll` on every item
   * the list's filter matches (ignoring `limit`/`offset`). Rows are written
   * 500 at a time.
   *
   * The action picks bin or live rows (`bulkTargetsBin`): restore and
   * permanentDelete touch only binned rows and refuse select-all; the rest
   * touch only live rows, whatever the filter's `isDeleted` says.
   * `affectedCount` counts only rows actually changed. The route requires
   * `posts:publish` for permanentDelete.
   *
   * Chunks are separate statements, not one transaction: a failure midway
   * leaves earlier chunks applied. Every action is idempotent, so retrying
   * the same request converges.
   */
  async bulkAction(
    workspaceId: string,
    userId: string,
    dto: BulkActionDto,
  ): Promise<{ affectedCount: number }> {
    assertIdsXorSelectAll(dto);
    const inBin = bulkTargetsBin(dto);
    const { action, categoryId } = dto;

    if (action === 'move') {
      // `undefined` means the caller never said where to move things, which
      // is not a move at all. `null` is a decision — unfile the selection —
      // so the two are told apart here rather than lumped as falsy.
      if (categoryId === undefined) {
        throw new BadRequestException('categoryId required for move action');
      }
      if (categoryId !== null) {
        await this.assertMediaFolder(workspaceId, categoryId);
      }
    }

    const ids = await this.resolveBulkIds(workspaceId, dto);

    let affectedCount = 0;
    for (const part of chunk(ids)) {
      affectedCount += await this.bulkChunk(
        workspaceId,
        userId,
        dto,
        part,
        inBin,
      );
    }

    this.logger.log(
      `Bulk ${action} on ${ids.length} media items in workspace ${workspaceId}`,
    );

    return { affectedCount };
  }

  /**
   * The ids a bulk request names. Explicit ids must all belong to the
   * workspace (else 400); select-all reads them through the list's filter,
   * on live rows only (a select-all bin action never gets this far).
   */
  private async resolveBulkIds(
    workspaceId: string,
    dto: BulkActionDto,
  ): Promise<string[]> {
    if (dto.selectAll != null) {
      const filter = { ...dto.selectAll.filter, isDeleted: false };
      const rows = await this.db
        .select({ id: mediaItems.id })
        .from(mediaItems)
        .where(and(...this.buildItemConditions(workspaceId, filter)))
        .orderBy(asc(mediaItems.id));
      return rows.map((r) => r.id);
    }

    // A repeated id names one row: de-duplicated before the "not found"
    // count, as the Bin's idsByKind does (M10).
    const ids = [...new Set(dto.ids ?? [])];
    if (ids.length === 0) return [];
    const found = await this.db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(
        and(
          inArray(mediaItems.id, ids),
          eq(mediaItems.workspaceId, workspaceId),
        ),
      );
    if (found.length !== ids.length) {
      throw new BadRequestException('Some items not found');
    }
    return ids;
  }

  /**
   * Runs one bulk action on one chunk of ids; returns the rows touched.
   * Only rows in the state the action works on (`inBin`) are touched.
   */
  private async bulkChunk(
    workspaceId: string,
    userId: string,
    dto: BulkActionDto,
    ids: string[],
    inBin: boolean,
  ): Promise<number> {
    const inScope = and(
      inArray(mediaItems.id, ids),
      eq(mediaItems.workspaceId, workspaceId),
      eq(mediaItems.isDeleted, inBin),
    );
    const now = new Date();

    const write = async (set: Partial<typeof mediaItems.$inferInsert>) =>
      (
        await this.db
          .update(mediaItems)
          .set({ ...set, updatedAt: now })
          .where(inScope)
          .returning({ id: mediaItems.id })
      ).length;

    switch (dto.action) {
      case 'delete':
        return write({ isDeleted: true, deletedAt: now, deletedById: userId });
      case 'restore':
        return write({ isDeleted: false, deletedAt: null, deletedById: null });
      case 'move':
        return write({ categoryId: dto.categoryId ?? null });
      case 'star':
        return write({ isStarred: true });
      case 'unstar':
        return write({ isStarred: false });
      case 'permanentDelete': {
        const rows = await this.db.select().from(mediaItems).where(inScope);
        const { deletedIds } = await this.purgeItems(rows);
        return deletedIds.length;
      }
    }
  }

  /**
   * Record that an item was just used: sets `lastUsedAt` (the "Recently used"
   * sort) and nothing else. `usage_count` is a post count kept by the posts
   * trigger (migration 0055), so a click here must not bump it (D13).
   *
   * Scoped to the workspace like every other write here: the id alone comes
   * from the client, so without the workspace in the WHERE clause any
   * authenticated user could touch someone else's asset.
   */
  async markUsed(workspaceId: string, itemId: string): Promise<MediaItemView> {
    const [updated] = await this.db
      .update(mediaItems)
      .set({
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(mediaItems.id, itemId), eq(mediaItems.workspaceId, workspaceId)),
      )
      .returning({ id: mediaItems.id });

    if (!updated) {
      throw new NotFoundException('Media item not found');
    }

    return this.findOne(workspaceId, itemId);
  }

  /**
   * Permanently delete items whose Bin retention (lib/bin-retention.ts, the
   * same window the Bin shows as `purgeAt`) has run out. Called by the
   * scheduled job.
   */
  async cleanupRecycleBin(now: Date = new Date()) {
    const deletedBefore = binPurgeCutoff(now);
    const { deleted } = await this.purgeDeleted({ deletedBefore });

    this.logger.log(
      `Cleaned up ${deleted} items from recycle bin (binned before ${deletedBefore.toISOString()})`,
    );

    return { deletedCount: deleted };
  }
}

/**
 * A row whose file must never be deleted: a sample (0057), or any row that
 * points at a bundled sample file. Checked on the flag and the URL both.
 */
function isSampleFileRow(row: MediaLibraryItem): boolean {
  return (
    row.isSample === true ||
    isSampleAssetUrl(row.fileUrl) ||
    isSampleAssetUrl(row.thumbnailUrl)
  );
}
