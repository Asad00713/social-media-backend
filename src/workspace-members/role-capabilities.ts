export type WorkspaceRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST';
export type Capability =
  | 'billing:manage'
  | 'workspace:delete'
  | 'team:view'
  | 'team:manage'
  | 'channels:manage'
  | 'posts:publish'
  /** Approve a draft someone asked to have approved ("Needs approval"). */
  | 'posts:approve'
  | 'inbox:reply'
  | 'posts:draft'
  | 'inbox:view'
  | 'analytics:view'
  /**
   * See every member's Maestro conversations, not only your own.
   *
   * A conversation holds whatever someone typed into the agent, so this is
   * read access to colleagues' working notes. Kept at ADMIN for the same
   * reason `team:manage` is: it is the level where someone is accountable for
   * the workspace rather than just working in it.
   */
  | 'maestro:view-all'
  /** Change the workspace brand kit: colours, default logo, presets. */
  | 'brand:manage'
  /** Create, change, share and send Insights reports; they email people outside the workspace. */
  | 'reports:manage';

export const ROLE_RANK: Record<WorkspaceRole, number> = {
  OWNER: 4,
  ADMIN: 3,
  MEMBER: 2,
  GUEST: 1,
};

export const CAPABILITY_MIN_ROLE: Record<Capability, WorkspaceRole> = {
  'billing:manage': 'OWNER',
  'workspace:delete': 'OWNER',
  'team:view': 'GUEST',
  'team:manage': 'ADMIN',
  'channels:manage': 'MEMBER',
  'posts:publish': 'MEMBER',
  'posts:approve': 'ADMIN',
  'inbox:reply': 'MEMBER',
  'posts:draft': 'GUEST',
  'inbox:view': 'GUEST',
  'analytics:view': 'GUEST',
  'maestro:view-all': 'ADMIN',
  'brand:manage': 'ADMIN',
  'reports:manage': 'MEMBER',
};

export function roleCan(role: WorkspaceRole, capability: Capability): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[CAPABILITY_MIN_ROLE[capability]];
}
