import { config } from 'dotenv';
import { Client } from 'pg';
import { buildPoolConfig } from '../../drizzle/pool-config';
import { decideTarget } from '../../drizzle/migrate/target-guard';

/**
 * One-off owner script: stamps `libraryItemId` on the base `media_items` of
 * posts written before the Library tracked usage by id. An entry that already
 * has an id, or whose URL matches no item of the post's workspace, is left
 * alone. When several items share a URL the live one created first wins
 * (deleted items only win if nothing live matches). Platform overrides are not
 * touched: they already count by URL. `updated_at` is not touched either.
 * Idempotent: a second run finds nothing to stamp.
 */

const DEFAULT_BATCH_SIZE = 500;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export interface BackfillLibraryRefsOptions {
  databaseUrl: string;
  confirmedProduction: boolean;
  batchSize?: number;
  connect?: (url: string) => Promise<Client>;
}

async function defaultConnect(url: string): Promise<Client> {
  const { connectionString, ssl } = buildPoolConfig(url);
  const client = new Client({ connectionString, ssl });
  await client.connect();
  return client;
}

/** Entries that lack an id and match an item of the post's workspace by URL. */
const MATCHING_ITEM = `
  SELECT mi.id
    FROM media_items mi
   WHERE mi.workspace_id = p.workspace_id
     AND mi.file_url = e->>'url'
   ORDER BY mi.is_deleted, mi.created_at, mi.id
   LIMIT 1`;

const UPDATE_BATCH = `
  UPDATE posts p
     SET media_items = (
       SELECT jsonb_agg(
                CASE WHEN e ? 'libraryItemId' OR m.id IS NULL THEN e
                     ELSE e || jsonb_build_object('libraryItemId', m.id::text)
                END
                ORDER BY ord)
         FROM jsonb_array_elements(p.media_items) WITH ORDINALITY t(e, ord)
         LEFT JOIN LATERAL (${MATCHING_ITEM}) m ON true)
   WHERE p.id = ANY($1::uuid[])
     AND jsonb_typeof(p.media_items) = 'array'
     AND EXISTS (
       SELECT 1
         FROM jsonb_array_elements(p.media_items) AS t(e)
         JOIN LATERAL (${MATCHING_ITEM}) m ON true
        WHERE NOT (e ? 'libraryItemId'))
  RETURNING p.id`;

export async function runBackfillLibraryRefs(
  opts: BackfillLibraryRefsOptions,
): Promise<{ postsUpdated: number }> {
  const target = decideTarget(opts.databaseUrl, opts.confirmedProduction);
  if (!target.allowed) {
    throw new Error(target.reason ?? 'target refused');
  }
  // A manual data command: unlike the boot migrator, the deploy-internal host
  // needs the flag too, so a Railway shell cannot hit production by accident.
  if (target.host.endsWith('.railway.internal') && !opts.confirmedProduction) {
    throw new Error(
      `refusing to run against "${target.host}" without --i-know-this-is-production ` +
        '(npm needs a `--` before it: npm run library:backfill-refs -- --i-know-this-is-production).',
    );
  }

  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const client = await (opts.connect ?? defaultConnect)(opts.databaseUrl);
  try {
    let cursor = NIL_UUID;
    let postsUpdated = 0;
    for (;;) {
      const page = await client.query<{ id: string }>(
        'SELECT id FROM posts WHERE id > $1 ORDER BY id LIMIT $2',
        [cursor, batchSize],
      );
      if (page.rows.length === 0) break;
      const ids = page.rows.map((r) => r.id);
      const updated = await client.query(UPDATE_BATCH, [ids]);
      postsUpdated += updated.rowCount ?? 0;
      cursor = ids[ids.length - 1];
    }
    return { postsUpdated };
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  config({ path: '.env' });
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      '[library:backfill-refs] DATABASE_URL is not set; refusing to run.',
    );
    process.exit(1);
  }
  try {
    const { postsUpdated } = await runBackfillLibraryRefs({
      databaseUrl: url,
      confirmedProduction: process.argv.includes('--i-know-this-is-production'),
    });
    console.log(
      `[library:backfill-refs] done; ${postsUpdated} post(s) updated.`,
    );
  } catch (error) {
    console.error(
      `[library:backfill-refs] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
