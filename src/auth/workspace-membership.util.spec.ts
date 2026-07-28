import { mergeWorkspacesWithRoles } from './workspace-membership.util';

const ws = (id: string, name = id) =>
  ({ id, name, slug: name, ownerId: 'o', createdAt: new Date(), updatedAt: new Date() }) as any;

describe('mergeWorkspacesWithRoles', () => {
  it('tags owned as OWNER and members by their invitation role, owner wins on overlap', () => {
    const owned = [ws('a')];
    const memberships = [
      { workspace: ws('b'), role: 'MEMBER' as const },
      { workspace: ws('a'), role: 'ADMIN' as const }, // overlap with owned
    ];
    const out = mergeWorkspacesWithRoles(owned, memberships);
    expect(out.map((w) => [w.id, w.role])).toEqual([
      ['a', 'OWNER'],
      ['b', 'MEMBER'],
    ]);
  });
});
