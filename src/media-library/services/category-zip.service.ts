import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Readable } from 'stream';
import { finished } from 'stream/promises';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Response as ExpressResponse } from 'express';
import { ZipFile } from 'yazl';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import {
  mediaCategories,
  mediaItems,
} from '../../drizzle/schema/media-library.schema';
import { sanitizeFileName, zipEntryNames } from '../lib/zip-names';
import { StorageObjectService } from './storage-object.service';

/** 2 GB: the largest folder a single zip download may hold. */
export const ZIP_MAX_BYTES = 2147483648;

// TODO(merge): the contract's error body; import its type from
// dto/contract.ts (Task 9) once both branches are merged.
const ZIP_TOO_LARGE = {
  code: 'ZIP_TOO_LARGE',
  message: 'This folder is over 2 GB. Download fewer files at a time.',
} as const;

const SKIPPED_ENTRY = '_skipped.txt';

/**
 * How long one file's host may take to send its response headers. Only the
 * header stage is timed: a large video may stream for minutes after that.
 */
export const ZIP_FETCH_HEADERS_TIMEOUT_MS = 20_000;

interface ZipSourceRow {
  name: string;
  mimeType: string | null;
  fileUrl: string;
}

/** `attachment; filename="…"`, plus an RFC 5987 UTF-8 name when not ASCII. */
function contentDisposition(folderName: string): string {
  const name = `${sanitizeFileName(folderName)}.zip`;
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  const header = `attachment; filename="${ascii}"`;
  if (ascii === name) return header;
  const encoded = encodeURIComponent(name).replace(
    /['()]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${header}; filename*=UTF-8''${encoded}`;
}

/**
 * Streams a media folder as a zip. Files are fetched one at a time and stored
 * uncompressed (they are already compressed media), so memory stays flat
 * whatever the folder's size. Only files in our own storage are fetched
 * (SSRF guard); anything else, and any download that fails before its first
 * byte, is listed in `_skipped.txt`.
 */
@Injectable()
export class CategoryZipService {
  private readonly logger = new Logger(CategoryZipService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly storageObjects: StorageObjectService,
  ) {}

  /** 404 outside the workspace, 400 for a non-media folder, 413 over 2 GB. */
  async assertZippable(workspaceId: string, categoryId: string): Promise<void> {
    await this.loadZippableFolder(workspaceId, categoryId);
  }

  async streamZip(
    workspaceId: string,
    categoryId: string,
    res: ExpressResponse,
  ): Promise<void> {
    // Every check that can fail cleanly runs before a header is written.
    const folder = await this.loadZippableFolder(workspaceId, categoryId);
    const items: ZipSourceRow[] = await this.db
      .select({
        name: mediaItems.name,
        mimeType: mediaItems.mimeType,
        fileUrl: mediaItems.fileUrl,
      })
      .from(mediaItems)
      .where(liveItemsIn(workspaceId, categoryId))
      .orderBy(asc(mediaItems.createdAt), asc(mediaItems.id));
    const names = zipEntryNames(items);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDisposition(folder.name));

    const zip = new ZipFile();
    const aborter = new AbortController();
    const onClose = () => aborter.abort();
    res.on('close', onClose);
    // Never rejects: resolves to the error, if any, once the response is done.
    const responseDone = finished(res).then(
      () => null,
      (err: Error) => err,
    );
    zip.on('error', (err: unknown) => {
      this.logger.error(`Zip of folder ${categoryId} failed: ${String(err)}`);
      res.destroy();
    });
    zip.outputStream.pipe(res);

    try {
      const skipped: string[] = [];
      for (let i = 0; i < items.length && !aborter.signal.aborted; i++) {
        const reason = await this.addItem(zip, items[i], names[i], aborter);
        if (reason) skipped.push(`${names[i]} - ${reason}`);
      }
      if (aborter.signal.aborted) {
        this.logger.debug(`Zip of folder ${categoryId} closed by the client`);
        return;
      }
      if (skipped.length > 0) {
        const text = [
          'These files are not in this download:',
          '',
          ...skipped,
          '',
        ].join('\n');
        zip.addBuffer(Buffer.from(text, 'utf8'), SKIPPED_ENTRY, {
          compress: false,
        });
      }
      zip.end();
      const err = await responseDone;
      if (err) {
        this.logger.debug(
          `Zip of folder ${categoryId} ended early: ${err.message}`,
        );
      }
    } catch (err) {
      // The headers and part of an entry are already out, so no error body
      // can follow: cut the connection so the browser reports a failed
      // download instead of saving a corrupt zip.
      if (!aborter.signal.aborted) {
        this.logger.error(
          `Zip of folder ${categoryId} failed mid-stream: ${String(err)}`,
        );
      }
      res.destroy();
    } finally {
      res.off('close', onClose);
    }
  }

  /** Adds one file; returns why it was skipped, or null once it is written. */
  private async addItem(
    zip: ZipFile,
    item: ZipSourceRow,
    name: string,
    aborter: AbortController,
  ): Promise<string | null> {
    if (!this.storageObjects.isOwnStorageUrl(item.fileUrl)) {
      return 'not stored in Schedura storage, so it was not downloaded';
    }

    // A host that accepts the connection but never answers would otherwise
    // hold the whole zip open. The timer is cleared once headers arrive, so
    // it never cuts a body that is still streaming.
    const headersTimeout = new AbortController();
    const timer = setTimeout(
      () => headersTimeout.abort(),
      ZIP_FETCH_HEADERS_TIMEOUT_MS,
    );
    let response: Response;
    try {
      // `redirect: 'error'`: a redirect could point anywhere, and our storage
      // never needs one.
      response = await fetch(item.fileUrl, {
        redirect: 'error',
        signal: AbortSignal.any([aborter.signal, headersTimeout.signal]),
      });
    } catch (err) {
      if (aborter.signal.aborted) throw err;
      if (headersTimeout.signal.aborted) {
        this.logger.warn(
          `Zip: ${item.fileUrl} sent no response within ${ZIP_FETCH_HEADERS_TIMEOUT_MS / 1000} s; skipped`,
        );
        return `no response from storage within ${ZIP_FETCH_HEADERS_TIMEOUT_MS / 1000} s`;
      }
      this.logger.warn(`Zip: could not fetch ${item.fileUrl}: ${String(err)}`);
      return 'download failed';
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      this.logger.warn(
        `Zip: ${item.fileUrl} answered HTTP ${response.status}; skipped`,
      );
      return `download failed (HTTP ${response.status})`;
    }

    const stream = Readable.fromWeb(
      response.body as unknown as NodeReadableStream<Uint8Array>,
    );
    // yazl pipes the stream without listening for its errors, so a failure
    // mid-file must be caught here (and is fatal: the entry is half written).
    const ended = new Promise<void>((resolve, reject) => {
      stream.on('error', reject);
      stream.once('end', resolve);
    });
    zip.addReadStream(stream, name, { compress: false });
    // One download open at a time: wait for this file before the next fetch.
    await ended;
    return null;
  }

  private async loadZippableFolder(
    workspaceId: string,
    categoryId: string,
  ): Promise<{ name: string }> {
    const [folder] = await this.db
      .select({
        id: mediaCategories.id,
        name: mediaCategories.name,
        type: mediaCategories.type,
      })
      .from(mediaCategories)
      .where(
        and(
          eq(mediaCategories.id, categoryId),
          eq(mediaCategories.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!folder) throw new NotFoundException('Category not found');
    if (folder.type !== 'media') {
      throw new BadRequestException('Only media folders can be downloaded');
    }

    const [total] = await this.db
      .select({ bytes: sql<string | null>`sum(${mediaItems.fileSize})` })
      .from(mediaItems)
      .where(liveItemsIn(workspaceId, categoryId));
    if (Number(total?.bytes ?? 0) > ZIP_MAX_BYTES) {
      throw new PayloadTooLargeException(ZIP_TOO_LARGE);
    }
    return folder;
  }
}

function liveItemsIn(workspaceId: string, categoryId: string) {
  return and(
    eq(mediaItems.workspaceId, workspaceId),
    eq(mediaItems.categoryId, categoryId),
    eq(mediaItems.isDeleted, false),
  );
}
