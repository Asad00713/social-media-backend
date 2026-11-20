import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import type { NextFunction, Request, Response } from 'express';

/**
 * What build is this process running?
 *
 * Two stamps, both safe to show anyone:
 *   - APP_VERSION: the semver in package.json ("1.0.0"). Bumped by hand at
 *     release time; see docs/releasing.md.
 *   - APP_COMMIT: the first 7 characters of the deployed git SHA. Railway sets
 *     RAILWAY_GIT_COMMIT_SHA on every deploy; locally there is none -> 'dev'.
 *
 * They surface in three places: GET /health/version, the X-App-Version
 * response header, and the Sentry release (`schedura-backend@1.0.0+abc1234`),
 * so "which build threw this?" always has an answer.
 *
 * Imported by instrument.ts, which must load before everything else, so this
 * file stays dependency-free (node built-ins only; express as types).
 */

export const APP_VERSION_HEADER = 'X-App-Version';

const UNKNOWN_VERSION = 'unknown';
const DEV_COMMIT = 'dev';
const SHORT_SHA_LENGTH = 7;

/**
 * Only a semver-shaped string is trusted. The value ends up in a response
 * header and a Sentry release name, and an env var is outside our control:
 * anything else (a blank, a stray "undefined", CR/LF) falls through to the
 * next source rather than being echoed.
 */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

function readVersionFrom(dir: string): string | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(join(dir, 'package.json'), 'utf8'),
    ) as { version?: unknown } | null;
    const version = parsed?.version;
    return typeof version === 'string' && SEMVER_RE.test(version)
      ? version
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolution order:
 *   1. `npm_package_version` — set by npm when started through `npm run ...`.
 *      NOT set by `node dist/src/main`, which is how the Docker image starts.
 *   2. package.json under the working directory — the image's WORKDIR holds a
 *      copy of package.json (see Dockerfile), so this is the production path.
 *   3. package.json found by walking up from this file — covers a start from
 *      another directory, in both src/ (ts-jest) and dist/src/ (nest build).
 *   4. 'unknown' — never throws; a missing version must not stop the app.
 */
export function resolveAppVersion(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  startDir: string = __dirname,
): string {
  const fromEnv = env.npm_package_version?.trim();
  if (fromEnv && SEMVER_RE.test(fromEnv)) return fromEnv;

  const fromCwd = readVersionFrom(cwd);
  if (fromCwd) return fromCwd;

  let dir = startDir;
  for (let i = 0; i < 4; i++) {
    const found = readVersionFrom(dir);
    if (found) return found;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return UNKNOWN_VERSION;
}

/** Short git SHA from the deploy platform, or 'dev' when there is none. */
export function resolveAppCommit(env: NodeJS.ProcessEnv = process.env): string {
  // GIT_COMMIT is the generic fallback AdminService already honours.
  const raw = (env.RAILWAY_GIT_COMMIT_SHA ?? env.GIT_COMMIT)?.trim();
  return raw && SHA_RE.test(raw)
    ? raw.slice(0, SHORT_SHA_LENGTH).toLowerCase()
    : DEV_COMMIT;
}

export const APP_VERSION = resolveAppVersion();
export const APP_COMMIT = resolveAppCommit();

/**
 * Sentry release name. SENTRY_RELEASE wins when set, so a CI-created release
 * (with sourcemaps) can still override this.
 */
export function sentryRelease(
  env: NodeJS.ProcessEnv = process.env,
  version: string = APP_VERSION,
  commit: string = APP_COMMIT,
): string {
  const override = env.SENTRY_RELEASE?.trim();
  return override || `schedura-backend@${version}+${commit}`;
}

/** Stamps every response with the running version. Install early in main.ts. */
export function appVersionMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader(APP_VERSION_HEADER, APP_VERSION);
  next();
}
