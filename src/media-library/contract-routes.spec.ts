/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Reflect metadata reads */
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MediaController } from '../media/media.controller';
import { REQUIRE_CAPABILITY } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { LibraryUploadController } from './library-upload.controller';
import { LibraryZipController } from './library-zip.controller';
import { MediaLibraryController } from './media-library.controller';

// The Library API contract (frontend repo,
// docs/superpowers/specs/2026-10-31-library-api-contract.md) as routes: each
// one exists exactly once, on the controller that owns it, behind exactly the
// capability below. Metadata is read the way
// workspace-members/every-workspace-route-guarded.spec.ts reads it.

const BASE = '/workspaces/:workspaceId/media-library';

interface Route {
  key: string;
  controller: string;
  handler: string;
  guards: unknown[];
  capability: unknown;
}

const asArray = (p: unknown): string[] =>
  (Array.isArray(p) ? p : [p ?? '']).map(String);
const join = (...parts: string[]) =>
  '/' +
  parts
    .map((s) => s.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');

function routesOf(ctrl: any): Route[] {
  const out: Route[] = [];
  const proto = ctrl.prototype as Record<string, any>;
  for (const name of Object.getOwnPropertyNames(proto)) {
    const handler = proto[name];
    if (name === 'constructor' || typeof handler !== 'function') continue;
    const sub = Reflect.getMetadata('path', handler);
    const method = Reflect.getMetadata('method', handler);
    if (sub === undefined || method === undefined) continue;
    const guards = [
      ...((Reflect.getMetadata(GUARDS_METADATA, ctrl) as unknown[]) ?? []),
      ...((Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[]) ?? []),
    ];
    const capability =
      Reflect.getMetadata(REQUIRE_CAPABILITY, handler) ??
      Reflect.getMetadata(REQUIRE_CAPABILITY, ctrl);
    for (const base of asArray(Reflect.getMetadata('path', ctrl))) {
      for (const s of asArray(sub)) {
        const verb = RequestMethod[method as number] ?? String(method);
        out.push({
          key: `${verb} ${join(base, s)}`,
          controller: ctrl.name,
          handler: name,
          guards,
          capability,
        });
      }
    }
  }
  return out;
}

const ROUTES: Route[] = [
  MediaLibraryController,
  LibraryZipController,
  LibraryUploadController,
  MediaController,
].flatMap(routesOf);

function only(key: string): Route {
  const found = ROUTES.filter((r) => r.key === key);
  expect({ key, count: found.length }).toEqual({ key, count: 1 });
  return found[0];
}

/** Workspace Library routes: `[method path under BASE, capability]`. */
const CAPABILITIES: [string, 'posts:draft' | 'posts:publish'][] = [
  ['GET stats', 'posts:draft'],
  ['GET categories', 'posts:draft'],
  ['POST categories/:categoryId/zip-ticket', 'posts:draft'],
  ['GET templates', 'posts:draft'],
  ['POST templates/bulk', 'posts:draft'],
  ['GET snippets', 'posts:draft'],
  ['POST snippets/bulk', 'posts:draft'],
  ['GET links', 'posts:draft'],
  ['POST links/bulk', 'posts:draft'],
  ['GET items', 'posts:draft'],
  ['PUT items/:itemId', 'posts:draft'],
  ['POST items/:itemId/use', 'posts:draft'],
  ['GET items/:itemId/usage', 'posts:draft'],
  ['POST items/:itemId/alt-text', 'posts:draft'],
  ['POST items/bulk', 'posts:draft'],
  ['GET recycle-bin', 'posts:draft'],
  ['POST recycle-bin/restore', 'posts:draft'],
  ['POST recycle-bin/delete', 'posts:publish'],
  ['POST recycle-bin/empty', 'posts:publish'],
  // Delete forever, one Bin row at a time (a live row is a 404, Task 14).
  ['DELETE items/:itemId/permanent', 'posts:publish'],
  ['DELETE templates/:templateId/permanent', 'posts:publish'],
  ['DELETE snippets/:snippetId/permanent', 'posts:publish'],
  ['DELETE links/:linkId/permanent', 'posts:publish'],
];

const ZIP_DOWNLOAD = `GET ${BASE}/categories/:categoryId/zip`;

const UPLOAD_ROUTES = [
  'POST /media/upload/file',
  'POST /media/upload/url',
  'POST /media/upload/base64',
  'POST /media/signed-upload-params',
  'POST /media/r2/presign-composer-video',
];

describe('Library API contract routes', () => {
  it.each(CAPABILITIES)(
    '%s is on MediaLibraryController behind WorkspaceRoleGuard with %s',
    (route, capability) => {
      const [verb, sub] = route.split(' ');
      const r = only(`${verb} ${join(BASE, sub)}`);
      expect({
        controller: r.controller,
        roleGuard: r.guards.includes(WorkspaceRoleGuard),
        capability: r.capability,
      }).toEqual({
        controller: 'MediaLibraryController',
        roleGuard: true,
        capability,
      });
    },
  );

  it('the zip download is LibraryZipController alone: no guards, no capability, an OPEN_ROUTES entry', () => {
    const r = only(ZIP_DOWNLOAD);
    expect({
      controller: r.controller,
      guards: r.guards,
      capability: r.capability,
    }).toEqual({
      controller: 'LibraryZipController',
      guards: [],
      capability: undefined,
    });

    // OPEN_ROUTES lives in that spec (not exported, so it is read as text).
    const guardSpec = fs.readFileSync(
      path.join(
        __dirname,
        '..',
        'workspace-members',
        'every-workspace-route-guarded.spec.ts',
      ),
      'utf8',
    );
    const openRoutes = guardSpec.slice(
      guardSpec.indexOf('const OPEN_ROUTES'),
      guardSpec.indexOf('};', guardSpec.indexOf('const OPEN_ROUTES')),
    );
    expect(openRoutes).toContain(`'${ZIP_DOWNLOAD}':`);
  });

  it.each(UPLOAD_ROUTES)(
    '%s is LibraryUploadController behind JwtAuthGuard',
    (key) => {
      const r = only(key);
      expect({
        controller: r.controller,
        jwt: r.guards.includes(JwtAuthGuard),
      }).toEqual({ controller: 'LibraryUploadController', jwt: true });
    },
  );

  it('MediaController declares none of the upload routes any more', () => {
    const left = routesOf(MediaController)
      .map((r) => r.key)
      .filter((k) => UPLOAD_ROUTES.includes(k));
    expect(left).toEqual([]);
  });
});
