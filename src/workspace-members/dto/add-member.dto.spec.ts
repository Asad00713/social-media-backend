import { MemberRole } from './add-member.dto';

describe('MemberRole enum', () => {
  it('matches the DB member_role enum values', () => {
    expect(Object.values(MemberRole).sort()).toEqual(['ADMIN', 'GUEST', 'MEMBER']);
    expect((MemberRole as Record<string, string>).VIEWER).toBeUndefined();
  });
});
