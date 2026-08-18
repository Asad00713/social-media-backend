import { roleCan, CAPABILITY_MIN_ROLE } from './role-capabilities';

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

  it('GUEST is view/draft only', () => {
    expect(roleCan('GUEST', 'analytics:view')).toBe(true);
    expect(roleCan('GUEST', 'posts:draft')).toBe(true);
    expect(roleCan('GUEST', 'posts:publish')).toBe(false);
    expect(roleCan('GUEST', 'inbox:reply')).toBe(false);
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
});
