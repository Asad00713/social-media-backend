import type { Workspace } from '../drizzle/schema';

export type WorkspaceRoleLabel = 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST';

// Workspace shape safe to return to clients: excludes admin-only internal
// columns (`suspensionNote`, `suspendedById`) and the Maestro BYOK credential
// (`maestroAnthropicKey`, encrypted but still a secret — it must NEVER leave
// the server; settings read it via GET /maestro/key, which returns only a
// masked hint). Keep in sync with the `columns` projection used in
// AuthService#whoAmI.
export type PublicWorkspace = Omit<
  Workspace,
  | 'suspensionNote'
  | 'suspendedById'
  | 'maestroAnthropicKey'
  | 'maestroAnthropicKeyHint'
  | 'maestroAnthropicKeySetAt'
  | 'maestroOnboardedAt'
>;

export type WorkspaceWithRole = PublicWorkspace & { role: WorkspaceRoleLabel };

export function mergeWorkspacesWithRoles(
  owned: PublicWorkspace[],
  memberships: {
    workspace: PublicWorkspace;
    role: 'ADMIN' | 'MEMBER' | 'GUEST';
  }[],
): WorkspaceWithRole[] {
  const byId = new Map<string, WorkspaceWithRole>();
  for (const w of owned) byId.set(w.id, { ...w, role: 'OWNER' });
  for (const m of memberships) {
    if (byId.has(m.workspace.id)) continue; // owner wins
    byId.set(m.workspace.id, { ...m.workspace, role: m.role });
  }
  return [...byId.values()];
}
