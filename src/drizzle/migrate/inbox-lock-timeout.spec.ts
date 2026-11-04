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
 * four CHECK constraints. 0058 adds foreign keys to users and workspace
 * (SHARE ROW EXCLUSIVE on both).
 */
const FILES = [
  '0046_inbox_items_thread_key.sql',
  '0052_inbox_conversations_backfill.sql',
  '0054_library_columns.sql',
  '0055_posts_library_refs.sql',
  '0056_media_categories_created_by.sql',
  '0057_library_is_sample.sql',
  '0058_insight_hidden_steps.sql',
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
