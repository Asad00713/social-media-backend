import { writeFileSync } from 'fs';
import { config } from 'dotenv';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinarySdk } from 'cloudinary';
import { Client } from 'pg';
import { buildPoolConfig } from '../../drizzle/pool-config';
import { decideTarget } from '../../drizzle/migrate/target-guard';
import { CloudinaryService } from '../../media/cloudinary.service';
import { CloudflareR2Service } from '../../media/cloudflare-r2.service';
import { extensionOf, hasDocumentMagic } from '../lib/document-file';
import { isWorkspaceR2Key } from '../services/storage-object.service';

/**
 * One-off owner script: moves every document (PDF, PPT, PPTX, DOC, DOCX)
 * still stored on Cloudinary to Cloudflare R2, and points the database at the
 * new copy. Documents live on R2 only (owner decision): Cloudinary answers
 * HTTP 401 to a public fetch of a PDF while "Allow delivery of PDF and ZIP
 * files" is off, so those files can be neither previewed nor published.
 *
 * What it migrates, one (workspace, Cloudinary URL) pair at a time:
 *   - Library rows (`media_items`, binned ones too) on Cloudinary whose type
 *     is `document` or whose URL shows one;
 *   - document URLs posts use with no Library row of their workspace.
 *
 * For each: download the original through the Cloudinary API (signed, so the
 * delivery 401 does not apply), upload it to R2 under the workspace's
 * `composer/documents/<ws>/system/...` key (the layout `isWorkspaceR2Key`
 * accepts, so a later purge can delete it), then in ONE transaction move the
 * Library rows to the R2 URL and rewrite the URL wherever the workspace uses
 * it (posts, campaign slots, evergreen entries, templates). A failed
 * transaction deletes the R2 copy again.
 *
 * Default is a DRY RUN: it reads the database and asks Cloudinary's admin API
 * whether each file exists (read-only), and writes nothing. `--apply` does the
 * work. The Cloudinary original is NEVER deleted here: the ledger (printed,
 * and written to `--ledger`) lists every public id for that later step.
 *
 * Idempotent: a moved row is on R2 and no longer selected, a rewritten post
 * no longer holds the old URL, and every write is guarded by the old URL.
 */

/** The five types R2's `composer-document` kind takes, by extension. */
const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const EXTENSION_BY_TYPE = new Map(
  Object.entries(CONTENT_TYPES).map(([ext, type]) => [type, ext]),
);

/** A Cloudinary URL that shows a document: a raw file, or a document extension. */
const DOCUMENT_URL_SQL = `(%s ~* '/raw/upload/' OR %s ~* '\\.(pdf|docx?|pptx?|xlsx?|csv|txt|rtf|odt|odp|ods|zip|key|pages|numbers|epub)$')`;
function documentUrlSql(column: string): string {
  return DOCUMENT_URL_SQL.replace(/%s/g, column);
}

const LOG = '[library:migrate-documents-to-r2]';

// ---------------------------------------------------------------------------
// Ports (real adapters in main(), mocks in the spec)
// ---------------------------------------------------------------------------

/** Where a document sits on Cloudinary. */
export interface CloudinaryDocumentRef {
  publicId: string;
  resourceType: 'image' | 'raw';
  /** The delivery type, `upload` for everything the app stored. */
  deliveryType: string;
  /** The format to download in: `pdf` for a PDF image, '' for a raw file. */
  format: string;
}

export interface DocumentSource {
  /** Admin API lookup (read-only): does it exist, and how big is it. */
  probe(
    ref: CloudinaryDocumentRef,
  ): Promise<{ exists: boolean; bytes?: number }>;
  /** The original bytes, through a signed API download. */
  download(ref: CloudinaryDocumentRef): Promise<Buffer>;
  /** Every document on the account (read-only), for the dry-run report. */
  listDocuments?(): Promise<ListedDocument[]>;
}

export interface ListedDocument {
  publicId: string;
  resourceType: string;
  format: string;
  bytes: number;
}

