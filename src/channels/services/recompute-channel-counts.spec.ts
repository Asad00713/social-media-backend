import { buildRecomputeSql } from './recompute-channel-counts';

describe('buildRecomputeSql', () => {
  it('counts only non-integration channels and is safe for zero-billable workspaces', () => {
    const sql = buildRecomputeSql();
    expect(sql).toContain("category <> 'integration'");
    expect(sql).toContain('COALESCE');
    // Must not reference a non-existent is_active column.
    expect(sql).not.toContain('is_active');
  });
});
