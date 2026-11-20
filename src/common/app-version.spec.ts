import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import request from 'supertest';
import {
  APP_VERSION_HEADER,
  appVersionMiddleware,
  resolveAppCommit,
  resolveAppVersion,
  sentryRelease,
} from './app-version';

const made: string[] = [];

/** A temp dir, optionally holding a package.json with the given version. */
function tempDir(version?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'app-version-'));
  made.push(dir);
  if (version !== undefined) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
  }
  return dir;
}

afterAll(() =>
  made.forEach((d) => rmSync(d, { recursive: true, force: true })),
);

describe('resolveAppVersion', () => {
  it('prefers npm_package_version (started through npm run)', () => {
    expect(
      resolveAppVersion(
        { npm_package_version: '2.3.4' },
        tempDir('9.9.9'),
        tempDir(),
      ),
    ).toBe('2.3.4');
  });

  it('reads package.json under the cwd when started with plain node', () => {
    expect(resolveAppVersion({}, tempDir('1.2.3'), tempDir())).toBe('1.2.3');
  });

  it('walks up from the module directory when the cwd has no package.json', () => {
    const root = tempDir('4.5.6');
    const nested = join(root, 'dist', 'src', 'common');
    mkdirSync(nested, { recursive: true });
    expect(resolveAppVersion({}, tempDir(), nested)).toBe('4.5.6');
  });

  it("falls back to 'unknown' instead of throwing", () => {
    const empty = tempDir();
    expect(resolveAppVersion({}, empty, empty)).toBe('unknown');
  });

  it('ignores a non-semver env value rather than echoing it', () => {
    expect(
      resolveAppVersion(
        { npm_package_version: 'undefined\r\nX-Evil: 1' },
        tempDir('1.0.0'),
        tempDir(),
      ),
    ).toBe('1.0.0');
  });

  it('ignores a package.json whose version is not semver', () => {
    expect(resolveAppVersion({}, tempDir('banana'), tempDir())).toBe('unknown');
  });

  it('resolves this repo real package.json to a semver', () => {
    // No env, real cwd: exactly the production path of `node dist/src/main`.
    expect(resolveAppVersion({})).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('resolveAppCommit', () => {
  it('shortens the Railway SHA to 7 characters', () => {
    expect(
      resolveAppCommit({
        RAILWAY_GIT_COMMIT_SHA: '2B47F00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    ).toBe('2b47f00');
  });

  it('falls back to GIT_COMMIT', () => {
    expect(resolveAppCommit({ GIT_COMMIT: '0123456789abcdef' })).toBe(
      '0123456',
    );
  });

  it("is 'dev' with no deploy stamp", () => {
    expect(resolveAppCommit({})).toBe('dev');
  });

  it("is 'dev' for a blank or malformed value", () => {
    expect(resolveAppCommit({ RAILWAY_GIT_COMMIT_SHA: '  ' })).toBe('dev');
    expect(resolveAppCommit({ RAILWAY_GIT_COMMIT_SHA: 'not a sha' })).toBe(
      'dev',
    );
  });
});

describe('sentryRelease', () => {
  it('is schedura-backend@<version>+<commit>', () => {
    expect(sentryRelease({}, '1.0.0', '2b47f00')).toBe(
      'schedura-backend@1.0.0+2b47f00',
    );
  });

  it('lets SENTRY_RELEASE override', () => {
    expect(sentryRelease({ SENTRY_RELEASE: 'ci-42' }, '1.0.0', 'dev')).toBe(
      'ci-42',
    );
  });

  it('ignores a blank SENTRY_RELEASE', () => {
    expect(sentryRelease({ SENTRY_RELEASE: ' ' }, '1.0.0', 'dev')).toBe(
      'schedura-backend@1.0.0+dev',
    );
  });
});

describe('appVersionMiddleware', () => {
  const app = express();
  app.use(appVersionMiddleware);
  app.get('/ok', (_req, res) => res.json({ ok: true }));
  // The header must also be on error responses: that is when support asks.
  app.get('/boom', (_req, res) => res.status(500).json({ ok: false }));

  it('stamps X-App-Version on a success response', async () => {
    const res = await request(app).get('/ok').expect(200);
    expect(res.headers['x-app-version']).toMatch(/^\d+\.\d+\.\d+/);
    expect(APP_VERSION_HEADER.toLowerCase()).toBe('x-app-version');
  });

  it('stamps it on an error response too', async () => {
    const res = await request(app).get('/boom').expect(500);
    expect(res.headers['x-app-version']).toBeDefined();
  });

  it('stamps it on a 404', async () => {
    const res = await request(app).get('/nope').expect(404);
    expect(res.headers['x-app-version']).toBeDefined();
  });
});

describe('main.ts wiring', () => {
  // main.ts boots the whole app, so it cannot be imported here; read it.
  const main = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');

  it('installs the middleware', () => {
    expect(main).toContain('app.use(appVersionMiddleware)');
  });

  it('exposes the header to browsers (CORS) so the frontend can read it', () => {
    expect(main).toMatch(/exposedHeaders:\s*\[[^\]]*APP_VERSION_HEADER/);
  });
});
