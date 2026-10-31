import { config } from 'dotenv';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { buildPoolConfig } from '../../drizzle/pool-config';
import { decideTarget } from '../../drizzle/migrate/target-guard';
import { CloudinaryService } from '../../media/cloudinary.service';
import { CloudflareR2Service } from '../../media/cloudflare-r2.service';
import { StorageObjectService } from '../services/storage-object.service';

/**
 * One-off owner script: fills `media_items.file_size` where it is NULL by
 * asking the store that holds the bytes (R2 HEAD, Cloudinary admin API). A row
 * whose size cannot be found stays NULL (it counts as 0) and is reported in
 * `failed`. Cloudinary's admin API is rate-limited, so after
 * `maxCloudinaryCalls` the remaining Cloudinary rows are skipped; run it again
 * later to pick them up. R2 rows are not capped. Idempotent.
 */

const PAGE_SIZE = 100;
const DEFAULT_MAX_CLOUDINARY_CALLS = 400;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** The slice of StorageObjectService this script needs. */
export type SizeProbe = Pick<StorageObjectService, 'realSize'>;

export interface BackfillFileSizesOptions {
  databaseUrl: string;
  confirmedProduction: boolean;
  dryRun: boolean;
  maxCloudinaryCalls?: number;
  storage: SizeProbe;
  connect?: (url: string) => Promise<Client>;
}

export interface BackfillFileSizesResult {
  filled: number;
  failed: string[];
  skippedForRateLimit: number;
}

interface NullSizeRow {
  id: string;
  workspace_id: string;
  storage_provider: 'cloudinary' | 'r2' | null;
  cloudinary_public_id: string | null;
  file_url: string;
  type: string;
  mime_type: string | null;
}

async function defaultConnect(url: string): Promise<Client> {
  const { connectionString, ssl } = buildPoolConfig(url);
  const client = new Client({ connectionString, ssl });
  await client.connect();
  return client;
}

export async function runBackfillFileSizes(
  opts: BackfillFileSizesOptions,
): Promise<BackfillFileSizesResult> {
  const target = decideTarget(opts.databaseUrl, opts.confirmedProduction);
  if (!target.allowed) {
    throw new Error(target.reason ?? 'target refused');
  }
  if (target.host.endsWith('.railway.internal') && !opts.confirmedProduction) {
    throw new Error(
      `refusing to run against "${target.host}" without --i-know-this-is-production ` +
        '(npm needs a `--` before it: npm run library:backfill-sizes -- --i-know-this-is-production).',
    );
  }

  const maxCloudinaryCalls =
    opts.maxCloudinaryCalls ?? DEFAULT_MAX_CLOUDINARY_CALLS;
  const result: BackfillFileSizesResult = {
    filled: 0,
    failed: [],
    skippedForRateLimit: 0,
  };
  let cloudinaryCalls = 0;

  const client = await (opts.connect ?? defaultConnect)(opts.databaseUrl);
  try {
    let cursor = NIL_UUID;
    for (;;) {
      const page = await client.query<NullSizeRow>(
        `SELECT id, workspace_id, storage_provider, cloudinary_public_id,
                file_url, type, mime_type
           FROM media_items
          WHERE file_size IS NULL AND id > $1
          ORDER BY id
          LIMIT $2`,
        [cursor, PAGE_SIZE],
      );
      if (page.rows.length === 0) break;

      for (const row of page.rows) {
        const provider = row.storage_provider ?? 'cloudinary';
        if (provider === 'cloudinary') {
          if (cloudinaryCalls >= maxCloudinaryCalls) {
            result.skippedForRateLimit += 1;
            continue;
          }
          cloudinaryCalls += 1;
        }
        let size: number | null;
        try {
          size = await opts.storage.realSize({
            workspaceId: row.workspace_id,
            storageProvider: provider,
            cloudinaryPublicId: row.cloudinary_public_id,
            fileUrl: row.file_url,
            type: row.type,
            mimeType: row.mime_type,
          });
        } catch (error) {
          // One provider error must not end the pass: the row is reported
          // and the next one is tried.
          result.failed.push(row.id);
          console.warn(
            `[library:backfill-sizes] size lookup failed for ${row.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }
        if (size === null) {
          result.failed.push(row.id);
          console.warn(`[library:backfill-sizes] no size found for ${row.id}`);
          continue;
        }
        if (!opts.dryRun) {
          await client.query(
            'UPDATE media_items SET file_size = $1 WHERE id = $2 AND file_size IS NULL',
            [size, row.id],
          );
        }
        result.filled += 1;
      }
      cursor = page.rows[page.rows.length - 1].id;
    }
    return result;
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  config({ path: '.env' });
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      '[library:backfill-sizes] DATABASE_URL is not set; refusing to run.',
    );
    process.exit(1);
  }
  const dryRun = process.argv.includes('--dry-run');
  try {
    const configService = new ConfigService();
    // realSize never touches the database, so the service gets no connection.
    const storage: SizeProbe = new StorageObjectService(
      new CloudinaryService(configService),
      new CloudflareR2Service(configService),
      undefined as never,
    );
    const res = await runBackfillFileSizes({
      databaseUrl: url,
      confirmedProduction: process.argv.includes('--i-know-this-is-production'),
      dryRun,
      storage,
    });
    console.log(
      `[library:backfill-sizes] ${dryRun ? 'dry run: would fill' : 'filled'} ${res.filled}; ` +
        `${res.failed.length} failed; ${res.skippedForRateLimit} skipped for rate limit.`,
    );
    if (res.failed.length) console.log(`failed ids: ${res.failed.join(', ')}`);
  } catch (error) {
    console.error(
      `[library:backfill-sizes] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
