import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { INTEGRATION_PLATFORMS, SUPPORTED_PLATFORMS } from './channels.schema';
import {
  BRAND_TONES,
  TWEAK_PLATFORMS,
  workspaceBrandVoice,
} from './workspace-brand-voice.schema';

const migration = readFileSync(
  join(process.cwd(), 'drizzle', 'migrations', '0101_brand_voice.sql'),
  'utf8',
);

/** The migration without `--` comment lines, so prose cannot satisfy a check. */
const migrationCode = migration
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');

describe('workspace_brand_voice schema', () => {
  const cfg = getTableConfig(workspaceBrandVoice);

  it('names the table workspace_brand_voice with workspace_id as the primary key and one FK', () => {
    expect(cfg.name).toBe('workspace_brand_voice');
    expect(cfg.columns.find((c) => c.primary)?.name).toBe('workspace_id');
    expect(cfg.foreignKeys).toHaveLength(1);
  });

  it('has exactly these columns', () => {
    expect(cfg.columns.map((c) => c.name).sort()).toEqual(
      [
        'channel_tweaks',
        'created_at',
        'description',
        'emoji_level',
        'hashtags_mode',
        'previous',
        'tone',
        'updated_at',
        'version',
        'words_avoid',
        'words_use',
        'workspace_id',
      ].sort(),
    );
  });

  it('emoji_level and hashtags_mode are nullable with no default (NULL = not set)', () => {
    for (const name of ['emoji_level', 'hashtags_mode']) {
      const column = cfg.columns.find((c) => c.name === name);
      expect(column?.notNull).toBe(false);
      expect(column?.hasDefault).toBe(false);
    }
  });

  it('TWEAK_PLATFORMS is SUPPORTED_PLATFORMS without the integrations, in that order', () =>
    expect([...TWEAK_PLATFORMS]).toEqual(
      SUPPORTED_PLATFORMS.filter((p) => !INTEGRATION_PLATFORMS.includes(p)),
    ));
});

describe('0101_brand_voice.sql', () => {
  it('0101 names every schema column', () => {
    for (const c of getTableConfig(workspaceBrandVoice).columns) {
      expect(migrationCode).toContain(`"${c.name}"`);
    }
  });

  it('0101 is idempotent and never destructive', () => {
    expect(migrationCode).toMatch(
      /CREATE TABLE IF NOT EXISTS "workspace_brand_voice"/,
    );
    expect(migrationCode).not.toMatch(/\b(DROP|TRUNCATE)\b|\bDELETE\s+FROM\b/i);
    expect(migrationCode).toMatch(/ON CONFLICT \("workspace_id"\) DO NOTHING/);
  });

  it('0101 tone CHECK lists exactly BRAND_TONES', () => {
    // Anchored on the ARRAY[...] literal, not on the end of the CHECK.
    //
    // The previous pattern closed on `\),?\n` and matched lazily, so it
    // stopped at the FIRST `)` inside the expression — the one closing
    // `cardinality("tone") <= 4)`. The capture then held no quoted tones,
    // `quoted` came back `[]`, and this failed against a migration that was
    // correct all along: 0101 does list all nine tones, with the cap.
    //
    // The tones are the only quoted strings inside `ARRAY[...]`, so matching
    // that cannot be cut short the same way. What the test is FOR is unchanged
    // — the SQL constraint and the TS `BRAND_TONES` list must never drift.
    const list =
      migrationCode.match(
        /CONSTRAINT "workspace_brand_voice_tone_chk"[\s\S]*?ARRAY\[([^\]]*)\]/,
      )?.[1] ?? '';
    const quoted = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(quoted.sort()).toEqual([...BRAND_TONES].sort());

    // Asserted against the whole file: the capture above ends at the
    // ARRAY[...] literal, and the cardinality cap sits after it.
    expect(migrationCode).toContain('cardinality("tone") <= 4');
  });
});
