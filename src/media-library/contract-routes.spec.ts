import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MediaController } from '../media/media.controller';
import { OPEN_ROUTES } from '../workspace-members/open-workspace-routes';
import {
  collectControllerRoutes,
  joinPath,
  routesOfController,
} from '../workspace-members/testing/controller-routes';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';

// The Library API contract (frontend repo,
// docs/superpowers/specs/2026-10-31-library-api-contract.md) as routes: each
// one exists exactly once across EVERY controller under src, on the
// controller that owns it, behind exactly the guards and capability below.

const BASE = '/workspaces/:workspaceId/media-library';

const { routes: ROUTES } = collectControllerRoutes();

function only(key: string) {
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
  'POST /media/r2/presign-composer-document',
];

describe('Library API contract routes', () => {
  it('discovers the controllers from disk', () => {
    const controllers = new Set(ROUTES.map((r) => r.controller));
    for (const name of [
      'MediaLibraryController',
      'LibraryZipController',
      'LibraryUploadController',
      'MediaController',
    ]) {
      expect(controllers).toContain(name);
    }
  });

  it.each(CAPABILITIES)(
    '%s is on MediaLibraryController behind JwtAuthGuard + WorkspaceRoleGuard with %s',
    (route, capability) => {
      const [verb, sub] = route.split(' ');
      const r = only(`${verb} ${joinPath(BASE, sub)}`);
      expect({
        controller: r.controller,
        jwt: r.guards.includes(JwtAuthGuard),
        roleGuard: r.guards.includes(WorkspaceRoleGuard),
        capability: r.capability,
      }).toEqual({
        controller: 'MediaLibraryController',
        jwt: true,
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
    expect(OPEN_ROUTES[ZIP_DOWNLOAD]).toEqual(expect.any(String));
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
    const left = routesOfController(MediaController)
      .map((r) => r.key)
      .filter((k) => UPLOAD_ROUTES.includes(k));
    expect(left).toEqual([]);
  });
});
