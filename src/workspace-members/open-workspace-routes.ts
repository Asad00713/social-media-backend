/**
 * Workspace-scoped routes that are deliberately NOT behind WorkspaceRoleGuard,
 * each with the reason. every-workspace-route-guarded.spec.ts fails on any
 * workspace route that is neither guarded nor listed here, and on a stale
 * entry. Do not add a route here because it is inconvenient to guard it.
 *
 * Keys are `METHOD /full/path`; values are the reason.
 */
const SUPER_ADMIN_ONLY =
  'AdminController is behind JwtAuthGuard + SuperAdminGuard: platform staff act on any workspace, so a workspace role does not apply';
const INBOX_ADMIN_SUPER_ADMIN_ONLY =
  'InboxAdminController is behind JwtAuthGuard + SuperAdminGuard: platform staff act on any workspace, so a workspace role does not apply';
export const OPEN_ROUTES: Record<string, string> = {
  'GET /admin/workspaces/:workspaceId': SUPER_ADMIN_ONLY,
  'POST /admin/inbox/workspaces/:workspaceId/cleanup-orphaned-thread-keys':
    INBOX_ADMIN_SUPER_ADMIN_ONLY,
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
  'GET /workspaces/:workspaceId/media-library/categories/:categoryId/zip':
    "folder zip download: a browser navigation cannot carry the in-memory bearer token; access is a 5-minute HMAC ticket minted by the posts:draft-gated zip-ticket route, and the ticket's user is re-checked for posts:draft",
};
