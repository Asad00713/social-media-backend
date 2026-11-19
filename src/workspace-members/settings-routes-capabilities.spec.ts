import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { REQUIRE_CAPABILITY } from './require-capability.decorator';
import { WorkspaceRoleGuard } from './workspace-role.guard';
import { OPEN_ROUTES } from './open-workspace-routes';
import { roleCan, type Capability } from './role-capabilities';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SKIP_LAUNCH_GATE } from '../auth/decorators/skip-launch-gate.decorator';
import { WorkspaceController } from '../workspace/workspace.controller';
import { WorkspaceMembersController } from './workspace-members.controller';
import { JoinLinkController } from './join-link.controller';
import { PublicInvitationsController } from './public-invitations.controller';
import { LabelsController } from '../labels/labels.controller';
import { BillingController } from '../billing/billing.controller';
import { AccountSettingsController } from '../users/account-settings.controller';

// The Settings Part A route capability matrix (Settings spec section 4.3).
// Each row is `handler -> capability`; null means the route is deliberately
// not capability-gated (JWT-only, or listed in OPEN_ROUTES with a reason).
// A `complete` table must name every route handler of its controller, so a
// route added later cannot slip in unpinned. A partial table pins only the
// rows listed (BillingController has many routes outside Part A).

type Ctor = new (...a: any[]) => object;
type Table = Record<string, Capability | null>;

const MATRIX: Array<[string, Ctor, Table, boolean]> = [
  [
    'WorkspaceController',
    WorkspaceController,
    {
      create: null,
      findAll: null,
      findBySlug: null,
      findOne: 'settings:view',
      publishingDefaults: 'posts:draft',
      update: 'workspace:manage',
      presignLogo: 'workspace:manage',
      deletionPreview: 'workspace:delete',
      removePermanently: 'workspace:delete',
    },
    true,
  ],
  [
    'WorkspaceMembersController',
    WorkspaceMembersController,
    {
      inviteMember: 'team:manage',
      batchInvite: 'team:manage',
      getPendingInvitations: 'team:manage',
      getInvitationLink: 'team:manage',
      resendInvitation: 'team:manage',
      cancelInvitation: 'team:manage',
      getInviteLink: 'team:manage',
      setInviteLink: 'team:manage',
      resetInviteLink: 'team:manage',
      getMyInvitations: null,
      acceptInvitation: null,
      rejectInvitation: null,
      getMembers: 'team:view',
      updateMemberRole: 'team:manage',
      leaveWorkspace: null,
      removeMember: null,
      restoreMember: 'team:manage',
    },
    true,
  ],
  [
    'LabelsController',
    LabelsController,
    {
      list: 'posts:draft',
      create: 'labels:manage',
      update: 'labels:manage',
      merge: 'labels:manage',
      remove: 'labels:manage',
      restore: 'labels:manage',
    },
    true,
  ],
  [
    'BillingController',
    BillingController,
    {
      getBillingOverview: 'billing:manage',
      getProviderInvoices: 'billing:manage',
      createPortalLink: 'billing:manage',
      cancelSubscription: 'billing:manage',
    },
    false,
  ],
];

function handlersOf(Ctrl: Ctor): string[] {
  const proto = Ctrl.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto).filter(
    (n) =>
      n !== 'constructor' &&
      Reflect.getMetadata('path', proto[n] as object) !== undefined,
  );
}

function handlerOf(Ctrl: Ctor, name: string): object {
  return (Ctrl.prototype as Record<string, object>)[name];
}

function guardsOf(Ctrl: Ctor, name: string): unknown[] {
  return [
    ...((Reflect.getMetadata('__guards__', Ctrl) as unknown[]) ?? []),
    ...((Reflect.getMetadata('__guards__', handlerOf(Ctrl, name)) as
      | unknown[]
      | undefined) ?? []),
  ];
}

function capabilityOf(Ctrl: Ctor, name: string): Capability | null {
  return (Reflect.getMetadata(REQUIRE_CAPABILITY, handlerOf(Ctrl, name)) ??
    Reflect.getMetadata(REQUIRE_CAPABILITY, Ctrl) ??
    null) as Capability | null;
}

function routeOf(Ctrl: Ctor, name: string): { method: string; path: string } {
  const base = Reflect.getMetadata('path', Ctrl) as string | string[];
  const handler = handlerOf(Ctrl, name);
  const sub = Reflect.getMetadata('path', handler) as string | string[];
  const clean = (p: string | string[]) =>
    (Array.isArray(p) ? p[0] : p).replace(/^\/+|\/+$/g, '');
  const path = '/' + [clean(base), clean(sub)].filter(Boolean).join('/');
  const method: string =
    RequestMethod[Reflect.getMetadata('method', handler) as number];
  return { method, path };
}

