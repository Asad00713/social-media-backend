import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  BRAND_PROFILE_SOURCES,
  FIRST_WEEK_STATUSES,
  workspaceBrandProfiles,
} from './workspace-brand-profile.schema';

const ROOT = process.cwd();
const migration = readFileSync(
  join(ROOT, 'drizzle', 'migrations', '0040_home_first_week.sql'),
  'utf8',
);
const seed = readFileSync(
  join(ROOT, 'src', 'drizzle', 'seeds', 'plans.seed.ts'),
  'utf8',
);

/** The migration without `--` comment lines, so prose cannot satisfy a check. */
const migrationCode = migration
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');

describe('workspace_brand_profiles schema', () => {
  const cfg = getTableConfig(workspaceBrandProfiles);

  it('is named workspace_brand_profiles with workspace_id as the primary key', () => {
    expect(cfg.name).toBe('workspace_brand_profiles');
    const pk = cfg.columns.find((c) => c.primary);
    expect(pk?.name).toBe('workspace_id');
  });

  it('has every column the spec lists', () => {
    expect(cfg.columns.map((c) => c.name).sort()).toEqual(
      [
        'audience',
        'created_at',
        'drafted_count',
        'error',
        'posts_read',
        'sells',
        'source',
        'source_channel_id',
        'source_platform',
        'status',
        'updated_at',
        'voice',
        'week_ends_at',
        'week_starts_on',
        'workspace_id',
      ].sort(),
    );
  });

  it('has two foreign keys (workspace, channel)', () => {
    expect(cfg.foreignKeys).toHaveLength(2);
  });

  it('exports the status and source enums in spec order', () => {
    expect(FIRST_WEEK_STATUSES).toEqual([
      'reading',
      'drafting',
      'ready',
      'needs_description',
      'no_tokens',
      'failed',
    ]);
    expect(BRAND_PROFILE_SOURCES).toEqual(['posts', 'described']);
  });
});

describe('0040_home_first_week.sql', () => {
  it('mentions every schema column, so schema and SQL cannot drift', () => {
    for (const c of getTableConfig(workspaceBrandProfiles).columns) {
      expect(migrationCode).toContain(`"${c.name}"`);
    }
  });

  it('is idempotent and never destructive (a failing migration crash-loops prod)', () => {
    expect(migrationCode).toMatch(
      /CREATE TABLE IF NOT EXISTS "workspace_brand_profiles"/,
    );
    // `ON DELETE CASCADE` on a foreign key is fine; destructive statements are not.
    expect(migrationCode).not.toMatch(/\b(DROP|TRUNCATE)\b|\bDELETE\s+FROM\b/i);
    // every constraint add is inside a duplicate_object guard
    const adds = migrationCode.match(/ADD CONSTRAINT/g) ?? [];
    const guards =
      migrationCode.match(/WHEN duplicate_object THEN NULL/g) ?? [];
    expect(adds.length).toBeGreaterThan(0);
    expect(guards.length).toBe(adds.length);
  });

  it('only raises Free rows that are still at zero (guarded UPDATEs)', () => {
    expect(migrationCode).toMatch(
      /UPDATE "plans"[\s\S]*?WHERE "code" = 'FREE' AND "ai_tokens_per_month" = 0/,
    );
    expect(migrationCode).toMatch(
      /UPDATE "workspace_usage"[\s\S]*?"ai_tokens_limit" = 0/,
    );
  });

  it('gives Free 100 tokens, matching the seed', () => {
    expect(migrationCode).toMatch(/"ai_tokens_per_month" = 100/);
    const freeBlock =
      seed.match(/code: 'FREE'[\s\S]*?isActive: true/)?.[0] ?? '';
    expect(freeBlock).toMatch(/aiTokensPerMonth: 100/);
    expect(freeBlock).toMatch(/aiFeatures: true/);
  });
});
