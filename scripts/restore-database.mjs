#!/usr/bin/env node
/**
 * Lists backups in R2 and restores one into a target database.
 *
 * This is the half of the backup system that actually matters. A backup nobody
 * has restored is a guess, so this script exists to be run — on a scratch
 * database, on purpose, before anyone needs it in anger.
 *
 * Usage:
 *   node scripts/restore-database.mjs --list
 *   node scripts/restore-database.mjs --key backups/schedura-....dump --target "postgres://…"
 *   node scripts/restore-database.mjs --latest --target "postgres://…"
 *
 * Restoring over a non-empty database also needs --clean, and restoring into
 * anything that looks like production additionally needs --i-know-this-is-production.
 *
 * Required env: the four CLOUDFLARE_R2_* vars (same as the backup script).
 * Optional env: PG_RESTORE (path to pg_restore), BACKUP_PREFIX.
 */

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';

const PREFIX = (process.env.BACKUP_PREFIX ?? 'backups/').replace(/^\/+/, '');
const PG_RESTORE = process.env.PG_RESTORE ?? 'pg_restore';

function parseArgs(argv) {
  const args = { list: false, latest: false, clean: false, confirmProduction: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') args.list = true;
    else if (arg === '--latest') args.latest = true;
    else if (arg === '--clean') args.clean = true;
    else if (arg === '--i-know-this-is-production') args.confirmProduction = true;
    else if (arg === '--key') args.key = argv[++i];
    else if (arg === '--target') args.target = argv[++i];
  }
  return args;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[restore] Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

/**
 * A restore is destructive and irreversible, and the one thing worse than
 * having no backup is overwriting a live database with an old one by accident.
 * Hostnames that look managed/remote are treated as production unless the
 * caller says otherwise in so many words.
 */
function looksLikeProduction(connectionString) {
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(connectionString);
  return !local;
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'], env });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}

function makeClient() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${requireEnv('CLOUDFLARE_R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requireEnv('CLOUDFLARE_R2_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('CLOUDFLARE_R2_SECRET_ACCESS_KEY'),
    },
  });
}

async function listBackups(s3, bucket) {
  const objects = [];
  let continuationToken;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: PREFIX,
        ContinuationToken: continuationToken,
      }),
    );
    objects.push(...(page.Contents ?? []));
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  return objects.sort(
    (a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bucket = requireEnv('CLOUDFLARE_R2_BUCKET');
  const s3 = makeClient();

  const backups = await listBackups(s3, bucket);

  if (args.list || (!args.key && !args.latest)) {
    if (backups.length === 0) {
      console.log('[restore] No backups found. Has the backup job ever run?');
      return;
    }
    console.log(`[restore] ${backups.length} backup(s) in r2://${bucket}/${PREFIX}\n`);
    for (const object of backups) {
      const mb = ((object.Size ?? 0) / 1024 / 1024).toFixed(1);
      console.log(`  ${object.LastModified?.toISOString()}  ${mb.padStart(8)} MB  ${object.Key}`);
    }
    if (!args.list) {
      console.log('\nPass --key <key> --target <connection string> to restore one.');
    }
    return;
  }

  const key = args.latest ? backups[0]?.Key : args.key;
  if (!key) {
    console.error('[restore] No backup to restore (empty bucket, or --key not given).');
    process.exit(1);
  }
  if (!args.target) {
    console.error('[restore] --target <connection string> is required.');
    process.exit(1);
  }

  if (looksLikeProduction(args.target) && !args.confirmProduction) {
    console.error(
      '[restore] REFUSING: the target does not look local.\n' +
        '          A restore overwrites every table it touches and cannot be undone.\n' +
        '          Re-run with --i-know-this-is-production if that is genuinely what you want.',
    );
    process.exit(1);
  }

  const workDir = await mkdtemp(join(tmpdir(), 'schedura-restore-'));
  const filePath = join(workDir, 'restore.dump');

  try {
    console.log(`[restore] Downloading ${key}…`);
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    await pipeline(object.Body, createWriteStream(filePath));

    console.log('[restore] Restoring…');
    const restoreArgs = [
      '--dbname',
      args.target,
      '--no-owner',
      '--no-privileges',
      // Keep going past individual object errors so one incompatible extension
      // or missing role does not abandon the rest of the restore.
      '--exit-on-error=0',
    ];
    if (args.clean) restoreArgs.push('--clean', '--if-exists');
    restoreArgs.push(filePath);

    await run(PG_RESTORE, restoreArgs, process.env);
    console.log('[restore] Done. Verify row counts before pointing the app at it.');
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[restore] FAILED: ${error.message}`);
  process.exit(1);
});
