#!/usr/bin/env node
/**
 * Takes a compressed logical backup of the production database and uploads it
 * to Cloudflare R2.
 *
 * Why this exists: Railway's managed backups are a paid feature and this
 * project is not on that plan — the "backups" its dashboard lists are
 * volume-resize snapshots taken when the infrastructure changed, months apart,
 * not a schedule. So the only real recovery path is the one in this file.
 *
 * Deliberately independent of the app: it runs from CI (see
 * .github/workflows/database-backup.yml), not from a NestJS cron, so a backend
 * that is down, crash-looping, or mid-deploy still gets backed up.
 *
 * Usage:
 *   node scripts/backup-database.mjs
 *
 * Required env:
 *   DATABASE_URL                     the database to dump
 *   CLOUDFLARE_R2_ACCOUNT_ID         same R2 credentials the app already uses
 *   CLOUDFLARE_R2_ACCESS_KEY_ID
 *   CLOUDFLARE_R2_SECRET_ACCESS_KEY
 *   CLOUDFLARE_R2_BUCKET
 * Optional env:
 *   BACKUP_PREFIX                    key prefix in the bucket (default "backups/")
 *   BACKUP_RETENTION_DAYS            delete older backups (default 30, 0 = keep all)
 *   PG_DUMP                          path to pg_dump (default: "pg_dump" on PATH)
 */

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';

const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS ?? 30);
const PREFIX = (process.env.BACKUP_PREFIX ?? 'backups/').replace(/^\/+/, '');
const PG_DUMP = process.env.PG_DUMP ?? 'pg_dump';

/** Fails loudly and early rather than producing a backup that silently isn't one. */
function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[backup] Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

/**
 * Timestamp that sorts lexicographically, so the newest backup is also the
 * last one in an alphabetical object listing. Colons are not legal in object
 * keys on every storage backend, so they are stripped rather than escaped.
 */
function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z');
}

function run(command, args, { captureStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      // The connection string arrives via env, never argv — argv is visible to
      // every other process on the machine via the process list.
      stdio: captureStdout ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    if (captureStdout) child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
    });
  });
}

async function main() {
  const databaseUrl = requireEnv('DATABASE_URL');
  const accountId = requireEnv('CLOUDFLARE_R2_ACCOUNT_ID');
  const accessKeyId = requireEnv('CLOUDFLARE_R2_ACCESS_KEY_ID');
  const secretAccessKey = requireEnv('CLOUDFLARE_R2_SECRET_ACCESS_KEY');
  const bucket = requireEnv('CLOUDFLARE_R2_BUCKET');

  const workDir = await mkdtemp(join(tmpdir(), 'schedura-backup-'));
  const fileName = `schedura-${timestamp()}.dump`;
  const filePath = join(workDir, fileName);

  try {
    // Custom format (-Fc): compressed, and pg_restore can list its contents and
    // restore selected tables from it. A plain .sql dump can do neither, which
    // matters when you are restoring one table rather than the whole database.
    console.log('[backup] Dumping database…');
    await run(
      PG_DUMP,
      ['--format=custom', '--no-owner', '--no-privileges', `--file=${filePath}`, databaseUrl],
    );

    const { size } = await stat(filePath);
    if (size === 0) throw new Error('pg_dump produced an empty file');

    // A dump that exists is not a dump that works. Reading the archive's table
    // of contents proves the file is a well-formed archive and not a truncated
    // write or an error page — the cheapest check that catches a real failure.
    console.log('[backup] Verifying archive…');
    const { stdout } = await run('pg_restore', ['--list', filePath], { captureStdout: true });
    const entries = stdout.split('\n').filter((line) => line && !line.startsWith(';')).length;
    if (entries === 0) throw new Error('Archive contains no restorable entries');
    console.log(`[backup] Archive OK — ${entries} entries, ${(size / 1024 / 1024).toFixed(1)} MB`);

    const s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });

    const key = `${PREFIX}${fileName}`;
    console.log(`[backup] Uploading to r2://${bucket}/${key}`);
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentLength: size,
        ContentType: 'application/octet-stream',
      }),
    );
    console.log('[backup] Upload complete');

    if (RETENTION_DAYS > 0) {
      await pruneOldBackups(s3, bucket, RETENTION_DAYS);
    }

    console.log(`[backup] Done: ${key}`);
  } finally {
    // The dump holds every row in the database — never leave it on the runner.
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Deletes backups older than the retention window.
 *
 * Keeps the newest backup unconditionally, whatever its age: a database that
 * has not been backed up in longer than the window is exactly when you must not
 * also delete the last copy that exists.
 */
async function pruneOldBackups(s3, bucket, retentionDays) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
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

  if (objects.length <= 1) return;

  const newest = objects.reduce((a, b) =>
    (a.LastModified?.getTime() ?? 0) > (b.LastModified?.getTime() ?? 0) ? a : b,
  );
  const expired = objects.filter(
    (object) =>
      object.Key !== newest.Key && (object.LastModified?.getTime() ?? 0) < cutoff,
  );

  if (expired.length === 0) {
    console.log(`[backup] Retention: nothing older than ${retentionDays}d`);
    return;
  }

  // DeleteObjects caps at 1000 keys per call.
  for (let i = 0; i < expired.length; i += 1000) {
    const chunk = expired.slice(i, i + 1000);
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: chunk.map((object) => ({ Key: object.Key })) },
      }),
    );
  }
  console.log(`[backup] Retention: deleted ${expired.length} backup(s) older than ${retentionDays}d`);
}

main().catch((error) => {
  // Message only: the connection string and R2 secrets must never reach a log.
  console.error(`[backup] FAILED: ${error.message}`);
  process.exit(1);
});
