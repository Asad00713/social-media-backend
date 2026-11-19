import { join } from 'node:path';
import { readMigrations } from './runner';

/**
 * I4: 0046 rewrites inbox_items under ACCESS EXCLUSIVE and 0052 locks
 * inbox_conversations EXCLUSIVE, both inside the boot migrator's transaction.
 * Without a lock_timeout either one queues behind any open transaction on the
 * still-running old instance, and every Inbox read queues behind it. Each must
 * bound its wait as its first executable statement; SET LOCAL is scoped to the
 * runner's per-file transaction. 0054 alters media_items, saved_links, plans
 * and workspace_usage (ACCESS EXCLUSIVE) and builds two indexes. 0055 rewrites
 * posts (two generated columns) under ACCESS EXCLUSIVE and builds three GIN
 * indexes. 0056 alters media_categories (ACCESS EXCLUSIVE) and adds a
 * foreign key to users. 0057 alters the five Library tables and validates
 * four CHECK constraints. 0058 creates post_comments with foreign keys to
 * posts, workspace and users (SHARE ROW EXCLUSIVE on each). 0059 creates
 * workspace_brand_kits with foreign keys to workspace, media_items and
 * users (SHARE ROW EXCLUSIVE on each).
 * 0060 adds foreign keys to users and workspace (SHARE ROW EXCLUSIVE on
 * both).
 * 0061 creates short_links with foreign keys to workspace, posts and
 * users (SHARE ROW EXCLUSIVE on each).
 * 0062 creates channel_audience with a foreign key to social_media_channels
 * (SHARE ROW EXCLUSIVE).
 * 0063 adds the pause columns to social_media_channels (ACCESS EXCLUSIVE)
 * and creates network_requests with foreign keys to workspace and users.
 * 0064 adds nickname and show_in_sidebar to social_media_channels (ACCESS
 * EXCLUSIVE).
 * 0065 updates integration rows of social_media_channels (ROW EXCLUSIVE).
 * 0066 creates insight_reports with foreign keys to workspace, media_items and
 * users (SHARE ROW EXCLUSIVE on each).
 * 0067 creates channel_connect_links with foreign keys to workspace and users
 * (SHARE ROW EXCLUSIVE on each) and adds three columns plus a foreign key to
 * social_media_channels (ACCESS EXCLUSIVE).
 * 0080 adds removed_at / removed_by to workspace_invitations (ACCESS
 * EXCLUSIVE) and a foreign key to users (SHARE ROW EXCLUSIVE).
 * 0082 adds request_id to error_logs (ACCESS EXCLUSIVE, catalog-only).
 * 0083 creates platform_incidents with a foreign key to users (SHARE ROW
 * EXCLUSIVE). 0086 builds an index on posts (SHARE) and 0087 one on
 * error_logs (SHARE), each with a tighter bound of its own, checked below.
 * 0090 adds four columns to users (ACCESS EXCLUSIVE, catalog-only).
 * 0091 adds five columns to workspace and one to workspace_invitations
 * (ACCESS EXCLUSIVE, catalog-only), then a unique index on workspace (SHARE).
 * 0092 creates workspace_labels and post_labels with foreign keys to
 * workspace, users, posts and workspace_labels (SHARE ROW EXCLUSIVE on each).
 * 0093 drops and re-adds the foreign keys to users on six tables plus
 * workspace.owner_id (ACCESS EXCLUSIVE on each table and on users).
 */
const FILES = [
  '0046_inbox_items_thread_key.sql',
  '0052_inbox_conversations_backfill.sql',
  '0054_library_columns.sql',
  '0055_posts_library_refs.sql',
  '0056_media_categories_created_by.sql',
  '0057_library_is_sample.sql',
  '0058_post_comments.sql',
  '0059_brand_kits.sql',
  '0060_insight_hidden_steps.sql',
  '0061_short_links.sql',
  '0062_channel_audience.sql',
  '0063_channel_pause_and_network_requests.sql',
  '0064_channel_nickname_sidebar.sql',
  '0065_release_locked_integrations.sql',
  '0066_insight_reports.sql',
  '0067_channel_connect_links.sql',
  '0080_member_soft_removal.sql',
  '0082_error_logs_request_id.sql',
  '0083_platform_status.sql',
  '0090_user_account_settings.sql',
  '0091_workspace_settings.sql',
  '0092_workspace_labels.sql',
  '0093_users_fk_set_null.sql',
];

const firstStatement = (sql: string): string =>
  sql
    .replace(/^\s*--.*$/gm, '')
    .trim()
    .split(';')[0]
    .trim();

describe('migrations bound their lock wait (I4)', () => {
  const files = readMigrations(join(process.cwd(), 'drizzle', 'migrations'));

  it.each(FILES)('%s starts with SET LOCAL lock_timeout', (name) => {
    const file = files.find((f) => f.name === name);
    expect(file).toBeDefined();
    expect(firstStatement(file!.sql)).toBe("SET LOCAL lock_timeout = '10s'");
  });
});

describe('0086 bounds both the lock wait and the build', () => {
  const files = readMigrations(join(process.cwd(), 'drizzle', 'migrations'));
  const statements = (sql: string): string[] =>
    sql
      .replace(/^\s*--.*$/gm, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);

  it('sets a 3 s lock_timeout and a statement_timeout before the index', () => {
    const file = files.find(
      (f) => f.name === '0086_posts_updated_at_index.sql',
    );
    expect(file).toBeDefined();
    const [first, second, third] = statements(file!.sql);
    expect(first).toBe("SET LOCAL lock_timeout = '3s'");
    expect(second).toMatch(/^SET LOCAL statement_timeout = '\d+s'$/);
    expect(third).toMatch(/^CREATE INDEX IF NOT EXISTS "posts_updated_at_idx"/);
  });

  it('keeps the index out of 0083', () => {
    const file = files.find((f) => f.name === '0083_platform_status.sql');
    expect(file!.sql.replace(/^\s*--.*$/gm, '')).not.toMatch(/ON "posts"/);
  });
});

describe('0087 bounds both the lock wait and the build', () => {
  const files = readMigrations(join(process.cwd(), 'drizzle', 'migrations'));
  const statements = (sql: string): string[] =>
    sql
      .replace(/^\s*--.*$/gm, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);

  it('sets a 3 s lock_timeout and a statement_timeout before a partial index', () => {
    const file = files.find(
      (f) => f.name === '0087_error_logs_request_id_index.sql',
    );
    expect(file).toBeDefined();
    const [first, second, third, ...rest] = statements(file!.sql);
    expect(first).toBe("SET LOCAL lock_timeout = '3s'");
    expect(second).toMatch(/^SET LOCAL statement_timeout = '\d+s'$/);
    expect(third).toMatch(
      /^CREATE INDEX IF NOT EXISTS "error_logs_request_id_idx"[\s\S]*WHERE "request_id" IS NOT NULL$/,
    );
    expect(rest).toEqual([]);
  });

  it('keeps the index out of 0082, so its ACCESS EXCLUSIVE lock is short', () => {
    const file = files.find((f) => f.name === '0082_error_logs_request_id.sql');
    expect(file!.sql.replace(/^\s*--.*$/gm, '')).not.toMatch(/CREATE INDEX/i);
  });
});