describe.each(MATRIX)('%s capability matrix', (_n, Ctrl, table, complete) => {
  if (complete) {
    it('names every route handler, none missing from the table', () => {
      expect(handlersOf(Ctrl).sort()).toEqual(Object.keys(table).sort());
    });
  }

  it.each(Object.entries(table))('%s requires %s', (handler, cap) => {
    expect(handlersOf(Ctrl)).toContain(handler);
    expect(capabilityOf(Ctrl, handler)).toBe(cap);
    if (cap) {
      expect(guardsOf(Ctrl, handler)).toContain(JwtAuthGuard);
      expect(guardsOf(Ctrl, handler)).toContain(WorkspaceRoleGuard);
    }
  });

  it('a workspace-scoped route without a capability is a listed OPEN_ROUTE', () => {
    const unlisted = Object.entries(table)
      .filter(([, cap]) => cap === null)
      .map(([handler]) => routeOf(Ctrl, handler))
      .filter((r) => r.path.includes(':workspaceId'))
      .map((r) => `${r.method} ${r.path}`)
      .filter((key) => !(key in OPEN_ROUTES));
    expect(unlisted).toEqual([]);
  });
});

describe('leaveWorkspace is an open route (any role may leave)', () => {
  it('has no capability and is listed in OPEN_ROUTES', () => {
    expect(
      capabilityOf(WorkspaceMembersController, 'leaveWorkspace'),
    ).toBeNull();
    expect(routeOf(WorkspaceMembersController, 'leaveWorkspace')).toEqual({
      method: 'DELETE',
      path: '/workspace-members/:workspaceId/members/me',
    });
    expect(OPEN_ROUTES).toHaveProperty([
      'DELETE /workspace-members/:workspaceId/members/me',
    ]);
  });
});

describe('launch-gate exemptions (@SkipLaunchGate)', () => {
  const skips = (Ctrl: Ctor, name: string) =>
    Reflect.getMetadata(SKIP_LAUNCH_GATE, handlerOf(Ctrl, name)) === true;

  it.each<[string, Ctor, string]>([
    ['DELETE /users/me', AccountSettingsController, 'deleteAccount'],
    ['GET /users/me/workspaces', AccountSettingsController, 'getWorkspaces'],
    ['GET /invitations/join/:code', JoinLinkController, 'preview'],
    ['POST /invitations/join/:code', JoinLinkController, 'join'],
    [
      'POST /workspace-members/invitations/accept',
      WorkspaceMembersController,
      'acceptInvitation',
    ],
  ])('%s skips the launch gate', (_route, Ctrl, handler) => {
    expect(skips(Ctrl, handler)).toBe(true);
  });

  it('the account preference routes stay gated', () => {
    expect(skips(AccountSettingsController, 'getPreferences')).toBe(false);
    expect(skips(AccountSettingsController, 'updatePreferences')).toBe(false);
  });
});

describe('account and invite-link routes carry no workspace capability', () => {
  it('DELETE /users/me and GET /users/me/workspaces are JWT-only', () => {
    expect(routeOf(AccountSettingsController, 'deleteAccount')).toEqual({
      method: 'DELETE',
      path: '/users/me',
    });
    expect(routeOf(AccountSettingsController, 'getWorkspaces')).toEqual({
      method: 'GET',
      path: '/users/me/workspaces',
    });
    for (const h of ['deleteAccount', 'getWorkspaces']) {
      expect(guardsOf(AccountSettingsController, h)).toContain(JwtAuthGuard);
      expect(guardsOf(AccountSettingsController, h)).not.toContain(
        WorkspaceRoleGuard,
      );
      expect(capabilityOf(AccountSettingsController, h)).toBeNull();
    }
  });

  it('invite-link preview is public: no JWT, no role guard, no capability', () => {
    expect(routeOf(JoinLinkController, 'preview')).toEqual({
      method: 'GET',
      path: '/invitations/join/:code',
    });
    expect(guardsOf(JoinLinkController, 'preview')).not.toContain(JwtAuthGuard);
    expect(guardsOf(JoinLinkController, 'preview')).not.toContain(
      WorkspaceRoleGuard,
    );
    expect(capabilityOf(JoinLinkController, 'preview')).toBeNull();
  });

  it('invite-link join needs a signed-in user but no workspace role', () => {
    expect(routeOf(JoinLinkController, 'join')).toEqual({
      method: 'POST',
      path: '/invitations/join/:code',
    });
    expect(guardsOf(JoinLinkController, 'join')).toContain(JwtAuthGuard);
    expect(guardsOf(JoinLinkController, 'join')).not.toContain(
      WorkspaceRoleGuard,
    );
    expect(capabilityOf(JoinLinkController, 'join')).toBeNull();
  });

  it('the email-invitation preview is public', () => {
    expect(guardsOf(PublicInvitationsController, 'preview')).not.toContain(
      JwtAuthGuard,
    );
    expect(capabilityOf(PublicInvitationsController, 'preview')).toBeNull();
  });
});

describe('role thresholds behind the matrix', () => {
  it('a GUEST is denied settings:view', () => {
    expect(roleCan('GUEST', 'settings:view')).toBe(false);
    expect(roleCan('MEMBER', 'settings:view')).toBe(true);
  });

  it('a MEMBER is denied workspace:manage', () => {
    expect(roleCan('MEMBER', 'workspace:manage')).toBe(false);
    expect(roleCan('ADMIN', 'workspace:manage')).toBe(true);
  });

  it('an ADMIN is denied workspace:delete and billing:manage', () => {
    expect(roleCan('ADMIN', 'workspace:delete')).toBe(false);
    expect(roleCan('ADMIN', 'billing:manage')).toBe(false);
    expect(roleCan('OWNER', 'workspace:delete')).toBe(true);
    expect(roleCan('OWNER', 'billing:manage')).toBe(true);
  });
});