export interface DocumentTarget {
  upload(input: {
    workspaceId: string;
    buffer: Buffer;
    contentType: string;
    filename: string;
  }): Promise<{ key: string; publicUrl: string }>;
  remove(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Options and result
// ---------------------------------------------------------------------------

export interface MigrateDocumentsOptions {
  databaseUrl: string;
  confirmedProduction: boolean;
  /** False (the default) is a dry run: nothing is uploaded or written. */
  apply: boolean;
  /** Dry run only: also download each file and check its bytes (read-only). */
  verifyDownload?: boolean;
  /** Our Cloudinary cloud name; any other cloud's URL is skipped. */
  cloudName: string;
  source: DocumentSource;
  /** Required with `apply`. */
  target?: DocumentTarget;
  /** Stop after this many files (a cautious first run). */
  limit?: number;
  connect?: (url: string) => Promise<Client>;
  log?: (line: string) => void;
}

export interface LedgerEntry {
  workspaceId: string;
  /** Library rows moved; empty for a URL only posts used. */
  itemIds: string[];
  oldUrl: string;
  cloudinaryPublicId: string;
  cloudinaryResourceType: 'image' | 'raw';
  r2Key: string;
  newUrl: string;
  bytes: number;
  refsRewritten: number;
}

export interface MigrateDocumentsResult {
  dryRun: boolean;
  /** Distinct (workspace, URL) pairs found. */
  candidates: number;
  /** Library rows among them. */
  libraryRows: number;
  /** Pairs only posts use. */
  postOnlyUrls: number;
  /** Pairs per workspace. */
  byWorkspace: Record<string, number>;
  /** Moved (apply), or would be moved (dry run). */
  migrated: number;
  skipped: { workspaceId: string; url: string; reason: string }[];
  failed: { workspaceId: string; url: string; error: string }[];
  refsRewritten: number;
  ledger: LedgerEntry[];
  /** The account's own documents, when the source can list them. */
  cloudinary?: {
    total: number;
    byWorkspace: Record<string, number>;
    /** On the account, but no candidate in this database points at it. */
    notInDatabase: number;
  };
}

interface Candidate {
  workspaceId: string;
  url: string;
  itemIds: string[];
  /** The rows' own public id, when they carry one. */
  publicId: string | null;
  mimeType: string | null;
  name: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Where a Cloudinary delivery URL's file sits:
 * `https://res.cloudinary.com/<cloud>/<image|raw>/<type>/[v<n>/]<public id>[.<ext>]`.
 * A raw file's public id keeps its extension; an image's does not (the
 * extension is the format). Null for another cloud, a video, or a URL with
 * transformation segments (never one the app stored).
 */
export function parseCloudinaryUrl(
  url: string,
  cloudName: string,
): CloudinaryDocumentRef | null {
  let path: string;
  try {
    const u = new URL(url);
    if (u.hostname !== 'res.cloudinary.com') return null;
    path = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 4 || parts[0] !== cloudName) return null;
  const resourceType = parts[1];
  if (resourceType !== 'image' && resourceType !== 'raw') return null;
  const deliveryType = parts[2];
  let rest = parts.slice(3);
  if (/^v\d+$/.test(rest[0] ?? '')) rest = rest.slice(1);
  if (rest.length === 0 || rest.some((s) => s.includes(','))) return null;
  const tail = rest.join('/');
  if (resourceType === 'raw') {
    return { publicId: tail, resourceType, deliveryType, format: '' };
  }
  const format = extensionOf(tail);
  const publicId = format ? tail.slice(0, -(format.length + 1)) : tail;
  return { publicId, resourceType, deliveryType, format };
}

/**
 * The R2 content type of a document: its stored mime type when it is one of
 * the five, else its URL's extension. Null for anything else (a spreadsheet,
 * a ZIP): R2 does not take it, so it is reported and left where it is.
 */
export function documentContentType(
  url: string,
  mimeType: string | null,
): string | null {
  const bare = mimeType?.split(';')[0].trim().toLowerCase();
  if (bare && EXTENSION_BY_TYPE.has(bare)) return bare;
  return CONTENT_TYPES[extensionOf(new URL(url).pathname)] ?? null;
}

/** True when the bytes start the way a file of this type does. */
export function bytesMatchType(buffer: Buffer, contentType: string): boolean {
  if (buffer.length === 0) return false;
  const ext = EXTENSION_BY_TYPE.get(contentType);
  if (ext === 'pdf')
    return buffer.subarray(0, 5).toString('latin1') === '%PDF-';
  return hasDocumentMagic(buffer.subarray(0, 16));
}

/** The first 8 characters of a workspace id: enough to tell them apart in a log. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/** The workspace a `library/<ws>/...` public id belongs to, or null. */
function workspaceOfPublicId(publicId: string): string | null {
  const m = /^library\/([0-9a-f-]{36})\//i.exec(publicId);
  return m ? m[1] : null;
}

/** The download name: the item's name with the type's extension. */
function fileNameFor(name: string | null, contentType: string): string {
  const ext = EXTENSION_BY_TYPE.get(contentType) ?? 'pdf';
  const base = (name ?? '').trim() || 'document';
  return `${base}.${ext}`;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

async function defaultConnect(url: string): Promise<Client> {
  const { connectionString, ssl } = buildPoolConfig(url);
  const client = new Client({ connectionString, ssl });
  await client.connect();
  return client;
}

/** Library rows and post-only URLs to move, grouped by (workspace, URL). */
async function findCandidates(
  client: Client,
  cloudName: string,
): Promise<{ list: Candidate[]; libraryRows: number; postOnly: number }> {
  const prefix = `https://res.cloudinary.com/${cloudName}/%`;
  // Sample rows (0057) share one file across workspaces and are never ours
  // to move; a database without the column has none.
  const hasSample = await client.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'media_items' AND column_name = 'is_sample') AS ok`,
  );
  const notSample = hasSample.rows[0]?.ok ? 'AND is_sample = false' : '';
  const rows = await client.query<{
    id: string;
    workspace_id: string;
    file_url: string;
    cloudinary_public_id: string | null;
    mime_type: string | null;
    name: string | null;
  }>(
    `SELECT id, workspace_id, file_url, cloudinary_public_id, mime_type, name
       FROM media_items
      WHERE storage_provider = 'cloudinary'
        ${notSample}
        AND file_url LIKE $1
        AND (type = 'document' OR ${documentUrlSql('file_url')})
      ORDER BY workspace_id, file_url, created_at, id`,
    [prefix],
  );

  const byKey = new Map<string, Candidate>();
  for (const r of rows.rows) {
    const key = `${r.workspace_id} ${r.file_url}`;
    const found = byKey.get(key);
    if (found) {
      found.itemIds.push(r.id);
      continue;
    }
    byKey.set(key, {
      workspaceId: r.workspace_id,
      url: r.file_url,
      itemIds: [r.id],
      publicId: r.cloudinary_public_id,
      mimeType: r.mime_type,
      name: r.name,
    });
  }
  const libraryRows = rows.rows.length;

  const posts = await client.query<{ workspace_id: string; url: string }>(
    `SELECT DISTINCT p.workspace_id, u.url
       FROM posts p,
            jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(p.media_urls) = 'array'
                   THEN p.media_urls ELSE '[]'::jsonb END) AS u(url)
      WHERE u.url LIKE $1 AND ${documentUrlSql('u.url')}
      ORDER BY 1, 2`,
    [prefix],
  );
  let postOnly = 0;
  for (const r of posts.rows) {
    const key = `${r.workspace_id} ${r.url}`;
    if (byKey.has(key)) continue;
    postOnly += 1;
    byKey.set(key, {
      workspaceId: r.workspace_id,
      url: r.url,
      itemIds: [],
      publicId: null,
      mimeType: null,
      name: null,
    });
  }
  return { list: [...byKey.values()], libraryRows, postOnly };
}

/** Tables that may be missing on an older database (evergreen is manual). */
async function existingTables(
  client: Client,
  names: string[],
): Promise<Set<string>> {
  const res = await client.query<{ name: string }>(
    `SELECT n AS name FROM unnest($1::text[]) n WHERE to_regclass(n) IS NOT NULL`,
    [names],
  );
  return new Set(res.rows.map((r) => r.name));
}

/**
 * Moves one (workspace, URL) to R2 in the database: the Library rows, then
 * every JSON string equal to the old URL in the workspace's posts, campaign
 * slots, evergreen entries and templates. Matching the whole JSON string
 * (quotes included) touches the URL and nothing that merely contains it.
 * Returns the references rewritten, or null when the rows changed under us.
 */
async function moveInDatabase(
  client: Client,
  c: Candidate,
  next: { url: string; bytes: number; contentType: string },
  tables: Set<string>,
): Promise<number | null> {
  const oldJson = JSON.stringify(c.url);
  const newJson = JSON.stringify(next.url);
  await client.query('BEGIN');
  try {
    if (c.itemIds.length > 0) {
      const moved = await client.query(
        `UPDATE media_items
            SET file_url = $3,
                storage_provider = 'r2',
                cloudinary_public_id = NULL,
                mime_type = COALESCE(mime_type, $4),
                file_size = $5,
                thumbnail_url = CASE
                  WHEN thumbnail_url LIKE 'https://res.cloudinary.com/%' THEN NULL
                  ELSE thumbnail_url END,
                updated_at = now()
          WHERE workspace_id = $1
            AND file_url = $2
            AND storage_provider = 'cloudinary'
            AND id = ANY($6::uuid[])`,
        [
          c.workspaceId,
          c.url,
          next.url,
          next.contentType,
          next.bytes,
          c.itemIds,
        ],
      );
      if (moved.rowCount !== c.itemIds.length) {
        await client.query('ROLLBACK');
        return null;
      }
    }

    let refs = 0;
    // `col` is the SET target; `ref` the same column, qualified where the
    // UPDATE joins another table that could share its name.
    const swap = (col: string, ref = col) =>
      `${col} = CASE WHEN strpos(${ref}::text, $2) > 0
                     THEN replace(${ref}::text, $2, $3)::jsonb ELSE ${ref} END`;
    const holds = (col: string) => `strpos(COALESCE(${col}::text, ''), $2) > 0`;

    const posts = await client.query(
      `UPDATE posts
          SET ${swap('media_items')}, ${swap('platform_content')}, ${swap('targets')}
        WHERE workspace_id = $1
          AND (${holds('media_items')} OR ${holds('platform_content')} OR ${holds('targets')})`,
      [c.workspaceId, oldJson, newJson],
    );
    refs += posts.rowCount ?? 0;

    if (tables.has('campaign_slot_content')) {
      const slots = await client.query(
        `UPDATE campaign_slot_content s
            SET ${swap('content', 's.content')}
           FROM campaigns c
          WHERE c.id = s.campaign_id AND c.workspace_id = $1 AND ${holds('s.content')}`,
        [c.workspaceId, oldJson, newJson],
      );
      refs += slots.rowCount ?? 0;
    }
    if (tables.has('campaign_evergreen_posts')) {
      const evergreen = await client.query(
        `UPDATE campaign_evergreen_posts e
            SET ${swap('content', 'e.content')}, ${swap('variations', 'e.variations')}
           FROM campaigns c
          WHERE c.id = e.campaign_id AND c.workspace_id = $1
            AND (${holds('e.content')} OR ${holds('e.variations')})`,
        [c.workspaceId, oldJson, newJson],
      );
      refs += evergreen.rowCount ?? 0;
    }
    const templates = await client.query(
      `UPDATE media_templates
          SET ${swap('content')},
              thumbnail_url = CASE WHEN thumbnail_url = $4 THEN $5 ELSE thumbnail_url END
        WHERE workspace_id = $1 AND (${holds('content')} OR thumbnail_url = $4)`,
      [c.workspaceId, oldJson, newJson, c.url, next.url],
    );
    refs += templates.rowCount ?? 0;

    await client.query('COMMIT');
    return refs;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function runMigrateDocumentsToR2(
  opts: MigrateDocumentsOptions,
): Promise<MigrateDocumentsResult> {
  const target = decideTarget(opts.databaseUrl, opts.confirmedProduction);
  if (!target.allowed) throw new Error(target.reason ?? 'target refused');
  if (target.host.endsWith('.railway.internal') && !opts.confirmedProduction) {
    throw new Error(
      `refusing to run against "${target.host}" without --i-know-this-is-production ` +
        '(npm needs a `--` before it: npm run library:migrate-documents-to-r2 -- --apply --i-know-this-is-production).',
    );
  }
  if (opts.apply && !opts.target) {
    throw new Error('--apply needs an R2 target');
  }
  const log = opts.log ?? ((line: string) => console.log(line));
  const dryRun = !opts.apply;

  const result: MigrateDocumentsResult = {
    dryRun,
    candidates: 0,
    libraryRows: 0,
    postOnlyUrls: 0,
    byWorkspace: {},
    migrated: 0,
    skipped: [],
    failed: [],
    refsRewritten: 0,
    ledger: [],
  };

  const client = await (opts.connect ?? defaultConnect)(opts.databaseUrl);
  try {
    const found = await findCandidates(client, opts.cloudName);
    const list =
      opts.limit && opts.limit > 0
        ? found.list.slice(0, opts.limit)
        : found.list;
    result.candidates = found.list.length;
    result.libraryRows = found.libraryRows;
    result.postOnlyUrls = found.postOnly;
    for (const c of found.list) {
      const ws = shortId(c.workspaceId);
      result.byWorkspace[ws] = (result.byWorkspace[ws] ?? 0) + 1;
    }

    const tables = await existingTables(client, [
      'campaign_slot_content',
      'campaign_evergreen_posts',
    ]);

    for (const c of list) {
      const skip = (reason: string) => {
        result.skipped.push({ workspaceId: c.workspaceId, url: c.url, reason });
        log(`${LOG} skip ws=${shortId(c.workspaceId)} ${c.url}: ${reason}`);
      };

      const ref = parseCloudinaryUrl(c.url, opts.cloudName);
      if (!ref) {
        skip('not a plain image/raw URL on our Cloudinary account');
        continue;
      }
      // The row's own public id wins: it is what the upload returned.
      if (c.publicId) ref.publicId = c.publicId;
      const contentType = documentContentType(c.url, c.mimeType);
      if (!contentType) {
        skip('not a PDF, PPT, PPTX, DOC or DOCX; R2 does not take it');
        continue;
      }
      if (!ref.format && ref.resourceType === 'image') {
        ref.format = EXTENSION_BY_TYPE.get(contentType) ?? '';
      }

      let buffer: Buffer | null = null;
      try {
        if (dryRun && !opts.verifyDownload) {
          const probe = await opts.source.probe(ref);
          if (!probe.exists) {
            skip('missing on Cloudinary');
            continue;
          }
          result.migrated += 1;
          log(
            `${LOG} would move ws=${shortId(c.workspaceId)} rows=${c.itemIds.length} ` +
              `${ref.resourceType}:${ref.publicId} (${probe.bytes ?? '?'} bytes)`,
          );
          continue;
        }

        buffer = await opts.source.download(ref);
        if (!bytesMatchType(buffer, contentType)) {
          skip(`downloaded bytes are not a ${contentType} file`);
          continue;
        }
        if (dryRun) {
          result.migrated += 1;
          log(
            `${LOG} would move ws=${shortId(c.workspaceId)} rows=${c.itemIds.length} ` +
              `${ref.resourceType}:${ref.publicId} (${buffer.length} bytes, download verified)`,
          );
          continue;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.failed.push({
          workspaceId: c.workspaceId,
          url: c.url,
          error: message,
        });
        log(`${LOG} FAILED ws=${shortId(c.workspaceId)} ${c.url}: ${message}`);
        continue;
      }

      // --apply from here on.
      const r2 = opts.target!;
      let stored: { key: string; publicUrl: string };
      try {
        stored = await r2.upload({
          workspaceId: c.workspaceId,
          buffer,
          contentType,
          filename: fileNameFor(c.name, contentType),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.failed.push({
          workspaceId: c.workspaceId,
          url: c.url,
          error: message,
        });
        log(
          `${LOG} FAILED upload ws=${shortId(c.workspaceId)} ${c.url}: ${message}`,
        );
        continue;
      }
      if (!isWorkspaceR2Key(stored.key, c.workspaceId)) {
        await r2.remove(stored.key).catch(() => undefined);
        result.failed.push({
          workspaceId: c.workspaceId,
          url: c.url,
          error: `R2 key ${stored.key} is not a workspace key`,
        });
        continue;
      }

      let refs: number | null;
      try {
        refs = await moveInDatabase(
          client,
          c,
          { url: stored.publicUrl, bytes: buffer.length, contentType },
          tables,
        );
      } catch (error) {
        await r2.remove(stored.key).catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        result.failed.push({
          workspaceId: c.workspaceId,
          url: c.url,
          error: message,
        });
        log(
          `${LOG} FAILED db ws=${shortId(c.workspaceId)} ${c.url}: ${message}`,
        );
        continue;
      }
      if (refs === null) {
        await r2.remove(stored.key).catch(() => undefined);
        skip('the Library rows changed during the run; run it again');
        continue;
      }

      const entry: LedgerEntry = {
        workspaceId: c.workspaceId,
        itemIds: c.itemIds,
        oldUrl: c.url,
        cloudinaryPublicId: ref.publicId,
        cloudinaryResourceType: ref.resourceType,
        r2Key: stored.key,
        newUrl: stored.publicUrl,
        bytes: buffer.length,
        refsRewritten: refs,
      };
      result.ledger.push(entry);
      result.migrated += 1;
      result.refsRewritten += refs;
      log(`${LOG} LEDGER ${JSON.stringify(entry)}`);
    }

    if (opts.source.listDocuments) {
      try {
        const listed = await opts.source.listDocuments();
        const known = new Set(
          found.list
            .map((c) => {
              const ref = parseCloudinaryUrl(c.url, opts.cloudName);
              return c.publicId ?? ref?.publicId;
            })
            .filter((p): p is string => !!p),
        );
        const byWorkspace: Record<string, number> = {};
        for (const d of listed) {
          const ws = workspaceOfPublicId(d.publicId);
          const label = ws ? shortId(ws) : '(other folder)';
          byWorkspace[label] = (byWorkspace[label] ?? 0) + 1;
        }
        result.cloudinary = {
          total: listed.length,
          byWorkspace,
          notInDatabase: listed.filter((d) => !known.has(d.publicId)).length,
        };
      } catch (error) {
        log(
          `${LOG} could not list the account's documents: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return result;
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Real adapters
// ---------------------------------------------------------------------------

/** Cloudinary through its SDK (configured by `CloudinaryService`). */
export class CloudinaryDocumentSource implements DocumentSource {
  constructor(
    private readonly sdk: typeof cloudinarySdk,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async probe(
    ref: CloudinaryDocumentRef,
  ): Promise<{ exists: boolean; bytes?: number }> {
    try {
      const res = (await this.sdk.api.resource(ref.publicId, {
        resource_type: ref.resourceType,
        type: ref.deliveryType,
      })) as { bytes?: number };
      return { exists: true, bytes: res.bytes };
    } catch (error) {
      const e = error as { error?: { http_code?: number }; http_code?: number };
      if ((e?.error?.http_code ?? e?.http_code) === 404)
        return { exists: false };
      throw error;
    }
  }

  /**
   * `private_download_url` signs an API download of the ORIGINAL file, which
   * the account's PDF delivery setting does not block. A dropped connection
   * (fetch's TypeError) is tried twice more; an HTTP answer is final.
   */
  async download(ref: CloudinaryDocumentRef): Promise<Buffer> {
    const url = this.sdk.utils.private_download_url(ref.publicId, ref.format, {
      resource_type: ref.resourceType,
      type: ref.deliveryType,
      expires_at: Math.floor(Date.now() / 1000) + 600,
    });
    let res: Response | undefined;
    for (let attempt = 1; !res; attempt += 1) {
      try {
        res = await this.fetchImpl(url);
      } catch (error) {
        if (!(error instanceof TypeError) || attempt >= 3) throw error;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    if (!res.ok) {
      throw new Error(`Cloudinary download answered HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /** PDFs (stored as images) and raw files, through the Search API. */
  async listDocuments(): Promise<ListedDocument[]> {
    const out: ListedDocument[] = [];
    let cursor: string | undefined;
    do {
      let q = this.sdk.search
        .expression('(resource_type:image AND format:pdf) OR resource_type:raw')
        .max_results(500);
      if (cursor) q = q.next_cursor(cursor);
      const page = (await q.execute()) as {
        resources: {
          public_id: string;
          resource_type: string;
          format?: string;
          bytes: number;
        }[];
        next_cursor?: string;
      };
      for (const r of page.resources) {
        out.push({
          publicId: r.public_id,
          resourceType: r.resource_type,
          format: r.format ?? '',
          bytes: r.bytes,
        });
      }
      cursor = page.next_cursor;
    } while (cursor);
    return out;
  }
}

/** R2 through the app's own service: same keys, same checks. */
export function r2DocumentTarget(r2: CloudflareR2Service): DocumentTarget {
  return {
    upload: ({ workspaceId, buffer, contentType, filename }) =>
      r2.uploadBuffer({
        kind: 'composer-document',
        workspaceId,
        buffer,
        contentType,
        filename,
      }),
    remove: (key) => r2.deleteObject(key),
  };
}

/** `--name value` or `--name=value`. */
function argValue(argv: string[], name: string): string | undefined {
  const joined = argv.find((a) => a.startsWith(`${name}=`));
  if (joined) return joined.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function printSummary(res: MigrateDocumentsResult): void {
  const verb = res.dryRun ? 'would move' : 'moved';
  console.log(
    `${LOG} ${res.dryRun ? 'DRY RUN (nothing written)' : 'APPLIED'}: ` +
      `${res.candidates} document(s) found (${res.libraryRows} Library row(s), ` +
      `${res.postOnlyUrls} post-only URL(s)) in ${Object.keys(res.byWorkspace).length} workspace(s); ` +
      `${verb} ${res.migrated}; skipped ${res.skipped.length}; failed ${res.failed.length}; ` +
      `references rewritten ${res.refsRewritten}.`,
  );
  console.log(`${LOG} by workspace: ${JSON.stringify(res.byWorkspace)}`);
  const reasons: Record<string, number> = {};
  for (const s of res.skipped) reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
  if (res.skipped.length) {
    console.log(`${LOG} skipped by reason: ${JSON.stringify(reasons)}`);
  }
  if (res.cloudinary) {
    console.log(
      `${LOG} Cloudinary account: ${res.cloudinary.total} document(s) ` +
        `by workspace folder ${JSON.stringify(res.cloudinary.byWorkspace)}; ` +
        `${res.cloudinary.notInDatabase} with no row in this database.`,
    );
  }
}

async function main(): Promise<void> {
  config({ path: '.env' });
  const argv = process.argv.slice(2);
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(`${LOG} DATABASE_URL is not set; refusing to run.`);
    process.exit(1);
  }
  const apply = argv.includes('--apply');
  if (apply && argv.includes('--dry-run')) {
    console.error(`${LOG} pass --apply or --dry-run, not both.`);
    process.exit(1);
  }
  try {
    const configService = new ConfigService();
    const cloudinary = new CloudinaryService(configService);
    if (!cloudinary.isReady()) throw new Error('Cloudinary is not configured');
    const r2 = new CloudflareR2Service(configService);
    if (apply && !r2.isReady()) throw new Error('R2 is not configured');
    const limit = Number(argValue(argv, '--limit') ?? 0) || undefined;

    const res = await runMigrateDocumentsToR2({
      databaseUrl: url,
      confirmedProduction: argv.includes('--i-know-this-is-production'),
      apply,
      verifyDownload: argv.includes('--verify-download'),
      cloudName: process.env.CLOUDINARY_CLOUD_NAME ?? '',
      source: new CloudinaryDocumentSource(cloudinarySdk),
      target: apply ? r2DocumentTarget(r2) : undefined,
      limit,
    });
    printSummary(res);

    if (apply && res.ledger.length > 0) {
      const path =
        argValue(argv, '--ledger') ??
        `migrate-documents-to-r2-ledger-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      writeFileSync(path, JSON.stringify(res.ledger, null, 2), 'utf8');
      console.log(
        `${LOG} ledger written to ${path} (keep it: it lists the Cloudinary originals to delete later).`,
      );
    }
    if (res.failed.length) process.exitCode = 2;
  } catch (error) {
    console.error(
      `${LOG} ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
