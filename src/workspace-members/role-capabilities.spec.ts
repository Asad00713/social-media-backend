import {
  roleCan,
  CAPABILITY_MIN_ROLE,
  type Capability,
} from './role-capabilities';

describe('roleCan', () => {
  it('OWNER can everything', () => {
    for (const cap of Object.keys(CAPABILITY_MIN_ROLE)) {
      expect(roleCan('OWNER', cap as any)).toBe(true);
    }
  });

  it('MEMBER can publish + channels but not team/billing', () => {
    expect(roleCan('MEMBER', 'posts:publish')).toBe(true);
    expect(roleCan('MEMBER', 'channels:manage')).toBe(true);
    expect(roleCan('MEMBER', 'team:manage')).toBe(false);
    expect(roleCan('MEMBER', 'billing:manage')).toBe(false);
  });

  it('GUEST is view and comment only', () => {
    expect(roleCan('GUEST', 'analytics:view')).toBe(true);
    expect(roleCan('GUEST', 'posts:view')).toBe(true);
    expect(roleCan('GUEST', 'posts:comment')).toBe(true);
    expect(roleCan('GUEST', 'posts:draft')).toBe(false);
    expect(roleCan('GUEST', 'posts:publish')).toBe(false);
    expect(roleCan('GUEST', 'inbox:reply')).toBe(false);
  });

  it('posts:view and posts:comment are GUEST', () => {
    expect(CAPABILITY_MIN_ROLE['posts:view']).toBe('GUEST');
    expect(CAPABILITY_MIN_ROLE['posts:comment']).toBe('GUEST');
  });

  it('posts:draft is MEMBER', () => {
    expect(roleCan('GUEST', 'posts:draft')).toBe(false);
    expect(roleCan('MEMBER', 'posts:draft')).toBe(true);
  });

  /** Mirrored by the frontend's `capabilities.ts`; this list pins the shared keys. */
  it('the map has exactly these 18 keys', () => {
    expect(Object.keys(CAPABILITY_MIN_ROLE).sort()).toEqual(
      [
        'analytics:view',
        'billing:manage',
        'brand:manage',
        'channels:manage',
        'inbox:reply',
        'inbox:view',
        'labels:manage',
        'posts:approve',
        'posts:comment',
        'posts:draft',
        'posts:publish',
        'posts:view',
        'reports:manage',
        'settings:view',
        'team:manage',
        'team:view',
        'workspace:delete',
        'workspace:manage',
      ].sort(),
    );
  });

  it('ADMIN cannot manage billing', () => {
    expect(roleCan('ADMIN', 'team:manage')).toBe(true);
    expect(roleCan('ADMIN', 'billing:manage')).toBe(false);
  });

  it('lets any member view the team (team:view floor is GUEST)', () => {
    expect(roleCan('GUEST', 'team:view')).toBe(true);
    expect(roleCan('MEMBER', 'team:view')).toBe(true);
    expect(roleCan('ADMIN', 'team:view')).toBe(true);
    expect(roleCan('OWNER', 'team:view')).toBe(true);
  });

  it('keeps team management ADMIN+ (a viewer cannot manage)', () => {
    expect(roleCan('GUEST', 'team:manage')).toBe(false);
    expect(roleCan('MEMBER', 'team:manage')).toBe(false);
    expect(roleCan('ADMIN', 'team:manage')).toBe(true);
  });

  it('maestro:view-all is not a capability', () => {
    // @ts-expect-error removed: Maestro history is the caller's own, for every role
    const removed: Capability = 'maestro:view-all';
    expect(removed).toBe('maestro:view-all');
    expect(Object.keys(CAPABILITY_MIN_ROLE)).not.toContain('maestro:view-all');
  });

  /** A report emails people outside the workspace, so a viewer cannot manage one. */
  it('keeps managing reports MEMBER+', () => {
    expect(roleCan('GUEST', 'reports:manage')).toBe(false);
    expect(roleCan('MEMBER', 'reports:manage')).toBe(true);
    expect(roleCan('ADMIN', 'reports:manage')).toBe(true);
    expect(roleCan('OWNER', 'reports:manage')).toBe(true);
  });

  /** The brand voice steers every AI draft, so a member cannot rewrite it. */
  it('keeps brand voice edits ADMIN+', () => {
    expect(roleCan('MEMBER', 'brand:manage')).toBe(false);
    expect(roleCan('ADMIN', 'brand:manage')).toBe(true);
  });
});

describe('settings capabilities (spec §4.2)', () => {
  it.each([
    ['settings:view', 'GUEST', false],
    ['settings:view', 'MEMBER', true],
    ['workspace:manage', 'MEMBER', false],
    ['workspace:manage', 'ADMIN', true],
    ['labels:manage', 'GUEST', false],
    ['labels:manage', 'MEMBER', true],
    ['billing:manage', 'ADMIN', false],
    ['workspace:delete', 'ADMIN', false],
  ] as const)('%s for %s is %s', (cap, role, ok) => {
    expect(roleCan(role, cap)).toBe(ok);
  });
});
