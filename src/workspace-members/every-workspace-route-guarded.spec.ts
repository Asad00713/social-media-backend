import { WorkspaceRoleGuard } from './workspace-role.guard';
import { OPEN_ROUTES } from './open-workspace-routes';
import { collectControllerRoutes } from './testing/controller-routes';

// The global regression net. Every controller under src is discovered from disk,
// so a brand-new controller is covered without anyone editing this file. Any route
// whose path carries a workspace id must be behind WorkspaceRoleGuard AND demand a
// capability (the guard waves a request through when no capability is declared).
// The only way out is OPEN_ROUTES (open-workspace-routes.ts), and each entry
// must say why.

const WS_PARAM = /:(workspaceId|wsId|wid)(\b|\/|$)/;

describe('every workspace-scoped route is role-guarded', () => {
  const { routes, controllers } = collectControllerRoutes();
  const workspaceRoutes = routes
    .filter((r) => WS_PARAM.test(r.fullPath))
    .map((r) => ({ ...r, hasGuard: r.guards.includes(WorkspaceRoleGuard) }));

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
