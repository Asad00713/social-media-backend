import { join } from 'node:path';
import { readMigrations } from './runner';

/**
 * I4: 0046 rewrites inbox_items under ACCESS EXCLUSIVE and 0052 locks
 * inbox_conversations EXCLUSIVE, both inside the boot migrator's transaction.
 * Without a lock_timeout either one queues behind any open transaction on the
 * still-running old instance, and every Inbox read queues behind it. Each must
 * bound its wait as its first executable statement; SET LOCAL is scoped to the
 * runner's per-file transaction.
 */
const FILES = [
  '0046_inbox_items_thread_key.sql',
  '0052_inbox_conversations_backfill.sql',
];

const firstStatement = (sql: string): string =>
  sql
    .replace(/^\s*--.*$/gm, '')
    .trim()
    .split(';')[0]
    .trim();

describe('inbox migrations bound their lock wait (I4)', () => {
  const files = readMigrations(join(process.cwd(), 'drizzle', 'migrations'));

  it.each(FILES)('%s starts with SET LOCAL lock_timeout', (name) => {
    const file = files.find((f) => f.name === name);
    expect(file).toBeDefined();
    expect(firstStatement(file!.sql)).toBe("SET LOCAL lock_timeout = '10s'");
  });
});
