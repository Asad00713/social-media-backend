/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- Reflect metadata reads */
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { RequestMethod } from '@nestjs/common';
import { REQUIRE_CAPABILITY } from './require-capability.decorator';
import { WorkspaceRoleGuard } from './workspace-role.guard';

// The global regression net. Every controller under src is discovered from disk,
// so a brand-new controller is covered without anyone editing this file. Any route
// whose path carries a workspace id must be behind WorkspaceRoleGuard AND demand a
// capability (the guard waves a request through when no capability is declared).
// The only way out is OPEN_ROUTES below, and each entry must say why.

const WS_PARAM = /:(workspaceId|wsId|wid)(\b|\/|$)/;

// 'METHOD /full/path' -> reason this workspace route is deliberately not
// role-guarded. Do not add a route here because it is inconvenient to guard it.
const SUPER_ADMIN_ONLY =
  'AdminController is behind JwtAuthGuard + SuperAdminGuard: platform staff act on any workspace, so a workspace role does not apply';
const OPEN_ROUTES: Record<string, string> = {
  'GET /admin/workspaces/:workspaceId': SUPER_ADMIN_ONLY,
  'GET /admin/workspaces/:workspaceId/posts': SUPER_ADMIN_ONLY,
  'GET /admin/workspaces/:workspaceId/media': SUPER_ADMIN_ONLY,
  'GET /admin/workspaces/:workspaceId/billing': SUPER_ADMIN_ONLY,
  'POST /admin/workspaces/:workspaceId/suspend': SUPER_ADMIN_ONLY,
  'POST /admin/workspaces/:workspaceId/reactivate': SUPER_ADMIN_ONLY,
  'DELETE /admin/workspaces/:workspaceId/channels/:channelId': SUPER_ADMIN_ONLY,
  'PATCH /admin/workspaces/:workspaceId/members/:memberId': SUPER_ADMIN_ONLY,
  'DELETE /admin/workspaces/:workspaceId/members/:memberId': SUPER_ADMIN_ONLY,
  'DELETE /admin/workspaces/:workspaceId/invitations/:invitationId':
    SUPER_ADMIN_ONLY,
  'DELETE /workspace-members/:workspaceId/members/:memberId':
    'member-leave: a member or guest must be able to remove their OWN row, which a team:manage gate would block; WorkspaceMembersService.removeMember enforces isSelf || owner || admin || super-admin',
};

const SRC = path.resolve(__dirname, '..');

function findControllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findControllerFiles(full));
    else if (entry.name.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

interface Route {
  key: string;
  controller: string;
  handler: string;
  fullPath: string;
  hasGuard: boolean;
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

function collectRoutes(): { routes: Route[]; controllers: string[] } {
  const routes: Route[] = [];
  const controllers: string[] = [];
  for (const file of findControllerFiles(SRC).sort()) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(file) as Record<string, unknown>;
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      const ctrl = exported as any;
      // @Controller() always writes PATH_METADATA ('path') on the class.
      if (Reflect.getMetadata('path', ctrl) === undefined) continue;
      controllers.push(ctrl.name);
      const proto = ctrl.prototype as Record<string, any>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const sub = Reflect.getMetadata('path', handler);
        const method = Reflect.getMetadata('method', handler);
        if (sub === undefined || method === undefined) continue;
        const guards = [
          ...((Reflect.getMetadata('__guards__', ctrl) as unknown[]) ?? []),
          ...((Reflect.getMetadata('__guards__', handler) as unknown[]) ?? []),
        ];
        const capability =
          Reflect.getMetadata(REQUIRE_CAPABILITY, handler) ??
          Reflect.getMetadata(REQUIRE_CAPABILITY, ctrl);
        for (const base of asArray(Reflect.getMetadata('path', ctrl))) {
          for (const s of asArray(sub)) {
            const fullPath = join(base, s);
            const verb = RequestMethod[method as number] ?? String(method);
            routes.push({
              key: `${verb} ${fullPath}`,
              controller: ctrl.name,
              handler: name,
              fullPath,
              hasGuard: guards.includes(WorkspaceRoleGuard),
              capability,
            });
          }
        }
      }
    }
  }
  return { routes, controllers };
}

describe('every workspace-scoped route is role-guarded', () => {
  const { routes, controllers } = collectRoutes();
  const workspaceRoutes = routes.filter((r) => WS_PARAM.test(r.fullPath));

  it('discovers a plausible number of controllers and routes', () => {
    expect(controllers.length).toBeGreaterThan(35);
    expect(workspaceRoutes.length).toBeGreaterThan(250);
  });

  it('every workspace route has WorkspaceRoleGuard and a required capability', () => {
    const offenders = workspaceRoutes
      .filter((r) => !(r.key in OPEN_ROUTES))
      .filter((r) => !r.hasGuard || !r.capability)
      .map(
        (r) =>
          `${r.key}  (${r.controller}.${r.handler}) ` +
          `guard=${r.hasGuard} capability=${String(r.capability)}`,
      );
    expect(offenders).toEqual([]);
  });

  it('the allowlist has no stale entries', () => {
    const real = new Set(workspaceRoutes.map((r) => r.key));
    const stale = Object.keys(OPEN_ROUTES).filter((k) => !real.has(k));
    expect(stale).toEqual([]);
  });

  it('every allowlist entry states a reason', () => {
    for (const [k, reason] of Object.entries(OPEN_ROUTES)) {
      expect({ k, ok: reason.trim().length > 10 }).toEqual({ k, ok: true });
    }
  });
});
