export type WorkspaceRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST';
export type Capability =
  | 'billing:manage'
  | 'workspace:delete'
  | 'team:view'
  | 'team:manage'
  | 'channels:manage'
  | 'posts:publish'
  /** See posts, the planner and insights. A Viewer (GUEST) holds it. */
  | 'posts:view'
  /** Comment on a post, and resolve or reopen a comment. A Viewer (GUEST) holds it. */
  | 'posts:comment'
  /** Approve a draft someone asked to have approved ("Needs approval"). */
  | 'posts:approve'
  | 'inbox:reply'
  /** Create and edit drafts, and use the composer. A Viewer (GUEST) does not hold it. */
  | 'posts:draft'
  | 'inbox:view'
  | 'analytics:view'
  /** Change the workspace brand kit and brand voice. */
  | 'brand:manage'
  /** Create, change, share and send Insights reports; they email people outside the workspace. */
  | 'reports:manage'
  /** Open Settings and read the workspace-level pages (Settings spec §4.2). */
  | 'settings:view'
  /** Change workspace General, publishing defaults and the invite link (Settings spec §4.2). */
  | 'workspace:manage'
  /** Create, rename, recolour, merge and delete workspace labels (Settings spec §4.2). */
  | 'labels:manage';

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
  'posts:view': 'GUEST',
  'posts:comment': 'GUEST',
  'posts:draft': 'MEMBER',
  'inbox:view': 'GUEST',
  'analytics:view': 'GUEST',
  'brand:manage': 'ADMIN',
  'reports:manage': 'MEMBER',
  'settings:view': 'MEMBER',
  'workspace:manage': 'ADMIN',
  'labels:manage': 'MEMBER',
};

export function roleCan(role: WorkspaceRole, capability: Capability): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[CAPABILITY_MIN_ROLE[capability]];
}
