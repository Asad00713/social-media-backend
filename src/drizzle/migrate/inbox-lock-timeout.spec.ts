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
 * 0066 creates channel_connect_links with foreign keys to workspace and users
 * (SHARE ROW EXCLUSIVE on each) and adds three columns plus a foreign key to
 * social_media_channels (ACCESS EXCLUSIVE).
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
  '0066_channel_connect_links.sql',
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
